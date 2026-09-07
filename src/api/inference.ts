import { HEADERS, request, type Session } from "./client.js";
import { ApiError, CliError } from "../cli/errors.js";

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

/**
 * Request metadata the platform returns in headers rather than the body, so the
 * OpenAI/Anthropic wire shapes stay untouched. Cost and timing are opt-in via
 * X-Aiand-Metrics and are emitted on non-streaming responses only.
 */
export type ChatMeta = {
  /** The resolved catalog name -- the only place `auto`'s choice is reported. */
  model?: string;
  requestId?: string;
  cost?: string;
  costCurrency?: string;
  inferenceMs?: number;
  reasoningEffort?: string;
  /** `reasoning_only` | `truncated` | `empty` -- set only on a contentless 200. */
  emptyCompletion?: string;
  rateLimitLimit?: string;
  rateLimitRemaining?: string;
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
    rateLimitLimit: get(HEADERS.RATE_LIMIT_LIMIT),
    rateLimitRemaining: get(HEADERS.RATE_LIMIT_REMAINING),
  };
}

/** Human-readable form of X-Empty-Completion, when the server sends one. */
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

/**
 * Why a 200 carried no assistant text.
 *
 * X-Empty-Completion is the clearest signal but it is not sent for every case —
 * a reasoning model that exhausts `max_tokens` before it writes any content
 * comes back as `finish_reason: "length"` with every completion token counted as
 * reasoning, and no header at all. Falling back to the body means the CLI can
 * still say what happened instead of printing a blank line.
 */
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

/**
 * `auto` is an operator-gated feature, so a deployment can reject it. The
 * server's message points at GET /v1/models; point at our own flags instead.
 */
export function withModelHint(error: unknown, model: string): unknown {
  if (
    error instanceof ApiError &&
    error.status === 400 &&
    model === "auto" &&
    error.message.includes("'auto' is not supported")
  ) {
    return new ApiError(error.status, "Automatic model selection is not enabled for this account.", {
      requestId: error.requestId,
      type: error.type,
      hint: "Name a model with -m, or set a default: aiand config set model <id>. `aiand models` lists them.",
    });
  }
  return error;
}

export async function createChatCompletion(
  session: Session,
  body: ChatRequest,
  signal?: AbortSignal
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
  const raw = (await response.json()) as {
    choices?: {
      message?: { content?: string | null; reasoning_content?: string | null };
      finish_reason?: string | null;
    }[];
    usage?: Usage;
  };
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
  text?: string;
  /** Reasoning tokens, where the model emits them separately. */
  reasoning?: string;
  usage?: Usage;
  finishReason?: string;
};

/**
 * Stream a completion. Headers (and therefore the resolved model) are available
 * before the first token; cost headers are not sent on streams.
 *
 * The API enables `stream_options.include_usage` server-side, so the final
 * chunk always carries usage.
 */
export async function streamChatCompletion(
  session: Session,
  body: ChatRequest,
  signal?: AbortSignal
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

  return { meta: readMeta(response), chunks: parseSse(response.body) };
}

type SseDelta = {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: Usage | null;
};

/** Minimal SSE reader: we only need `data:` lines, and `[DONE]` ends the stream. */
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });

    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);

      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;

      let event: SseDelta;
      try {
        event = JSON.parse(payload) as SseDelta;
      } catch {
        continue; // Keep-alives and partial frames are not fatal.
      }

      const choice = event.choices?.[0];
      const chunk: StreamChunk = {};
      if (choice?.delta?.content) chunk.text = choice.delta.content;
      if (choice?.delta?.reasoning_content) chunk.reasoning = choice.delta.reasoning_content;
      if (choice?.finish_reason) chunk.finishReason = choice.finish_reason;
      if (event.usage) chunk.usage = event.usage;
      if (Object.keys(chunk).length > 0) yield chunk;
    }
  }
}
