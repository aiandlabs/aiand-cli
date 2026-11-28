import { CliError } from "../../cli/errors.js";
import {
  commentSuffix,
  dropLoneFlowLine,
  isCommentLine,
  joinYamlLines,
  keepHeaderComment,
  sectionRange,
  splitYamlLines,
  stripTrailingComment,
  unquoteYaml,
} from "./yaml.js";
import { INVALID_CONFIG_HINT } from "./yaml-probes.js";

export const HERMES_KEY_EXPORT_DENY = "aiand key export*";

const ITEM = `- ${JSON.stringify(HERMES_KEY_EXPORT_DENY)}`;

type Section = { at: number; end: number; indent: string };
type DenySection = Section & { items: number[]; itemIndent: string };

function invalid(message: string): CliError {
  return new CliError(message, { hint: INVALID_CONFIG_HINT });
}

function meaningful(line: string): boolean {
  return line.trim() !== "" && !isCommentLine(line);
}

/** Only a block mapping can take another top-level approvals key. */
function assertMappingDocument(lines: string[]): void {
  const first = lines.find(meaningful);
  if (first === undefined) return;
  const code = stripTrailingComment(first);
  if (!/^[A-Za-z0-9_.-]+\s*:(?:[ \t]+|$)/.test(code)) {
    throw invalid("config.yaml has a non-mapping document ai& does not edit.");
  }
}

/** The top-level approvals mapping, with the empty-flow sentinels made editable. */
function approvalsSection(lines: string[]): Section | null {
  const at = lines.findIndex((line) => /^approvals\s*:/.test(line));
  if (at === -1) return null;
  const value = stripTrailingComment(lines[at]!)
    .replace(/^approvals\s*:\s*/, "")
    .trim();
  if (value !== "") {
    if (!/^\{\s*\}$/.test(value)) {
      throw invalid("config.yaml has an inline `approvals:` value ai& does not edit.");
    }
    lines[at] = keepHeaderComment("approvals", lines[at]!);
  }
  // sectionRange describes mapping bodies, so an indentless sequence (valid
  // YAML at the key's own column) would otherwise look like an empty mapping.
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!meaningful(line)) continue;
    if (/^-(\s|$)/.test(line)) {
      throw invalid("config.yaml has a sequence `approvals:` value ai& does not edit.");
    }
    break;
  }
  let section = sectionRange(lines, "approvals");
  if (section === null) return null;
  if (dropLoneFlowLine(lines, section.at, section.end)) {
    section = sectionRange(lines, "approvals");
    if (section === null) return null;
  }
  const body = lines.slice(section.at + 1, section.end);
  const first = body.find(meaningful);
  if (first !== undefined) {
    const code = stripTrailingComment(first).trim();
    if (/^-(\s|$)/.test(code) || code === "[]") {
      throw invalid("config.yaml has a sequence `approvals:` value ai& does not edit.");
    }
    if (code.startsWith("{") || code.startsWith("[")) {
      throw invalid("config.yaml has an inline `approvals:` value ai& does not edit.");
    }
    if (!/^[A-Za-z0-9_.-]+\s*:(?:[ \t]+|$)/.test(code)) {
      throw invalid("config.yaml has a non-mapping `approvals:` value ai& does not edit.");
    }
  }
  const indent = /^(\s+)\S/.exec(first ?? "")?.[1] ?? "  ";
  return { ...section, indent };
}

/** One direct sequence item's decoded scalar, or undefined for another line. */
function sequenceValue(line: string, indent: string): string | undefined {
  const match = new RegExp(`^${indent}-(?:[ \t]+(.*))?$`).exec(line);
  if (!match) return undefined;
  return unquoteYaml(stripTrailingComment(match[1] ?? "").trim());
}

/** The deny key and its direct sequence items; nested dash items never count. */
function denySection(lines: string[], approvals: Section): DenySection | null {
  const key = new RegExp(`^${approvals.indent}deny\\s*:`);
  const at = lines.findIndex(
    (line, index) => index > approvals.at && index < approvals.end && key.test(line),
  );
  if (at === -1) return null;
  const value = stripTrailingComment(lines[at]!).replace(key, "").trim();
  if (value !== "") {
    if (!/^\[\s*\]$/.test(value)) {
      throw invalid("config.yaml has an inline `deny:` value ai& does not edit.");
    }
    lines[at] = `${approvals.indent}deny:${commentSuffix(lines[at]!)}`;
  }

  // An indentless sequence is valid YAML, so a dash at the key's indent stays
  // in this body; the next mapping key at that indent ends it.
  let end = at + 1;
  const sibling = new RegExp(`^${approvals.indent}\\S`);
  const indentlessItem = new RegExp(`^${approvals.indent}-(?:\\s|$)`);
  while (end < approvals.end) {
    const line = lines[end]!;
    if (meaningful(line) && sibling.test(line) && !indentlessItem.test(line)) break;
    end += 1;
  }
  const body = lines.slice(at + 1, end);
  const firstAt = body.findIndex(meaningful);
  let itemIndent = `${approvals.indent}  `;
  const items: number[] = [];
  if (firstAt !== -1) {
    const first = body[firstAt]!;
    const dash = /^([ ]*)-(?:[ \t]+|$)/.exec(first);
    if (dash) {
      itemIndent = dash[1]!;
      if (itemIndent.length < approvals.indent.length) {
        throw invalid("config.yaml has a `deny:` sequence outside aiand's editable block.");
      }
      body.forEach((line, index) => {
        if (sequenceValue(line, itemIndent) !== undefined) items.push(at + 1 + index);
      });
      // A deny rule is one scalar. Block scalars, folded continuations, and
      // nested values own following lines: inserting beside their dash alone
      // (or deleting it as the export rule) would corrupt that value. Comments
      // between ordinary one-line items remain safe to leave in place.
      for (let index = 0; index < items.length; index += 1) {
        const itemAt = items[index]!;
        const raw = stripTrailingComment(lines[itemAt]!)
          .slice(itemIndent.length + 1)
          .trim();
        if (/^[|>]/.test(raw)) {
          throw invalid("config.yaml has a multi-line `deny:` item ai& does not edit.");
        }
        const itemEnd = items[index + 1] ?? end;
        for (let cursor = itemAt + 1; cursor < itemEnd; cursor += 1) {
          if (meaningful(lines[cursor]!)) {
            throw invalid("config.yaml has a multi-line `deny:` item ai& does not edit.");
          }
        }
      }
    } else if (
      stripTrailingComment(first).trim() !== "[]" ||
      body.some((line, index) => index !== firstAt && meaningful(line))
    ) {
      throw invalid("config.yaml has a non-sequence `deny:` value ai& does not edit.");
    } else {
      // A lone [] child is the same empty-flow sentinel as deny: []. Remove
      // only that sentinel; comments around it remain exactly where they are.
      lines.splice(at + 1 + firstAt, 1);
      end -= 1;
    }
  }
  return { at, end, indent: approvals.indent, items, itemIndent };
}

/** Add the unconditional shell-command deny without reformatting other YAML. */
export function withHermesKeyExportDeny(text: string): { text: string; added: boolean } {
  const { lines: split, trailingNewline, eol } = splitYamlLines(text);
  const lines = text === "" ? [] : [...split];
  const approvals = approvalsSection(lines);
  if (approvals === null) {
    assertMappingDocument(lines);
    lines.push("approvals:", "  deny:", `    ${ITEM}`);
    return { text: joinYamlLines(lines, trailingNewline, eol), added: true };
  }
  const deny = denySection(lines, approvals);
  if (deny === null) {
    lines.splice(approvals.end, 0, `${approvals.indent}deny:`, `${approvals.indent}  ${ITEM}`);
  } else {
    if (
      deny.items.some((at) => sequenceValue(lines[at]!, deny.itemIndent) === HERMES_KEY_EXPORT_DENY)
    ) {
      return { text, added: false };
    }
    let insertAt = deny.at + 1;
    for (let at = deny.at + 1; at < deny.end; at += 1) {
      if (meaningful(lines[at]!)) insertAt = at + 1;
    }
    lines.splice(insertAt, 0, `${deny.itemIndent}${ITEM}`);
  }
  return { text: joinYamlLines(lines, trailingNewline, eol), added: true };
}

/** Remove only the exact key-export rule and any empty scaffolding left by it. */
export function withoutHermesKeyExportDeny(text: string): string {
  const { lines, trailingNewline, eol } = splitYamlLines(text);
  try {
    const approvals = approvalsSection(lines);
    if (approvals === null) return text;
    const deny = denySection(lines, approvals);
    if (deny === null) return text;
    let removed = false;
    for (let index = deny.items.length - 1; index >= 0; index -= 1) {
      const at = deny.items[index]!;
      if (sequenceValue(lines[at]!, deny.itemIndent) !== HERMES_KEY_EXPORT_DENY) continue;
      const comment = commentSuffix(lines[at]!).trim();
      lines.splice(at, 1, ...(comment === "" ? [] : [`${deny.itemIndent}${comment}`]));
      removed = true;
    }
    if (!removed) return text;

    // Re-read after the splice. A comment is user content, not empty
    // scaffolding, so it keeps its deny/approvals headers in place.
    let currentApprovals = approvalsSection(lines);
    if (currentApprovals === null) return joinYamlLines(lines, trailingNewline, eol);
    const currentDeny = denySection(lines, currentApprovals);
    if (
      currentDeny !== null &&
      commentSuffix(lines[currentDeny.at]!) === "" &&
      lines.slice(currentDeny.at + 1, currentDeny.end).every((line) => line.trim() === "")
    ) {
      lines.splice(currentDeny.at, 1);
    }
    currentApprovals = approvalsSection(lines);
    if (
      currentApprovals !== null &&
      commentSuffix(lines[currentApprovals.at]!) === "" &&
      lines.slice(currentApprovals.at + 1, currentApprovals.end).every((line) => line.trim() === "")
    ) {
      lines.splice(currentApprovals.at, 1);
    }
    return joinYamlLines(lines, trailingNewline, eol);
  } catch (error) {
    // Off must not reinterpret a user's later inline rewrite as ours.
    if (error instanceof CliError) return text;
    throw error;
  }
}
