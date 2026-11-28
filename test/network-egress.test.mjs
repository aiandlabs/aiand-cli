import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

/** Every host src/ and the installers name in a URL or as a bare quoted hostname, with where. */
function namedHosts() {
  const files = [
    ...sourceFiles(join(ROOT, "src")),
    join(ROOT, "install.sh"),
    join(ROOT, "install.ps1"),
  ];
  const found = new Map();
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      const code = codeOf(line, file);
      const hosts = [
        ...[...code.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]),
        ...[...code.matchAll(/["'`]([a-z0-9-]+(?:\.[a-z0-9-]+)+)["'`]/gi)]
          .map((m) => m[1])
          .filter((name) => /^[a-z0-9.-]+\.(com|ai|dev|io|org|net|co)$/.test(name)),
      ];
      for (const raw of hosts) {
        const host = raw.toLowerCase().replace(/\.$/, "");
        if (!host || notEgress(host)) continue;
        const where = `${relative(ROOT, file)}:${index + 1}`;
        found.set(host, [...(found.get(host) ?? []), where]);
      }
    });
  }
  return found;
}

const NAMED = namedHosts();
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
