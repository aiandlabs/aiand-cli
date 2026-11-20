import type { Model } from "../api/models.js";

export type Verb = "on" | "off" | "status";

export type DetectResult = { installed: boolean; path: string | null };

export type ProbeResult = {
  active: boolean; // aiand routing live, ground truth from real files
  model: string | null;
};
export type EnableInput = {
  apiKey: string; // resolved session key, baked literal
  model: string; // resolved default or --model
  pinModel?: boolean; // --model was passed (not native): the adapter pins it where it keeps its model
  profileModel?: string; // the profile's default, for adapters with their own default order
  profileName: string; // the aiand profile, for adapters that ask aiand for the key themselves
  catalog: Model[]; // live /v1/models
  baseUrl: string; // API origin (api.json fetches)
};

export type EnableResult = {
  model: string; // the model now in effect, in the agent's own ref format
  catalogModel?: string; // its ai& catalog id, when it is one of ours
  filesWritten: string[];
  warnings?: string[];
};

export type DisableInput = {
  loggingOut?: string; // the aiand profile being logged out, when logout calls
  force?: boolean; // `off --force`: forget remote state aiand cannot reach (Open WebUI)
};

export type DisableResult = {
  stripped: boolean;
  notes?: string[];
  warnings?: string[];
};

/** Everything a one-process session launcher needs to build its injection. */
export type SessionLaunchInput = {
  apiKey: string; // resolved session key; launchers must not put it in the child env
  // (a throwaway file the agent reads itself is fine). The one exception:
  // Codex asks `aiand key export` for the key, so when it came from
  // AIAND_API_KEY the launcher hands that variable back.
  model: string | undefined; // --model, catalog-validated; undefined = adapter picks
  profileModel?: string; // the profile's default, for adapters that must bake a concrete model
  profileName: string; // the aiand profile, for adapters that ask aiand for the key themselves
  catalog: Model[]; // live /v1/models (adapters that build model maps)
  baseUrl?: string; // --base-url override; adapters fall back to their default
};

type SessionLaunch = {
  env: Record<string, string>; // added to child env
  args?: string[]; // extra CLI args before passthrough
  // Passthrough flags the adapter must own: user-supplied `--flag value`
  // and `--flag=value` forms of these are dropped so the launcher's
  // routing cannot be overridden. Everything else passes verbatim.
  stripPassthroughFlags?: string[];
  // Always run by the launcher after the child exits, success or failure:
  // remove throwaway overlays, close ephemeral servers. The launcher owns
  // this lifecycle because sessionLaunch is async — ephemeral servers can
  // bind before returning, so no pre-spawn hook is needed.
  cleanup?: () => Promise<void>;
};

/** What a config-only adapter with a browser front end hands `open`. */
export type OpenTarget = {
  url: string; // opened in the browser (printed instead under AIAND_NO_BROWSER)
  message?: string; // one line on what to do there
};

type OpenExtras = {
  env?: Record<string, string>;
  args?: string[];
};

/** Options for the pre-write guards. */
type GuardOptions = { force: boolean };

export type AgentAdapter = {
  id: string; // short: "opencode"
  label: string; // "OpenCode"
  bin: string; // PATH binary: "opencode"
  install: { command: string; url: string };
  aliases?: string[];
  detect(): DetectResult; // which/where probe
  managedFiles(): string[]; // absolute paths this adapter touches
  probe(): Promise<ProbeResult>; // read real config, no flags trusted
  enable(input: EnableInput): Promise<EnableResult>;
  enableGuard?(opts: GuardOptions): Promise<void>;
  // ^ Runs inside agentOn, before the snapshot + enable(). Adapters whose
  // target app holds config in memory refuse the write while the app is
  // running; --force (parsed by the command layer) escapes every guard.
  offGuard?(opts: GuardOptions): Promise<void>;
  // ^ Same refusal for `off`: the app rewrites its config file from memory on
  // exit, which would clobber the subtractive strip. Only adapters whose
  // target app holds the config in memory define one.
  shadowEnv?: string[]; // child-env names the launcher deletes for this agent
  // ^ Adapters that route outside the child env (an overlay file) list the
  // inherited names that would shadow or confuse that routing.
  allowUnpinnedModel?: boolean; // "--model native" skips catalog validation
  // ^ Adapters that read "native" as "leave the model unpinned" opt in;
  // every other adapter keeps the catalog-membership error for it.
  sessionLaunch?(input: SessionLaunchInput): Promise<SessionLaunch>;
  openExtras?(input: { args: string[]; profileModel?: string }): Promise<OpenExtras>;
  disable(input?: DisableInput): Promise<undefined | DisableResult>;
  // ^ Subtract marked aiand writes; never a snapshot rewind.
  refreshKey?(input: { apiKey: string; previousKey?: string }): Promise<boolean>;
  // ^ Swap ONLY the baked API-key literal in an already-active config, leaving
  // (with `previousKey`: only when that exact key is the one baked)
  // model ids and every unrelated key/byte untouched. Idempotent: a
  // config whose key already matches is a no-op. Resolves whether a marked
  // config was found (touched), so unmarked files stay silent. An adapter that
  // bakes a key but cannot swap it leaves this out, and rebake tells the user
  // to re-run `aiand <id> on`; one that bakes no key at all (Codex asks
  // `aiand key export`) defines it as `false` so rebake stays silent.
  snapshotRemote?(): Promise<object>;
  // ^ Adapters whose managed config is remote (no managedFiles) capture it
  // here before the first write. agentOn stores it in the snapshot manifest
  // under the same "first capture stays authoritative" rule as files. It
  // must hold no key literal: the snapshot is written to disk.
  remoteSnapshotCovers?(snapshot: object): Promise<boolean>;
  // ^ Whether an existing remote capture is of what `on` targets now (the
  // same Open WebUI instance); one that is not is replaced, as a file
  // snapshot of a moved config is.
  restore?(snapshot: object): Promise<string[]>;
  // ^ `restore --force` for a remote config: put back what snapshotRemote
  // captured. Resolves warnings to print.
  launcherOnly?: boolean; // adapters with session-only routing: on/off unsupported
  configOnly?: boolean; // adapters whose agent is a GUI app: open wires but never spawns
  openConfigured?(): Promise<OpenTarget>;
  // ^ Config-only adapters with a browser front end: what bare `aiand <id>`
  // opens once the config is wired. Without it, open prints the Copilot
  // app's pick-a-model advice.
  helpNotes?: string; // an extra paragraph for `aiand <id> --help`
  openLaunchesSession?: boolean; // bare `aiand <id>` runs one session (run-agent), never `on`
};
