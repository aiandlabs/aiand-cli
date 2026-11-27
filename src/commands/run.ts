import { EOL } from "node:os";

import { resolveEffectiveModel } from "../agents/catalog.js";
import { openSession, type Session } from "../api/client.js";
import {
  type ChatMeta,
  type ChatRequest,
  createChatCompletion,
  describeEmptyResponse,
  type Message,
  streamChatCompletion,
  type Usage,
  withModelHint,
} from "../api/inference.js";
import { bool, float, int, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { err, json, out, safeLine, streamWriter, style } from "../cli/output.js";
import { readStdin } from "../cli/stdin.js";
import { type ResolvedProfile, resolveProfile } from "../config.js";

export const help = `${style.bold("aiand run")} -- send one prompt and print the answer

Usage
  aiand run "explain this stack trace"
  cat main.ts | aiand run "review this file"
  aiand run --model auto --system "be terse" "why is the sky blue?"

Options
  -m, --model <id>           model to call (default: catalog preferred)
      --system <text>        system prompt
      --max-tokens <n>
      --temperature <n>
      --top-p <n>
      --reasoning-effort <l> one of the model's published levels
      --stop <text>          stop sequence (repeatable)
      --show-reasoning       stream reasoning tokens to stderr
      --no-stream            wait for the whole response
      --json                 print one JSON chat-completion object
  -q, --quiet                suppress the stats footer

Piped stdin is appended to the prompt, so you can pass a file as context.
On a terminal, escape and control sequences in the answer are removed;
redirect or pipe stdout to get the model's raw text.
Omitting -m resolves a concrete catalog model (profile model when still listed,
else the curated preferred default). Pass -m auto to let ai& choose per request
when your account supports it; the choice is reported in the footer.`;

/**
 * Model for one inference call (run and chat): --model as-is, else the live
 * catalog's pick. When the catalog is unreachable a configured profile model
 * still sends; never fall back to gateway `auto`, which is not a catalog id
 * and 400s when automatic selection is off.
 */
export async function inferenceModel(
  requested: string | undefined,
  profile: ResolvedProfile,
): Promise<string> {
  try {
    return await resolveEffectiveModel(requested, profile.apiUrl, profile.model);
  } catch (error) {
    if (requested || !profile.model) throw error;
    return profile.model;
  }
}

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    model: { type: "string", short: "m" },
    system: { type: "string" },
    "max-tokens": { type: "string" },
    temperature: { type: "string" },
    "top-p": { type: "string" },
    "reasoning-effort": { type: "string" },
    stop: { type: "string", multiple: true },
    "show-reasoning": { type: "boolean", default: false },
    "no-stream": { type: "boolean", default: false },
    quiet: { type: "boolean", short: "q", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const profile = resolveProfile(str(parsed, "profile"));
  const prompt = await buildPrompt(parsed.positionals);
  const session = await openSession(profile);

  const messages: Message[] = [];
  const system = str(parsed, "system");
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const model = await inferenceModel(str(parsed, "model"), profile);

  const body: ChatRequest = {
    model,
    messages,
  };
  const maxTokens = int(parsed, "max-tokens");
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  const temperature = float(parsed, "temperature");
  if (temperature !== undefined) body.temperature = temperature;
  const topP = float(parsed, "top-p");
  if (topP !== undefined) body.top_p = topP;
  const effort = str(parsed, "reasoning-effort");
  if (effort) body.reasoning_effort = effort;
  const stop = parsed.values.stop as string[] | undefined;
  if (stop?.length) body.stop = stop;

  const wantsJson = bool(parsed, "json");
  const stream = !bool(parsed, "no-stream");
  const quiet = bool(parsed, "quiet") || wantsJson;

  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);

  try {
    if (stream) {
      await runStreaming(session, body, controller.signal, {
        showReasoning: bool(parsed, "show-reasoning"),
        quiet,
        wantsJson,
      });
    } else {
      const result = await createChatCompletion(session, body, controller.signal);
      if (wantsJson) return json(withJsonMetrics(result.raw, result.meta));

      if (result.reasoning && bool(parsed, "show-reasoning")) {
        const reasoning = streamWriter(process.stderr);
        reasoning.write(`thinking: ${result.reasoning}${EOL}`, style.dim);
        reasoning.endLine();
      }
      if (result.text) {
        const answer = streamWriter(process.stdout);
        answer.write(`${result.text}${EOL}`);
        answer.endLine();
      } else {
        err(
          style.yellow("No content. ") +
            safeLine(
              describeEmptyResponse({
                meta: result.meta,
                finishReason: result.finishReason,
                usage: result.usage,
              }),
            ),
        );
      }
      if (!quiet) err(statsLine(result.meta, result.usage));
    }
  } catch (error) {
    throw withModelHint(error, body.model);
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

async function runStreaming(
  session: Session,
  body: ChatRequest,
  signal: AbortSignal,
  options: { showReasoning: boolean; quiet: boolean; wantsJson: boolean },
): Promise<void> {
  const { meta, chunks } = await streamChatCompletion(session, body, signal);

  let id: string | undefined;
  let created: number | undefined;
  let model: string | undefined;
  let usage: Usage | null = null;
  let text = "";
  let reasoningText = "";
  let finishReason: string | undefined;
  let reasoningOpen = false;
  const answer = streamWriter(process.stdout);
  const reasoning = streamWriter(process.stderr);

  for await (const chunk of chunks) {
    if (chunk.id !== undefined) id = chunk.id;
    if (chunk.created !== undefined) created = chunk.created;
    if (chunk.model !== undefined) model = chunk.model;
    if (chunk.reasoning) {
      reasoningText += chunk.reasoning;
      if (!options.wantsJson && options.showReasoning) {
        if (!reasoningOpen) {
          reasoning.write("thinking: ", style.dim);
          reasoningOpen = true;
        }
        reasoning.write(chunk.reasoning, style.dim);
      }
    }
    if (chunk.text) {
      if (reasoningOpen) {
        reasoning.endLine();
        reasoningOpen = false;
      }
      text += chunk.text;
      if (!options.wantsJson) answer.write(chunk.text);
    }
    if (chunk.finishReason) finishReason = chunk.finishReason;
    if (chunk.usage) usage = chunk.usage;
  }

  if (options.wantsJson) {
    const completion = {
      ...(id !== undefined ? { id } : {}),
      object: "chat.completion",
      ...(created !== undefined ? { created } : {}),
      ...(model !== undefined ? { model } : {}),
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: text,
            ...(reasoningText ? { reasoning_content: reasoningText } : {}),
          },
          finish_reason: finishReason ?? null,
        },
      ],
      usage,
    };
    return json(withJsonMetrics(completion, meta));
  }

  if (reasoningOpen) reasoning.endLine();
  answer.endLine();

  if (!text) {
    err(
      style.yellow("No content. ") + safeLine(describeEmptyResponse({ meta, finishReason, usage })),
    );
  }

  if (!options.quiet) err(statsLine(meta, usage));
}

function withJsonMetrics(raw: unknown, meta: ChatMeta): Record<string, unknown> {
  const completion: Record<string, unknown> =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  if (meta.cost !== undefined && meta.cost.trim() !== "") {
    const cost = Number(meta.cost);
    if (Number.isFinite(cost)) completion.cost = cost;
  }
  if (meta.costCurrency) completion.currency = meta.costCurrency;
  if (meta.inferenceMs !== undefined && Number.isFinite(meta.inferenceMs)) {
    completion.inference_ms = meta.inferenceMs;
  }
  return completion;
}

function statsLine(meta: ChatMeta, usage: Usage | null): string {
  const parts: string[] = [];
  if (meta.model) parts.push(meta.model);
  if (usage) {
    const cached = usage.prompt_tokens_details?.cached_tokens;
    parts.push(
      `${usage.prompt_tokens ?? 0} in / ${usage.completion_tokens ?? 0} out` +
        (cached ? ` (${cached} cached)` : ""),
    );
  }
  if (meta.cost) {
    parts.push(`${meta.cost} ${(meta.costCurrency ?? "").toUpperCase()}`.trim());
  }
  if (meta.inferenceMs !== undefined && !Number.isNaN(meta.inferenceMs)) {
    parts.push(`${meta.inferenceMs}ms`);
  }
  if (meta.reasoningEffort) parts.push(`effort=${meta.reasoningEffort}`);
  if (meta.requestId) parts.push(meta.requestId);
  // Model, cost, effort and request id come from response headers.
  return style.dim(safeLine(parts.join("  ·  ")));
}

async function buildPrompt(positionals: string[]): Promise<string> {
  const inline = positionals.join(" ").trim();
  const piped = await readStdin();

  if (inline && piped) return `${inline}\n\n${piped}`;
  const prompt = inline || piped;
  if (!prompt) {
    throw new CliError("No prompt given.", {
      hint: 'Pass one as an argument -- aiand run "your question" -- or pipe it on stdin.',
    });
  }
  return prompt;
}
