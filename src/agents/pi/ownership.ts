import { isRoutableBaseUrl } from "../../config.js";
import { asObject, jsoncDelete, jsoncSet, parseWrittenObject } from "../managed-file.js";
import { PI_KEY_EXPORT_GUARD_PATH } from "./guard.js";

/** Provider id in Pi's models.json and the key of its auth.json credential. */
export const PI_PROVIDER_ID = "aiand";

/**
 * What enable() recorded so off can tell its values from the user's. The
 * baked key never appears here: only ids, previous values, file modes,
 * and the absolute paths we wrote (paths are not secrets; the snapshot
 * manifest already stores them).
 */
export type PiRecord = {
  /** What settings.json's defaultProvider was before on (undefined = absent). */
  previousDefaultProvider?: string;
  /** What settings.json's defaultModel was before the write off must undo. */
  previousDefaultModel?: string;
  /** The defaultModel this on wrote (a catalog id); off hands back or removes it. */
  wroteDefaultModel?: string;
  /**
   * The providers.aiand baseUrl `on` wrote — names only, never the
   * key. probe, disable, and refreshKey prove a stamp-less block is
   * still ours by matching it; a repointed block is the user's.
   */
  wroteBaseUrl?: string;
  /** True only when on appended the key-export guard; pre-owned entries stay. */
  addedKeyExportGuard?: boolean;
  /** File mode before `on` wrote it, per file off rewrites. */
  previousModelsMode?: number;
  previousSettingsMode?: number;
  /** auth.json's mode before `on` wrote it; a new file stays private. */
  previousAuthMode?: number;
  /** Where `on` actually wrote the files; off strips them if the dir moved. */
  modelsPath?: string;
  authPath?: string;
  settingsPath?: string;
};

/** The provider block Pi's model runtime composes from models.json. */
export function aiandProvider(
  models: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return asObject(asObject(models.providers)?.[PI_PROVIDER_ID]);
}

/**
 * parseWrittenObject for raw file text: {} when empty, undefined when
 * malformed. Never throws — a file mid-edit must fail the ownership
 * proof below, not crash a status or cleanup path.
 */
export function parseConfigQuiet(text: string): Record<string, unknown> | undefined {
  try {
    return text.trim() ? parseWrittenObject(text) : {};
  } catch {
    return undefined;
  }
}

type JsoncToken = { text: string; start: number; end: number; value?: string };
type ExtensionEntry = {
  value: string;
  start: number;
  end: number;
  commaBefore?: number;
  commaAfter?: number;
};

/** One JSONC token, with comments and whitespace left out of the token stream. */
function nextJsoncToken(text: string, from: number): JsoncToken | undefined {
  let at = from;
  for (;;) {
    while (at < text.length && /\s/.test(text[at]!)) at++;
    if (text[at] === "/" && text[at + 1] === "/") {
      while (at < text.length && text[at] !== "\n") at++;
      continue;
    }
    if (text[at] === "/" && text[at + 1] === "*") {
      const close = text.indexOf("*/", at + 2);
      if (close === -1) throw new SyntaxError("Unterminated block comment");
      at = close + 2;
      continue;
    }
    break;
  }
  if (at >= text.length) return undefined;
  const start = at;
  if ("{}[],:".includes(text[at]!)) return { text: text[at]!, start, end: at + 1 };
  if (text[at] === '"') {
    at++;
    while (at < text.length) {
      if (text[at] === "\\") {
        at += 2;
      } else if (text[at] === '"') {
        at++;
        const raw = text.slice(start, at);
        return { text: raw, start, end: at, value: JSON.parse(raw) as string };
      } else {
        at++;
      }
    }
    throw new SyntaxError("Unterminated string");
  }
  while (at < text.length && !/[\s{}[\],:]/.test(text[at]!)) at++;
  return { text: text.slice(start, at), start, end: at };
}

/** Locate a validated settings.extensions string array without rewriting it. */
function piExtensionsArray(
  text: string,
  open: JsoncToken,
): { close: number; entries: ExtensionEntry[] } {
  const entries: ExtensionEntry[] = [];
  let at = open.end;
  let lastComma: number | undefined;
  let previous: ExtensionEntry | undefined;
  for (;;) {
    const token = nextJsoncToken(text, at);
    if (token === undefined) throw new SyntaxError("Unterminated extensions array");
    at = token.end;
    if (token.text === "]") return { close: token.start, entries };
    if (token.text === ",") {
      if (previous !== undefined && previous.commaAfter === undefined) {
        previous.commaAfter = token.start;
      }
      lastComma = token.start;
      continue;
    }
    if (token.value === undefined) throw new SyntaxError("extensions must contain strings");
    const entry: ExtensionEntry = {
      value: token.value,
      start: token.start,
      end: token.end,
      commaBefore: lastComma,
    };
    entries.push(entry);
    previous = entry;
    lastComma = undefined;
  }
}

function findPiExtensionsArray(
  text: string,
): { close: number; entries: ExtensionEntry[] } | undefined {
  let objectDepth = 0;
  let arrayDepth = 0;
  let at = 0;
  for (;;) {
    const token = nextJsoncToken(text, at);
    if (token === undefined) return undefined;
    at = token.end;
    if (token.text === "{") {
      objectDepth++;
      continue;
    }
    if (token.text === "}") {
      objectDepth--;
      continue;
    }
    if (token.text === "[") {
      arrayDepth++;
      continue;
    }
    if (token.text === "]") {
      arrayDepth--;
      continue;
    }
    if (token.value !== "extensions" || objectDepth !== 1 || arrayDepth !== 0) continue;
    const colon = nextJsoncToken(text, at);
    if (colon?.text !== ":") continue;
    const open = nextJsoncToken(text, colon.end);
    if (open?.text === "[") return piExtensionsArray(text, open);
  }
}

/** Undefined means absent; any other shape is unsupported and fails loudly for on. */
function piExtensions(text: string): string[] | undefined {
  const settings = text.trim() ? parseWrittenObject(text) : {};
  const extensions = settings.extensions;
  if (extensions === undefined) return undefined;
  if (!Array.isArray(extensions) || extensions.some((entry) => typeof entry !== "string")) {
    throw new SyntaxError("settings.extensions must be an array of strings");
  }
  return extensions as string[];
}

/** Append only our exact extension entry, leaving all pre-existing bytes in place. */
export function withPiKeyExportGuard(text: string): { text: string; added: boolean } {
  const extensions = piExtensions(text);
  if (extensions === undefined) {
    return {
      text: jsoncSet(text, ["extensions"], [PI_KEY_EXPORT_GUARD_PATH]),
      added: true,
    };
  }
  if (extensions.includes(PI_KEY_EXPORT_GUARD_PATH)) return { text, added: false };
  const array = findPiExtensionsArray(text);
  if (array === undefined) throw new SyntaxError("settings.extensions is not editable");
  const last = array.entries.at(-1);
  const hadTrailingComma = last?.commaAfter !== undefined;
  let out = text;
  let close = array.close;
  if (last !== undefined && !hadTrailingComma) {
    out = `${out.slice(0, last.end)},${out.slice(last.end)}`;
    close++;
  }
  const entry = `${JSON.stringify(PI_KEY_EXPORT_GUARD_PATH)}${hadTrailingComma ? "," : ""}`;
  out = `${out.slice(0, close)}${entry}${out.slice(close)}`;
  return { text: out, added: true };
}

/** Remove only our exact entry and any extensions property it leaves empty. */
export function withoutPiKeyExportGuard(text: string): string {
  try {
    let out = text;
    for (;;) {
      const extensions = piExtensions(out);
      if (extensions === undefined || !extensions.includes(PI_KEY_EXPORT_GUARD_PATH)) return out;
      const array = findPiExtensionsArray(out);
      const entry = array?.entries.find(
        (candidate) => candidate.value === PI_KEY_EXPORT_GUARD_PATH,
      );
      if (entry === undefined) return out;
      const comma = entry.commaAfter ?? entry.commaBefore;
      out = `${out.slice(0, entry.start)}${out.slice(entry.end)}`;
      if (comma !== undefined) {
        const at = comma > entry.start ? comma - (entry.end - entry.start) : comma;
        out = `${out.slice(0, at)}${out.slice(at + 1)}`;
      }
      if (piExtensions(out)?.length === 0) return jsoncDelete(out, ["extensions"]);
    }
  } catch (error) {
    // A later unsupported rewrite belongs to the user; off leaves it alone.
    if (error instanceof SyntaxError) return text;
    throw error;
  }
}

/**
 * The proof that a stamp-less routing is still ours: the models.json
 * block names the baseUrl `on` wrote, it is still routable, and
 * settings.json still defaults to aiand. The record alone never proves
 * anything — with no record, wroteBaseUrl is undefined and no
 * routable block can match it.
 */
export function routingStillOurs(
  models: Record<string, unknown> | undefined,
  settings: Record<string, unknown> | undefined,
  added: PiRecord | null,
): boolean {
  const baseUrl = models === undefined ? undefined : aiandProvider(models)?.baseUrl;
  return (
    baseUrl === added?.wroteBaseUrl &&
    isRoutableBaseUrl(baseUrl) &&
    settings?.defaultProvider === PI_PROVIDER_ID
  );
}

/**
 * The settings.json hand-back off performs on one file, current dir or
 * moved: a defaultModel we wrote is restored (or removed) only while it is
 * still ours, and a defaultProvider we set is handed back. Values the user
 * changed in between are theirs and stay, with a note.
 */
export function handBackSettings(
  text: string,
  added: PiRecord | null,
): { text: string; notes: string[] } {
  const notes: string[] = [];
  const settings = text.trim() ? parseWrittenObject(text) : {};
  let out = text;
  if (added?.wroteDefaultModel !== undefined) {
    if (settings.defaultModel === added.wroteDefaultModel) {
      out =
        added.previousDefaultModel !== undefined
          ? jsoncSet(out, ["defaultModel"], added.previousDefaultModel)
          : jsoncDelete(out, ["defaultModel"]);
    } else if (settings.defaultModel !== undefined) {
      notes.push("left defaultModel because you edited it");
    }
  }
  if (settings.defaultProvider === PI_PROVIDER_ID) {
    out =
      added?.previousDefaultProvider !== undefined
        ? jsoncSet(out, ["defaultProvider"], added.previousDefaultProvider)
        : jsoncDelete(out, ["defaultProvider"]);
  } else if (settings.defaultProvider !== undefined) {
    notes.push("left defaultProvider because you edited it");
  }
  return { text: out, notes };
}

/**
 * models.json text with our provider block dropped: unrelated providers
 * survive, and an emptied `providers` map (ours alone) is dropped with it.
 * An empty or malformed text passes through unchanged (nothing of ours to
 * drop), never throws.
 */
export function dropPiProvider(text: string): string {
  let out = jsoncDelete(text, ["providers", PI_PROVIDER_ID]);
  const left = asObject((out.trim() ? parseWrittenObject(out) : {}).providers);
  if (left && Object.keys(left).length === 0) {
    out = jsoncDelete(out, ["providers"]);
  }
  return out;
}
