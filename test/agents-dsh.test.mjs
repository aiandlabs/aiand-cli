// dsh adapter: the on/off/status wiring the ai& gateway needs for a
// DeepSeek Harness session. The adapter owns two files under
// $DSH_HOME: the home patch layer (cordis.patch.yml) and the
// credential store (.credentials.yaml).
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import { enableInput as baseEnableInput, catalogModel, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-dsh-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  mkdirSync(process.env.AIAND_HOME, { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { dshAdapter } = await import("../dist/agents/dsh/adapter.js");
const { CliError } = await import("../dist/cli/errors.js");
const { snapshotFiles } = await import("../dist/agents/snapshot.js");

const GLM = "zai-org/glm-5.3";
const KIMI = "moonshotai/kimi-k3";
const CATALOG = [catalogModel(GLM, { capabilities: ["tools", "vision"] }), catalogModel(KIMI)];

const BANNER = "# Managed by aiand: `aiand dsh off` removes this row.";
const MARKER = "x-aiand: true";
const KEY_REF = "AIAND_DSH_API_KEY";

/** The llm-pi-ai row `on` writes: every catalog model through the gateway. */
const LLM_ROW = `${BANNER}
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      aiand:
        ${MARKER}
        displayName: aiand
        api: openai-completions
        baseURL: https://api.aiand.com/v1
        apiKeyEnv: ${KEY_REF}
        compat:
          supportsReasoningEffort: false
        models:
          - id: ${GLM}
            name: ${GLM}
            contextWindow: 128000
            maxTokens: 128000
            input: [text, image]
          - id: ${KIMI}
            name: ${KIMI}
            contextWindow: 128000
            maxTokens: 128000
            input: [text]`;

/** The agent-default-model row `on` writes. */
const DEFAULT_ROW = `${BANNER}
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    ${MARKER}
    provider: aiand
    model: ${GLM}`;

const credentials = (key) => `version: 1\nrefs:\n  ${KEY_REF}: ${key}\n`;

/** A user's patch layer: their own row and comment, which must survive byte for byte. */
const USER_PATCH = [
  "# user comment",
  "- id: session-persistence-jsonl",
  "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
  "  config:",
  "    root: ~/.dsh/sessions",
  "",
].join("\n");

const USER_CREDENTIALS = "version: 1\nrefs:\n  OTHER_PROVIDER_KEY: user-secret\n";

/** A user's default-model row: what `on` sets aside and `off` hands back. */
const USER_DEFAULT_ROW = `- id: agent-default-model
  name: 'mine'
  config:
    provider: myroute
    model: my-model
`;

/** The hand-back shape: the user's values in aiand's row, unmarked. */
const RESTORED_DEFAULT_ROW = `- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: myroute
    model: my-model
`;

const dshHomeDir = () => process.env.DSH_HOME || join(process.env.AIAND_HOME, ".dsh");
const patchPath = () => join(dshHomeDir(), "cordis.patch.yml");
const credsPath = () => join(dshHomeDir(), ".credentials.yaml");
const readPatch = () => readFileSync(patchPath(), "utf8");
const readCreds = () => readFileSync(credsPath(), "utf8");
const mode = (path) => statSync(path).mode & 0o777;
const addedRecord = () => join(process.env.AIAND_CONFIG_DIR, "snapshots", "dsh", "added.json");
const readRecord = () => JSON.parse(readFileSync(addedRecord(), "utf8"));

const seedPatch = (text) => {
  mkdirSync(dshHomeDir(), { recursive: true });
  writeFileSync(patchPath(), text);
};
const seedCreds = (text) => {
  mkdirSync(dshHomeDir(), { recursive: true });
  writeFileSync(credsPath(), text);
};

const enableInput = (overrides = {}) =>
  baseEnableInput({
    apiKey: "sk-enable-1",
    model: GLM,
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
    profileName: "default",
    ...overrides,
  });

/** Run fn with process.stdin.isTTY forced, restoring whatever was there. */
const withStdinTty = async (tty, fn) => {
  const saved = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
  try {
    return await fn();
  } finally {
    if (saved) Object.defineProperty(process.stdin, "isTTY", saved);
    else delete process.stdin.isTTY;
  }
};

beforeEach(() => {
  delete process.env.DSH_HOME;
  rmSync(join(process.env.AIAND_HOME, ".dsh"), { recursive: true, force: true });
  rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "dsh"), {
    recursive: true,
    force: true,
  });
});

describe("dsh adapter", () => {
  test("id/label/bin/install/managedFiles", () => {
    assert.equal(dshAdapter.id, "dsh");
    assert.equal(dshAdapter.label, "DeepSeek Harness");
    assert.equal(dshAdapter.bin, "dsh");
    assert.match(dshAdapter.install.command, /@deepseek-ai\/dsh@/);
    assert.equal(dshAdapter.install.url, "https://deepseek.com/en/harness/");
    assert.deepEqual(dshAdapter.managedFiles(), [patchPath(), credsPath()]);
  });
});

describe("dsh on", () => {
  test("writes both rows and the credential ref, with the exact bytes", async () => {
    const result = await dshAdapter.enable(enableInput());
    assert.equal(readPatch(), `\n${LLM_ROW}\n${DEFAULT_ROW}\n`);
    assert.equal(readCreds(), credentials("sk-enable-1"));
    assert.equal(mode(patchPath()), 0o644, "a patch file on creates takes the ordinary mode");
    assert.equal(mode(credsPath()), 0o600, "the credential file is owner-only");
    assert.deepEqual(result, {
      model: GLM,
      catalogModel: GLM,
      filesWritten: [patchPath(), credsPath()],
      warnings: [],
    });
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: GLM });
    assert.ok(!readPatch().includes("sk-"), "the key never rides in the patch layer");
  });

  test("keeps a user patch file's mode and a user credential file's other refs", async () => {
    seedPatch(USER_PATCH);
    chmodSync(patchPath(), 0o600);
    seedCreds(USER_CREDENTIALS);
    chmodSync(credsPath(), 0o600);
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    assert.equal(mode(patchPath()), 0o600, "a pre-existing patch mode survives on");
    assert.equal(mode(credsPath()), 0o600);
    assert.equal(
      readCreds(),
      "version: 1\nrefs:\n  OTHER_PROVIDER_KEY: user-secret\n  AIAND_DSH_API_KEY: sk-enable-1\n",
    );
  });

  test("normalizes the base URL and falls back to the default origin", async () => {
    await dshAdapter.enable(enableInput({ baseUrl: "https://api.aiand.com/" }));
    assert.ok(
      readPatch().includes("baseURL: https://api.aiand.com/v1"),
      "a trailing slash is trimmed",
    );
    rmSync(dshHomeDir(), { recursive: true, force: true });
    await dshAdapter.enable(enableInput({ baseUrl: undefined }));
    assert.ok(
      readPatch().includes("baseURL: https://api.aiand.com/v1"),
      "the default origin is used",
    );
  });

  test("a re-on keeps the first capture and a model picked inside our routing", async () => {
    seedPatch(USER_DEFAULT_ROW);
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    const first = await dshAdapter.enable(enableInput());
    assert.ok(
      first.warnings.some((w) => w.includes("Set aside your dsh default (myroute/my-model)")),
    );
    // A --model re-on repins the default model; the undo target stays the first capture's.
    const repin = await dshAdapter.enable(enableInput({ model: KIMI, pinModel: true }));
    assert.equal(repin.model, KIMI);
    assert.ok(readPatch().includes(`model: ${KIMI}`));
    assert.equal(readRecord().previousProvider, "myroute");
    assert.equal(readRecord().previousModel, "my-model");
    // A plain re-on keeps the pick and the first record, and rotates the key.
    await dshAdapter.enable(enableInput({ apiKey: "sk-enable-2" }));
    assert.equal(readCreds(), credentials("sk-enable-2"));
    assert.equal(readRecord().previousProvider, "myroute");
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: KIMI });
    // Off still hands the set-aside default back, unmarked (the
    // re-on chain stacks ownership banners above the row; their
    // count is incidental, the user's values are what matter).
    await dshAdapter.disable();
    const restored = readPatch();
    assert.ok(restored.includes(RESTORED_DEFAULT_ROW), "the set-aside default is handed back");
    assert.ok(!restored.includes(MARKER), "the hand-back row is unmarked");
    assert.equal(existsSync(credsPath()), false);
  });

  test("--model native is refused and nothing is written", async () => {
    await assert.rejects(
      dshAdapter.enable(enableInput({ model: "native" })),
      (error) => error instanceof CliError && /not on ai&/.test(error.message),
    );
    assert.equal(existsSync(patchPath()), false);
    assert.equal(existsSync(credsPath()), false);
  });

  test("refuses a hand-written llm-pi-ai row that declares providers", async () => {
    const foreign = [
      "- id: llm-pi-ai",
      "  name: 'mine'",
      "  config:",
      "    providers:",
      "      openai:",
      "        baseURL: https://api.openai.com/v1",
      "",
    ].join("\n");
    seedPatch(foreign);
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
    assert.equal(readPatch(), foreign, "the user's row is untouched");
    assert.equal(existsSync(credsPath()), false);
  });

  test("refuses a flow-style providers row instead of clobbering it", async () => {
    const foreign = [
      "- id: llm-pi-ai",
      "  name: 'mine'",
      "  config:",
      "    providers: {openai: {baseURL: https://api.openai.com/v1}}",
      "",
    ].join("\n");
    seedPatch(foreign);
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
    assert.equal(readPatch(), foreign, "the user's row is untouched");
  });

  test("a row the parser cannot read becomes a CliError naming the file", async () => {
    const broken = [
      "- id: llm-pi-ai",
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      "  config:",
      "    baseURL: https://api.aiand.com/v1",
      "    baseURL: https://api.aiand.com/v1",
      "    apiKeyEnv: AIAND_DSH_API_KEY",
      "",
    ].join("\n");
    seedPatch(broken);
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) =>
        error instanceof CliError &&
        /is not a patch file aiand can read/.test(error.message) &&
        /duplicate baseURL/.test(error.message),
    );
    assert.equal(readPatch(), broken, "the user's file is untouched");
  });

  test("a foreign credentials document is a CliError, nothing written", async () => {
    seedCreds("records:\n  x: y\n");
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) =>
        error instanceof CliError && /is not a credentials file aiand can read/.test(error.message),
    );
    assert.equal(readCreds(), "records:\n  x: y\n", "the user's file is untouched");
    assert.equal(existsSync(patchPath()), false, "no half-wired home");
  });

  test("the credentials error never echoes the file's first line", async () => {
    // A file whose first line is a bare secret must not leak it through the
    // error message (which lands in logs and --json output).
    seedCreds("sk-test-a-value-that-looks-like-a-key\n");
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) => !error.message.includes("sk-test-a-value-that-looks-like-a-key"),
    );
  });
});

describe("dsh off", () => {
  test("removes exactly what on added; user content survives byte for byte", async () => {
    seedPatch(USER_PATCH);
    seedCreds(USER_CREDENTIALS);
    chmodSync(patchPath(), 0o600);
    chmodSync(credsPath(), 0o600);
    // The command layer snapshots before the first write; seed that
    // here so the manifest records which files the user had.
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    assert.equal(readPatch(), `${USER_PATCH}${LLM_ROW}\n${DEFAULT_ROW}\n`);
    const off = await dshAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(readPatch(), USER_PATCH);
    assert.equal(readCreds(), USER_CREDENTIALS);
    assert.equal(mode(patchPath()), 0o600, "off restores the pre-on patch mode");
    assert.equal(mode(credsPath()), 0o600, "off restores the pre-on credential mode");
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
    assert.equal((await dshAdapter.disable()).stripped, false, "a second off is a no-op");
  });

  test("unlinks the files on created once off empties them", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    const off = await dshAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(existsSync(patchPath()), false, "cordis.patch.yml held only our rows");
    assert.equal(existsSync(credsPath()), false, ".credentials.yaml held only our key");
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
  });

  test("leaves a route the user repointed, with a note", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    seedPatch(
      readPatch().replace(
        "baseURL: https://api.aiand.com/v1",
        "baseURL: https://api.example.com/v1",
      ),
    );
    const off = await dshAdapter.disable();
    assert.equal(off.stripped, true);
    assert.ok(off.notes?.includes("left the aiand route because you edited it"));
    const after = readPatch();
    assert.ok(after.includes("baseURL: https://api.example.com/v1"), "the user's routing stays");
    assert.ok(after.includes(`apiKeyEnv: ${KEY_REF}`), "the ref name stays with the routing");
    assert.ok(!after.includes(MARKER), "the ownership marker is stripped");
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
    assert.equal(existsSync(credsPath()), false, "the baked key never outlives the strip");
    assert.equal((await dshAdapter.disable()).stripped, false);
  });

  test("hands back a default it set aside, unmarked", async () => {
    seedPatch(USER_DEFAULT_ROW);
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    const on = await dshAdapter.enable(enableInput());
    assert.ok(on.warnings.some((w) => w.includes("Set aside your dsh default (myroute/my-model)")));
    await dshAdapter.disable();
    assert.equal(readPatch(), `${BANNER}\n${RESTORED_DEFAULT_ROW}`);
    assert.equal(existsSync(credsPath()), false);
  });

  test("keeps a servable model the user picked inside our routing", async () => {
    await dshAdapter.enable(enableInput());
    seedPatch(readPatch().replace(`model: ${GLM}`, `model: ${KIMI}`));
    const result = await dshAdapter.enable(enableInput());
    assert.equal(result.model, KIMI);
    assert.ok(!result.warnings.some((w) => w.includes("Set aside")));
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: KIMI });
  });
});

describe("dsh status and keys", () => {
  test("probe reads the patch file itself", async () => {
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null }, "no patch file");
    seedPatch(USER_PATCH);
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null }, "no aiand row");
    await dshAdapter.enable(enableInput());
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: GLM });
    seedPatch(readPatch().replace(`model: ${GLM}`, `model: ${KIMI}`));
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: KIMI });
  });

  test("probe reports routing live but unpinned when the default row is not ours", async () => {
    await dshAdapter.enable(enableInput());
    // Drop the default row's marker alone (column-4 indent; the llm
    // row's marker sits at column 8).
    seedPatch(readPatch().replace(/^ {4}x-aiand: true\n/m, ""));
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: null });
  });

  test("refreshKey swaps only the key literal, gated on previousKey", async () => {
    assert.equal(await dshAdapter.refreshKey({ apiKey: "sk-new" }), false, "nothing wired");
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    // Same key: an idempotent no-op that still re-tightens a loosened mode.
    assert.equal(await dshAdapter.refreshKey({ apiKey: "sk-enable-1" }), true);
    chmodSync(credsPath(), 0o644);
    assert.equal(await dshAdapter.refreshKey({ apiKey: "sk-enable-1" }), true);
    assert.equal(mode(credsPath()), 0o600);
    // A rotation from a key that is not the baked one is a no-op.
    assert.equal(
      await dshAdapter.refreshKey({ apiKey: "sk-newer", previousKey: "sk-someone-else" }),
      false,
    );
    assert.equal(readCreds(), credentials("sk-enable-1"));
    // The baked key is the one being replaced: swap it.
    assert.equal(
      await dshAdapter.refreshKey({ apiKey: "sk-newer", previousKey: "sk-enable-1" }),
      true,
    );
    assert.equal(readCreds(), credentials("sk-newer"));
    assert.equal(mode(credsPath()), 0o600);
  });
});

describe("dsh ownership proof", () => {
  /** Drop the llm row's ownership marker (column-8 indent), as a rewrite might. */
  const dropMarker = () => {
    seedPatch(readPatch().replace(/^ {8}x-aiand: true\n/m, ""));
  };

  test("probe: a dropped marker still reads active while the record proof holds", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    dropMarker();
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: GLM });
  });

  test("probe: a repointed route reads inactive even with a live record", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    dropMarker();
    seedPatch(readPatch().replace("https://api.aiand.com/v1", "https://foreign.example/v1"));
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
  });

  test("off: strips when the marker is gone but the record proof holds", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    dropMarker();
    const off = await dshAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(existsSync(patchPath()), false);
    assert.equal(existsSync(credsPath()), false);
    assert.equal(existsSync(addedRecord()), false, "the record is cleared with the strip");
  });

  test("a re-on re-bakes a row whose marker a rewrite dropped", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    dropMarker();
    await dshAdapter.enable(enableInput({ apiKey: "sk-enable-2" }));
    assert.ok(readPatch().includes(MARKER));
    assert.equal(readCreds(), credentials("sk-enable-2"));
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: GLM });
  });

  test("refreshKey: a dropped marker still swaps while the record proof holds", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    dropMarker();
    assert.equal(
      await dshAdapter.refreshKey({ apiKey: "sk-new-1", previousKey: "sk-enable-1" }),
      true,
    );
    assert.equal(readCreds(), credentials("sk-new-1"));
  });

  test("refreshKey: a repointed route returns false, byte-identical", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    dropMarker();
    seedPatch(readPatch().replace("https://api.aiand.com/v1", "https://foreign.example/v1"));
    const before = readCreds();
    assert.equal(await dshAdapter.refreshKey({ apiKey: "sk-new-1" }), false);
    assert.equal(readCreds(), before);
  });

  test("refreshKey: an unreadable patch returns false, never throws", async () => {
    seedPatch("{broken\n");
    assert.equal(await dshAdapter.refreshKey({ apiKey: "sk-new-1" }), false);
  });

  test("probe: a row the parser cannot read reads inactive, never throws", async () => {
    seedPatch(
      [
        "- id: llm-pi-ai",
        "  name: '@deepseek-ai/dsh-llm-pi-ai'",
        "  config:",
        "    baseURL: https://api.aiand.com/v1",
        "    baseURL: https://api.aiand.com/v1",
        "    apiKeyEnv: AIAND_DSH_API_KEY",
        "",
      ].join("\n"),
    );
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
  });

  test("off: a file broken after on drops the key, keeps the record, and recovers", async () => {
    // The pi#353 class: a raw throw between the two writes must never strand
    // the baked key in the credential file.
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    seedPatch(
      readPatch().replace(
        "baseURL: https://api.aiand.com/v1",
        "baseURL: https://api.aiand.com/v1\n        baseURL: https://api.aiand.com/v1",
      ),
    );
    await assert.rejects(
      dshAdapter.disable(),
      (error) =>
        error instanceof CliError && /is not a patch file aiand can read/.test(error.message),
    );
    assert.ok(!readCreds().includes("sk-enable-1"), "the baked key is gone");
    // Fix the file: the record survived, so a second off completes the strip.
    seedPatch(readPatch().replace("        baseURL: https://api.aiand.com/v1\n", ""));
    const off = await dshAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(existsSync(patchPath()), false);
    assert.equal(existsSync(credsPath()), false);
  });
});

describe("dsh CRLF homes", () => {
  test("on splices a CRLF patch file and off restores it byte for byte", async () => {
    const crlf = USER_PATCH.replace(/\n/g, "\r\n");
    seedPatch(crlf);
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    const rows = readPatch()
      .split("\n")
      .filter((line) => line.startsWith("- id:"));
    assert.equal(rows.length, 3, "our two rows splice in; no duplicate of the user's");
    await dshAdapter.disable();
    assert.equal(readPatch(), crlf);
  });

  test("a row id with a trailing comment still reads as the row it names", async () => {
    const foreign = [
      "- id: llm-pi-ai # mine",
      "  name: 'mine'",
      "  config:",
      "    providers:",
      "      openai:",
      "        baseURL: https://api.openai.com/v1",
      "",
    ].join("\n");
    seedPatch(foreign);
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
    assert.equal(readPatch(), foreign);
  });
});

describe("dsh shapes the reader refuses or hides", () => {
  test("a marker inside a block scalar body is text, not our ownership proof", async () => {
    const foreign = [
      "- id: llm-pi-ai",
      "  name: 'mine'",
      "  config:",
      "    providers:",
      "      openai:",
      "        baseURL: https://api.openai.com/v1",
      "    script: |",
      "      x-aiand: true",
      "",
    ].join("\n");
    seedPatch(foreign);
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
    assert.equal(readPatch(), foreign);
  });

  test("a second document or a tab reads as a CliError, never a crash", async () => {
    // A duplicate key inside a row we read is covered by "a row the parser
    // cannot read becomes a CliError naming the file"; these two shapes
    // break the whole document, wherever they sit.
    const broken = [
      { name: "second document", text: "- id: a\n  name: b\n---\n- id: c\n  name: d\n" },
      { name: "tab indent", text: "- id: a\n\tname: b\n" },
    ];
    for (const { name, text } of broken) {
      seedPatch(text);
      assert.deepEqual(await dshAdapter.probe(), { active: false, model: null }, name);
      await assert.rejects(
        dshAdapter.enable(enableInput()),
        (error) =>
          error instanceof CliError && /is not a patch file aiand can read/.test(error.message),
        name,
      );
      assert.equal(readPatch(), text, `${name}: the user's file is untouched`);
    }
  });

  test("a leading document marker is legal and the rows below still read", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    seedPatch(`---\n${USER_PATCH}`);
    await dshAdapter.enable(enableInput());
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: GLM });
    await dshAdapter.disable();
    assert.equal(readPatch(), `---\n${USER_PATCH}`);
  });

  test("a leading BOM does not hide the first row from the reader", async () => {
    const foreign = `\uFEFF- id: llm-pi-ai\n  name: 'mine'\n  config:\n    providers:\n      openai:\n        baseURL: https://api.openai.com/v1\n`;
    seedPatch(foreign);
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
    assert.equal(readPatch(), foreign, "the user's row is untouched");
  });
});

describe("dsh sessionLaunch", () => {
  const launchInput = (overrides = {}) => ({
    apiKey: "sk-session-1",
    model: GLM,
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
    profileName: "default",
    ...overrides,
  });
  const overlayPatch = (launch) =>
    readFileSync(join(launch.env.DSH_HOME, "cordis.patch.yml"), "utf8");

  test("runs one session from a throwaway home, key out of the child env", async () => {
    const launch = await dshAdapter.sessionLaunch(launchInput());
    try {
      // The only env the child gets is the overlay home and a blank
      // override of the ref name: dsh resolves refs with the
      // inherited environment first, so a blank value lets the
      // overlay's credential file win.
      assert.deepEqual(launch.env, { DSH_HOME: launch.env.DSH_HOME, [KEY_REF]: "" });
      assert.notEqual(launch.env.DSH_HOME, dshHomeDir());
      assert.deepEqual(launch.args, ["--profile", "headless"]);
      assert.deepEqual(launch.stripPassthroughFlags, ["--patch"]);
      const overlay = launch.env.DSH_HOME;
      assert.equal(mode(join(overlay, "cordis.patch.yml")), 0o600);
      assert.equal(mode(join(overlay, ".credentials.yaml")), 0o600);
      assert.equal(
        readFileSync(join(overlay, "cordis.patch.yml"), "utf8"),
        `${LLM_ROW}\n${DEFAULT_ROW}\n`,
      );
      assert.equal(
        readFileSync(join(overlay, ".credentials.yaml"), "utf8"),
        credentials("sk-session-1"),
      );
      assert.equal(existsSync(patchPath()), false, "nothing is written under the real home");
      assert.equal(existsSync(credsPath()), false);
    } finally {
      await launch.cleanup();
    }
    assert.equal(existsSync(launch.env.DSH_HOME), false, "cleanup removes the overlay");
  });

  test("picks the web profile on a terminal, headless when piped", async () => {
    const web = await withStdinTty(true, () => dshAdapter.sessionLaunch(launchInput()));
    try {
      assert.deepEqual(web.args, ["--profile", "web"]);
    } finally {
      await web.cleanup();
    }
    const piped = await withStdinTty(false, () => dshAdapter.sessionLaunch(launchInput()));
    try {
      assert.deepEqual(piped.args, ["--profile", "headless"]);
    } finally {
      await piped.cleanup();
    }
  });

  test("resolves the startup model: --model, else the profile default, else the catalog's first entry", async () => {
    const pinned = await dshAdapter.sessionLaunch(launchInput({ model: KIMI }));
    try {
      assert.ok(overlayPatch(pinned).includes(`    model: ${KIMI}`));
    } finally {
      await pinned.cleanup();
    }
    const profiled = await dshAdapter.sessionLaunch(
      launchInput({ model: undefined, profileModel: KIMI }),
    );
    try {
      assert.ok(overlayPatch(profiled).includes(`    model: ${KIMI}`));
    } finally {
      await profiled.cleanup();
    }
    // A model outside the catalog falls back to the first entry.
    const foreign = await dshAdapter.sessionLaunch(launchInput({ model: "foreign/model" }));
    try {
      assert.ok(overlayPatch(foreign).includes(`    model: ${GLM}`));
    } finally {
      await foreign.cleanup();
    }
    const first = await dshAdapter.sessionLaunch(launchInput({ model: undefined }));
    try {
      assert.ok(overlayPatch(first).includes(`    model: ${GLM}`));
    } finally {
      await first.cleanup();
    }
    await assert.rejects(dshAdapter.sessionLaunch(launchInput({ catalog: [] })), CliError);
  });

  test("restates the real session root so history survives the throwaway", async () => {
    mkdirSync(join(dshHomeDir(), "sessions"), { recursive: true });
    const launch = await dshAdapter.sessionLaunch(launchInput());
    try {
      assert.ok(overlayPatch(launch).includes("- id: session-persistence-jsonl"));
      assert.ok(overlayPatch(launch).includes(`    root: ${join(dshHomeDir(), "sessions")}`));
    } finally {
      await launch.cleanup();
    }
  });
});

describe("dsh DSH_HOME", () => {
  test("relocates the config root", () => {
    const elsewhere = join(process.env.AIAND_HOME, "elsewhere");
    process.env.DSH_HOME = elsewhere;
    try {
      assert.deepEqual(dshAdapter.managedFiles(), [
        join(elsewhere, "cordis.patch.yml"),
        join(elsewhere, ".credentials.yaml"),
      ]);
    } finally {
      delete process.env.DSH_HOME;
    }
  });

  test("off strips the recorded home when $DSH_HOME moved", async () => {
    const first = join(process.env.AIAND_HOME, "first-home");
    process.env.DSH_HOME = first;
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    const wired = [join(first, "cordis.patch.yml"), join(first, ".credentials.yaml")];
    assert.deepEqual(dshAdapter.managedFiles(), wired);
    // The home moved between on and off; the new home need not exist.
    const second = join(process.env.AIAND_HOME, "second-home");
    process.env.DSH_HOME = second;
    try {
      assert.deepEqual(
        dshAdapter.managedFiles(),
        [join(second, "cordis.patch.yml"), join(second, ".credentials.yaml"), ...wired],
        "managedFiles includes the recorded moved paths",
      );
      const off = await dshAdapter.disable();
      assert.equal(off.stripped, true);
      assert.ok(
        off.notes?.some(
          (n) =>
            n.includes("stripped the aiand config from") &&
            n.includes(first) &&
            n.includes("because the dsh home moved"),
        ),
      );
      assert.equal(existsSync(wired[0]), false);
      assert.equal(existsSync(wired[1]), false);
      assert.equal(existsSync(addedRecord()), false, "the record is cleared with the strip");
      assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
    } finally {
      delete process.env.DSH_HOME;
    }
  });
});
