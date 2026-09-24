import { hostname } from "node:os";
import { type RebakeNote, rebakeAgentKeys } from "../agents/rebake.js";
import { type AccountOrg, getUser, listOrgs, validateKey } from "../api/account.js";
import { openSession, type Session } from "../api/client.js";
import {
  type DeviceCodeResponse,
  pollForToken,
  startDeviceAuthorization,
  type TokenResponse,
  verificationUrl,
} from "../api/device.js";
import { openBrowser } from "../cli/browser.js";
import { ApiError, CliError, EXIT, loginCancelled, SYNTHETIC_STATUS } from "../cli/errors.js";
import { link } from "../cli/links.js";
import { err, fields, out, spinner, style } from "../cli/output.js";
import { confirm, isInteractive, readSecret } from "../cli/prompt.js";
import { type PromptInput, type PromptOutput, promptSelect } from "../cli/select.js";
import { readStdin } from "../cli/stdin.js";
import {
  CREDENTIAL_ORIGIN,
  loadConfig,
  maskKey,
  type ResolvedProfile,
  resolveProfile,
  saveConfig,
  saveCredential,
  updateProfile,
} from "../config.js";
import { nowSeconds } from "../time.js";
import { type BrowserFlowResult, signInViaLocalhostCallback } from "./browser.js";
import { CREDENTIAL_SOURCE, storageLabel } from "./identity.js";

function printRebakeNotes(notes: RebakeNote[]): void {
  for (const note of notes) {
    err(style.dim(`[${note.agent}] ${note.note}`));
  }
}

/** Server-side name for a key minted on this machine. */
const defaultKeyName = (): string => `aiand@${hostname() || "cli"}`;

/** Promote a freshly-signed-in profile to the active one when it is not. */
async function activateProfile(name: string): Promise<void> {
  await updateProfile(name, {});
  if (loadConfig().profile !== name) {
    await saveConfig({ ...loadConfig(), profile: name });
  }
}

export type DeviceLoginOptions = {
  profile?: string;
  json?: boolean;
  /** Internal test seam: prompt streams for the multi-org picker. */
  input?: PromptInput;
  output?: PromptOutput;
  /** Internal: display name for the minted key; defaults to aiand@<hostname>. */
  keyName?: string;
  /** Internal test seam: opener injected into the browser sign-in. */
  open?: (url: string) => Promise<boolean>;
  /** Internal test seam: browser callback wait cap (default 5 minutes). */
  timeoutMs?: number;
  /** Internal test seam: the wait between device-token polls. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** Mint an org-scoped API key via a browser device-code approval, persist the
 * credential, promote the profile, and rebake the key into active agents. */
export async function deviceLogin(opts: DeviceLoginOptions = {}): Promise<void> {
  const profile = resolveProfile(opts.profile);

  const keyName = opts.keyName ?? defaultKeyName();
  let deviceStart: DeviceCodeResponse;
  try {
    deviceStart = await startDeviceAuthorization(profile.authUrl, {
      keyName,
    });
  } catch (error) {
    return degradeToPaste(error, opts, "starting the device sign-in");
  }
  const url = verificationUrl(profile.authUrl, deviceStart);

  // --json stdout carries only the final JSON blob (completeSignIn below);
  // the code/URL a human follows go to stderr, like browserLogin's status.
  const show = opts.json ? err : out;
  show();
  show(`  ${style.dim("Your code ")}  ${style.bold(style.cyan(deviceStart.user_code))}`);
  show(`  ${style.dim("Approve at")}  ${link(url)}`);
  show();
  if (!(await openBrowser(url)))
    err(style.dim("Could not open a browser -- open the URL above to continue."));

  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);

  const spin = spinner("Waiting for approval in the browser...");
  let tokens: TokenResponse;
  try {
    tokens = await pollForToken(profile.authUrl, deviceStart, {
      signal: controller.signal,
      sleep: opts.sleep,
      onSlowDown: (interval) =>
        err(style.dim(`Server asked us to back off; polling every ${interval}s.`)),
    });
  } catch (error) {
    return degradeToPaste(error, opts, "waiting for the approval");
  } finally {
    spin.stop();
    process.removeListener("SIGINT", onInterrupt);
  }

  await completeSignIn(profile, tokens, opts);
}

/**
 * Device-to-paste fallback: when the device service can't be reached, an
 * interactive terminal may fall through to pasting a key instead of
 * dead-ending the sign-in. Non-interactive runs (CI, pipes) keep the original
 * error — paste needs a prompt. User-driven outcomes (deny, Ctrl-C, poll
 * expiry) stay fatal so cancellation remains cancellation.
 */
async function degradeToPaste(
  error: unknown,
  opts: DeviceLoginOptions,
  doing: string,
): Promise<void> {
  // Ctrl-C (130), an explicit deny (3), and poll expiry (also 3) stay fatal.
  // Only network (status 0) and 5xx may fall through to pasting a key.
  if (
    error instanceof CliError &&
    (error.exitCode === EXIT.INTERRUPTED || error.exitCode === EXIT.LOGIN_DENIED)
  )
    throw error;
  const recoverable =
    error instanceof ApiError &&
    (error.status === SYNTHETIC_STATUS.UNREACHABLE || error.status >= 500);
  if (!recoverable || !isInteractive() || opts.json) throw error;
  err(
    style.yellow(
      `Device sign-in failed while ${doing} (${(error as Error).message}) — paste a key instead.`,
    ),
  );
  const ok = await confirm("Paste a key instead?", {
    default: false,
    input: opts.input,
    output: opts.output,
  });
  if (!ok) throw error;
  return pasteLogin({ ...opts, interactive: true });
}

/** Default interactive sign-in: browser authorization-code + PKCE with a
 * device-code fallback when the server or terminal cannot do the browser
 * half. Minted keys keep origin "device" either way. */
export async function browserLogin(opts: DeviceLoginOptions = {}): Promise<void> {
  const profile = resolveProfile(opts.profile);
  const keyName = opts.keyName ?? defaultKeyName();

  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  let result: BrowserFlowResult;
  try {
    result = await signInViaLocalhostCallback({
      authUrl: profile.authUrl,
      keyName,
      open: opts.open,
      timeoutMs: opts.timeoutMs,
      signal: controller.signal,
      onStatus: (line) => err(style.dim(line)),
    });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
  if (!result.ok) {
    // Ctrl-C after a successful callback still completes the sign-in; only a
    // failed wait is a cancellation.
    if (controller.signal.aborted) throw loginCancelled();
    if (result.fatal) throw new CliError(result.failure, { exitCode: EXIT.LOGIN_DENIED });
    if (!result.unsupported) {
      err(
        style.dim(
          `Browser sign-in didn't complete (${result.failure}) — continuing with a device code.`,
        ),
      );
    }
    return deviceLogin({ ...opts, keyName });
  }
  await completeSignIn(profile, result.tokens, opts);
}

async function pickOrg(
  orgs: AccountOrg[],
  opts: { json?: boolean; input?: PromptInput; output?: PromptOutput },
): Promise<AccountOrg | null> {
  if (orgs.length === 1) return orgs[0]!;
  if (orgs.length === 0) return null;
  if (!opts.json && isInteractive()) {
    const picked = await promptSelect({
      message: "Which organization should this machine use?",
      choices: orgs.map((o) => ({ value: o.id, label: o.name })),
      input: opts.input,
      output: opts.output,
    });
    if (picked === null) throw loginCancelled();
    return orgs.find((o) => o.id === picked) ?? orgs[0]!;
  }
  err(style.dim(`This account has multiple organizations; using ${orgs[0]!.name}.`));
  return orgs[0]!;
}

async function completeSignIn(
  profile: ResolvedProfile,
  tokens: TokenResponse,
  opts: { json?: boolean; input?: PromptInput; output?: PromptOutput },
): Promise<void> {
  // Identity and org resolve before the first save, so cancelling at the
  // picker (exit 130) leaves no credential behind. The pending session carries
  // no refresh_token, which would otherwise rotate and save before pickOrg,
  // and a non-null credential keeps a 401 from reading as a bad env key.
  const pending: Session = {
    profile,
    token: tokens.access_token,
    credential: { access_token: tokens.access_token, origin: CREDENTIAL_ORIGIN.DEVICE },
  };
  const [user, orgs] = await Promise.all([getUser(pending), listOrgs(pending)]);
  const org = tokens.org ?? (await pickOrg(orgs, opts));

  await saveCredential(profile.name, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: nowSeconds() + tokens.expires_in,
    origin: CREDENTIAL_ORIGIN.DEVICE,
    user,
    ...(org ? { org } : {}),
  });

  await activateProfile(profile.name);

  const session = await openSession(resolveProfile(profile.name));

  const notes = await rebakeAgentKeys(session.token);
  printRebakeNotes(notes);

  if (opts.json) {
    return out(
      JSON.stringify(
        {
          profile: profile.name,
          user,
          org: org ?? null,
          key: maskKey(session.token),
        },
        null,
        2,
      ),
    );
  }

  out(style.green("Signed in."));
  out();
  fields([
    ["email", user.email || style.dim("unknown")],
    ["org", org ? `${org.name} ${style.dim(`(${org.id})`)}` : style.dim("none")],
    ["profile", profile.name],
    ["key", style.dim(maskKey(session.token))],
  ]);
}

export type PasteLoginOptions = {
  profile?: string;
  /** Key supplied programmatically (tests, internal callers). */
  key?: string;
  /** `--with-token`: read the key from stdin. */
  fromStdin?: boolean;
  /** `--paste`: prompt interactively (masked input). */
  interactive?: boolean;
  json?: boolean;
  /** Internal test seam: prompt streams for the masked paste prompt. */
  input?: PromptInput;
  output?: PromptOutput;
};

function readPastedKey(opts: PasteLoginOptions): Promise<string> {
  if (opts.interactive) {
    return readPastedKeyInteractive(opts);
  }
  if (opts.key !== undefined) {
    if (!/^sk-/.test(opts.key)) {
      throw new CliError('Keys start with "sk-".', {
        hint: "Check the key and try again.",
      });
    }
    return Promise.resolve(opts.key);
  }
  if (opts.fromStdin) {
    return readPastedKeyStdin();
  }
  throw new CliError("No key source given for paste login.");
}

async function readPastedKeyInteractive(
  opts: Pick<PasteLoginOptions, "input" | "output">,
): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const key = await readSecret("Paste your ai& API key (sk-…): ", {
      input: opts.input,
      output: opts.output,
    });
    if (!/^sk-/.test(key)) {
      err(style.red(`Keys start with "sk-" (attempt ${attempt} of 3).`));
      continue;
    }
    return key;
  }

  throw new CliError("Three invalid keys in a row — giving up.");
}

async function readPastedKeyStdin(): Promise<string> {
  const piped = await readStdin();
  if (piped === null) {
    throw new CliError("Pipe the key: aiand login --with-token < key.txt");
  }
  const [firstLine = "", ...rest] = piped.split(/\r?\n/);
  if (rest.some((line) => line.trim() !== "")) {
    throw new CliError("Pipe a single-line key.", {
      hint: "aiand login --with-token < key.txt",
    });
  }
  const key = firstLine.trim();
  if (!/^sk-/.test(key)) {
    throw new CliError('Keys start with "sk-".', {
      hint: "Check the key and try again.",
    });
  }
  return key;
}

/** Validate an existing key against the API (401 → rejected), store it as a
 * pasted credential, promote the profile, and rebake active agents. */
export async function pasteLogin(opts: PasteLoginOptions = {}): Promise<void> {
  const profile = resolveProfile(opts.profile);

  const key = await readPastedKey(opts);
  const user = await validateKey(key, profile.authUrl);
  // Multi-org accounts pick an org as in completeSignIn, before the save, so
  // cancelling the picker leaves no credential behind.
  const pending: Session = {
    profile,
    token: key,
    credential: { access_token: key, origin: CREDENTIAL_ORIGIN.PASTE },
  };
  const orgs = await listOrgs(pending);
  const org = await pickOrg(orgs, opts);
  const storage = await saveCredential(profile.name, {
    access_token: key,
    origin: CREDENTIAL_ORIGIN.PASTE,
    user,
    ...(org ? { org } : {}),
  });

  await activateProfile(profile.name);
  printRebakeNotes(await rebakeAgentKeys(key));

  if (opts.json) {
    return out(
      JSON.stringify({ profile: profile.name, source: CREDENTIAL_SOURCE.PASTED, storage }, null, 2),
    );
  }

  out(style.green("Signed in with a pasted key."));
  out();
  fields([
    ["email", user.email || style.dim("unknown")],
    ["profile", profile.name],
    ["source", "pasted key"],
    ["storage", storageLabel(storage)],
  ]);
}
