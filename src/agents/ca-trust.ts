/**
 * The OS certificate store, passed on to what the CLI starts: agents and the
 * `npm install -g` that fetches one. The CLI trusts the store in its own
 * process (cli/system-ca.ts); a child has its own TLS stack and trusts only
 * what its runtime reads. Node 22.19+ and Bun 1.2.23+ read the store under
 * `NODE_USE_SYSTEM_CA=1`; older ones, and agents that build their own CA list
 * from Node's bundled roots, take the store's extra certificates through
 * `NODE_EXTRA_CA_CERTS`. Both add to the bundled roots and replace nothing.
 * `SSL_CERT_FILE` is left alone: on Linux it replaces Codex's store outright.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SYSTEM_CA_VAR, storeOnlyCertificates } from "../cli/system-ca.js";
import { configDir, writeFileAtomic } from "../fsutil.js";
import type { AgentAdapter } from "./types.js";

export const USE_SYSTEM_CA_VAR = "NODE_USE_SYSTEM_CA";
export const EXTRA_CA_VAR = "NODE_EXTRA_CA_CERTS";

/** Where the store's extra certificates are written for `NODE_EXTRA_CA_CERTS`. */
const storeBundlePath = (): string => join(configDir(), "system-ca.pem");

/**
 * Agents that read the OS store on their own, and so need nothing when run
 * directly: Claude Code (`CLAUDE_CODE_CERT_STORE` defaults to `bundled,system`),
 * Codex (native roots), OpenCode (built with `--use-system-ca`), the Copilot
 * CLI and app, and Hermes (truststore). Pi, Oh My Pi and Jouzu use their
 * runtime's bundled roots only.
 */
const READS_STORE_ITSELF = new Set([
  "claude",
  "codex",
  "opencode",
  "copilot",
  "copilot-app",
  "hermes",
]);

function hasVar(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): boolean {
  const key =
    platform === "win32"
      ? Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase())
      : name;
  return key !== undefined && env[key] !== undefined && env[key] !== "";
}

async function writeBundle(path: string, certs: readonly string[]): Promise<boolean> {
  const pem = `${certs.map((cert) => cert.trim()).join("\n")}\n`;
  try {
    if ((await readFile(path, "utf8").catch(() => "")) !== pem) {
      await writeFileAtomic(path, pem, { mode: 0o644 });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * `env` for a child the CLI starts, with the OS store trusted. A variable
 * the caller already set is theirs and stays as it is; `AIAND_SYSTEM_CA=0`
 * leaves `env` untouched.
 */
export async function withStoreTrust(
  env: NodeJS.ProcessEnv,
  opts: {
    platform?: NodeJS.Platform;
    certs?: readonly string[];
    bundlePath?: string;
  } = {},
): Promise<NodeJS.ProcessEnv> {
  const platform = opts.platform ?? process.platform;
  if (env[SYSTEM_CA_VAR] === "0") return env;
  const next = { ...env };
  if (!hasVar(env, USE_SYSTEM_CA_VAR, platform)) next[USE_SYSTEM_CA_VAR] = "1";
  if (!hasVar(env, EXTRA_CA_VAR, platform)) {
    const certs = opts.certs ?? storeOnlyCertificates({ env });
    const path = opts.bundlePath ?? storeBundlePath();
    if (certs.length > 0 && (await writeBundle(path, certs))) next[EXTRA_CA_VAR] = path;
  }
  return next;
}

/**
 * What `on` tells someone whose store holds certificates an agent run
 * directly would not trust: the setting that makes it trust them. Empty when
 * the agent reads the store itself or the store adds nothing.
 */
export function storeTrustNotes(
  adapter: Pick<AgentAdapter, "id" | "label" | "bin">,
  opts: { env?: NodeJS.ProcessEnv; certs?: readonly string[] } = {},
): string[] {
  const env = opts.env ?? process.env;
  if (READS_STORE_ITSELF.has(adapter.id) || env[SYSTEM_CA_VAR] === "0") return [];
  if (hasVar(env, USE_SYSTEM_CA_VAR, process.platform)) return [];
  const certs = opts.certs ?? storeOnlyCertificates({ env });
  if (certs.length === 0) return [];
  return [
    `${adapter.label} does not read this computer's certificate store by itself. \`aiand ${adapter.id}\` sets that up for each session; to run \`${adapter.bin}\` directly on a network that inspects HTTPS, set ${USE_SYSTEM_CA_VAR}=1 in your environment (or ${EXTRA_CA_VAR} to a PEM file holding the company root).`,
  ];
}
