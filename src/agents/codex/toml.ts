// The CLI takes no runtime dependencies, so this is only the TOML the Codex adapter needs.

export type TomlValue = string | boolean | string[] | { [key: string]: TomlValue };
export type TomlTable = Record<string, TomlValue>;

// A JSON string is a valid TOML basic string.
const renderString = (value: string): string => JSON.stringify(value);

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const renderKey = (key: string): string => (BARE_KEY.test(key) ? key : renderString(key));

export function renderInline(value: TomlValue): string {
  if (typeof value === "string") return renderString(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(renderString).join(", ")}]`;
  const entries = Object.entries(value).map(
    ([key, inner]) => `${renderKey(key)} = ${renderInline(inner)}`,
  );
  return `{${entries.join(", ")}}`;
}

export function renderTable(name: string, table: TomlTable): string {
  const lines = Object.entries(table).map(
    ([key, value]) => `${renderKey(key)} = ${renderInline(value)}`,
  );
  return `${name ? `[${name}]\n` : ""}${lines.join("\n")}\n`;
}

export type TomlSection = { name: string; text: string };

type ScanState = { multi: string | null; depth: number };

function scanLine(line: string, state: ScanState): ScanState {
  let { multi, depth } = state;
  for (let i = 0; i < line.length; i++) {
    if (multi) {
      if (multi === '"""' && line[i] === "\\") i++;
      else if (line.startsWith(multi, i)) {
        multi = null;
        i += 2;
      }
      continue;
    }
    const char = line[i];
    if (char === "#") break;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      multi = line.slice(i, i + 3);
      i += 2;
    } else if (char === '"') {
      for (i++; i < line.length && line[i] !== '"'; i++) if (line[i] === "\\") i++;
    } else if (char === "'") {
      i = line.indexOf("'", i + 1);
      if (i < 0) break;
    } else if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth = Math.max(0, depth - 1);
  }
  return { multi, depth };
}

/** Physical lines, with a multi-line string or array kept whole as one entry. */
export function logicalLines(text: string): string[] {
  const lines: string[] = [];
  let state: ScanState = { multi: null, depth: 0 };
  for (const line of text.split(/(?<=\n)/)) {
    if (state.multi !== null || state.depth > 0) lines[lines.length - 1] += line;
    else lines.push(line);
    state = scanLine(line, state);
  }
  return lines;
}

const HEADER = /^\s*\[\[?\s*([^\],=]+?)\s*\]\]?\s*(?:#.*)?\s*$/;

export function splitSections(text: string): TomlSection[] {
  const sections: TomlSection[] = [{ name: "", text: "" }];
  for (const line of logicalLines(text)) {
    const header = HEADER.exec(line);
    if (header) sections.push({ name: header[1]!.replace(/\s*\.\s*/g, "."), text: "" });
    sections.at(-1)!.text += line;
  }
  return sections;
}

const KEY_VALUE = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/;
const OWN_VALUE = /^("(?:[^"\\]|\\.)*"|\[(?:"(?:[^"\\]|\\.)*"|[^\]"])*\]|true|false)\s*(?:#.*)?$/;

export function readKeys(sections: TomlSection[]): Record<string, Record<string, unknown>> {
  const keys: Record<string, Record<string, unknown>> = {};
  for (const section of sections) {
    const table: Record<string, unknown> = {};
    for (const line of logicalLines(section.text)) {
      const pair = KEY_VALUE.exec(line);
      if (!pair) continue;
      const raw = pair[2]!;
      try {
        table[pair[1]!] = JSON.parse(OWN_VALUE.exec(raw)?.[1] ?? raw);
      } catch {
        table[pair[1]!] = raw;
      }
    }
    keys[section.name] = { ...keys[section.name], ...table };
  }
  return keys;
}
