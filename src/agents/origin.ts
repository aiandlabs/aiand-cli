import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseJsonResponse, publicRequest } from "../api/client.js";
import type { Model, ModelList } from "../api/models.js";
import { ApiError, CliError, SYNTHETIC_STATUS } from "../cli/errors.js";
import { configDir, type Profile, writeFileAtomic } from "../config.js";
import { PRIVATE_FILE_MODE } from "../fsutil.js";
import { HOUR_MS } from "../time.js";
import { keyFingerprint } from "./known-keys.js";

/**
 * Model-origin exclusion. Two sources, unioned: the profile's own
 * `exclude-origin` setting, and the org's policy, which the
 * gateway reports on an authenticated `GET /v1/models` as `policy`. The CLI
 * filters the catalog it hands to every adapter, so excluded models never
 * reach a slot, a default or a menu. The gateway is the guarantee; this is
 * what keeps the CLI from offering what the gateway would refuse.
 */

/** ISO 3166-1 alpha-2. */
const COUNTRY = /^[A-Z]{2}$/;
const CLEAR_WORDS = new Set(["none", "off", "-"]);
const ORG_POLICY_FILE = "org-origin-policy.json";
const ORG_POLICY_TTL_MS = 6 * HOUR_MS;

export type OriginPolicy = {
  /** Every excluded country, profile and org together, sorted. */
  exclude: string[];
  profile: string[];
  /** The org's list; null when the gateway has not said (old gateway, offline, no cache). */
  org: string[] | null;
};

export const NO_POLICY: OriginPolicy = { exclude: [], profile: [], org: null };

/** `CN`, `cn, us`, or `none` to clear; anything else is refused. */
export function parseOriginList(value: string): string[] {
  const trimmed = value.trim();
  if (CLEAR_WORDS.has(trimmed.toLowerCase())) return [];
  const codes = trimmed.split(/[\s,]+/).filter(Boolean);
  const bad = codes.filter((code) => !COUNTRY.test(code.toUpperCase()));
  if (codes.length === 0 || bad.length > 0) {
    throw new CliError(`"${value}" is not a list of country codes.`, {
      hint: "Use ISO 3166-1 alpha-2 codes, comma separated (for example: CN or CN,RU), or none to clear.",
    });
  }
  return [...new Set(codes.map((code) => code.toUpperCase()))].sort();
}

/** The profile's stored list, ignoring anything a hand edit made unreadable. */
export function profileOrigins(profile: Pick<Profile, "excludeOrigins">): string[] {
  const stored = profile.excludeOrigins;
  if (!Array.isArray(stored)) return [];
  return [
    ...new Set(stored.filter((code) => typeof code === "string" && COUNTRY.test(code))),
  ].sort();
}

export function makePolicy(profile: string[], org: string[] | null): OriginPolicy {
  return { exclude: [...new Set([...profile, ...(org ?? [])])].sort(), profile, org };
}

/**
 * Why a model is excluded, or null when it is allowed. A model with no
 * `origins` cannot be shown to be outside the policy, so under any policy
 * it is excluded: an older gateway fails closed rather than open.
 */
export function exclusionReason(
  model: Pick<Model, "origins"> | undefined,
  policy: OriginPolicy,
): string | null {
  if (policy.exclude.length === 0) return null;
  const origins = model?.origins;
  if (!Array.isArray(origins)) return "its origin is unknown";
  const hit = origins.filter((country) => policy.exclude.includes(country));
  return hit.length > 0 ? `origin ${hit.join(", ")}` : null;
}

/** "exclude-origin CN (profile) and CN, RU (org policy)". */
export function describePolicy(policy: OriginPolicy): string {
  const parts: string[] = [];
  if (policy.profile.length > 0) parts.push(`${policy.profile.join(", ")} (profile)`);
  if (policy.org?.length) parts.push(`${policy.org.join(", ")} (org policy)`);
  return `exclude-origin ${parts.join(" and ")}`;
}

/**
 * The allowed part of the catalog. Under a policy that leaves nothing, the
 * command fails here: no adapter may fall back to an excluded model.
 */
export function allowedCatalog(catalog: Model[], policy: OriginPolicy): Model[] {
  if (policy.exclude.length === 0) return catalog;
  const allowed = catalog.filter((model) => exclusionReason(model, policy) === null);
  if (allowed.length > 0) return allowed;
  const published = catalog.some((model) => Array.isArray(model.origins));
  throw new CliError(`No ai& model is allowed under ${describePolicy(policy)}.`, {
    hint: published
      ? "Every model in the catalog is excluded. Change the setting with `aiand config set exclude-origin`, or ask your org admin about the policy."
      : "This gateway does not publish model origins, so no model can be shown to be allowed. Nothing was changed.",
  });
}

/** Refuse an explicit model the policy excludes, naming why. */
export function assertModelAllowed(
  catalog: Model[],
  id: string,
  policy: OriginPolicy,
  flag = "--model",
): void {
  const reason = exclusionReason(
    catalog.find((model) => model.id === id),
    policy,
  );
  if (reason === null) return;
  throw new CliError(`${flag} "${id}" is excluded by ${describePolicy(policy)} (${reason}).`, {
    hint: "Pick another model (aiand models lists them), or change the setting with `aiand config set exclude-origin`.",
  });
}

/**
 * `auto` is chosen per request by the gateway, which knows the org's policy
 * but not this profile's setting. Under a profile exclusion the org policy
 * does not cover, `auto` could pick an excluded model, so it is refused.
 */
export function assertAutoAllowed(policy: OriginPolicy): void {
  const uncovered = policy.profile.filter((code) => !(policy.org ?? []).includes(code));
  if (uncovered.length === 0) return;
  throw new CliError(`--model auto can pick a model from ${uncovered.join(", ")}.`, {
    hint: `The gateway chooses for auto and only applies your org's policy, not this profile's ${describePolicy(policy)}. Name a model instead.`,
  });
}

/** The first allowed model the catalog ranks for `slot`, or undefined when it ranks none. */
export function recommendedFor(catalog: Model[], slot: "main" | "fast"): string | undefined {
  let best: { id: string; rank: number } | undefined;
  for (const model of catalog) {
    const rank = model.recommended?.[slot];
    if (typeof rank !== "number" || !Number.isFinite(rank)) continue;
    if (best === undefined || rank < best.rank) best = { id: model.id, rank };
  }
  return best?.id;
}

// --- The org policy, from an authenticated listing --------------------------

type PolicyCache = Record<string, { fetchedAt: number; exclude: string[] | null }>;

const policyPath = (): string => join(configDir(), ORG_POLICY_FILE);
/** One entry per gateway and key: a key names its org. Never the key itself. */
const cacheKey = (baseUrl: string, key: string): string =>
  `${baseUrl} ${keyFingerprint(key).slice(0, 32)}`;

async function readPolicyCache(): Promise<PolicyCache> {
  try {
    const parsed: unknown = JSON.parse(await readFile(policyPath(), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as PolicyCache)
      : {};
  } catch {
    return {};
  }
}

/** The org's list from a listing body: null when the gateway sent no policy. */
export function policyFromListing(body: Partial<ModelList> | null | undefined): string[] | null {
  const exclude = body?.policy?.exclude_origins;
  if (!Array.isArray(exclude)) return null;
  return [
    ...new Set(exclude.filter((code) => typeof code === "string" && COUNTRY.test(code))),
  ].sort();
}

export async function saveOrgPolicy(
  baseUrl: string,
  key: string,
  exclude: string[] | null,
): Promise<void> {
  const cache = await readPolicyCache();
  cache[cacheKey(baseUrl, key)] = { fetchedAt: Date.now(), exclude };
  await writeFileAtomic(policyPath(), `${JSON.stringify(cache, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
}

/** The cached org list for this gateway and key; `stale` reads past the TTL too. */
export async function cachedOrgPolicy(
  baseUrl: string,
  key: string,
  { stale = false } = {},
): Promise<string[] | null | undefined> {
  const entry = (await readPolicyCache())[cacheKey(baseUrl, key)];
  if (!entry || typeof entry.fetchedAt !== "number") return undefined;
  if (!stale && Date.now() - entry.fetchedAt >= ORG_POLICY_TTL_MS) return undefined;
  return Array.isArray(entry.exclude) ? entry.exclude : null;
}

/**
 * The org's list, from the gateway: a fresh cache, else one authenticated
 * listing. Offline, the last cached answer stands, and with none the org
 * policy is unknown (null): the gateway still enforces it on every request.
 */
export async function fetchOrgPolicy(baseUrl: string, key: string): Promise<string[] | null> {
  const fresh = await cachedOrgPolicy(baseUrl, key);
  if (fresh !== undefined) return fresh;
  let body: Partial<ModelList>;
  try {
    const response = await publicRequest(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      await response.arrayBuffer().catch(() => {});
      return (await cachedOrgPolicy(baseUrl, key, { stale: true })) ?? null;
    }
    body = await parseJsonResponse<Partial<ModelList>>(response);
  } catch (error) {
    if (error instanceof ApiError && error.status === SYNTHETIC_STATUS.UNREACHABLE) {
      return (await cachedOrgPolicy(baseUrl, key, { stale: true })) ?? null;
    }
    throw error;
  }
  const exclude = policyFromListing(body);
  await saveOrgPolicy(baseUrl, key, exclude);
  return exclude;
}

/** The profile's list and the org's, for this gateway and key. */
export async function resolvePolicy(
  profile: Pick<Profile, "excludeOrigins">,
  baseUrl: string,
  key: string,
): Promise<OriginPolicy> {
  return makePolicy(profileOrigins(profile), await fetchOrgPolicy(baseUrl, key));
}
