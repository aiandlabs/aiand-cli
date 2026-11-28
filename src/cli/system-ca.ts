/**
 * Trust for the certificate authorities in the operating system's store.
 *
 * A company that inspects HTTPS installs its own root in the OS store (the
 * Windows Root store, the macOS System keychain, the Linux system bundle),
 * never in the Mozilla set Node bundles. Node reads the OS store only under
 * `--use-system-ca`, which a plain `node` launch does not pass, so the CLI adds
 * the store to this process itself before its first request, with the tls
 * API every Node the CLI runs on (22.21 or later) has. The relaunch for a
 * proxy keeps adding the flag; this covers every launch without one.
 *
 * {@link ensureSystemCertificates} is the one call for code that makes a
 * request outside `fetchOrFail`; it is cheap after the first time.
 */

import * as fs from "node:fs";
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
 * The distribution CA bundles, in the order Go's crypto/x509 tries them; the
 * first that exists is the store. On Linux the CLI reads these itself rather
 * than through Node, because Node's system read follows `SSL_CERT_FILE` and
 * `SSL_CERT_DIR`, and a variable a project's environment sets must not choose
 * the roots a request carrying the key trusts. They are root-owned paths
 * that only `update-ca-certificates` / `update-ca-trust` change.
 */
export const LINUX_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/pki/tls/cacert.pem",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
  "/etc/ssl/cert.pem",
] as const;

/** Where the store is read from; tests pass their own. */
export type StoreSource = {
  platform?: NodeJS.Platform;
  /** A file's text, or null when it does not exist. */
  readFile?: (path: string) => string | null;
};

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

function readIfPresent(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The OS store's certificates, as PEM. */
function systemCertificates(api: CaApi, source: StoreSource): string[] {
  if ((source.platform ?? process.platform) !== "linux") {
    return api.getCACertificates?.("system") ?? [];
  }
  const read = source.readFile ?? readIfPresent;
  for (const path of LINUX_BUNDLES) {
    const text = read(path);
    if (text !== null) return (text.match(PEM_BLOCK) ?? []).map((pem) => `${pem}\n`);
  }
  return [];
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
  opts: { env?: NodeJS.ProcessEnv; execArgv?: readonly string[]; api?: CaApi } & StoreSource = {},
): SystemCaOutcome {
  const env = opts.env ?? process.env;
  const api = opts.api ?? tls;
  if (env[SYSTEM_CA_VAR] === "0") return { state: "off" };
  // Node's own read on Linux follows SSL_CERT_FILE / SSL_CERT_DIR and can miss
  // the distribution bundle, so Linux merges the bundle in regardless.
  const linux = (opts.platform ?? process.platform) === "linux";
  if (!linux && nodeReadsSystemStore(env, opts.execArgv ?? process.execArgv)) {
    return { state: "node" };
  }
  if (
    typeof api.getCACertificates !== "function" ||
    typeof api.setDefaultCACertificates !== "function"
  ) {
    return { state: "unsupported" };
  }
  try {
    const current = api.getCACertificates("default");
    const added = missingFrom(current, systemCertificates(api, opts));
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
  opts: { env?: NodeJS.ProcessEnv; api?: CaApi } & StoreSource = {},
): string[] {
  const env = opts.env ?? process.env;
  const api = opts.api ?? tls;
  if (env[SYSTEM_CA_VAR] === "0" || typeof api.getCACertificates !== "function") return [];
  try {
    return missingFrom(api.getCACertificates("bundled"), systemCertificates(api, opts));
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
