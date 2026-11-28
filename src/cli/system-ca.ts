/**
 * Trust for the certificate authorities in the operating system's store.
 *
 * A company that inspects HTTPS installs its own root in the OS store (the
 * Windows Root store, the macOS System keychain, the Linux system bundle),
 * never in the Mozilla set Node bundles. Node reads the OS store only under
 * `--use-system-ca`, which a plain `node` launch does not pass, so the CLI adds
 * the store to this process itself before its first request. The relaunch
 * for a proxy keeps adding the flag; this covers every launch without one.
 */

import { existsSync } from "node:fs";
import * as tls from "node:tls";

/** Set to `0` to keep Node's own store only, for a site that wants exactly that. */
export const SYSTEM_CA_VAR = "AIAND_SYSTEM_CA";

/** The parts of `node:tls` this module calls; tests pass their own. */
export type CaApi = {
  getCACertificates?: (type?: "default" | "system" | "bundled" | "extra") => string[];
  setDefaultCACertificates?: (certs: ReadonlyArray<string>) => void;
};

export type SystemCaOutcome =
  /** `AIAND_SYSTEM_CA=0`: Node's store only. */
  | { state: "off" }
  /** Node already loads the store (`--use-system-ca` or `NODE_USE_SYSTEM_CA=1`). */
  | { state: "node" }
  /** This Node has no API to read the store; `NODE_EXTRA_CA_CERTS` still works. */
  | { state: "unsupported" }
  /** `added` is how many store certificates Node did not already trust. */
  | { state: "added"; added: number }
  | { state: "failed"; reason: string };

const pemKey = (pem: string): string => pem.replace(/\s+/g, "");

/**
 * Whether reading the store is worth it. On Linux, Node reads OpenSSL's
 * certificate directory and prints "Cannot open directory" to stderr on every
 * run where it is missing, as in a minimal container without ca-certificates,
 * which then has no company root to find either.
 */
export function storeExpected(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): boolean {
  if (platform !== "linux" || env.SSL_CERT_FILE) return true;
  return exists(env.SSL_CERT_DIR || "/etc/ssl/certs");
}

/** The certificates in `extra` that `base` does not already hold. */
export function missingFrom(base: readonly string[], extra: readonly string[]): string[] {
  const seen = new Set(base.map(pemKey));
  const out: string[] = [];
  for (const pem of extra) {
    const key = pemKey(pem);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pem);
  }
  return out;
}

export function nodeReadsSystemStore(env: NodeJS.ProcessEnv, execArgv: readonly string[]): boolean {
  const fromOptions = (env.NODE_OPTIONS ?? "").split(/\s+/).includes("--use-system-ca");
  return execArgv.includes("--use-system-ca") || fromOptions || env.NODE_USE_SYSTEM_CA === "1";
}

/**
 * Add the OS store to the CAs every later TLS connection in this process
 * (fetch included) trusts. It adds and never removes, so `NODE_EXTRA_CA_CERTS`
 * and the bundled set keep working beside it.
 */
export function trustSystemCertificates(
  opts: { env?: NodeJS.ProcessEnv; execArgv?: readonly string[]; api?: CaApi } = {},
): SystemCaOutcome {
  const env = opts.env ?? process.env;
  const api = opts.api ?? tls;
  if (env[SYSTEM_CA_VAR] === "0") return { state: "off" };
  if (nodeReadsSystemStore(env, opts.execArgv ?? process.execArgv)) return { state: "node" };
  if (
    typeof api.getCACertificates !== "function" ||
    typeof api.setDefaultCACertificates !== "function"
  ) {
    return { state: "unsupported" };
  }
  if (!storeExpected(env)) return { state: "added", added: 0 };
  try {
    const current = api.getCACertificates("default");
    const added = missingFrom(current, api.getCACertificates("system"));
    if (added.length > 0) api.setDefaultCACertificates([...current, ...added]);
    return { state: "added", added: added.length };
  } catch (error) {
    return { state: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

let applied: SystemCaOutcome | undefined;

/** {@link trustSystemCertificates} for this process, once. */
export function ensureSystemCertificates(): SystemCaOutcome {
  applied ??= trustSystemCertificates();
  return applied;
}

/**
 * The CAs in the OS store that Node's bundled set lacks: what an agent built
 * on its own bundled store would reject. Empty when the store holds nothing
 * extra, cannot be read, or `AIAND_SYSTEM_CA=0`.
 */
export function storeOnlyCertificates(
  opts: { env?: NodeJS.ProcessEnv; api?: CaApi } = {},
): string[] {
  const env = opts.env ?? process.env;
  const api = opts.api ?? tls;
  if (env[SYSTEM_CA_VAR] === "0" || typeof api.getCACertificates !== "function") return [];
  if (!storeExpected(env)) return [];
  try {
    return missingFrom(api.getCACertificates("bundled"), api.getCACertificates("system"));
  } catch {
    return [];
  }
}

/**
 * OpenSSL verification codes that mean the chain ends at a root nobody here
 * trusts, which is what HTTPS inspection with an unknown company root looks
 * like. A name mismatch or an expired certificate is a different problem.
 */
const UNTRUSTED_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_UNTRUSTED",
]);

/** The `type` of the ApiError a request fails with on an untrusted certificate. */
export const UNTRUSTED_CERTIFICATE = "untrusted_certificate";

/** Whether a fetch failure (or anything in its cause chain) is an untrusted certificate. */
export function isUntrustedCertificate(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && UNTRUSTED_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const CERTIFICATES_GUIDE_URL =
  "https://github.com/aiandlabs/aiand-cli/blob/main/docs/it-admin-certificates.md";

/** What to tell someone whose request hit an untrusted certificate. */
export function untrustedCertificateHint(
  outcome: SystemCaOutcome = ensureSystemCertificates(),
): string {
  const lead =
    "The server's certificate is not trusted. On a network that inspects HTTPS, the company's root certificate must be in this computer's certificate store.";
  const tail = `Ask your IT team to install it there, or set NODE_EXTRA_CA_CERTS to a PEM file holding it. See ${CERTIFICATES_GUIDE_URL}`;
  switch (outcome.state) {
    case "off":
      return `${lead} ${SYSTEM_CA_VAR}=0 is set, so aiand is not reading that store. ${tail}`;
    case "unsupported":
      return `${lead} This Node.js (${process.version}) cannot read that store: update to Node.js 22.21 or later. ${tail}`;
    case "failed":
      return `${lead} aiand could not read that store (${outcome.reason}). ${tail}`;
    default:
      return `${lead} That store was read, and it does not hold the root this certificate chains to. ${tail}`;
  }
}
