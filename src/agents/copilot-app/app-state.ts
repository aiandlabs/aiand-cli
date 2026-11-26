// The app's own state beside its provider rows: the model new sessions
// start on (app_state), and whether its GitHub account has Copilot access
// (accounts). Both are undocumented and read from the live app (1.4.x).
import { queryCopilotSql, sqlString } from "./sqlite.js";

/**
 * The app_state key naming the model new sessions start on, as
 * `<provider row id>/<model id>`. The app writes it whenever the user picks
 * a model, and a new session opens on it; with none, or one naming a
 * provider that is gone, a new session opens on Copilot Fusion (GitHub's
 * own model routing), which never reaches ai&.
 */
const SELECTED_MODEL_KEY = "copilot-selected-model";

export const selectionFor = (providerId: string, model: string): string => `${providerId}/${model}`;
export const selectionModel = (value: string | null, providerId: string): string | null =>
  value?.startsWith(`${providerId}/`) ? value.slice(providerId.length + 1) : null;

export async function hasAppState(dbPath: string): Promise<boolean> {
  const rows = await queryCopilotSql(
    dbPath,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_state';",
  );
  return rows.length === 1;
}

export async function readSelectedModel(dbPath: string): Promise<string | null> {
  const rows = await queryCopilotSql(
    dbPath,
    `SELECT value FROM app_state WHERE key = ${sqlString(SELECTED_MODEL_KEY)};`,
  );
  const value = rows[0]?.value;
  return typeof value === "string" ? value : null;
}

export function setSelectedModelSql(value: string): string {
  return `INSERT INTO app_state (key, value, updated_at) VALUES (${sqlString(SELECTED_MODEL_KEY)}, ${sqlString(value)}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`;
}

const COPILOT_FREE_URL = "https://github.com/settings/copilot";

/**
 * Whether the GitHub accounts signed in to the app can start a session.
 * The app needs Copilot access (Copilot Free or a seat) even when every
 * request goes to a BYOK provider such as ai&: without it, it stops at a
 * subscription screen and refuses to start sessions. The app caches
 * `/copilot_internal/user`'s `copilot_app_enabled` per account as
 * `copilotAppEnabled` in accounts.settings_json, refreshed when it runs.
 * It can hold several accounts and picks one per project, so every
 * account counts, not just the default. Only login and settings_json are
 * read; never the token columns.
 */
type CopilotAccess =
  | { state: "enabled" }
  | { state: "none"; logins: string[] }
  | { state: "partial"; logins: string[] }
  | { state: "signed-out" }
  | { state: "unknown" };

const ACCOUNT_COLUMNS = ["login", "kind", "settings_json"];
/** The account kinds the app signs in with (github.com and GitHub Enterprise Server). */
const ACCOUNT_KINDS = "('github', 'github_enterprise_server')";

/** One account's cached access: true, false, or undefined when it cannot tell. */
function accountAccess(settingsJson: unknown): boolean | undefined {
  try {
    const value = (JSON.parse(String(settingsJson ?? "{}")) as Record<string, unknown>)
      .copilotAppEnabled;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function copilotAccess(dbPath: string): Promise<CopilotAccess> {
  try {
    const columns = await queryCopilotSql(
      dbPath,
      "SELECT name FROM pragma_table_info('accounts');",
    );
    const names = new Set(columns.map((row) => String(row.name)));
    if (!ACCOUNT_COLUMNS.every((name) => names.has(name))) return { state: "unknown" };
    const accounts = await queryCopilotSql(
      dbPath,
      `SELECT login, settings_json FROM accounts WHERE kind IN ${ACCOUNT_KINDS} ORDER BY rowid;`,
    );
    if (accounts.length === 0) return { state: "signed-out" };
    const access = accounts.map((row) => ({
      login: String(row.login),
      enabled: accountAccess(row.settings_json),
    }));
    const without = access.filter((a) => a.enabled === false).map((a) => a.login);
    if (without.length === 0) {
      return access.some((a) => a.enabled === true) ? { state: "enabled" } : { state: "unknown" };
    }
    return without.length === access.length
      ? { state: "none", logins: without }
      : { state: "partial", logins: without };
  } catch {
    // Access is advice, never a reason for on or status to fail.
    return { state: "unknown" };
  }
}

const GET_ACCESS = `Turn on Copilot Free (${COPILOT_FREE_URL}) or get a Copilot seat, then reopen the app.`;
const PER_PROJECT =
  "The app picks an account for each project, and a project that uses one of them will not start a session, even on ai&.";

/** What `on` says about Copilot access; always something unless access is confirmed. */
export function accessWarningOnEnable(access: CopilotAccess): string | undefined {
  switch (access.state) {
    case "enabled":
      return undefined;
    case "none":
      return access.logins.length === 1
        ? `The GitHub account signed in to the app (${access.logins[0]}) has no Copilot access, so the app will not start a session, even on ai&. ${GET_ACCESS}`
        : `None of the GitHub accounts signed in to the app (${access.logins.join(", ")}) has Copilot access, so the app will not start a session, even on ai&. ${GET_ACCESS}`;
    case "partial":
      return `Some GitHub accounts signed in to the app (${access.logins.join(", ")}) have no Copilot access. ${PER_PROJECT} ${GET_ACCESS}`;
    case "signed-out":
      return "Sign in to the app with a GitHub account that has Copilot access; Copilot Free is enough. The app will not start a session without it, even on ai&.";
    case "unknown":
      return "The app needs Copilot access on its GitHub account, even though every request goes to ai&. Copilot Free is enough.";
  }
}

/** What `status` says: only a known problem, never the general reminder. */
export function accessWarningOnStatus(access: CopilotAccess): string | undefined {
  switch (access.state) {
    case "none":
      return access.logins.length === 1
        ? `When the app last checked, its GitHub account (${access.logins[0]}) had no Copilot access, so it will not start a session, even on ai&. ${GET_ACCESS}`
        : `When the app last checked, none of its GitHub accounts (${access.logins.join(", ")}) had Copilot access, so it will not start a session, even on ai&. ${GET_ACCESS}`;
    case "partial":
      return `When the app last checked, some of its GitHub accounts (${access.logins.join(", ")}) had no Copilot access. ${PER_PROJECT} ${GET_ACCESS}`;
    case "signed-out":
      return "No GitHub account is signed in to the app. It needs one with Copilot access to start a session, even on ai&; Copilot Free is enough.";
    default:
      return undefined;
  }
}

/**
 * The app_state change that hands the selected model back: only while it
 * still names one of our rows (`ids`, which may already be gone from the
 * app). The pick `on` replaced comes back; with none recorded, the key goes
 * and the app falls back to its own default. A pick the user made since is
 * theirs: it stays, and the note says so.
 */
export async function restoreSelection(
  dbPath: string,
  ids: string[],
  previous: string | null | undefined,
): Promise<{ sql: string[]; note?: string }> {
  if (!(await hasAppState(dbPath))) return { sql: [] };
  const current = await readSelectedModel(dbPath);
  if (ids.some((id) => selectionModel(current, id) !== null)) {
    return {
      sql: [
        typeof previous === "string"
          ? setSelectedModelSql(previous)
          : `DELETE FROM app_state WHERE key = ${sqlString(SELECTED_MODEL_KEY)};`,
      ],
    };
  }
  // Only a selection `on` wrote (a recorded previous) can have been changed since.
  if (previous === undefined || current === null || current === previous) return { sql: [] };
  return {
    sql: [],
    note: `left the app's selected model (${current}) because you picked it after aiand copilot-app on`,
  };
}
