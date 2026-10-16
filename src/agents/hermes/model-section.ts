import { CliError } from "../../cli/errors.js";
import { HERMES_PROVIDER_ID } from "./plugin.js";
import {
  childValueIsMultiLine,
  commentSuffix,
  dropLoneFlowLine,
  isSectionBodyLine,
  joinYamlLines,
  keepHeaderComment,
  keepLineComment,
  sectionRange,
  splitYamlLines,
  stripTrailingComment,
  unquoteYaml,
} from "./yaml.js";
import { INVALID_CONFIG_HINT, throwOnInlineSection, throwOnSequenceBody } from "./yaml-probes.js";

/**
 * The `model:` section of a hermes config: the fields ai& routes (provider,
 * default, base_url), the spots they occupied before `on`, and the whole
 * section body the untouched restore hands back. Hermes's stock config is a
 * `model:` mapping hundreds of lines long, most of it comments the user
 * wrote, and `on` rewrites three of those lines and moves a third — so the
 * spots carry enough context to put each one back where it stood, byte for
 * byte, and `off` restores the whole body when nobody edited it.
 */

/** The `model:` body's own indent, taken from its first key-shaped line. */
function modelBodyIndent(body: string[]): string {
  return /^(\s+)\S/.exec(body.find((line) => /^\s+\w/.test(line)) ?? "")?.[1] ?? "  ";
}

/** The key pattern of one `model:` field, anchored at the body's indent. */
function modelFieldPattern(field: "provider" | "default" | "base_url", indent: string): RegExp {
  return field === "provider"
    ? new RegExp(`^${indent}provider\\s*:`)
    : field === "base_url"
      ? new RegExp(`^${indent}base_url\\s*:`)
      : new RegExp(`^${indent}(?:"?default"?|model)\\s*:`);
}

/**
 * One `model:` field plus the spot it occupied: the raw line, its index
 * inside the section body (the indexing restoreHermesModelLine splices by)
 * and the body's indent. The pin drops and rewrites lines, so the body the
 * restore sees is not the body the capture saw — the recorded index is a
 * position to clamp, never an identity to trust.
 */
export type ModelFieldSpot = { line: string; at: number; indent: string };

/** The `model:` body plus the indent it is written at, when the section is a mapping. */
function modelSection(
  lines: string[],
): { at: number; end: number; body: string[]; indent: string } | undefined {
  const section = sectionRange(lines, "model");
  if (!section) return undefined;
  const body = lines.slice(section.at + 1, section.end);
  return { ...section, body, indent: modelBodyIndent(body) };
}

/** Rejoin a file around a rewritten `model:` body: the header stays the bare `model:` key. */
function rejoinModel(
  lines: string[],
  span: { at: number; end: number },
  body: string[],
  trailingNewline: boolean,
  eol: string,
): string {
  return joinYamlLines(
    [
      ...lines.slice(0, span.at),
      keepHeaderComment("model", lines[span.at]!),
      ...body,
      ...lines.slice(span.end),
    ],
    trailingNewline,
    eol,
  );
}

/** One `model:` field with the spot it stood at; undefined when no section or field matched. */
export function modelFieldLineAt(
  text: string,
  field: "provider" | "default" | "base_url",
): ModelFieldSpot | undefined {
  const section = modelSection(splitYamlLines(text).lines);
  const at = section?.body.findIndex((line) => modelFieldPattern(field, section.indent).test(line));
  if (section === undefined || at === undefined || at === -1) return undefined;
  return { line: section.body[at]!, at, indent: section.indent };
}

/** The raw source line of one `model:` field, so off can hand back the exact bytes. */
export function modelFieldLine(
  text: string,
  field: "provider" | "default" | "base_url",
): string | undefined {
  return modelFieldLineAt(text, field)?.line;
}

/** The `model.base_url` spot on drops and off hands back, when the section holds one. */
export function modelBaseUrlSpot(text: string): ModelFieldSpot | undefined {
  return modelFieldLineAt(text, "base_url");
}

/** The `model:` section's body lines as they stand, or undefined with no mapping section. */
export function modelSectionBody(text: string): string[] | undefined {
  const { lines } = splitYamlLines(text);
  const span = sectionRange(lines, "model");
  if (span === null) return undefined;
  // The span's trailing blanks are the separator the user wrote between the
  // section and the next key: carrying them into the record is what lets the
  // restore re-create them exactly, rather than guessing how many there were.
  let end = span.end;
  while (end < lines.length && lines[end]!.trim() === "") end += 1;
  return lines.slice(span.at + 1, end);
}

/**
 * Put the recorded `model:` body back verbatim: `on` rewrites three lines and
 * moves a third, which shuffles the comments and blanks that were written
 * around them, so a per-line restore cannot always return every line to where
 * the user wrote it. Only the untouched case uses this — a hand-edit between
 * on and off keeps the per-line restore, so the user's own line survives.
 */
export function restoreHermesModelBody(text: string, body: string[]): string {
  const { lines, trailingNewline, eol } = splitYamlLines(text);
  throwOnInlineSection(lines, "model");
  const section = modelSection(lines);
  if (!section) return text;
  // `on`'s drop leaves a blank behind where a line used to be, so the seam
  // between the section and the next key can hold one blank more than the
  // user wrote. The recorded body already carries its own separator, so the
  // seam's blanks are swallowed whole: one separator survives, and the file
  // ends up byte-identical to what it was before `on`.
  let end = section.end;
  while (end < lines.length && lines[end]!.trim() === "") end += 1;
  return rejoinModel(lines, { at: section.at, end }, [...body], trailingNewline, eol);
}

/**
 * Drop a stale `model.base_url` in one pass, reporting the spot it stood at
 * beside the rewritten text, so the caller can record exactly what off has
 * to put back (and only then: `dropped` false means nothing changed and the
 * text comes back byte-identical).
 */
export function dropStaleModelBaseUrl(text: string): {
  text: string;
  dropped: boolean;
  spot: ModelFieldSpot | undefined;
} {
  const { lines, trailingNewline, eol } = splitYamlLines(text);
  const empty = { text, dropped: false, spot: undefined };
  throwOnInlineSection(lines, "model");
  const section = modelSection(lines);
  if (!section) return empty;
  const report = dropModelBaseUrl(section.body, section.indent);
  if (!report.dropped) return empty;
  return {
    text: rejoinModel(lines, section, section.body, trailingNewline, eol),
    dropped: true,
    spot: report.spot,
  };
}

/**
 * Put one recorded `model:` line back (or delete the field when none was
 * recorded).
 */
export function restoreHermesModelLine(
  text: string,
  field: "provider" | "default" | "base_url",
  recorded: ModelFieldSpot | string | undefined,
): string {
  const { lines, trailingNewline, eol } = splitYamlLines(text);
  throwOnInlineSection(lines, "model");
  const section = modelSection(lines);
  const line = typeof recorded === "string" ? recorded : recorded?.line;
  // No section left to restore into: a base_url-only body is emptied by the
  // default and provider restores first, so the header is gone by the time
  // the last line comes back (bug #1) — recreate it rather than lose the line.
  if (!section) {
    if (line === undefined) return text;
    return joinYamlLines(["model:", line, ...lines], trailingNewline, eol);
  }
  const { body, indent } = section;
  const pattern = modelFieldPattern(field, indent);
  const at = body.findIndex((candidate) => pattern.test(candidate));
  // Replacing or deleting a multi-line value's header alone strands its
  // body (block scalar, folded body) — refuse instead.
  if (at !== -1 && childValueIsMultiLine(body, at, indent)) {
    throw new CliError(`config.yaml has a multi-line \`model.${field}\` value ai& does not edit.`, {
      hint: INVALID_CONFIG_HINT,
    });
  }
  if (line === undefined) {
    if (at === -1) return text;
    body.splice(at, 1);
    // Our lines were the section's whole body: drop the bare header too.
    if (body.every((candidate) => candidate.trim() === "")) {
      return joinYamlLines(
        [...lines.slice(0, section.at), ...lines.slice(section.end)],
        trailingNewline,
        eol,
      );
    }
    return rejoinModel(lines, section, body, trailingNewline, eol);
  }
  if (at !== -1) {
    // The field is back (the user's own, or a second restore): the recorded
    // line takes that slot, never a second key beside it.
    body.splice(at, 1);
  }
  // The drop and the pins shifted the body, so the recorded index is a
  // position to clamp, never an identity to trust.
  const anchor =
    typeof recorded === "object" && recorded !== undefined
      ? Math.min(Math.max(recorded.at, 0), body.length)
      : undefined;
  if (anchor !== undefined) {
    // A drop that carried a trailing comment left a lone `${indent}# note`
    // placeholder: the recorded line (comment once) takes that slot, so the
    // note never comes back twice (bug #3). The pins can shift the
    // placeholder off its index — scan for it, and fall back to the clamped
    // position only when the user replaced it with their own base_url.
    const line2 = line;
    const note = commentSuffix(line2).trim();
    const holder = note === "" ? -1 : body.indexOf(`${indent}${note}`);
    // A pure insert never eats the neighbour now standing at the anchor.
    body.splice(holder === -1 ? anchor : holder, holder === -1 ? 0 : 1, line2);
  } else if (field === "default") {
    // Beside the provider line, where pinHermesModel puts it.
    const providerAt = body.findIndex((candidate) =>
      modelFieldPattern("provider", indent).test(candidate),
    );
    body.splice(providerAt !== -1 ? providerAt + 1 : body.length, 0, line);
  } else if (field === "base_url") {
    // Last, after the fields pinHermesModel writes in front of it, so the
    // section's own key order survives the round trip.
    body.push(line);
  } else {
    // First, where pinHermesModel puts the provider line.
    body.unshift(line);
  }
  return rejoinModel(lines, section, body, trailingNewline, eol);
}

/**
 * Rewrite (or add) the top-level `model:` mapping of a hermes config:
 * `provider: aiand` always, the pinned model as `default` only when one
 * is given. Indentation follows the section's own keys; the body-less scalar
 * form (`model: ""`, a fresh install's sentinel) is replaced by the mapping.
 * Hermes accepts `model` as an alias for the model id — an alias or
 * `default` line is rewritten to `default`, the key we own.
 */
export function pinHermesModel(text: string, model: string | undefined): string {
  const { lines, trailingNewline, eol } = splitYamlLines(text);
  const pinned = model === undefined ? null : `default: ${JSON.stringify(model)}`;
  throwOnInlineSection(lines, "model");
  const at = lines.findIndex((line) => /^model\s*:/.test(line));
  if (at === -1) {
    const block = ["model:", "  provider: aiand", ...(pinned ? [`  ${pinned}`] : [])];
    return joinYamlLines([...block, ...lines], trailingNewline, eol);
  }
  // An inline empty dict (`model: {}`, PyYAML's empty-dict dump) takes the
  // pinned provider without leaving a stale flow value beside the mapping.
  // An inline empty sequence (`model: []`) is refused like providers:.
  const inlineFlow = /^model\s*:\s*(\{\}|\[\])\s*(#.*)?$/.exec(lines[at]!);
  if (inlineFlow?.[1] === "[]") {
    throw new CliError("config.yaml has a sequence `model:` value ai& does not edit.", {
      hint: INVALID_CONFIG_HINT,
    });
  }
  if (inlineFlow) {
    lines[at] = keepHeaderComment("model", lines[at]!);
  }
  // The scalar form carries no body; a mapping's runs to the next column-0
  // line, blank lines and comments included (then minus the trailing blanks).
  const scalar = /^model\s*:\s*\S/.test(stripTrailingComment(lines[at]!));
  let end = at + 1;
  if (!scalar) {
    while (end < lines.length && isSectionBodyLine(lines[end]!)) end += 1;
  }
  if (!scalar && dropLoneFlowLine(lines, at, end)) {
    end = at + 1;
    while (end < lines.length && isSectionBodyLine(lines[end]!)) end += 1;
  }
  while (end > at + 1 && lines[end - 1]!.trim() === "") end -= 1;
  const body = scalar ? [] : lines.slice(at + 1, end);
  if (!scalar) throwOnSequenceBody(body, "model");
  const header = keepHeaderComment("model", lines[at]!);
  const indent = /^(\s+)\S/.exec(body.find((line) => /^\s+\w/.test(line)) ?? "")?.[1] ?? "  ";
  const providerKey = new RegExp(`^${indent}provider\\s*:`);
  const modelKey = new RegExp(`^${indent}(?:"?default"?|model)\\s*:`);
  const modelIdx = body.findIndex((line) => modelKey.test(line));
  // Splicing the header line alone would strand a multi-line value's body
  // (block scalar, folded body) as invalid YAML — refuse instead.
  // A delete over a multi-line default refuses the same way.
  if (modelIdx !== -1 && childValueIsMultiLine(body, modelIdx, indent)) {
    throw new CliError("config.yaml has a multi-line `model.default` value ai& does not edit.", {
      hint: INVALID_CONFIG_HINT,
    });
  }
  // The dropped default's trailing comment rides onto the fresh pinned line
  // so a `default: u  # keep` pin keeps its note.
  const droppedDefault = pinned !== null ? body.find((line) => modelKey.test(line)) : undefined;
  const defaultSuffix = droppedDefault ? commentSuffix(droppedDefault) : "";
  dropModelBaseUrl(body, indent);
  const out: string[] = [];
  let providerAt = -1;
  for (const line of body) {
    if (providerKey.test(line)) {
      out.push(keepLineComment(`${indent}provider: aiand`, line));
      providerAt = out.length - 1;
    } else if (!(pinned !== null && modelKey.test(line))) {
      out.push(line); // dropped: rewritten after the provider line
    }
  }
  if (providerAt === -1) {
    out.unshift(`${indent}provider: aiand`);
    providerAt = 0;
  }
  if (pinned !== null) {
    const fresh = `${indent}${pinned}`;
    out.splice(providerAt + 1, 0, defaultSuffix ? `${fresh}${defaultSuffix}` : fresh);
  }
  // The header becomes the bare `model:` key: a scalar value left standing
  // in front of the mapping would not parse.
  return joinYamlLines(
    [...lines.slice(0, at), header, ...out, ...lines.slice(end)],
    trailingNewline,
    eol,
  );
}
/**
 * Route one `model:` field through aiand without touching the other, for
 * the keeps the overlay never performs: a kept servable default stays
 * byte-identical while its provider flips. Values already routing stay put.
 */
export function setHermesModelProvider(text: string): string {
  const { lines, trailingNewline, eol } = splitYamlLines(text);
  throwOnInlineSection(lines, "model");
  const section = modelSection(lines);
  if (!section) return text;
  const { body, indent } = section;
  const providerKey = modelFieldPattern("provider", indent);
  const at = body.findIndex((line) => providerKey.test(line));
  const alreadyRouted =
    at !== -1 &&
    unquoteYaml(stripTrailingComment(body[at]!.replace(providerKey, ""))) === HERMES_PROVIDER_ID;
  if (!alreadyRouted) {
    if (at !== -1) {
      body[at] = keepLineComment(`${indent}provider: ${HERMES_PROVIDER_ID}`, body[at]!);
    } else {
      body.unshift(`${indent}provider: ${HERMES_PROVIDER_ID}`);
    }
  }
  // The drop runs before the idempotent return: a provider already reading
  // `aiand` still rides the user's own `model.base_url`, so leaving it in
  // place keeps the endpoint hijack — and recording a restore target for a
  // line nobody dropped makes `off` claim the user edited it.
  const dropped = dropModelBaseUrl(body, indent);
  if (alreadyRouted && !dropped.dropped) return text;
  return rejoinModel(lines, section, body, trailingNewline, eol);
}

/**
 * Drop a `model.base_url` line from a `model:` body about to route through
 * aiand: Hermes's `_api_key_provider_runtime` prefers `model.base_url` over
 * the provider's own endpoint whenever the config's provider matches, so a
 * fresh install's OpenRouter line sends the ai& key there (401 "Missing
 * Authentication header"). The line's trailing comment survives as its own
 * line at the same indent — the note named the endpoint that must not be
 * used, and dropping the whole line would drop it. Returns whether one was
 * found, so the callers can stay byte-identical when there is nothing to do.
 */
function dropModelBaseUrl(
  body: string[],
  indent: string,
): { dropped: boolean; spot: ModelFieldSpot | undefined } {
  const key = new RegExp(`^${indent}base_url\\s*:`);
  let dropped = false;
  let spot: ModelFieldSpot | undefined;
  // Backwards, so a splice never shifts the index of a line still to visit.
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const line = body[i]!;
    if (!key.test(line)) continue;
    // Dropping a block scalar's header would strand its body as invalid
    // YAML: refuse the same way the default pin does.
    if (childValueIsMultiLine(body, i, indent)) {
      throw new CliError("config.yaml has a multi-line `model.base_url` value ai& does not edit.", {
        hint: INVALID_CONFIG_HINT,
      });
    }
    spot = { line, at: i, indent };
    const comment = commentSuffix(line).trim();
    body.splice(i, 1, ...(comment === "" ? [] : [`${indent}${comment}`]));
    dropped = true;
  }
  return { dropped, spot };
}
