// Repository hygiene: refuses content that should not be in a public package.
//
// Everything here is public the moment it lands, including code comments —
// TypeScript carries them into `dist` untouched, so a note written for a
// teammate becomes part of the published tarball.
//
// The rules below match *shapes*, never a list of specific terms. A checked-in
// denylist of the exact strings you are trying to keep out discloses them by
// existing, so each rule describes a category structurally: hostnames that
// aren't the documented endpoints, service-name shapes, ticket-reference
// shapes, absolute home paths, credential shapes.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** Everything authored or published. `dist` is included deliberately. */
const ROOTS = ["src", "scripts", ".github", "dist", "README.md", "CHANGELOG.md", "package.json"];

const SKIP_DIRS = new Set(["node_modules", ".git", "coverage"]);
const SCAN_EXT = new Set([".ts", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml"]);

/** The only hostnames this project has any business naming. */
const PUBLIC_HOSTS = new Set(["api.aiand.com", "console.aiand.com", "docs.aiand.com"]);

const RULES = [
  {
    name: "undocumented hostname",
    pattern: /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.aiand\.com\b/gi,
    // Only the documented endpoints may appear; anything else is environment
    // detail that users neither need nor should see.
    allow: (match) => PUBLIC_HOSTS.has(match.toLowerCase()),
    hint: `Name only ${[...PUBLIC_HOSTS].join(", ")}.`,
  },
  {
    name: "internal service name",
    // Any `<prefix>-<name>` service identifier, without listing which exist.
    pattern: /\b(?:worker|svc|service)-[a-z][a-z0-9]*(?:-[a-z0-9]+)*\b/gi,
    hint: "Describe what the API does, not the service that implements it.",
  },
  {
    name: "private workspace package",
    // A scoped package from a scope this repo does not publish under.
    pattern: /@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*/gi,
    allow: (match) =>
      match.startsWith("@aiand/") ||
      match.startsWith("@types/") ||
      match.startsWith("@opencode-ai/") ||
      match.startsWith("@anthropic-ai/") ||
      match.startsWith("@openai/"),
    hint: "Reference only published packages.",
  },
  {
    name: "private repository tooling",
    pattern: /\b(?:pnpm|turbo|wrangler|nx|lerna)\b/gi,
    hint: "This project builds with npm and tsc; do not reference other repositories' tooling.",
  },
  {
    name: "issue tracker reference",
    pattern: /\b[A-Z]{2,6}-\d{1,6}\b/g,
    // Standards and encodings share the shape; they are not ticket references.
    allow: (match) =>
      /^(?:RFC|UTF|SHA|ISO|ANSI|AES|RSA|HTTP|IPv|EC|P|CVE|SLSA|ES)-?\d/i.test(match),
    hint: "Internal ticket identifiers must not be published.",
  },
  {
    name: "absolute home path",
    pattern: /\/(?:Users|home)\/[a-z0-9._-]+\//gi,
    hint: "Use a relative path, ~, or an environment variable.",
  },
  {
    name: "credential-shaped string",
    // A live key is the prefix plus 64 hex; masked examples in docs are short.
    pattern: /\bsk-[0-9a-f]{24,}\b/gi,
    hint: "Never commit an API key, even a revoked one.",
  },
  {
    name: "private-context aside",
    // Notes written for teammates: "internal only", "do not ship", "TODO(name)".
    pattern: /\b(?:internal[- ]only|do not ship|for the team|our monorepo|the monorepo)\b/gi,
    hint: "Rewrite for a reader outside the organization, or delete it.",
  },
];

function* walk(entry) {
  const absolute = join(ROOT, entry);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return; // `dist` is absent before a build; not a failure of this check.
  }
  if (stats.isFile()) {
    yield entry;
    return;
  }
  for (const child of readdirSync(absolute)) {
    if (SKIP_DIRS.has(child)) continue;
    yield* walk(join(entry, child));
  }
}

const findings = [];

for (const target of ROOTS) {
  for (const file of walk(target)) {
    if (file.endsWith(".map")) continue;
    const dot = file.lastIndexOf(".");
    if (dot !== -1 && !SCAN_EXT.has(file.slice(dot))) continue;
    // This file defines the patterns, so it necessarily contains them.
    if (file.endsWith("check-public.mjs")) continue;

    readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .forEach((line, index) => {
        for (const rule of RULES) {
          rule.pattern.lastIndex = 0;
          for (const match of line.matchAll(rule.pattern)) {
            if (rule.allow?.(match[0])) continue;
            findings.push({
              file,
              line: index + 1,
              rule: rule.name,
              match: match[0],
              hint: rule.hint,
              context: line.trim().slice(0, 100),
            });
            break;
          }
        }
      });
  }
}

if (findings.length > 0) {
  console.error(
    `check-public failed: ${findings.length} item${findings.length === 1 ? "" : "s"} should not be published.\n`
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}]  "${f.match}"`);
    console.error(`    ${f.context}`);
    console.error(`    ${f.hint}\n`);
  }
  process.exit(1);
}

console.log(`check-public ok: ${RULES.length} rules, nothing to redact`);
