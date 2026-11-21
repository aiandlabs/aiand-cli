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
 * Whether the GitHub account the app is signed in to can start a session.
 * The app needs Copilot access (Copilot Free or a seat) even when every
 * request goes to a BYOK provider such as ai&: without it, it stops at a
 * subscription screen and refuses to start sessions. The app caches
 * `/copilot_internal/user`'s `copilot_app_enabled` per account as
 * `copilotAppEnabled` in accounts.settings_json, refreshed when it runs.
 * Only login and settings_json are read; never the token columns.
 */
type CopilotAccess =
  | { state: "enabled" }
  | { state: "none"; login: string }
  | { state: "signed-out" }
  | { state: "unknown" };

const ACCOUNT_COLUMNS = ["login", "is_default", "kind", "settings_json"];

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
      "SELECT login, is_default, settings_json FROM accounts WHERE kind = 'github';",
    );
    if (accounts.length === 0) return { state: "signed-out" };
    const account =
      accounts.find((row) => Number(row.is_default) === 1) ??
      (accounts.length === 1 ? accounts[0] : undefined);
    if (!account) return { state: "unknown" };
    const settings = JSON.parse(String(account.settings_json ?? "{}")) as Record<string, unknown>;
    if (settings.copilotAppEnabled === true) return { state: "enabled" };
    if (settings.copilotAppEnabled === false)
      return { state: "none", login: String(account.login) };
    return { state: "unknown" };
  } catch {
    // Access is advice, never a reason for on or status to fail.
    return { state: "unknown" };
  }
}

const GET_ACCESS = `Turn on Copilot Free (${COPILOT_FREE_URL}) or get a Copilot seat, then reopen the app.`;

/** What `on` says about Copilot access; always something unless access is confirmed. */
export function accessWarningOnEnable(access: CopilotAccess): string | undefined {
  switch (access.state) {
    case "enabled":
      return undefined;
    case "none":
      return `The GitHub account signed in to the app (${access.login}) has no Copilot access, so the app will not start a session, even on ai&. ${GET_ACCESS}`;
    case "signed-out":
      return "Sign in to the app with a GitHub account that has Copilot access; Copilot Free is enough. The app will not start a session without it, even on ai&.";
    case "unknown":
      return "The app needs Copilot access on its GitHub account, even though every request goes to ai&. Copilot Free is enough.";
  }
}

/** What `status` says: only a known problem, never the general reminder. */
export function accessWarningOnStatus(access: CopilotAccess): string | undefined {
  if (access.state === "none") {
    return `When the app last checked, its GitHub account (${access.login}) had no Copilot access, so it will not start a session, even on ai&. ${GET_ACCESS}`;
  }
  if (access.state === "signed-out") {
    return "No GitHub account is signed in to the app. It needs one with Copilot access to start a session, even on ai&; Copilot Free is enough.";
  }
  return undefined;
}

/**
 * The app_state change that hands the selected model back: only while it
 * still names one of the rows being removed (a pick the user made since is
 * theirs). The pick `on` replaced comes back; with none recorded, the key
 * goes and the app falls back to its own default.
 */
export async function restoreSelectionSql(
  dbPath: string,
  ids: string[],
  previous: string | null | undefined,
): Promise<string[]> {
  if (!(await hasAppState(dbPath))) return [];
  const current = await readSelectedModel(dbPath);
  if (!ids.some((id) => selectionModel(current, id) !== null)) return [];
  if (typeof previous === "string") return [setSelectedModelSql(previous)];
  return [`DELETE FROM app_state WHERE key = ${sqlString(SELECTED_MODEL_KEY)};`];
}
