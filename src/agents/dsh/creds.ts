/**
 * Surgical edits to dsh's credential store (`$DSH_HOME/.credentials.yaml`).
 *
 * dsh rewrites this file itself, comment-preserving, key by key, so aiand
 * does too: one credential ref is set or deleted at a time, never by
 * re-rendering the document. The store is parsed by dsh with `uniqueKeys`,
 * so a second `refs:` key anywhere — block or flow form — is a file that
 * refuses to boot, and both writers here rewrite the map in place instead.
 *
 * The credential file is the one place a secret can sit, so a parse error
 * never quotes the offending line: a file whose first line is a bare secret
 * must not leak its content through an error message.
 */
import { escapeRe, leadingSpaces, renderScalar, stripComment, unquote } from "./patch.js";

/** The parts of a flow-map line (`refs: {…}` plus any trailing comment):
 * text before the brace, the map's inner text, and what follows the close
 * brace. False for anything else, including a comment-less `refs:` header. */
function flowRefs(line: string): { head: string; inner: string; tail: string } | undefined {
  const plain = line.trim();
  // A comment's own braces are not part of a map, so the open brace is
  // looked for only in what precedes a trailing comment.
  const comment = plain.search(/\s#/);
  const open = (comment >= 0 ? plain.slice(0, comment) : plain).indexOf("{");
  if (open < 0) return undefined;
  let depth = 0;
  let quote = "";
  for (let i = open; i < plain.length; i++) {
    const ch = plain[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        // What follows the close brace (whitespace, maybe a comment) is
        // the user's: keep it verbatim rather than regenerating it.
        return {
          head: plain.slice(0, open + 1),
          inner: plain.slice(open + 1, i),
          tail: plain.slice(i + 1),
        };
      }
    }
  }
  throw new SyntaxError("an unterminated flow map on the refs line");
}

/** Character ranges of a flow map's top-level `key: value` pairs. */
function flowPairs(inner: string): { start: number; end: number }[] {
  const pairs: { start: number; end: number }[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i <= inner.length; i++) {
    const ch = i < inner.length ? inner[i]! : "";
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if ((depth === 0 && ch === ",") || i === inner.length) {
      if (inner.slice(start, i).trim() !== "") pairs.push({ start, end: i });
      start = i + 1;
    }
  }
  return pairs;
}

/** Whether a flow pair's key is `name`. */
function refKeyMatches(
  inner: string,
  range: { start: number; end: number },
  name: string,
): boolean {
  const key = /^"?([^":]+)"?:/.exec(inner.slice(range.start, range.end).trim());
  return key !== null && unquote(key[1]!.trim()) === name;
}

/** Set credential ref `name` to `value`: rewrite its line when present, else
 * append it under `refs:`, creating the `version: 1` document for a file that
 * does not exist yet. A file that is not a credentials document is a loud
 * SyntaxError, so a foreign file is never corrupted. */
export function credentialRefSet(text: string, name: string, value: string): string {
  const entry = `  ${name}: ${renderScalar(value)}`;
  if (text.trim() === "") return `version: 1\nrefs:\n${entry}\n`;
  const lines = text.split("\n");
  const first = lines.find((line) => line.trim() !== "" && !line.trim().startsWith("#")) ?? "";
  if (!/^(version|refs):/.test(first.trim())) {
    throw new SyntaxError("not a credentials document (it must start with version: or refs:)");
  }
  const header = lines.findIndex((line) => /^refs:(?:\s|$)/.test(stripComment(line.trim())));
  if (header < 0) return `${lines.join("\n").replace(/\n$/, "")}\nrefs:\n${entry}\n`;
  const flow = flowRefs(lines[header]!);
  if (flow) {
    // A flow map (`refs: {}` is what dsh itself writes once its last ref is
    // gone): rewrite it in place. Appending a block under it instead would
    // duplicate the key, and dsh parses credentials with uniqueKeys.
    const flowEntry = `${name}: ${renderScalar(value)}`;
    const pair = flowPairs(flow.inner).find((range) => refKeyMatches(flow.inner, range, name));
    const inner = pair
      ? flow.inner.slice(0, pair.start) + flowEntry + flow.inner.slice(pair.end)
      : flow.inner.trim() === ""
        ? flowEntry
        : `${flow.inner.replace(/\s+$/, "")}, ${flowEntry}`;
    return [
      ...lines.slice(0, header),
      `${flow.head}${inner}}${flow.tail}`,
      ...lines.slice(header + 1),
    ].join("\n");
  }
  if (stripComment(lines[header]!.trim()) !== "refs:") {
    throw new SyntaxError(
      "a refs header aiand cannot read (expected a key block or a one-line flow map)",
    );
  }
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
  const header = lines.findIndex((line) => /^refs:(?:\s|$)/.test(stripComment(line.trim())));
  if (header >= 0) {
    const flow = flowRefs(lines[header]!);
    if (flow) {
      // A flow map is rewritten in place; removing one key by line never
      // applies. Emptying the map drops the whole line, as the block form
      // drops its emptied header.
      const all = flowPairs(flow.inner);
      const pairs = all.filter((range) => !refKeyMatches(flow.inner, range, name));
      if (pairs.length === all.length) return text;
      if (pairs.length === 0)
        return [...lines.slice(0, header), ...lines.slice(header + 1)].join("\n");
      const inner = pairs.map((range) => flow.inner.slice(range.start, range.end)).join(", ");
      return [
        ...lines.slice(0, header),
        `${flow.head}${inner}}${flow.tail}`,
        ...lines.slice(header + 1),
      ].join("\n");
    }
  }
  const index = lines.findIndex((line) => line.trim() !== "" && key.test(stripComment(line)));
  if (index < 0) return text;
  lines.splice(index, 1);
  const refsHeader = lines.findIndex((line) => stripComment(line.trim()) === "refs:");
  if (refsHeader >= 0) {
    const stillHolds = lines
      .slice(refsHeader + 1)
      .some(
        (line) => line.trim() !== "" && !line.trim().startsWith("#") && leadingSpaces(line) > 0,
      );
    if (!stillHolds) lines.splice(refsHeader, 1);
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
