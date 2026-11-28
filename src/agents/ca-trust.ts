/**
 * The OS certificate store, passed on to what the CLI starts: agents and the
 * `npm install -g` that fetches one. The CLI trusts the store in its own
 * process (cli/system-ca.ts); a child has its own TLS stack and trusts only
 * what its runtime reads. An agent's own runtime may be older than the Node
 * the CLI needs (22.21): Node from 22.19 and Bun from 1.2.23 read the store
 * under `NODE_USE_SYSTEM_CA=1`, and any of them, along with agents that build
 * their own CA list from the bundled roots, take the store's extra
 * certificates through `NODE_EXTRA_CA_CERTS`. Both add to the bundled roots
 * and replace nothing. On Linux only the second is set: there
 * `NODE_USE_SYSTEM_CA` reads `SSL_CERT_FILE` / `SSL_CERT_DIR`, which a
 * project's environment can set, while the bundle comes from the
 * distribution's own file (cli/system-ca.ts). `SSL_CERT_FILE` itself is left
 * alone: on Linux it replaces Codex's store outright.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as tls from "node:tls";
import { PROXY_VARS } from "../cli/proxy.js";
import { isUntrustedCertificate, SYSTEM_CA_VAR, storeOnlyCertificates } from "../cli/system-ca.js";
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
const READS_STORE_ITSELF: ReadonlySet<string> = new Set([
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
 * leaves `env` untouched. `agent` names an agent that reads the store itself:
 * it gets no bundle file.
 */
export async function withStoreTrust(
  env: NodeJS.ProcessEnv,
  opts: {
    agent?: string;
    platform?: NodeJS.Platform;
    certs?: readonly string[];
    bundlePath?: string;
  } = {},
): Promise<NodeJS.ProcessEnv> {
  const platform = opts.platform ?? process.platform;
  if (env[SYSTEM_CA_VAR] === "0") return env;
  const next = { ...env };
  if (platform !== "linux" && !hasVar(env, USE_SYSTEM_CA_VAR, platform)) {
    next[USE_SYSTEM_CA_VAR] = "1";
  }
  if (opts.agent !== undefined && READS_STORE_ITSELF.has(opts.agent)) return next;
  if (!hasVar(env, EXTRA_CA_VAR, platform)) {
    const certs = opts.certs ?? storeOnlyCertificates({ env, platform });
    const path = opts.bundlePath ?? storeBundlePath();
    if (certs.length > 0 && (await writeBundle(path, certs))) next[EXTRA_CA_VAR] = path;
  }
  return next;
}

const PROBE_TIMEOUT_MS = 3000;

type Verdict = "trusted" | "untrusted" | "unknown";

/**
 * How `url`'s server's chain fares against `roots`: what an agent with only
 * those roots would see. The handshake verifies as usual and no request is
 * sent; the refusal's code says why. "unknown" for no answer or any other
 * TLS error.
 */
async function verdictFor(url: URL, roots: readonly string[]): Promise<Verdict> {
  const { promise, resolve } = Promise.withResolvers<Verdict>();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let socket: tls.TLSSocket;
  try {
    socket = tls.connect({
      host,
      port: Number(url.port || 443),
      ...(/^[\d.]+$|:/.test(host) ? {} : { servername: host }),
      ca: [...roots],
      timeout: PROBE_TIMEOUT_MS,
    });
  } catch {
    // A root Node cannot parse: no verdict.
    return "unknown";
  }
  const done = (answer: Verdict): void => {
    socket.destroy();
    resolve(answer);
  };
  socket.once("secureConnect", () => done("trusted"));
  socket.once("timeout", () => done("unknown"));
  socket.once("error", (error) => done(isUntrustedCertificate(error) ? "untrusted" : "unknown"));
  return promise;
}

/**
 * What `on` tells someone whose agent, run directly, would refuse the
 * gateway's certificate because the root it chains to is only in this
 * computer's store: the setting that fixes it. Nothing for an agent that
 * reads the store itself, nor for a store whose extra roots (Apple's, an MDM
 * profile's) the gateway connection does not use. Behind a proxy the check
 * cannot run directly, so the note says when it applies.
 */
export async function storeTrustNotes(
  adapter: Pick<AgentAdapter, "id" | "label" | "bin">,
  opts: {
    url: string;
    env?: NodeJS.ProcessEnv;
    certs?: readonly string[];
    /** The roots the agent trusts by itself; Node's bundled and extra sets by default. */
    roots?: readonly string[];
  },
): Promise<string[]> {
  const env = opts.env ?? process.env;
  if (READS_STORE_ITSELF.has(adapter.id) || env[SYSTEM_CA_VAR] === "0") return [];
  if (env[USE_SYSTEM_CA_VAR] === "1") return [];
  const url = new URL(opts.url);
  if (url.protocol !== "https:") return [];
  const certs = opts.certs ?? storeOnlyCertificates({ env });
  if (certs.length === 0) return [];
  const setting = `set ${USE_SYSTEM_CA_VAR}=1 in your environment (or ${EXTRA_CA_VAR} to a PEM file holding the company root)`;
  const direct = `\`aiand ${adapter.id}\` sets that up for each session; to run \`${adapter.bin}\` directly, ${setting}.`;
  if (PROXY_VARS.some((name) => hasVar(env, name, process.platform))) {
    return [
      `If your network inspects HTTPS with a company root, ${adapter.label} does not read this computer's certificate store by itself. ${direct}`,
    ];
  }
  const roots = opts.roots ?? [
    ...tls.getCACertificates("bundled"),
    ...tls.getCACertificates("extra"),
  ];
  // Only a refusal that the store's roots cure is one the setting fixes.
  if ((await verdictFor(url, roots)) !== "untrusted") return [];
  if ((await verdictFor(url, [...roots, ...certs])) !== "trusted") return [];
  return [
    `${adapter.label} would not trust the certificate ${url.origin} presents here: it chains to a root in this computer's certificate store, which ${adapter.label} does not read by itself. ${direct}`,
  ];
}
