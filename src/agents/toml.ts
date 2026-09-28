/**
 * The little TOML the Codex adapter needs, since the CLI takes no runtime
 * dependencies: render the tables it owns, split a file into table sections
 * so the ones it does not own survive byte for byte, and read back the few
 * keys it wrote. Not a general parser.
 */

export type TomlValue = string | boolean | string[] | { [key: string]: TomlValue };
export type TomlTable = Record<string, TomlValue>;

/** A JSON string is a valid TOML basic string: same quotes, same escapes. */
const renderString = (value: string): string => JSON.stringify(value);

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const renderKey = (key: string): string => (BARE_KEY.test(key) ? key : renderString(key));

/** A value on one line: what a table body and Codex's `-c key=value` both take. */
export function renderInline(value: TomlValue): string {
  if (typeof value === "string") return renderString(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(renderString).join(", ")}]`;
  const entries = Object.entries(value).map(
    ([key, inner]) => `${renderKey(key)} = ${renderInline(inner)}`,
  );
  return `{${entries.join(", ")}}`;
}

/** `key = value` lines, under a `[header]` unless `name` is empty (top-level keys). */
export function renderTable(name: string, table: TomlTable): string {
  const lines = Object.entries(table).map(
    ([key, value]) => `${renderKey(key)} = ${renderInline(value)}`,
  );
  return `${name ? `[${name}]\n` : ""}${lines.join("\n")}\n`;
}

/** One table's text, from its header line up to the next header. */
export type TomlSection = { name: string; text: string };

// Known limit: a line inside a multi-line array or string that starts with `[`
// and holds no comma reads as a header; neither Codex's writes nor ours
// produce one, and parsing multi-line values is more TOML than a profile needs.
const HEADER = /^\s*\[\[?\s*([^\],=]+?)\s*\]\]?\s*(?:#.*)?$/;

/** Split into sections; the first, named "", holds the keys before any header. */
export function splitSections(text: string): TomlSection[] {
  const sections: TomlSection[] = [{ name: "", text: "" }];
  for (const line of text.split(/(?<=\n)/)) {
    const header = HEADER.exec(line);
    if (header) sections.push({ name: header[1]!.replace(/\s*\.\s*/g, "."), text: "" });
    sections.at(-1)!.text += line;
  }
  return sections;
}

const KEY_VALUE = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/;
/** A value this module writes, with any trailing `# comment` cut off. */
const OWN_VALUE = /^("(?:[^"\\]|\\.)*"|\[(?:"(?:[^"\\]|\\.)*"|[^\]"])*\]|true|false)\s*(?:#.*)?$/;

/**
 * `key = value` pairs per section. Values this module writes (basic strings,
 * booleans, string arrays) come back typed; anything else stays raw text,
 * which callers treat as "not ours".
 */
export function readKeys(sections: TomlSection[]): Record<string, Record<string, unknown>> {
  const keys: Record<string, Record<string, unknown>> = {};
  for (const section of sections) {
    const table: Record<string, unknown> = {};
    for (const line of section.text.split("\n")) {
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
