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

/**
 * One `models[]` row per catalog model. The CLI addresses BYOK models by
 * provider-qualified id, so `id` is what selection strings name (wireModel
 * is what the request body sends); both keep the catalog id verbatim.
 * `maxPromptTokens`/`maxContextWindowTokens` mirror the context window —
 * the catalog has no separate output field (opencode's policy).
 * providers.json accepts `reasoningEffort` as a boolean only. The CLI
 * builds its own menu, so a level list is not written.
 */
export function buildCopilotModelEntries(catalog: Model[]): Record<string, unknown>[] {
  return catalog.map((model) => ({
    id: model.id,
    provider: COPILOT_PROVIDER_NAME,
    wireModel: model.id,
    name: model.name,
    maxPromptTokens: model.context_window,
    maxContextWindowTokens: model.context_window,
    ...(model.reasoning_efforts?.length
      ? { capabilities: { supports: { reasoningEffort: true } } }
      : {}),
  }));
}

function formatLevels(levels: readonly string[]): string {
  if (levels.length <= 1) return levels[0] ?? "";
  if (levels.length === 2) return `${levels[0]} and ${levels[1]}`;
  return `${levels.slice(0, -1).join(", ")}, and ${levels[levels.length - 1]}`;
}

/**
 * providers.json has no level list. Say so when a model omits `medium`,
 * the level the CLI's own menu offers and GLM-5.3 refuses.
 */
export function copilotReasoningMenuWarning(catalog: Model[]): string | undefined {
  const mismatched = catalog.filter(
    (model) =>
      (model.reasoning_efforts?.length ?? 0) > 0 && !model.reasoning_efforts?.includes("medium"),
  );
  if (mismatched.length === 0) return undefined;
  const accepts = mismatched
    .map((model) => `${model.id} accepts ${formatLevels(model.reasoning_efforts ?? [])}`)
    .join("; ");
  return `Copilot CLI builds its own reasoning menu. ${accepts}. GLM-5.3 refuses medium.`;
}
