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

// Known limit: inside a multi-line array or string, a line starting with `[` with no comma
// reads as a header.
const HEADER = /^\s*\[\[?\s*([^\],=]+?)\s*\]\]?\s*(?:#.*)?$/;

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
const OWN_VALUE = /^("(?:[^"\\]|\\.)*"|\[(?:"(?:[^"\\]|\\.)*"|[^\]"])*\]|true|false)\s*(?:#.*)?$/;

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
