import { ApiError, CliError, cancelled, SYNTHETIC_STATUS } from "../cli/errors.js";
import {
  gatewayNotJsonError,
  HEADERS,
  parseJsonResponse,
  request,
  type Session,
} from "./client.js";

export type Message = { role: "system" | "user" | "assistant"; content: string };

export type ChatRequest = {
  model: string;
  messages: Message[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning_effort?: string;
  stop?: string[];
};

export type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};

export type ChatMeta = {
  model?: string;
  requestId?: string;
  cost?: string;
  costCurrency?: string;
  inferenceMs?: number;
  reasoningEffort?: string;
  emptyCompletion?: string;
};

function readMeta(response: Response): ChatMeta {
  const get = (name: string): string | undefined => response.headers.get(name) ?? undefined;
  const inferenceMs = get(HEADERS.INFERENCE_MS);
  return {
    model: get(HEADERS.MODEL),
    requestId: get(HEADERS.REQUEST_ID),
    cost: get(HEADERS.COST),
    costCurrency: get(HEADERS.COST_CURRENCY),
    inferenceMs: inferenceMs === undefined ? undefined : Number(inferenceMs),
    reasoningEffort: get(HEADERS.REASONING_EFFORT),
    emptyCompletion: get(HEADERS.EMPTY_COMPLETION),
  };
}

function explainEmptyCompletion(reason: string): string {
  switch (reason) {
    case "reasoning_only":
      return "The model reasoned and then stopped without producing content. If you sent --stop, retry without it.";
    case "truncated":
      return "The token budget ran out inside the model's reasoning. Raise --max-tokens, or pick a model that reasons more briefly.";
    case "empty":
      return "The model produced nothing at all.";
    default:
      return `The response carried no content (${reason}).`;
  }
}

export function describeEmptyResponse(input: {
  meta: ChatMeta;
  finishReason?: string;
  usage?: Usage | null;
}): string {
  if (input.meta.emptyCompletion) return explainEmptyCompletion(input.meta.emptyCompletion);

  const reasoningTokens = input.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  if (input.finishReason === "length") {
    return reasoningTokens > 0
      ? `The token budget was spent reasoning (${reasoningTokens} reasoning tokens) before any answer was written. Raise --max-tokens, or pick a model that reasons more briefly.`
      : "The response hit the token limit before the model finished. Raise --max-tokens.";
  }
  if (reasoningTokens > 0) {
    return `The model reasoned (${reasoningTokens} tokens) and stopped without writing an answer. If you sent --stop, retry without it.`;
  }
  return "The model returned no content.";
}

const METRICS_HEADER = { [HEADERS.METRICS]: "true" };

export function withModelHint(error: unknown, model: string): unknown {
  if (
    error instanceof ApiError &&
    error.status === 400 &&
    model === "auto" &&
    error.message.includes("'auto' is not supported")
  ) {
    return new ApiError(
      error.status,
      "Automatic model selection is not enabled for this account.",
      {
        requestId: error.requestId,
        type: error.type,
        hint: "Name a model with -m, or set a default: aiand config set model <id>. `aiand models` lists them.",
      },
    );
  }
  return error;
}

export async function createChatCompletion(
  session: Session,
  body: ChatRequest,
  signal?: AbortSignal,
): Promise<{
  text: string;
  reasoning: string;
  finishReason?: string;
  usage: Usage | null;
  meta: ChatMeta;
  raw: unknown;
}> {
  const response = await request(session, {
    method: "POST",
    path: "/v1/chat/completions",
    body: { ...body, stream: false },
    headers: METRICS_HEADER,
    signal,
  });

  const meta = readMeta(response);
  const raw = await parseJsonResponse<{
    choices?: {
      message?: { content?: string | null; reasoning_content?: string | null };
      finish_reason?: string | null;
    }[];
    usage?: Usage;
  }>(response);
  const choice = raw.choices?.[0];

  return {
    text: choice?.message?.content ?? "",
    reasoning: choice?.message?.reasoning_content ?? "",
    finishReason: choice?.finish_reason ?? undefined,
    usage: raw.usage ?? null,
    meta,
    raw,
  };
}

export type StreamChunk = {
  id?: string;
  created?: number;
  model?: string;
  text?: string;
  reasoning?: string;
  usage?: Usage;
  finishReason?: string;
};

export async function streamChatCompletion(
  session: Session,
  body: ChatRequest,
  signal?: AbortSignal,
): Promise<{ meta: ChatMeta; chunks: AsyncGenerator<StreamChunk> }> {
  const response = await request(session, {
    method: "POST",
    path: "/v1/chat/completions",
    body: { ...body, stream: true },
    headers: { ...METRICS_HEADER, Accept: "text/event-stream" },
    signal,
  });

  if (!response.body) {
    throw new CliError("The server returned an empty stream.");
  }
  assertEventStream(response);

  const meta = readMeta(response);
  return { meta, chunks: parseSse(response, meta) };
}

type SseDelta = {
  id?: string;
  created?: number;
  model?: string;
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: Usage | null;
};

// A 200 HTML/text body on the stream endpoint is the same gateway failure
// parseJsonResponse reports as 502 — without this the HTML parses as an
// empty SSE stream and surfaces as a misleading "No content.".
function assertEventStream(response: Response): void {
  const contentType = response.headers.get("content-type");
  if (contentType?.toLowerCase().includes("text/event-stream")) return;
  throw gatewayNotJsonError(
    response,
    contentType
      ? `content-type "${contentType}" is not text/event-stream`
      : `missing content-type (expected "text/event-stream")`,
  );
}

/** One SSE line longer than this is no chat delta: a broken or hostile
 * stream that never sends a newline would otherwise grow without bound. */
const SSE_LINE_MAX_CHARS = 1024 * 1024;

const POST_DONE_GRACE_MS = 250;

function finiteMetricNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** Apply a parsed, named metrics trailer. Invalid JSON is not a trailer. */
function applyMetrics(meta: ChatMeta, payload: string): boolean {
  let metrics: { cost?: unknown; currency?: unknown; inference_ms?: unknown };
  try {
    metrics = JSON.parse(payload) as typeof metrics;
  } catch {
    return false;
  }
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return false;

  const cost = finiteMetricNumber(metrics.cost);
  if (cost !== undefined) meta.cost = String(cost);
  if (typeof metrics.currency === "string") meta.costCurrency = metrics.currency;
  const inferenceMs = finiteMetricNumber(metrics.inference_ms);
  if (inferenceMs !== undefined) meta.inferenceMs = inferenceMs;
  return true;
}

async function* parseSse(response: Response, meta: ChatMeta): AsyncGenerator<StreamChunk> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sniffed = false;
  let eventName = "";
  let doneAt: number | undefined;

  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: Awaited<ReturnType<typeof reader.read>> | null;
      try {
        if (doneAt === undefined) {
          // Ordinary completion content has no read timeout.
          result = await reader.read();
        } else {
          const remaining = POST_DONE_GRACE_MS - (Date.now() - doneAt);
          if (remaining <= 0) return;
          result = await Promise.race([
            reader.read(),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), remaining);
            }),
          ]);
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      // A null race result is the bounded trailer wait expiring, not an abort.
      if (result === null || result.done) return;
      buffer += decoder.decode(result.value, { stream: true });

      // A gateway answering 200 with HTML under an SSE content-type would
      // otherwise parse as an empty stream: the first non-blank byte of a
      // real event stream is never "<". Deferred past leading whitespace so
      // a chunk split cannot hide the "<".
      if (!sniffed) {
        const first = buffer.trimStart().slice(0, 1);
        if (first !== "") {
          sniffed = true;
          if (first === "<") {
            throw gatewayNotJsonError(
              response,
              "the response body looks like HTML, not server-sent events",
            );
          }
        }
      }

      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);

        if (line === "") {
          eventName = "";
          continue;
        }
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          doneAt ??= Date.now();
          continue;
        }
        if (doneAt !== undefined) {
          // Completion chunks after [DONE] are ignored. Only the named
          // metrics trailer may extend the response, and yields no chunk.
          if (eventName === "metrics" && applyMetrics(meta, payload)) return;
          continue;
        }

        let event: SseDelta;
        try {
          event = JSON.parse(payload) as SseDelta;
        } catch {
          continue;
        }

        const choice = event.choices?.[0];
        const chunk: StreamChunk = {};
        if (event.id !== undefined) chunk.id = event.id;
        if (event.created !== undefined) chunk.created = event.created;
        if (event.model !== undefined) chunk.model = event.model;
        if (choice?.delta?.content) chunk.text = choice.delta.content;
        if (choice?.delta?.reasoning_content) chunk.reasoning = choice.delta.reasoning_content;
        if (choice?.finish_reason) chunk.finishReason = choice.finish_reason;
        if (event.usage) chunk.usage = event.usage;
        if (Object.keys(chunk).length > 0) yield chunk;
      }
      if (buffer.length > SSE_LINE_MAX_CHARS) {
        throw new ApiError(
          SYNTHETIC_STATUS.BAD_GATEWAY,
          "The gateway sent a server-sent event line over 1 MiB; stopped reading the stream.",
          { requestId: response.headers.get(HEADERS.REQUEST_ID) ?? undefined },
        );
      }
    }
  } catch (cause) {
    // Mid-stream Ctrl-C aborts the body read: map it like fetchOrFail does
    // for the initial fetch so callers see CliError 130, not a raw AbortError.
    if (cause instanceof Error && cause.name === "AbortError") {
      throw cancelled();
    }
    throw cause;
  } finally {
    // Early returns after a trailer or grace expiry must not leave the body
    // socket open. Cancellation here is local cleanup, not a SIGINT abort.
    try {
      await reader.cancel();
    } catch {}
    reader.releaseLock();
  }
}
