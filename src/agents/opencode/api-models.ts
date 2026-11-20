import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { publicJson } from "../../api/client.js";
import { CliError } from "../../cli/errors.js";
import { err } from "../../cli/output.js";
import { configDir, trimSlash, writeFileAtomic } from "../../config.js";
import { PRIVATE_FILE_MODE } from "../../fsutil.js";
import { CATALOG_TTL_MS } from "../catalog.js";

/**
 * One model entry inside `provider.aiand.models`: taken verbatim from
 * `/v1/api.json` for `on` (it carries a real `limit.output`), derived from the
 * Model[] catalog for session launches.
 */
export type OpencodeModelEntry = Record<string, unknown>;

/** Last-good `/v1/api.json` model map, so `on` survives an unreachable gateway. */
const OPENCODE_API_CACHE_FILE = "opencode-api.json";

type ApiJsonCache = {
  fetchedAt: number;
  baseUrl: string;
  models: Record<string, OpencodeModelEntry>;
};

/**
 * Live api.json carries the canonical OpenCode model map (with real
 * limit.output) — take it verbatim so the picker matches the gateway. The
 * fetched map is cached per base URL; a failed fetch falls back to the last
 * good map instead of failing `on` outright (offline machine, fixture env).
 * A response without a models map, or with an empty one, counts as a failed
 * fetch, so it can never replace the last good map with an empty one.
 */
export async function getApiModels(baseUrl: string): Promise<Record<string, OpencodeModelEntry>> {
  const cachePath = join(configDir(), OPENCODE_API_CACHE_FILE);
  const trimmedBase = trimSlash(baseUrl);
  try {
    const api = await publicJson<{ opencode?: { models?: unknown } }>(`${trimmedBase}/v1/api.json`);
    const models = api?.opencode?.models;
    if (
      !models ||
      typeof models !== "object" ||
      Array.isArray(models) ||
      Object.keys(models).length === 0
    ) {
      throw new CliError(`${trimmedBase}/v1/api.json carried no OpenCode model map.`);
    }
    await writeFileAtomic(
      cachePath,
      `${JSON.stringify({ fetchedAt: Date.now(), baseUrl: trimmedBase, models }, null, 2)}\n`,
      { mode: PRIVATE_FILE_MODE },
    );
    return models as Record<string, OpencodeModelEntry>;
  } catch (error) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as Partial<ApiJsonCache>;
      if (
        cached?.baseUrl === trimmedBase &&
        cached.models &&
        typeof cached.models === "object" &&
        typeof cached.fetchedAt === "number" &&
        Date.now() - cached.fetchedAt < CATALOG_TTL_MS
      ) {
        err("OpenCode model map unreachable; using the last cached map.");
        return cached.models as Record<string, OpencodeModelEntry>;
      }
    } catch {
      // No usable cache — fall through to the original fetch error.
    }
    throw error;
  }
}
