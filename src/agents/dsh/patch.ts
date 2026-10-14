/**
 * Surgical edits to the two dsh files that carry aiand routing: the home-level
 * patch layer (`$DSH_HOME/cordis.patch.yml`) and the credential store
 * (`$DSH_HOME/.credentials.yaml`).
 *
 * Both files can hold the user's own content, so edits splice one row or one
 * credential key at a time instead of re-rendering the document: every other
 * row, comment, blank line and quoting style survives byte for byte. That also
 * keeps aiand out of dsh's YAML dialect entirely — a profile layer may carry
 * `!!js` expressions, and a parser that re-renders one would change what the
 * user booted. dsh rewrites the credential file itself (comment-preserving,
 * its own keys only) and never writes the home patch layer, which is why the
 * ownership marker can live there safely.
 *
 * Only the subset our own writes produce is read back; anything else inside a
 * row we own is a loud SyntaxError, never a silent mis-parse. A double-quoted
 * scalar follows the YAML 1.2 escape table, so a `\x41` or `\_` another tool
 * wrote reads as its character — a bad escape is that same loud SyntaxError,
 * never the raw backslashes.
 */
import { DSH_BANNER } from "./rows.js";

/** One top-level row of a patch list: the `- ` line through the line before
 * the next top-level row. Comments and blanks outside a range belong to the file. */
export type RowBlock = { from: number; to: number; lines: string[] };

/** Every top-level row of a patch document, in order. Row lines drop a
 * trailing `\r` — a hand-edited or Windows-written file keeps its CRLFs in
 * the text (splices write byte-for-byte through `from`/`to`), but the
 * parsers read one shape. Block scalar bodies are text, not structure:
 * their lines leave the readable set (the splice range keeps them), so a
 * `x-aiand: true` inside someone's `script: |` never reads as our marker.
 * A tab in indentation or a second document marker is a shape this reader
 * refuses: a loud SyntaxError, never a silent mis-parse. */
function findRows(text: string): RowBlock[] {
  const lines = text.split("\n");
  // A leading BOM is legal YAML; it must not hide the first row from the
  // reader (an invisible row means on appends a duplicate dsh refuses at
  // boot). A splice that replaces line 0 drops the BOM — harmless.
  if (lines[0]?.startsWith("\uFEFF")) lines[0] = lines[0].slice(1);
  const rows: RowBlock[] = [];
  let i = 0;
  // A leading `---` opens the one document this reader knows; the same
  // marker after rows starts a second one, which this reader refuses.
  // Comments and blanks before it are the document's own prologue: a
  // `# my patch` above the marker is legal YAML, not a second document.
  while (i < lines.length) {
    const plain = stripCr(lines[i]!);
    if (plain === "---" || plain === "" || plain.trim().startsWith("#")) i += 1;
    else break;
  }
  while (i < lines.length) {
    const line = stripCr(lines[i]!);
    if (line === "---" || line === "...") {
      throw new SyntaxError(`a second document starts at line ${i + 1}`);
    }
    if (line === "-" || line.startsWith("- ")) {
      let to = i + 1;
      while (to < lines.length) {
        const next = stripCr(lines[to]!);
        if (next === "-" || next.startsWith("- ")) break;
        if (next === "---" || next === "...") {
          throw new SyntaxError(`a second document starts at line ${to + 1}`);
        }
        to += 1;
      }
      rows.push({ from: i, to, lines: readableLines(lines.slice(i, to)) });
      i = to;
    } else {
      i += 1;
    }
  }
  return rows;
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** A row's structural lines: CRLFs dropped, block scalar bodies removed,
 * tab-indented lines and document markers refused. */
function readableLines(raw: string[]): string[] {
  const kept: string[] = [];
  let blockIndent = -1;
  for (const line of raw.map(stripCr)) {
    const trimmed = line.trim();
    if (blockIndent >= 0) {
      if (trimmed === "" || leadingSpaces(line) > blockIndent) continue;
      blockIndent = -1;
    }
    if (/^[ ]*\t/.test(line)) {
      throw new SyntaxError("a tab indents a line, which YAML forbids");
    }
    if (/^(?:[ ]*(?:-\s+)?)?[\w.@-]+:\s*[|>][-+\d]*(\s+.*)?$/.test(line)) {
      blockIndent = leadingSpaces(line);
    }
    kept.push(line);
  }
  return kept;
}

/** The top-level `key: value` pairs of a row written as a flow map
 * (`- {id: llm-pi-ai, config: {…}}`), or undefined when the row opens in
 * block form. A nested map's commas and colons are its own content, so only
 * the separators sitting outside every nested collection split the row's
 * keys — that is what keeps `config: {id: y}`'s `id` out of the row's.
 * Braces that never close, or a key repeated at the top level, are a shape
 * this reader refuses with a loud SyntaxError (the way a tab or a second
 * document is): an unreadable row would let `on` append a duplicate of the
 * row it could not see. */
export function flowRowEntries(row: RowBlock): Record<string, string> | undefined {
  const text = row.lines.join("\n");
  if (!/^-\s*\{/.test(text)) return undefined;
  const pairs: Record<string, string> = {};
  let quote = "";
  let depth = 0;
  /** The top-level colon of the entry being read, or -1 before it. */
  let colon = -1;
  let start = 0;
  const push = (end: number): void => {
    if (colon >= 0) {
      const key = unquote(text.slice(start, colon).trim());
      const value = text.slice(colon + 1, end).trim();
      if (key !== "") {
        if (key in pairs) throw new SyntaxError(`duplicate ${key} in a flow-map row`);
        pairs[key] = value;
      }
    }
    colon = -1;
    start = end + 1;
  };
  for (let i = text.indexOf("{"); i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote === '"') {
      if (ch === "\\") i += 1;
      else if (ch === '"') quote = "";
    } else if (quote === "'") {
      if (ch === "'" && text[i + 1] === "'") i += 1;
      else if (ch === "'") quote = "";
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (depth === 0) {
      // The row's opening brace: everything after it is one top-level entry
      // until a comma or the closing brace, which is where a key starts.
      if (ch !== "{") throw new SyntaxError("a flow-map row must open its braces first");
      depth = 1;
      start = i + 1;
    } else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) {
        push(i);
        return pairs;
      }
    } else if (depth === 1) {
      if (ch === ":" && colon < 0) colon = i;
      else if (ch === ",") push(i);
    }
  }
  throw new SyntaxError("a flow-map row never closes its braces");
}

/** The row's `id`: the `- id: ...` opener, the `- {id: ...}` flow-map opener,
 * or an `id:` line at the item's first-level indent (`id` may sit at any
 * first-level position, not just the opener). The key may be quoted
 * (`- "id": x`) the way a hand-edited file carries it. A trailing comment
 * and CRLF endings are shapes a hand-edited file carries; `.` in a regex
 * matches neither, so both are eaten before the value is read. */
function rowId(row: RowBlock): string | undefined {
  const opener = /^-\s*(['"]?)id\1:\s*(.*?)\s*$/.exec(row.lines[0] ?? "");
  if (opener?.[2]?.trim()) return unquote(stripComment(opener[2].trim()));
  // A flow-map row keeps every key in its opener, so the indented scan below
  // never meets one: read the top-level `id` there, or `on` appends a second
  // row for this one and the user's own config rides along unmanaged.
  const flow = flowRowEntries(row);
  if (flow !== undefined) return flow.id === undefined ? undefined : unquote(flow.id);
  const first = row.lines[0] ?? "";
  // The item's first level is the opener's content column: `-  id: x` and
  // `- "id": x` put their siblings where dsh reads them, not at a guessed
  // +2 — a wrong level reads a nested `id:` as the row's and misses the
  // real one. A lone `-` still takes its level from the next content line.
  const dash = first.trim() === "-" ? undefined : /^-\s*/.exec(first)?.[0].length;
  let level: number | undefined;
  if (dash !== undefined) level = dash;
  else if (first.trim() !== "-") level = leadingSpaces(first) + 2;
  for (const line of row.lines.slice(1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = leadingSpaces(line);
    if (level === undefined) level = indent;
    if (indent < level) break;
    if (indent !== level) continue;
    const m = /^\s*(['"]?)id\1:\s*(.*?)\s*$/.exec(line);
    if (m?.[2]?.trim()) return unquote(stripComment(m[2].trim()));
  }
  return undefined;
}

/** A row that inserts rows rather than naming one. Ours never match one;
 * splicing by row range never disturbs one. */
function isInsertRow(row: RowBlock): boolean {
  return row.lines.some((line) => /^(-\s+)?insert:$/.test(line.trim()));
}

/** The row `id` names (ignoring insert blocks), when present. */
export function findRowById(text: string, id: string): RowBlock | undefined {
  return findRows(text).find((row) => !isInsertRow(row) && rowId(row) === id);
}

/** The scalar value of a `key: value` line inside a row, at any depth. A
 * bare `key:` (a block, not a scalar) reads as absent. A row naming the key
 * twice with values is a foreign shape: read loudly, never last-wins. */
export function rowValue(row: RowBlock, key: string): string | undefined {
  const found: string[] = [];
  for (const line of row.lines) {
    const m = new RegExp(`^-?\\s*${escapeRe(key)}:\\s*(.*)$`).exec(line);
    if (!m) continue;
    if (m[1]!.trim() === "") continue;
    found.push(unquote(stripComment(m[1]!.trim())));
  }
  if (found.length > 1) throw new SyntaxError(`duplicate ${key} in row ${rowId(row) ?? "?"}`);
  return found[0];
}

/** Whether a row carries this exact line (the ownership marker proof). */
export function rowHasLine(row: RowBlock, line: string): boolean {
  return row.lines.some((entry) => stripComment(entry.trim()) === line);
}

/** The route keys declared under `providers:` in a row — used to tell our row
 * from a foreign one, and to spot user routes a lower layer would shadow.
 * A flow-style declaration (`providers: {…}`, or one nested inside a flow
 * `config: {…}`) names routes we cannot enumerate: it reports a sentinel
 * rather than the empty list a caller would read as "no providers". */
export function rowProviderKeys(row: RowBlock): string[] {
  if (row.lines.some((line) => /(^|[{,]\s*)providers:\s*\{/.test(stripComment(line.trim())))) {
    return ["<flow>"];
  }
  const header = row.lines.findIndex((line) =>
    /^(-\s+)?providers:/.test(stripComment(line.trim())),
  );
  if (header < 0) return [];
  const headerIndent = leadingSpaces(row.lines[header]!);
  const value = /^\s*(?:-\s+)?providers:\s*(.*)$/.exec(row.lines[header]!)![1]!.trim();
  if (value !== "" && !/^[|>]/.test(value)) return ["<flow>"];
  const keys: string[] = [];
  for (const line of row.lines.slice(header + 1)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (leadingSpaces(line) <= headerIndent) break;
    if (trimmed.startsWith("- ") || !trimmed.endsWith(":")) continue;
    const m = /^"?([\w.@-]+)"?:\s*$/.exec(trimmed);
    if (m) keys.push(m[1]!);
  }
  return keys;
}

/**
 * Replace the row `id` names with `rendered`, append it when absent, or prune
 * it when `rendered` is undefined. A replaced or pruned row loses only the
 * ownership banner lines directly above it, never the user's own comments
 * (`# keep: my route`) or the blank that separated their rows. Every
 * unrelated line survives byte for byte.
 */
export function spliceRow(text: string, id: string, rendered: string | undefined): string {
  const raw = text.split("\n");
  const endsNl = raw.length > 1 && raw[raw.length - 1] === "";
  const lines = endsNl ? raw.slice(0, -1) : raw;
  const row = findRowById(text, id);
  if (row === undefined) {
    if (rendered === undefined) return text;
    const rows = findRows(text);
    // Append after the last row's range, so trailing blanks and comments stay
    // below our block instead of being read back into it.
    const at = rows.length > 0 ? rows[rows.length - 1]!.to : lines.length;
    lines.splice(at, 0, ...rendered.split("\n"));
    return `${lines.join("\n")}\n`;
  }
  // A replaced row whose rendered block starts with its own comment lines
  // also loses the banner lines directly above it — otherwise each re-on
  // would stack one banner per run. Only the exact banner line goes: the
  // comment above our banner is the user's and stays put. A rendered block
  // with no comment head (the unmarked hand-back shape) keeps what sat
  // above the row.
  const replacesOwnComments = rendered?.trimStart().startsWith("#");
  const isBanner = (line: string | undefined): boolean =>
    line !== undefined && stripCr(line).trim() === DSH_BANNER;
  let from = row.from;
  if (replacesOwnComments || rendered === undefined) {
    while (isBanner(lines[from - 1])) from -= 1;
  }
  // Trailing comment lines inside the row's range belong to the next row's
  // banner (findRows stops only at `- ` openers): never consume them when
  // replacing, or the row below loses its banner.
  let to = row.to;
  while (
    to > row.from &&
    to - 1 < lines.length &&
    lines[to - 1] !== undefined &&
    lines[to - 1]!.trim().startsWith("#")
  ) {
    to -= 1;
  }
  const eaten = row.from - from;
  if (eaten > 0) {
    lines.splice(from, eaten);
    to -= eaten;
  }
  lines.splice(from, to - from, ...(rendered === undefined ? [] : rendered.split("\n")));
  const out = lines.join("\n");
  return out === "" ? "" : `${out}\n`;
}

/** Set credential ref `name` to `value`: rewrite its line when present, else
 * append it under `refs:`, creating the `version: 1` document for a file that
 * does not exist yet. A file that is not a credentials document is a loud
 * SyntaxError, so a foreign file is never corrupted. The error never quotes
 * the offending line: a file whose first line is a bare secret must not
 * leak its content through an error message. */
export function credentialRefSet(text: string, name: string, value: string): string {
  const entry = `  ${name}: ${renderScalar(value)}`;
  if (text.trim() === "") return `version: 1\nrefs:\n${entry}\n`;
  const lines = text.split("\n");
  const first = lines.find((line) => line.trim() !== "" && !line.trim().startsWith("#")) ?? "";
  if (!/^(version|refs):/.test(first.trim())) {
    throw new SyntaxError("not a credentials document (it must start with version: or refs:)");
  }
  const header = lines.findIndex((line) => stripComment(line.trim()) === "refs:");
  if (header < 0) return `${lines.join("\n").replace(/\n$/, "")}\nrefs:\n${entry}\n`;
  const key = new RegExp(`^"?${escapeRe(name)}"?:`);
  for (let i = header + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (leadingSpaces(lines[i]!) < 1) break;
    if (key.test(trimmed)) {
      lines[i] = entry;
      return `${lines.join("\n")}`;
    }
  }
  // Insert after the refs block's last content line, so a following
  // `records:` section and any trailing comment keep their place.
  let at = header + 1;
  for (let i = header + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (leadingSpaces(lines[i]!) < 1) break;
    at = i + 1;
  }
  lines.splice(at, 0, entry);
  return `${lines.join("\n")}`;
}

/** Delete credential ref `name`; an emptied `refs:` header goes with it.
 * A missing name is a no-op. */
export function credentialRefDelete(text: string, name: string): string {
  const lines = text.split("\n");
  const key = new RegExp(`^"?${escapeRe(name)}"?:`);
  const index = lines.findIndex((line) => line.trim() !== "" && key.test(stripComment(line)));
  if (index < 0) return text;
  lines.splice(index, 1);
  const header = lines.findIndex((line) => stripComment(line.trim()) === "refs:");
  if (header >= 0) {
    const stillHolds = lines
      .slice(header + 1)
      .some(
        (line) => line.trim() !== "" && !line.trim().startsWith("#") && leadingSpaces(line) > 0,
      );
    if (!stillHolds) lines.splice(header, 1);
  }
  return `${lines.join("\n")}`;
}

/** True when only `version:`, comments and blanks are left. */
export function credentialDocumentEmpty(text: string): boolean {
  return text
    .split("\n")
    .every(
      (line) => line.trim() === "" || line.trim().startsWith("#") || /^version:/.test(line.trim()),
    );
}

export function leadingSpaces(line: string): number {
  return /^[ ]*/.exec(line)![0].length;
}

function stripComment(text: string): string {
  const cut = text.search(/\s#/);
  return (cut >= 0 ? text.slice(0, cut) : text).trim();
}

// YAML double-quoted escapes (YAML 1.2 §5.7); JSON.parse rejects the
// YAML-only ones (`\_`, `\L`, `\a`, ...) a hand-edited file may carry.
const YAML_ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\x85",
  _: "\xa0",
  L: "\u2028",
  P: "\u2029",
};

/** A leading `"…"` scalar decoded by the YAML escape table. An unterminated
 * quote or an unknown escape is a loud SyntaxError, never the raw quoted text
 * (which would flow a backslashed value into a baseURL or key read). */
function parseDoubleQuoted(text: string): string {
  if (!/^"(?:[^"\\]|\\[\s\S])*"$/.test(text)) {
    throw new SyntaxError(`bad double-quoted scalar: ${text}`);
  }
  return text
    .slice(1, -1)
    .replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g, (_, esc: string) => {
      if (esc.length > 1) return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
      const out = YAML_ESCAPES[esc];
      if (out === undefined) throw new SyntaxError(`bad escape \\${esc} in: ${text}`);
      return out;
    });
}

export function unquote(value: string): string {
  if (value.startsWith('"')) return parseDoubleQuoted(value);
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** Quote a scalar only when a bare form would not parse back the same. */
export function renderScalar(value: string): string {
  if (
    value === "" ||
    value !== value.trim() ||
    value.includes(": ") ||
    value.endsWith(":") ||
    /[ \t]#/.test(value) ||
    /^[#&*!|>%@`,[\]{}?:-]/.test(value) ||
    /^(?:~|null|true|false|yes|no|on|off|y|n)$/i.test(value) ||
    /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)
  ) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Drop the ownership marker line and banner comment from every row of a
 * patch document, leaving all other lines (the routing values included)
 * byte-identical: the hand-back shape for a row the user repointed, which
 * must stop reading as ours while their edits stay. The strings are exact
 * lines only aiand writes, so a user row can never lose one — unless the
 * text sits inside a block scalar body, which is the user's content: a
 * block-scalar-aware scan skips those. */
export function stripOwnershipLines(text: string, marker: string, banner: string): string {
  const lines = text.split("\n");
  let blockIndent = -1;
  return lines
    .filter((line) => {
      const plain = stripCr(line);
      const trimmed = plain.trim();
      if (blockIndent >= 0) {
        if (trimmed === "" || leadingSpaces(plain) > blockIndent) return true;
        blockIndent = -1;
      }
      if (/^(?:[ ]*(?:-\s+)?)?[\w.@-]+:\s*[|>][-+\d]*(\s.*)?$/.test(plain)) {
        blockIndent = leadingSpaces(plain);
      }
      return stripComment(trimmed) !== marker && trimmed !== banner;
    })
    .join("\n");
}
