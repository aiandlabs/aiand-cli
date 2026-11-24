import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listModels, type Model } from "../api/models.js";
import { CliError, EXIT } from "../cli/errors.js";
import { safeLine } from "../cli/output.js";
import { configDir, writeFileAtomic } from "../config.js";
import { PRIVATE_FILE_MODE } from "../fsutil.js";
import { HOUR_MS } from "../time.js";
import {
  allowedCatalog,
  assertAutoAllowed,
  assertModelAllowed,
  NO_POLICY,
  type OriginPolicy,
  recommendedFor,
} from "./origin.js";

/** The gateway's per-request model choice; not a catalog id. */
const AUTO_MODEL = "auto";

const CATALOG_CACHE_FILE = "model-catalog.json";
export const CATALOG_TTL_MS = 6 * HOUR_MS;

/** Vision-capable means the capability list contains "vision". */
export function visionLabel(model: Model): "vision" | "text-only" {
  return model.capabilities.includes("vision") ? "vision" : "text-only";
}

// Only for a gateway that publishes no `recommended` ranks yet: the order the CLI used to keep. Filtered through the allowed
// catalog like everything else, and never reached under an origin policy,
// since such a gateway publishes no origins either and fails closed. Delete
// once every gateway ranks its models.
const LEGACY_DEFAULTS = [
  "zai-org/glm-5.3",
  "moonshotai/kimi-k3",
  "qwen/qwen3.8-27b",
  "google/gemma-4-31b-it",
];

type CatalogCache = {
  fetchedAt: number;
  baseUrl: string;
  models: Model[];
};

function catalogCachePath(): string {
  return join(configDir(), CATALOG_CACHE_FILE);
}

function parseCache(value: unknown): CatalogCache | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.fetchedAt !== "number" || !Number.isFinite(record.fetchedAt)) return null;
  if (typeof record.baseUrl !== "string" || record.baseUrl.length === 0) return null;
  if (!Array.isArray(record.models)) return null;
  const models: Model[] = [];
  for (const entry of record.models) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const model = entry as Record<string, unknown>;
    if (typeof model.id !== "string" || model.id.length === 0) return null;
    if (!Array.isArray(model.capabilities)) return null;
    if (!model.capabilities.every((cap) => typeof cap === "string")) return null;
    models.push(entry as Model);
  }
  return { fetchedAt: record.fetchedAt, baseUrl: record.baseUrl, models };
}

async function readCache(): Promise<CatalogCache | null> {
  try {
    const raw = await readFile(catalogCachePath(), "utf8");
    return parseCache(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isFresh(cache: CatalogCache, baseUrl: string): boolean {
  return cache.baseUrl === baseUrl && Date.now() - cache.fetchedAt < CATALOG_TTL_MS;
}

/**
 * Drop catalog entries whose id carries a control, escape or bidi character.
 * Ids flow into agent configs, banners, hints and warnings, so one that is not
 * a plain line is refused here rather than escaped at every place it is shown.
 */
function withoutUnsafeIds(models: Model[]): Model[] {
  const safe = models.filter(
    (model) => typeof model?.id === "string" && safeLine(model.id) === model.id,
  );
  if (safe.length < models.length && process.env.AIAND_DEBUG === "1") {
    process.stderr.write(
      `[aiand] ignored ${models.length - safe.length} catalog model(s) whose id has control characters\n`,
    );
  }
  return safe;
}

/**
 * The live /v1/models list, cached for 6h at <configDir>/model-catalog.json.
 * A fresh cache short-circuits the network entirely; a failed fetch does not
 * serve an expired cache. Entries with an unsafe id are dropped on the way in
 * and again on the way out of the cache, which anything can have written.
 */
export async function getCatalog(baseUrl: string): Promise<Model[]> {
  const cached = await readCache();
  if (cached && isFresh(cached, baseUrl)) return withoutUnsafeIds(cached.models);

  try {
    const models = withoutUnsafeIds(await listModels(null, baseUrl));
    const next: CatalogCache = { fetchedAt: Date.now(), baseUrl, models };
    await writeFileAtomic(catalogCachePath(), `${JSON.stringify(next, null, 2)}\n`, {
      mode: PRIVATE_FILE_MODE,
    });
    return models;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Could not reach the model catalog.", {
      hint: "Check your network and retry.",
      exitCode: EXIT.ERROR,
    });
  }
}

/**
 * Refuse a model id that is not in the live catalog. `flag` is the CLI flag
 * named in the error (`--model`). Callers that accept the
 * literal `"native"` escape hatch must skip this check themselves.
 */
export function validateCatalogModel(catalog: Model[], id: string, flag = "--model"): void {
  if (catalog.some((entry) => entry.id === id)) return;
  throw new CliError(`${flag} "${id}" is not in the catalog.`, {
    hint: `Valid ids: ${catalog.map((entry) => entry.id).join(", ")}`,
  });
}

/**
 * Pick the model written into agent configs from `models`, which callers
 * have already cut down to what the origin policy allows: an explicit
 * profile model when it is there, then the model the catalog ranks first
 * for the main slot, then (older gateways only) the legacy order, then
 * whatever the gateway lists first. `legacy` is an adapter's own legacy
 * order, tried ahead of the global one.
 */
export function resolveDefault(
  models: readonly Pick<Model, "id" | "recommended">[],
  profileModel?: string,
  legacy: readonly string[] = [],
): string {
  if (profileModel && models.some((model) => model.id === profileModel)) {
    return profileModel;
  }
  const ranked = recommendedFor(models as Model[], "main");
  if (ranked) return ranked;
  const publishesRanks = models.some((model) => model.recommended !== undefined);
  if (!publishesRanks) {
    for (const candidate of [...legacy, ...LEGACY_DEFAULTS]) {
      if (models.some((model) => model.id === candidate)) return candidate;
    }
  }
  const first = models[0];
  if (!first) {
    throw new CliError("The model catalog is empty.", {
      hint: "The gateway listed no models; retry later or check the base URL.",
    });
  }
  return first.id;
}

/**
 * Effective model for one-shot inference: an explicit --model flag wins
 * as-is, otherwise resolve through the live catalog (profile model when
 * still listed, else the catalog's pick). Under an origin policy the flag,
 * the profile model and the pick are all checked against it.
 */
export async function resolveEffectiveModel(
  flag: string | undefined,
  baseUrl: string,
  profileModel?: string,
  policy: OriginPolicy = NO_POLICY,
): Promise<string> {
  if (policy.exclude.length === 0) {
    if (flag !== undefined) return flag;
    return resolveDefault(await getCatalog(baseUrl), profileModel);
  }
  if (flag === AUTO_MODEL) {
    assertAutoAllowed(policy);
    return flag;
  }
  const catalog = await getCatalog(baseUrl);
  if (flag !== undefined) {
    assertModelAllowed(catalog, flag, policy);
    return flag;
  }
  if (profileModel) assertModelAllowed(catalog, profileModel, policy, "The profile model");
  return resolveDefault(allowedCatalog(catalog, policy), profileModel);
}
