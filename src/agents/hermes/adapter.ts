import type { Dirent } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentHome, DEFAULT_BASE_URL, trimSlash } from "../../config.js";
import { PRIVATE_FILE_MODE } from "../../fsutil.js";
import { resolveDefault } from "../catalog.js";
import { detectBinary } from "../detect.js";
import type { AgentAdapter, DetectResult, ProbeResult, SessionLaunchInput } from "../types.js";

const HERMES_ID = "hermes";
const HERMES_BIN = "hermes";

/**
 * The Hermes Agent commit the live matrix installs: the installer is
 * `curl ... | bash --commit <sha>`, so the pin is a commit, not a semver.
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const HERMES_COMMIT = "666f313d1d3abd8077291ba464cf0a10f1a6157f";

const HERMES_INSTALL = {
  command: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
  url: "https://hermes-agent.nousresearch.com/docs/",
};

/**
 * The Hermes Agent adapter (Nous Research, binary `hermes`, home
 * `~/.hermes`). Launcher-only: Hermes keeps its credentials in its own pool
 * and rewrites its own config, so aiand never writes persistent wiring.
 * Every routed session rides the throwaway HERMES_HOME overlay that
 * buildHermesOverlay() builds: user state (sessions, skills, memories, logs,
 * and the user's own plugins) is symlinked back so sessions stay native and
 * resumable, credentials exist only inside the overlay, and the real
 * `~/.hermes` is never written. Routing rides a dedicated `aiand` model
 * provider the overlay ships as a plugin, fed by the overlay `.env` — the
 * session key never touches the child environment.
 */

/** The overlay's own provider id, and the overlay .env names that feed it. */
const HERMES_PROVIDER_ID = "aiand";
const HERMES_PROVIDER_API_KEY_ENV = "AIAND_HERMES_API_KEY";
const HERMES_PROVIDER_BASE_URL_ENV = "AIAND_HERMES_BASE_URL";

/** Entries that never get linked back: Hermes's own credential pool. */
const CREDENTIAL_ENTRIES: Record<string, true> = { ".env": true, active_profile: true };
/** Windows directory symlinks need developer mode; copy state there instead. */
const CAN_LINK_DIRS = process.platform !== "win32";

/** Hermes's own home override, honoured as the real home the launcher overlays. */
const hermesHome = () => process.env.HERMES_HOME || join(agentHome(), ".hermes");

const isCredentialEntry = (name: string) =>
  CREDENTIAL_ENTRIES[name] === true || /auth|credential|token/i.test(name);

/**
 * Build the overlay home for one launch: the single builder sessionLaunch
 * uses, so a later persistent-`on` ticket can share it. Ordinary state
 * (sessions, skills, memories, logs) and the user's own plugins are
 * symlinked back to the real home; credential-shaped entries stay
 * overlay-only; the real config.yaml is copied, not linked, because the
 * overlay edits it; and the overlay's own `aiand` provider plugin plus its
 * config block and `.env` carry the routing. The caller (sessionLaunch's
 * cleanup) removes the overlay when the child exits.
 */
export async function buildHermesOverlay(
  realHome: string,
  routing: { apiKey: string; baseUrl: string; model: string | undefined },
): Promise<string> {
  const overlay = await mkdtemp(join(tmpdir(), "aiand-hermes-"));
  try {
    await linkRealHomeEntries(overlay, realHome);
    await writeOverlayEnv(overlay, realHome, routing);
    await writeOverlayProviderPlugin(overlay, routing);
    await writeOverlayConfig(overlay, routing);
    return overlay;
  } catch (error) {
    await rm(overlay, { recursive: true, force: true });
    throw error;
  }
}

/** Link state back into the overlay; credentials stay out, config is copied. */
async function linkRealHomeEntries(overlay: string, realHome: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(realHome, { withFileTypes: true });
  } catch {
    return; // No real home yet: a fresh install gets a fresh overlay.
  }
  for (const entry of entries) {
    if (isCredentialEntry(entry.name)) continue;
    // By NAME, not isFile(): a symlinked config.yaml reads as a link, and
    // linking it would let the overlay edit write through to the real home.
    if (entry.name === "config.yaml") {
      // Copied, not linked: the overlay edits it, the real one stays intact.
      await copyFile(join(realHome, entry.name), join(overlay, entry.name));
      continue;
    }
    if (entry.name === "plugins") {
      await linkUserPlugins(overlay, join(realHome, entry.name));
      continue;
    }
    await linkEntry(join(realHome, entry.name), join(overlay, entry.name), entry.isDirectory());
  }
}

/** One state entry, linked back; win32 copies directories (see CAN_LINK_DIRS). */
async function linkEntry(source: string, target: string, isDir: boolean): Promise<void> {
  if (isDir) {
    if (CAN_LINK_DIRS) await symlink(source, target, "dir");
    // ponytail: win32 dir-symlinks need developer mode, so state is
    // copied there; hermes itself runs on Unix, this is for stub runs.
    else await cp(source, target);
  } else {
    await symlink(source, target, "file");
  }
}

/**
 * User plugins link back one by one; only our own provider id stays
 * overlay-only — the overlay writes it fresh below, so a stale user file
 * under that id must never shadow this launch's routing.
 */
async function linkUserPlugins(overlay: string, source: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch {
    // Not a directory (a stray file named plugins): link it back whole.
    await linkEntry(source, join(overlay, "plugins"), false).catch(() => {});
    return;
  }
  const target = join(overlay, "plugins");
  let made = false;
  for (const entry of entries) {
    if (entry.name === "model-providers") continue; // handled below, minus our own id
    if (!made) {
      await mkdir(target, { recursive: true });
      made = true;
    }
    await linkEntry(join(source, entry.name), join(target, entry.name), entry.isDirectory());
  }
  let providerEntries: Dirent[];
  try {
    providerEntries = await readdir(join(source, "model-providers"), { withFileTypes: true });
  } catch {
    return; // No model-providers dir: nothing more to carry.
  }
  const kept = providerEntries.filter((entry) => entry.name !== HERMES_PROVIDER_ID);
  if (kept.length === 0) return;
  const providerTarget = join(target, "model-providers");
  await mkdir(providerTarget, { recursive: true });
  for (const entry of kept) {
    await linkEntry(
      join(source, "model-providers", entry.name),
      join(providerTarget, entry.name),
      entry.isDirectory(),
    );
  }
}

/** Recursive copy for the win32 path where symlinking a dir would throw. */
async function cp(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) await cp(from, to);
    // copyFile follows a symlink: the entry arrives as a plain file.
    else await copyFile(from, to);
  }
}

/**
 * The overlay .env carries the gateway routing. Hermes prefers its own
 * saved .env over process env vars, so this 0600 file is how the session
 * key reaches the child without ever riding its environment.
 */
async function writeOverlayEnv(
  overlay: string,
  realHome: string,
  { apiKey, baseUrl }: { apiKey: string; baseUrl: string },
): Promise<void> {
  // Ours are stripped from the carried-over lines first: a user's own
  // ANTHROPIC_* entries must never shadow the routing, whichever end of the
  // file their dotenv loader prefers — and a stale AIAND_HERMES_* pair (from
  // a hand-copied overlay, say) must never win over this launch's routing.
  const carried = (await readEnvLines(join(realHome, ".env"))).filter(
    (line) =>
      !/^\s*(?:export\s+)?(?:ANTHROPIC_(?:API_KEY|BASE_URL|TOKEN)|AIAND_HERMES_(?:API_KEY|BASE_URL))\s*=/.test(
        line,
      ),
  );
  const prefix = carried.length > 0 ? `${carried.join("\n")}\n` : "";
  // JSON.stringify quotes each value so a key with spaces or # stays one
  // dotenv entry.
  const content =
    `${prefix}${HERMES_PROVIDER_API_KEY_ENV}=${JSON.stringify(apiKey)}\n` +
    `${HERMES_PROVIDER_BASE_URL_ENV}=${JSON.stringify(baseUrl)}\n`;
  await writeFile(join(overlay, ".env"), content, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
}

/** Non-comment lines of a dotenv file, unchanged; a missing file reads empty. */
async function readEnvLines(path: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.trimStart().startsWith("#"));
}

/**
 * The overlay's own model provider: Hermes has no built-in ai& entry, so
 * the launcher ships one as a `model-provider` plugin under the overlay's
 * plugins tree. The profile drops the tool-role `name` before sending
 * (gateways that reject unnamed tool roles would fail the session
 * otherwise), reads its key and base URL from the overlay `.env` names, and
 * lists the pinned model as its fallback.
 */
async function writeOverlayProviderPlugin(
  overlay: string,
  { baseUrl, model }: { baseUrl: string; model: string | undefined },
): Promise<void> {
  const dir = join(overlay, "plugins", "model-providers", HERMES_PROVIDER_ID);
  await mkdir(dir, { recursive: true });
  const modelIds = model === undefined ? [] : [model];
  const modelValues = modelIds.map((id) => JSON.stringify(id)).join(", ");
  // A 1-tuple needs a trailing comma in Python.
  const pythonTuple = modelIds.length === 1 ? `${modelValues},` : modelValues;
  await writeFile(
    join(dir, "__init__.py"),
    `"""Ephemeral ai& provider generated by aiand."""

from providers import register_provider
from providers.base import ProviderProfile


class AiandProfile(ProviderProfile):
    def prepare_messages(self, messages):
        prepared = []
        for message in messages:
            item = dict(message)
            if item.get("role") == "tool":
                item.pop("name", None)
            prepared.append(item)


aiand = AiandProfile(
    name=${JSON.stringify(HERMES_PROVIDER_ID)},
    display_name="aiand",
    description="ai& gateway through aiand",
    api_mode="chat_completions",
    env_vars=(${JSON.stringify(HERMES_PROVIDER_API_KEY_ENV)}, ${JSON.stringify(HERMES_PROVIDER_BASE_URL_ENV)}),
    base_url=${JSON.stringify(baseUrl)},
    fallback_models=(${pythonTuple}),
    supports_vision=True,
)

register_provider(aiand)
`,
    "utf8",
  );
  await writeFile(
    join(dir, "plugin.yaml"),
    `name: ${HERMES_PROVIDER_ID}
kind: model-provider
version: 1.0.0
description: Ephemeral ai& provider generated by aiand
`,
    "utf8",
  );
}

/**
 * Overlay config.yaml: the providers.aiand block carries the gateway
 * connection (line surgery, no yaml dependency — same style as
 * pinHermesModel), then the top-level model: pin routes through it.
 */
async function writeOverlayConfig(
  overlay: string,
  { baseUrl, model }: { baseUrl: string; model: string | undefined },
): Promise<void> {
  const path = join(overlay, "config.yaml");
  const existing = await readFile(path, "utf8").catch(() => "");
  await writeFile(path, pinHermesModel(pinHermesProvider(existing, baseUrl, model), model), "utf8");
}

/**
 * Upsert the `providers.aiand` block of a hermes config: the connection
 * fields always, the model list only when a model is pinned (`native`
 * leaves the provider model-free, so Hermes's own default decides).
 * Hermes seeds no `providers:` key of its own, but a user one is rewritten
 * where it stands; other providers and unrelated keys stay put. `native`
 * is the only case with an empty model list — a pinned launch always names
 * exactly the routed model.
 */
export function pinHermesProvider(
  text: string,
  baseUrl: string,
  model: string | undefined,
): string {
  const entry = (indent: string) => [
    `${indent}aiand:`,
    `${indent}  name: aiand`,
    `${indent}  base_url: ${JSON.stringify(baseUrl)}`,
    `${indent}  key_env: ${HERMES_PROVIDER_API_KEY_ENV}`,
    `${indent}  transport: chat_completions`,
    ...(model === undefined
      ? []
      : [
          `${indent}  default_model: ${JSON.stringify(model)}`,
          `${indent}  models: ${JSON.stringify([model])}`,
        ]),
    `${indent}  discover_models: false`,
  ];
  const lines = text.split("\n");
  const at = lines.findIndex((line) => /^providers\s*:/.test(line));
  if (at === -1) {
    const gap = lines.length > 0 && lines[lines.length - 1]!.trim() !== "" ? [""] : [];
    return [...lines, ...gap, "providers:", ...entry("  ")].join("\n");
  }
  // The scalar form carries no body; a mapping's runs to the next column-0
  // line, blank lines included (then minus the trailing blank ones).
  const scalar = /^providers\s*:\s*\S/.test(lines[at]!);
  let end = at + 1;
  if (!scalar) {
    while (end < lines.length && (/^\s/.test(lines[end]!) || lines[end]!.trim() === "")) end += 1;
    while (end > at + 1 && lines[end - 1]!.trim() === "") end -= 1;
  }
  const body = scalar ? [] : lines.slice(at + 1, end);
  const indent = /^(\s+)\S/.exec(body.find((line) => /^\s+\S/.test(line)) ?? "")?.[1] ?? "  ";
  // Anchored to the section indent, so a deeper `aiand:` nested inside
  // another provider's own config can never match.
  const providerKey = new RegExp(`^${indent}aiand\\s*:`);
  const subAt = body.findIndex((line) => providerKey.test(line));
  if (subAt === -1)
    return [
      ...lines.slice(0, at),
      "providers:",
      ...body,
      ...entry(indent),
      ...lines.slice(end),
    ].join("\n");
  // The block's body runs while lines stay more indented than its own key.
  let subEnd = subAt + 1;
  while (
    subEnd < body.length &&
    (body[subEnd]!.trim() === "" || body[subEnd]!.startsWith(`${indent} `))
  )
    subEnd += 1;
  return [
    ...lines.slice(0, at),
    "providers:",
    ...body.slice(0, subAt),
    ...entry(indent),
    ...body.slice(subEnd),
    ...lines.slice(end),
  ].join("\n");
}

/**
 * Rewrite (or add) the top-level `model:` mapping of a hermes config:
 * `provider: aiand` always, the pinned model as `default` only when one
 * is given. Indentation follows the section's own keys; the body-less scalar
 * form (`model: ""`, a fresh install's sentinel) is replaced by the mapping.
 * Hermes accepts `model` as an alias for the model id — an alias or
 * `default` line is rewritten to `default`, the key we own.
 */
export function pinHermesModel(text: string, model: string | undefined): string {
  const lines = text.split("\n");
  const pinned = model === undefined ? null : `default: ${JSON.stringify(model)}`;
  const at = lines.findIndex((line) => /^model\s*:/.test(line));
  if (at === -1) {
    const block = ["model:", "  provider: aiand", ...(pinned ? [`  ${pinned}`] : [])];
    return [...block, ...lines].join("\n");
  }
  // The scalar form carries no body; a mapping's runs to the next column-0
  // line, blank lines included (then minus the trailing blank ones).
  const scalar = /^model\s*:\s*\S/.test(lines[at]!);
  let end = at + 1;
  if (!scalar) {
    while (end < lines.length && (/^\s/.test(lines[end]!) || lines[end]!.trim() === "")) end += 1;
    while (end > at + 1 && lines[end - 1]!.trim() === "") end -= 1;
  }
  const body = scalar ? [] : lines.slice(at + 1, end);
  const indent = /^(\s+)\S/.exec(body.find((line) => /^\s+\w/.test(line)) ?? "")?.[1] ?? "  ";
  const providerKey = new RegExp(`^${indent}provider\\s*:`);
  const modelKey = new RegExp(`^${indent}(?:"?default"?|model)\\s*:`);
  const out: string[] = [];
  let providerAt = -1;
  for (const line of body) {
    if (providerKey.test(line)) {
      out.push(`${indent}provider: aiand`);
      providerAt = out.length - 1;
    } else if (!(pinned !== null && modelKey.test(line))) {
      out.push(line); // dropped: rewritten after the provider line
    }
  }
  if (providerAt === -1) {
    out.unshift(`${indent}provider: aiand`);
    providerAt = 0;
  }
  if (pinned !== null) out.splice(providerAt + 1, 0, `${indent}${pinned}`);
  // The header becomes the bare `model:` key: a scalar value left standing
  // in front of the mapping would not parse.
  return [...lines.slice(0, at), "model:", ...out, ...lines.slice(end)].join("\n");
}

/** What the checkout's store shims held before a session: bytes or link target. */
type ShimSnapshot = {
  dir: string;
  entries: Record<string, { body?: Buffer; link?: string; mode: number }>;
};

/**
 * Locate hermes's store shims (checkout/.hermes/bin/hermes{,-acp}) from the
 * PATH binary: either the PATH entry is that directory already, or it is the
 * install's convenience shim `exec <root>/.hermes/bin/hermes "$@"`.
 */
async function shimDirFor(binPath: string | null): Promise<string | null> {
  if (binPath === null) return null;
  // The PATH entry may be the store shim itself, reached directly or through
  // a symlink: resolve it first, then check where it lives.
  const resolved = await realpath(binPath).catch(() => binPath);
  if (resolved.includes("/.hermes/bin/")) return dirname(resolved);
  // A convenience shim: `exec <checkout>/.hermes/bin/hermes "$@"`.
  let text: string;
  try {
    text = await readFile(resolved, "utf8");
  } catch {
    return null;
  }
  const exec = /^exec (\S+) "\$@"$/m.exec(text);
  const target = exec?.[1];
  return target?.includes("/.hermes/bin/") ? dirname(target) : null;
}

/**
 * Snapshot the store shims before a launch. Hermes self-relocates them to
 * whatever HERMES_HOME the session runs under, so an overlay launch rewrites
 * them to the overlay's tools path — which dies with cleanup, stranding the
 * user's own `hermes` binary. The cleanup restores these bytes. Best effort:
 * a PATH binary that reveals no checkout (a `.cmd` shim, an exotic install)
 * simply gets no snapshot. Concurrent launches race on the same shims;
 * the launcher assumes sessions run one at a time.
 */
async function snapshotShims(binPath: string | null): Promise<ShimSnapshot | null> {
  const dir = await shimDirFor(binPath);
  if (dir === null) return null;
  const entries: ShimSnapshot["entries"] = {};
  for (const name of await readdir(dir).catch(() => [])) {
    const path = join(dir, name);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        entries[name] = { link: await readlink(path), mode: info.mode & 0o777 };
      } else if (info.isFile()) {
        entries[name] = { body: await readFile(path), mode: info.mode & 0o777 };
      }
    } catch {
      // A racing hermes process touched it: leave that entry to hers.
    }
  }
  return { dir, entries };
}

/**
 * Whether a session-added entry points at the removed overlay: a symlink
 * into it, or a file whose bytes name it (a relocated shim script). Only
 * those are cleanup's to remove — anything else added mid-session (a user
 * drop, another installer) is legitimate and stays.
 */
async function pointsAtOverlay(path: string, overlay: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await readlink(path);
      return target === overlay || target.startsWith(`${overlay}/`);
    }
    if (info.isFile()) {
      const body = await readFile(path, "utf8").catch(() => null);
      return body?.includes(overlay) ?? false;
    }
    return false;
  } catch {
    return false; // Vanished mid-cleanup: nothing to remove.
  }
}

/** Put the shims back; delete only session additions that point at the removed overlay. */
async function restoreShims(snapshot: ShimSnapshot | null, overlay: string): Promise<void> {
  if (snapshot === null) return;
  for (const name of await readdir(snapshot.dir).catch(() => [])) {
    if (snapshot.entries[name] === undefined) {
      if (await pointsAtOverlay(join(snapshot.dir, name), overlay)) {
        await unlink(join(snapshot.dir, name)).catch(() => {});
      }
    }
  }
  for (const [name, entry] of Object.entries(snapshot.entries)) {
    const path = join(snapshot.dir, name);
    try {
      const info = await lstat(path);
      if (entry.link !== undefined) {
        const target = await readlink(path);
        if (info.isSymbolicLink() && target === entry.link) continue;
        await unlink(path);
        await symlink(entry.link, path);
        continue;
      }
      if (info.isFile() && entry.body !== undefined) {
        const current = await readFile(path);
        if (current.equals(entry.body)) continue;
      }
      await unlink(path);
    } catch {
      // Missing entry: fall through to the rewrite below.
    }
    if (entry.link !== undefined) {
      await symlink(entry.link, path).catch(() => {});
    } else if (entry.body !== undefined) {
      await writeFile(path, entry.body, { mode: entry.mode }).catch(() => {});
    }
  }
}

export const hermesAdapter: AgentAdapter = {
  id: HERMES_ID,
  label: "Hermes Agent",
  bin: HERMES_BIN,
  install: HERMES_INSTALL,
  aliases: ["hermes-agent"],
  launcherOnly: true,
  detect(): DetectResult {
    return detectBinary(HERMES_BIN);
  },
  managedFiles(): string[] {
    // Nothing is ever written: the launcher's overlay copies config.yaml and
    // never touches the real one, so there is no persistent managed file.
    return [];
  },
  async probe(): Promise<ProbeResult> {
    // Never active: launcher-only agents have no persistent aiand wiring.
    return { active: false, model: null };
  },
  async enable() {
    throw new Error("unreachable: agentOn refuses launcherOnly adapters");
  },
  async disable() {
    throw new Error("unreachable: agentOff refuses launcherOnly adapters");
  },
  async sessionLaunch(input: SessionLaunchInput) {
    // Works with no prior `on`: the routing lives in a throwaway HERMES_HOME
    // overlay, removed by cleanup when the child exits. Hermes reads its
    // key from the overlay .env, never the child env. `--model native`
    // arrives as the literal and leaves the model unpinned so Hermes's own
    // default wins; an explicit --model is pinned as-is; without one the
    // catalog default is pinned so a routed session never starts on a
    // provider the gateway key cannot reach.
    let model = input.model;
    if (model === "native") model = undefined;
    else if (model === undefined) model = resolveDefault(input.catalog, input.profileModel);
    const baseUrl = trimSlash(input.baseUrl ?? "") || DEFAULT_BASE_URL;
    // Snapshot before the child can self-relocate the store shims onto the
    // overlay path that cleanup is about to remove.
    const shims = await snapshotShims(detectBinary(HERMES_BIN).path);
    const overlay = await buildHermesOverlay(hermesHome(), {
      apiKey: input.apiKey,
      baseUrl,
      model,
    });
    // Mode is how the model was chosen: pinned (explicit or catalog
    // default) or native (Hermes's own default decides).
    if (process.env.AIAND_DEBUG === "1") {
      process.stderr.write(`[aiand hermes] mode: ${model === undefined ? "native" : "pinned"}\n`);
      process.stderr.write(`[aiand hermes] model: ${model ?? "(Hermes default)"}\n`);
      process.stderr.write(`[aiand hermes] base URL: ${baseUrl}\n`);
      process.stderr.write(`[aiand hermes] home overlay: ${overlay}\n`);
    }
    return {
      env: {
        HERMES_HOME: overlay,
        HERMES_INFERENCE_PROVIDER: HERMES_PROVIDER_ID,
        // Native names no model of ours: only the pinned launch sets the
        // model ids. HERMES_TUI_PROVIDER is deliberately absent — Hermes
        // does not honour it, so setting it would only mislead.
        ...(model === undefined ? {} : { HERMES_MODEL: model, HERMES_INFERENCE_MODEL: model }),
      },
      // The overlay pins provider and model; a user flag would override the
      // injected routing, so the launcher drops these from the passthrough
      // (both `--flag value` and `--flag=value`).
      args: ["--provider", HERMES_PROVIDER_ID, ...(model === undefined ? [] : ["--model", model])],
      stripPassthroughFlags: ["--provider", "--model", "-m"],
      cleanup: async () => {
        // Shims first: the user's `hermes` binary must never point at a
        // path cleanup is about to delete.
        await restoreShims(shims, overlay);
        await rm(overlay, { recursive: true, force: true });
      },
    };
  },
};
