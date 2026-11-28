import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AGENTS } from "../dist/agents/registry.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIST = JSON.parse(readFileSync(join(ROOT, "docs", "network-egress.json"), "utf8"));
const CONTACTS = new Set(["code", "redirect", "npm", "agent"]);
const NON_AGENT = ["cli", "installer", "sign-in", "links"];
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/** Hosts a test double or an example names; never real egress. */
const notEgress = (host) =>
  host === "localhost" ||
  /^\d+(\.\d+){3}$/.test(host) ||
  /\.(example|invalid|test|localhost)$/.test(host) ||
  host === "example.com";

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

/**
 * A line's code with comments dropped: a host named only in a comment is
 * documentation, not traffic. `//` preceded by `:` is a URL, not a comment.
 */
function codeOf(line, file) {
  const trimmed = line.trimStart();
  if (file.endsWith(".ts")) {
    if (/^(\/\/|\/\*|\*)/.test(trimmed)) return "";
    return line.replace(/(^|[^:])\/\/.*$/, "$1");
  }
  return trimmed.startsWith("#") ? "" : line;
}

/** Every top-level domain IANA delegates, so a hostname on any of them is caught. */
const TLDS = new Set(
  readFileSync(join(ROOT, "test", "iana-tlds.txt"), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#")),
);
/**
 * TLDs that are also file extensions (`"install.sh"`); a host on one of them
 * (`omp.sh`) is still caught in URL form.
 */
const FILE_EXTENSIONS = new Set(["md", "py", "sh", "zip"]);
const LABELS = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/** A static lowercase name ending in a delegated TLD, or null. */
function hostLike(name, inUrl = false) {
  if (!LABELS.test(name)) return null;
  const tld = name.slice(name.lastIndexOf(".") + 1);
  return TLDS.has(tld) && (inUrl || !FILE_EXTENSIONS.has(tld)) ? name : null;
}

/** What is left of a template once its last substitution (`${x}`, `$x`) is dropped. */
const staticTail = (text) => text.replace(/^.*\}/, "").replace(/^\$[A-Za-z_][\w:]*/, "");

/**
 * The hosts and host fragments one line of code names. A host is a URL's
 * authority or a quoted hostname on any TLD; a fragment (`.ingest.sentry.io`)
 * is the static end of a host built from a template or by joining strings.
 */
function namesIn(code) {
  const hosts = [];
  const fragments = [];
  // Case is kept: hostnames in code are lowercase, and `"iTerm.app"` is not one.
  const take = (raw, inUrl = false) => {
    const name = raw.replace(/\.$/, "");
    if (name.startsWith(".")) {
      const rest = hostLike(name.slice(1), inUrl);
      if (rest?.includes(".")) fragments.push(name);
    } else if (hostLike(name, inUrl)) {
      hosts.push(name);
    }
  };
  for (const [, authority] of code.matchAll(/\b(?:https?|wss?):\/\/([^\s"'`/?#\\]+)/gi)) {
    const host = authority
      .replace(/^[^@]*@/, "")
      .replace(/:\d+$/, "")
      .toLowerCase();
    take(/[${}]/.test(host) ? staticTail(host) : host, true);
  }
  for (const [, , content] of code.matchAll(/(["'`])([^"'`\s]*)\1/g)) {
    if (/:\/\//.test(content)) continue;
    take(/[${}]/.test(content) ? staticTail(content) : content);
  }
  return { hosts, fragments };
}

/** Every host and fragment `files` name outside comments, each with where. */
function namedIn(files) {
  const hosts = new Map();
  const fragments = new Map();
  const add = (map, name, where) => map.set(name, [...(map.get(name) ?? []), where]);
  for (const file of files) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        const where = `${relative(ROOT, file)}:${index + 1}`;
        const named = namesIn(codeOf(line, file));
        for (const host of named.hosts) if (!notEgress(host)) add(hosts, host, where);
        for (const fragment of named.fragments)
          if (!notEgress(fragment)) add(fragments, fragment, where);
      });
  }
  return { hosts, fragments };
}

const SCANNED = namedIn([
  ...sourceFiles(join(ROOT, "src")),
  join(ROOT, "install.sh"),
  join(ROOT, "install.ps1"),
]);
const NAMED = SCANNED.hosts;
const componentIds = LIST.components.map((component) => component.id);
const agentIds = AGENTS.map((adapter) => adapter.id);

test("every host entry is well formed and bilingual", () => {
  const seen = new Set();
  for (const entry of LIST.hosts) {
    const label = `${entry.host} (${entry.component})`;
    assert.match(entry.host, HOSTNAME, `${label}: a bare lowercase hostname, no scheme or port`);
    assert.ok(componentIds.includes(entry.component), `${label}: unknown component`);
    assert.ok(CONTACTS.has(entry.contact), `${label}: contact must be one of ${[...CONTACTS]}`);
    assert.equal(typeof entry.required, "boolean", `${label}: required is a boolean`);
    for (const field of ["purpose", ...(entry.disable ? ["disable"] : [])]) {
      for (const locale of ["en", "ja"]) {
        assert.ok(entry[field]?.[locale]?.trim(), `${label}: ${field}.${locale} is missing`);
      }
    }
    assert.ok(entry.required || entry.disable, `${label}: an optional host says how to avoid it`);
    const key = `${entry.host} ${entry.component} ${entry.purpose.en}`;
    assert.ok(!seen.has(key), `${label}: listed twice`);
    seen.add(key);
  }
  for (const component of LIST.components) {
    for (const locale of ["en", "ja"]) assert.ok(component.name?.[locale], component.id);
  }
});

test("the components are the CLI's own plus exactly the registered agents", () => {
  assert.deepEqual(
    componentIds.filter((id) => !NON_AGENT.includes(id)),
    agentIds,
    "one agent component per adapter in src/agents/registry.ts, in its order",
  );
  for (const component of LIST.components) {
    assert.equal(Boolean(component.agent), agentIds.includes(component.id), component.id);
    assert.ok(
      LIST.hosts.some((entry) => entry.component === component.id),
      `${component.id} lists no host`,
    );
  }
});

test("every host src/ or an installer names is in the list", () => {
  const listed = new Set(
    LIST.hosts.filter((entry) => entry.contact === "code").map((entry) => entry.host),
  );
  const missing = [...NAMED].filter(([host]) => !listed.has(host));
  assert.deepEqual(
    missing,
    [],
    `add these hosts to docs/network-egress.json (contact "code"), then run node scripts/render-it-admin-network.mjs:\n${missing
      .map(([host, where]) => `  ${host}: ${where.join(", ")}`)
      .join("\n")}`,
  );
});

test("every host fragment src/ or an installer builds ends a listed host", () => {
  const listed = LIST.hosts.map((entry) => `.${entry.host}`);
  const unmatched = [...SCANNED.fragments].filter(
    ([fragment]) => !listed.some((host) => host.endsWith(fragment)),
  );
  assert.deepEqual(
    unmatched,
    [],
    `these host fragments build hosts docs/network-egress.json does not list:\n${unmatched
      .map(([fragment, where]) => `  ${fragment}: ${where.join(", ")}`)
      .join("\n")}`,
  );
});

test("the scanner finds quoted hosts on any TLD, template URLs and joined strings", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiand-egress-probe-"));
  const probe = join(dir, "probe.ts");
  const SUB = "$"; // a template substitution in the probe's own code
  try {
    writeFileSync(
      probe,
      [
        'const a = "telemetry.vendor.jp";',
        `const b = \`https://${SUB}{region}.ingest.sentry.io/api/1/store\`;`,
        'const c = "metrics" + ".vendor.jp";',
        'const d = fetch("https://api.vendor.co.uk/v1");',
        `const e = \`${SUB}{prefix}.collector.vendor.io\`;`,
        '// const f = "https://only-in-a-comment.vendor.jp";',
        'const g = ["settings.json", "install.sh", "iTerm.app", "config.toml"];',
      ].join("\n"),
    );
    const { hosts, fragments } = namedIn([probe]);
    assert.deepEqual([...hosts.keys()].sort(), ["api.vendor.co.uk", "telemetry.vendor.jp"]);
    assert.deepEqual([...fragments.keys()].sort(), [
      ".collector.vendor.io",
      ".ingest.sentry.io",
      ".vendor.jp",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every host the list says the code names is still named there", () => {
  for (const entry of LIST.hosts.filter((e) => e.contact === "code")) {
    const where = NAMED.get(entry.host) ?? [];
    const scoped =
      entry.component === "installer"
        ? where.filter((w) => w.startsWith("install."))
        : entry.component === "links"
          ? where
          : where.filter((w) => w.startsWith("src/"));
    assert.ok(
      scoped.length > 0,
      `${entry.host} (${entry.component}) is listed as named in the code, but nothing uses it`,
    );
  }
});

test("redirect, npm and agent entries name what reaches them", () => {
  const codeHosts = new Set(LIST.hosts.filter((e) => e.contact === "code").map((e) => e.host));
  for (const entry of LIST.hosts) {
    const label = `${entry.host} (${entry.component})`;
    if (entry.contact === "redirect") {
      assert.ok(codeHosts.has(entry.via), `${label}: via ${entry.via} must be a listed code host`);
    } else {
      assert.equal(entry.via, undefined, `${label}: only a redirect has via`);
    }
    if (entry.contact === "npm") {
      const adapter = AGENTS.find((a) => a.id === entry.component);
      assert.match(
        adapter?.install.command ?? "",
        /^npm install -g /,
        `${label}: only an agent the CLI installs with npm reaches the registry through npm`,
      );
    }
    if (entry.contact === "agent") {
      assert.ok(agentIds.includes(entry.component), `${label}: an agent's own traffic`);
      assert.match(entry.source ?? "", /^https:\/\//, `${label}: cite a public source`);
    }
  }
});

test("each agent's entries name the version aiand installs, so a bump forces a re-check", () => {
  const pinned = /\d+\.\d+\.\d+|[0-9a-f]{40}/;
  for (const adapter of AGENTS) {
    const component = LIST.components.find((c) => c.id === adapter.id);
    const command = adapter.install.command;
    if (component.version === null) {
      assert.doesNotMatch(command, pinned, `${adapter.id} pins a version now; record it`);
      continue;
    }
    assert.ok(
      command.includes(component.version),
      `${adapter.id}: docs/network-egress.json was checked at ${component.version}, but aiand installs ${command}. Re-check the agent's hosts at the new version, then update its version and sources.`,
    );
    for (const entry of LIST.hosts.filter((e) => e.component === adapter.id && e.source)) {
      if (!/^https:\/\/(github\.com|unpkg\.com)\//.test(entry.source)) continue;
      assert.ok(
        entry.source.includes(component.version),
        `${entry.host} (${adapter.id}): ${entry.source} is not at ${component.version}`,
      );
    }
  }
});

test("each agent's install command and docs link hosts are listed for it", () => {
  for (const adapter of AGENTS) {
    const hosts = [
      ...[...adapter.install.command.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => [
        m[1],
        adapter.id,
      ]),
      [new URL(adapter.install.url).hostname, "links"],
    ];
    for (const [host, component] of hosts) {
      assert.ok(
        LIST.hosts.some((e) => e.host === host && e.component === component),
        `${host} (from ${adapter.id}'s install hint) must be listed under ${component}`,
      );
    }
    if (/^npm install -g /.test(adapter.install.command)) {
      assert.ok(
        LIST.hosts.some(
          (e) =>
            e.component === adapter.id && e.contact === "npm" && e.host === "registry.npmjs.org",
        ),
        `${adapter.id} installs with npm, so registry.npmjs.org is listed for it`,
      );
    }
  }
});
