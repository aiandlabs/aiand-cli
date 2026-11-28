import { parseScalar, readYamlMapping } from "./yaml.js";

export const OMP_KEY_EXPORT_DENY = "aiand key export*";

const KEY_LINE = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^:#\s"'][^:#]*?)\s*:(?:[ \t]+(.*))?$/;
const SEQUENCE_LINE = /^-(?:[ \t]+|$)/;

type TextLine = { body: string; ending: string };
type KeyLine = { key: string; value: string | null };
type Body = { end: number; indent: number; insertAt: number; placeholder: number };
type PatternsBody = Body & { items: number[]; itemIndent: number; sentinel: number };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isExactDeny(value: unknown): boolean {
  const rule = record(value);
  return (
    rule !== undefined &&
    Object.keys(rule).length === 2 &&
    rule.match === OMP_KEY_EXPORT_DENY &&
    rule.approval === "deny"
  );
}

function splitText(text: string): { lines: TextLine[]; eol: string; bom: string } {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom === "" ? text : text.slice(1);
  const lines: TextLine[] = [];
  let start = 0;
  let eol = "";
  for (let at = 0; at < body.length; at += 1) {
    if (body[at] !== "\n") continue;
    const cr = at > start && body[at - 1] === "\r";
    const ending = cr ? "\r\n" : "\n";
    if (eol === "") eol = ending;
    lines.push({ body: body.slice(start, cr ? at - 1 : at), ending });
    start = at + 1;
  }
  if (start < body.length) lines.push({ body: body.slice(start), ending: "" });
  return { lines, eol: eol || "\n", bom };
}

function joinText(lines: TextLine[], bom: string): string {
  return bom + lines.map((line) => line.body + line.ending).join("");
}

function indentOf(line: TextLine): number {
  return /^ */.exec(line.body)![0].length;
}

function meaningful(line: TextLine): boolean {
  return line.body.trim() !== "" && !line.body.trimStart().startsWith("#");
}

function commentAt(text: string): number {
  let quote: '"' | "'" | null = null;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (quote === '"') {
      if (char === "\\") at += 1;
      else if (char === '"') quote = null;
    } else if (quote === "'") {
      if (char === "'") quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#" && (at === 0 || text[at - 1] === " " || text[at - 1] === "\t")) {
      return at;
    }
  }
  return -1;
}

function code(line: TextLine): string {
  const at = commentAt(line.body);
  return (at === -1 ? line.body : line.body.slice(0, at)).trim();
}

function keyLine(line: TextLine): KeyLine | null {
  const content = line.body.trim();
  if (content === "" || content.startsWith("#") || SEQUENCE_LINE.test(content)) return null;
  const comment = commentAt(content);
  const match = KEY_LINE.exec(
    comment === -1 ? content.trimEnd() : content.slice(0, comment).trimEnd(),
  );
  if (!match) return null;
  const rawKey = match[1]!;
  let key: unknown = rawKey;
  if (rawKey.startsWith('"') || rawKey.startsWith("'")) key = parseScalar(rawKey);
  if (typeof key !== "string") throw new SyntaxError("mapping key is not a string");
  const value = match[2]?.trim() ?? null;
  return { key, value: value === "" ? null : value };
}

function findKey(lines: TextLine[], key: string, indent: number, from: number, to: number): number {
  for (let at = from; at < to; at += 1) {
    if (!meaningful(lines[at]!) || indentOf(lines[at]!) !== indent) continue;
    if (keyLine(lines[at]!)?.key === key) return at;
  }
  return -1;
}

/** End at the last real child, leaving blank separators and comments alone. */
function blockEnd(lines: TextLine[], at: number): number {
  const parentIndent = indentOf(lines[at]!);
  let end = at + 1;
  for (let index = at + 1; index < lines.length; index += 1) {
    if (!meaningful(lines[index]!)) continue;
    if (indentOf(lines[index]!) <= parentIndent) break;
    end = index + 1;
  }
  return end;
}

/** A mapping's direct body; omp's lone {} empty-map sentinel is editable. */
function mappingBody(lines: TextLine[], at: number): Body {
  const end = blockEnd(lines, at);
  let first = -1;
  let last = -1;
  let placeholder = -1;
  for (let index = at + 1; index < end; index += 1) {
    const text = code(lines[index]!);
    if (text === "{}") {
      if (placeholder === -1) placeholder = index;
      continue;
    }
    if (!meaningful(lines[index]!)) continue;
    if (first === -1) first = index;
    last = index;
  }
  if (first !== -1 && keyLine(lines[first]!) === null) {
    throw new SyntaxError("bash is not a mapping ai& can edit");
  }
  return {
    end,
    indent: first === -1 ? indentOf(lines[at]!) + 2 : indentOf(lines[first]!),
    insertAt: last === -1 ? (placeholder === -1 ? at + 1 : placeholder) : last + 1,
    placeholder,
  };
}

function directItem(line: TextLine, indent: number): boolean {
  return indentOf(line) === indent && SEQUENCE_LINE.test(line.body.slice(indent));
}

/** The block sequence under bash.patterns and its direct dash-item offsets. */
function patternsBody(lines: TextLine[], at: number, size: number): PatternsBody {
  const end = blockEnd(lines, at);
  let first = -1;
  for (let index = at + 1; index < end; index += 1) {
    if (meaningful(lines[index]!)) {
      first = index;
      break;
    }
  }
  const parentIndent = indentOf(lines[at]!);
  if (first === -1) {
    return {
      end,
      indent: parentIndent + 2,
      insertAt: at + 1,
      placeholder: -1,
      items: [],
      itemIndent: parentIndent + 2,
      sentinel: -1,
    };
  }
  if (code(lines[first]!) === "[]") {
    const onlySentinel = lines.slice(first + 1, end).every((line) => !meaningful(line));
    if (!onlySentinel || size !== 0)
      throw new SyntaxError("bash.patterns is not an editable sequence");
    const itemIndent = indentOf(lines[first]!);
    return {
      end,
      indent: itemIndent,
      insertAt: first,
      placeholder: -1,
      items: [],
      itemIndent,
      sentinel: first,
    };
  }
  const itemIndent = indentOf(lines[first]!);
  if (!directItem(lines[first]!, itemIndent) || itemIndent <= parentIndent) {
    throw new SyntaxError("bash.patterns is not an editable block sequence");
  }
  const items: number[] = [];
  for (let index = first; index < end; index += 1) {
    if (directItem(lines[index]!, itemIndent)) items.push(index);
  }
  if (items.length !== size) throw new SyntaxError("bash.patterns has an unsupported item layout");
  return {
    end,
    indent: itemIndent,
    insertAt: items[0] ?? at + 1,
    placeholder: -1,
    items,
    itemIndent,
    sentinel: -1,
  };
}

function emptyFlowHeader(line: TextLine): void {
  const colon = line.body.indexOf(":");
  const comment = commentAt(line.body);
  const header = line.body.slice(0, colon + 1);
  if (comment === -1) {
    line.body = header;
    return;
  }
  const gap = /[ \t]+$/.exec(line.body.slice(0, comment))?.[0] ?? " ";
  line.body = `${header}${gap}${line.body.slice(comment)}`;
}

function insert(lines: TextLine[], at: number, bodies: string[], eol: string): void {
  const hadFinalNewline = lines.length > 0 && lines.at(-1)!.ending !== "";
  if (at === lines.length && at > 0 && lines[at - 1]!.ending === "") {
    lines[at - 1]!.ending = eol;
  }
  const added = bodies.map((body) => ({ body, ending: eol }));
  if (at === lines.length && !hadFinalNewline) added.at(-1)!.ending = "";
  lines.splice(at, 0, ...added);
}

function denyLines(indent: number): string[] {
  const pad = " ".repeat(indent);
  return [`${pad}- match: ${JSON.stringify(OMP_KEY_EXPORT_DENY)}`, `${pad}  approval: deny`];
}

/** Read the path before touching bytes: invalid shapes must produce no edit. */
function ompPatterns(text: string): unknown[] | undefined {
  const config = readYamlMapping(text);
  if (config.bash === undefined) return undefined;
  const bash = record(config.bash);
  if (bash === undefined) {
    if (config.bash === null) return undefined;
    throw new SyntaxError("bash is not a mapping");
  }
  const patterns = bash.patterns;
  if (patterns === undefined || patterns === null) return undefined;
  if (!Array.isArray(patterns)) throw new SyntaxError("bash.patterns is not a sequence");
  return patterns;
}

/** Add the deny as the first matching rule without re-rendering user YAML. */
export function withOmpKeyExportDeny(text: string): { text: string; added: boolean } {
  const patterns = ompPatterns(text);
  if (patterns?.some(isExactDeny)) return { text, added: false };
  const { lines, eol, bom } = splitText(text);
  const bashAt = findKey(lines, "bash", 0, 0, lines.length);
  if (bashAt === -1) {
    let last = -1;
    lines.forEach((line, index) => {
      if (line.body.trim() !== "") last = index;
    });
    insert(lines, last + 1, ["bash:", "  patterns:", ...denyLines(4)], eol);
    return { text: joinText(lines, bom), added: true };
  }

  const bashHeader = keyLine(lines[bashAt]!);
  if (bashHeader?.value !== null && bashHeader?.value !== "{}") {
    throw new SyntaxError("bash is not an editable mapping");
  }
  const bash = mappingBody(lines, bashAt);
  const patternsAt = findKey(lines, "patterns", bash.indent, bashAt + 1, bash.end);
  if (patternsAt === -1) {
    if (bashHeader?.value === "{}") emptyFlowHeader(lines[bashAt]!);
    let insertAt = bash.insertAt;
    if (bash.placeholder !== -1) {
      lines.splice(bash.placeholder, 1);
      if (bash.placeholder < insertAt) insertAt -= 1;
    }
    const pad = " ".repeat(bash.indent);
    insert(lines, insertAt, [`${pad}patterns:`, ...denyLines(bash.indent + 2)], eol);
    return { text: joinText(lines, bom), added: true };
  }

  const header = keyLine(lines[patternsAt]!);
  if (header === null || (header.value !== null && !/^\[\s*\]$/.test(header.value))) {
    throw new SyntaxError("bash.patterns is not an editable block sequence");
  }
  const body = patternsBody(lines, patternsAt, patterns?.length ?? 0);
  if (header?.value !== null) emptyFlowHeader(lines[patternsAt]!);
  let insertAt = body.items[0] ?? (body.sentinel === -1 ? patternsAt + 1 : body.sentinel);
  if (body.sentinel !== -1) {
    lines.splice(body.sentinel, 1);
    if (body.sentinel < insertAt) insertAt -= 1;
  }
  insert(lines, insertAt, denyLines(body.itemIndent), eol);
  return { text: joinText(lines, bom), added: true };
}

/** True only when a section has no child content or comments of its own. */
function emptySection(lines: TextLine[], at: number): boolean {
  if (commentAt(lines[at]!.body) !== -1) return false;
  const parentIndent = indentOf(lines[at]!);
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.body.trim() === "") continue;
    if (line.body.trimStart().startsWith("#")) return false;
    return indentOf(line) <= parentIndent;
  }
  return true;
}

/** Remove one exact deny, then only blank scaffolding which that exposes. */
export function withoutOmpKeyExportDeny(text: string): string {
  try {
    const patterns = ompPatterns(text);
    const denyAt = patterns?.findIndex(isExactDeny) ?? -1;
    if (denyAt < 0) return text;
    const { lines, bom } = splitText(text);
    const hadFinalNewline = lines.length > 0 && lines.at(-1)!.ending !== "";
    const bashAt = findKey(lines, "bash", 0, 0, lines.length);
    if (bashAt === -1) return text;
    const bash = mappingBody(lines, bashAt);
    const patternsAt = findKey(lines, "patterns", bash.indent, bashAt + 1, bash.end);
    if (patternsAt === -1 || keyLine(lines[patternsAt]!)?.value !== null) return text;
    const body = patternsBody(lines, patternsAt, patterns!.length);
    const start = body.items[denyAt];
    if (start === undefined) return text;
    const end = body.items[denyAt + 1] ?? body.end;
    let last = start;
    for (let index = start + 1; index < end; index += 1) {
      if (meaningful(lines[index]!)) last = index;
    }
    lines.splice(start, last - start + 1);

    const currentPatternsAt = findKey(lines, "patterns", bash.indent, bashAt + 1, lines.length);
    if (currentPatternsAt !== -1 && emptySection(lines, currentPatternsAt)) {
      lines.splice(currentPatternsAt, 1);
    }
    const currentBashAt = findKey(lines, "bash", 0, 0, lines.length);
    if (currentBashAt !== -1 && emptySection(lines, currentBashAt)) {
      lines.splice(currentBashAt, 1);
    }
    if (!hadFinalNewline && lines.length > 0) lines.at(-1)!.ending = "";
    return joinText(lines, bom);
  } catch (error) {
    // Off must leave a later unsupported user rewrite untouched for retry.
    if (error instanceof SyntaxError) return text;
    throw error;
  }
}
