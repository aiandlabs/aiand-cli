import type { Model } from "../../api/models.js";
import { DEFAULT_BASE_URL, trimSlash } from "../../config.js";

/** Provider name in providers.json and the qualifier in every model selection. */
export const COPILOT_PROVIDER_NAME = "aiand";
/** Model selections the CLI accepts for a BYOK provider are `aiand/<id>`. */
export const COPILOT_SELECTION_PREFIX = `${COPILOT_PROVIDER_NAME}/`;

/** The gateway base URL the provider row speaks to. */
export const copilotBaseUrl = (baseUrl?: string): string =>
  `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;

/**
 * The provider row the CLI needs for BYOK: the OpenAI chat-completions
 * dialect over `baseUrl`, authenticating with the literal session key,
 * which (documented) bypasses GitHub sign-in entirely.
 */
export function buildCopilotProvider({
  apiKey,
  baseUrl,
}: {
  apiKey: string;
  baseUrl: string;
}): Record<string, unknown> {
  return {
    name: COPILOT_PROVIDER_NAME,
    type: "openai",
    wireApi: "completions",
    baseUrl,
    apiKey,
  };
}

/** The reasoning levels Copilot CLI recognizes in `reasoning_effort` (1.0.112). */
const COPILOT_REASONING_LEVELS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * One `models[]` row per catalog model. The CLI addresses BYOK models by
 * provider-qualified id, so `id` is what selection strings name (wireModel
 * is what the request body sends); both keep the catalog id verbatim.
 * `maxPromptTokens`/`maxContextWindowTokens` mirror the context window —
 * the catalog has no separate output field (opencode's policy).
 *
 * `capabilities.supports` follows the CLI's config reference, checked
 * against Copilot CLI 1.0.112:
 * - `reasoning_effort` lists the levels the model publishes, so the CLI
 *   offers exactly those (its ACP session config shows them as the
 *   reasoning-effort options). The boolean `reasoningEffort: true` this
 *   used to write enables no control at all. Levels the CLI does not
 *   recognize are left out. No level is chosen here: a request without
 *   one runs at the model's engine default.
 * - `vision` marks image input. Without it the CLI treats a BYOK model as
 *   text-only and drops images that tools return.
 */
export function buildCopilotModelEntries(catalog: Model[]): Record<string, unknown>[] {
  return catalog.map((model) => {
    const levels = (model.reasoning_efforts ?? []).filter((level) =>
      COPILOT_REASONING_LEVELS.has(level),
    );
    const vision = model.capabilities.includes("vision");
    const supports = {
      ...(levels.length > 0 ? { reasoning_effort: levels } : {}),
      ...(vision ? { vision: true } : {}),
    };
    return {
      id: model.id,
      provider: COPILOT_PROVIDER_NAME,
      wireModel: model.id,
      name: model.name,
      maxPromptTokens: model.context_window,
      maxContextWindowTokens: model.context_window,
      ...(Object.keys(supports).length > 0 ? { capabilities: { supports } } : {}),
    };
  });
}
