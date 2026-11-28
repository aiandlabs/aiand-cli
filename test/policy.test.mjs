import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { CliError } from "../dist/cli/errors.js";
import {
  LINUX_POLICY_PATH,
  MACOS_POLICY_PATH,
  readLinuxPolicy,
  readMacOSPolicy,
  readWindowsPolicy,
  WINDOWS_MACHINE_POLICY_KEY,
  WINDOWS_USER_POLICY_KEY,
} from "../dist/policy.js";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "aiand-policy-test-"));
const policyPath = join(temporaryDirectory, "policy.json");

after(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function fakeFile(contents, { uid = 0, isFile = true, readError } = {}) {
  const calls = { readFile: 0 };
  return {
    calls,
    fileSystem: {
      lstat() {
        return { isFile: () => isFile, uid };
      },
      readFile() {
        calls.readFile += 1;
        if (readError) throw readError;
        return contents;
      },
    },
  };
}

function fakeJson(value, options) {
  return fakeFile(JSON.stringify(value), options);
}

function read(fake, path = policyPath) {
  return readLinuxPolicy({ path, fileSystem: fake.fileSystem });
}

function assertPolicyError(readPolicy, { path = policyPath, key } = {}) {
  assert.throws(readPolicy, (error) => {
    assert.ok(error instanceof CliError, `Expected CliError, got ${error}`);
    assert.ok(error.message.includes(path), `Error does not name ${path}: ${error.message}`);
    if (key !== undefined) {
      assert.ok(error.message.includes(key), `Error does not name ${key}: ${error.message}`);
    }
    return true;
  });
}

test("returns an empty lock set when policy.json is absent", () => {
  assert.equal(LINUX_POLICY_PATH, "/etc/aiand/policy.json");

  let readCalls = 0;
  const error = Object.assign(new Error("not found"), { code: "ENOENT" });
  const fileSystem = {
    lstat() {
      throw error;
    },
    readFile() {
      readCalls += 1;
      return "{}";
    },
  };

  assert.deepEqual(readLinuxPolicy({ path: policyPath, fileSystem }), {
    settings: {},
    sources: {},
  });
  assert.equal(readCalls, 0);
});

test("returns declared settings with their policy path as lock source", () => {
  const settings = {
    baseUrl: "https://managed.example",
    allowedModels: [],
    allowedAgents: [],
    telemetry: false,
    selfUpdate: false,
  };
  const fake = fakeJson(settings);

  assert.deepEqual(read(fake), {
    settings,
    sources: {
      baseUrl: policyPath,
      allowedModels: policyPath,
      allowedAgents: policyPath,
      telemetry: policyPath,
      selfUpdate: policyPath,
    },
  });
});

test("locks only fields present in the policy", () => {
  const settings = { allowedAgents: ["opencode", "claude"], telemetry: true };
  const fake = fakeJson(settings);

  const loaded = read(fake);
  assert.deepEqual(loaded, {
    settings,
    sources: { allowedAgents: policyPath, telemetry: policyPath },
  });
  for (const key of ["baseUrl", "allowedModels", "selfUpdate"]) {
    assert.equal(Object.hasOwn(loaded.settings, key), false);
    assert.equal(Object.hasOwn(loaded.sources, key), false);
  }
});

test("downloadMirror is an https URL with no user name, query or fragment", () => {
  const ok = fakeJson({ downloadMirror: "https://mirror.example/aiand-cli/releases" });
  assert.deepEqual(read(ok).settings, {
    downloadMirror: "https://mirror.example/aiand-cli/releases",
  });
  for (const value of [
    "http://mirror.example/releases",
    "https://user@mirror.example/releases",
    "https://mirror.example/releases?x=1",
    "https://mirror.example/releases#x",
    42,
  ]) {
    assert.throws(
      () => read(fakeJson({ downloadMirror: value })),
      /invalid "downloadMirror" setting/,
      String(value),
    );
  }
});

test("rejects a policy file that is not root-owned", () => {
  const fake = fakeJson({ telemetry: false }, { uid: 1000 });

  assertPolicyError(() => read(fake));
  assert.equal(fake.calls.readFile, 0);
});

test("rejects symlinks and other non-regular policy files", () => {
  const fake = fakeJson({ telemetry: false }, { isFile: false });

  assertPolicyError(() => read(fake));
  assert.equal(fake.calls.readFile, 0);
});

test("fails closed when policy.json cannot be read", () => {
  let readCalls = 0;
  const fileSystem = {
    lstat() {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    },
    readFile() {
      readCalls += 1;
      return "{}";
    },
  };
  assertPolicyError(() => readLinuxPolicy({ path: policyPath, fileSystem }));
  assert.equal(readCalls, 0);

  const fake = fakeJson(
    { telemetry: false },
    { readError: Object.assign(new Error("read failed"), { code: "EIO" }) },
  );
  assertPolicyError(() => read(fake));
  assert.equal(fake.calls.readFile, 1);
});

test("fails closed on malformed JSON and non-object roots", () => {
  for (const contents of ['{"baseUrl":', "null", "[]", '"managed"', "42"]) {
    const fake = fakeFile(contents);
    assertPolicyError(() => read(fake));
    assert.equal(fake.calls.readFile, 1);
  }
});

test("fails closed on unknown settings and invalid setting values", () => {
  const unknown = fakeJson({ baseUrl: "https://managed.example", unexpected: true });
  assertPolicyError(() => read(unknown), { key: "unexpected" });

  const invalidSettings = [
    ["baseUrl", 42],
    ["allowedModels", "model"],
    ["allowedAgents", {}],
    ["telemetry", "false"],
    ["selfUpdate", 0],
    ["baseUrl", ""],
    ["baseUrl", "   "],
    ["baseUrl", " https://managed.example"],
    ["baseUrl", "https://managed.example "],
    ["allowedModels", [""]],
    ["allowedModels", [" model"]],
    ["allowedAgents", ["agent "]],
    ["allowedModels", ["valid-model", 42]],
    ["allowedAgents", [null]],
  ];
  for (const [key, value] of invalidSettings) {
    const fake = fakeJson({
      baseUrl: "https://managed.example",
      allowedModels: ["valid-model"],
      telemetry: false,
      [key]: value,
    });
    assertPolicyError(() => read(fake), { key });
  }
});

const macOSPolicyPath = join(temporaryDirectory, "managed preferences.plist");

function fakeMacOSPolicy({
  uid = 0,
  isFile = true,
  lstatError,
  result = { code: 0, stdout: "{}" },
} = {}) {
  const calls = [];
  return {
    calls,
    fileSystem: {
      lstat() {
        if (lstatError) throw lstatError;
        return { isFile: () => isFile, uid };
      },
    },
    async run(command, args, options) {
      calls.push({ command, args, options });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function readMacOS(fake, path = macOSPolicyPath) {
  return readMacOSPolicy({ path, fileSystem: fake.fileSystem, run: fake.run });
}

async function assertMacOSPolicyError(readPolicy, { path = macOSPolicyPath, key, message } = {}) {
  await assert.rejects(readPolicy, (error) => {
    assert.ok(error instanceof CliError, `Expected CliError, got ${error}`);
    assert.ok(error.message.includes(path), `Error does not name ${path}: ${error.message}`);
    if (key !== undefined) {
      assert.ok(error.message.includes(key), `Error does not name ${key}: ${error.message}`);
    }
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

test("returns an empty lock set when macOS managed preferences are absent", async () => {
  assert.equal(MACOS_POLICY_PATH, "/Library/Managed Preferences/com.aiand.cli.plist");

  const lstatCalls = [];
  const runCalls = [];
  const fileSystem = {
    lstat(path) {
      lstatCalls.push(path);
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
  };
  const run = async (...args) => {
    runCalls.push(args);
    return { code: 0, stdout: "{}" };
  };

  assert.deepEqual(await readMacOSPolicy({ fileSystem, run }), {
    settings: {},
    sources: {},
  });
  assert.deepEqual(lstatCalls, [MACOS_POLICY_PATH]);
  assert.equal(runCalls.length, 0);
});

test("reads macOS managed preferences with system plutil and their plist path as lock source", async () => {
  const settings = {
    baseUrl: "https://managed.example",
    allowedModels: ["model-a", "model-b"],
    allowedAgents: ["opencode", "claude"],
    telemetry: false,
    selfUpdate: true,
  };
  const fake = fakeMacOSPolicy({
    result: { code: 0, stdout: JSON.stringify(settings) },
  });

  assert.deepEqual(await readMacOS(fake), {
    settings,
    sources: {
      baseUrl: macOSPolicyPath,
      allowedModels: macOSPolicyPath,
      allowedAgents: macOSPolicyPath,
      telemetry: macOSPolicyPath,
      selfUpdate: macOSPolicyPath,
    },
  });
  assert.deepEqual(fake.calls, [
    {
      command: "/usr/bin/plutil",
      args: ["-convert", "json", "-o", "-", macOSPolicyPath],
      options: { timeoutMs: 10_000 },
    },
  ]);
});

test("locks only fields present in macOS managed preferences", async () => {
  const settings = { allowedModels: ["model-a"], telemetry: false };
  const fake = fakeMacOSPolicy({
    result: { code: 0, stdout: JSON.stringify(settings) },
  });

  const loaded = await readMacOS(fake);
  assert.deepEqual(loaded, {
    settings,
    sources: { allowedModels: macOSPolicyPath, telemetry: macOSPolicyPath },
  });
  for (const key of ["baseUrl", "allowedAgents", "selfUpdate"]) {
    assert.equal(Object.hasOwn(loaded.settings, key), false);
    assert.equal(Object.hasOwn(loaded.sources, key), false);
  }
});

test("rejects macOS managed preferences that are not root-owned regular files", async () => {
  for (const inspection of [
    { uid: 1000, isFile: true },
    { uid: 0, isFile: false },
  ]) {
    const fake = fakeMacOSPolicy(inspection);
    await assertMacOSPolicyError(() => readMacOS(fake), {
      message: `Managed policy "${macOSPolicyPath}" must be a regular file owned by root.`,
    });
    assert.equal(fake.calls.length, 0);
  }
});

test("fails closed when macOS managed preferences cannot be inspected", async () => {
  const fake = fakeMacOSPolicy({
    lstatError: Object.assign(new Error("permission denied"), { code: "EACCES" }),
  });

  await assertMacOSPolicyError(() => readMacOS(fake), {
    message: `Managed policy "${macOSPolicyPath}" could not be inspected.`,
  });
  assert.equal(fake.calls.length, 0);
});

test("fails closed when macOS managed preferences cannot be converted", async () => {
  const failures = [
    new Error("spawn failed"),
    { code: null, stdout: '{"telemetry":false}' },
    { code: 1, stdout: '{"telemetry":false}' },
    { code: 2, stdout: "" },
  ];

  for (const result of failures) {
    const fake = fakeMacOSPolicy({ result });
    await assertMacOSPolicyError(() => readMacOS(fake), {
      message: `Managed policy "${macOSPolicyPath}" could not be read with plutil.`,
    });
    assert.equal(fake.calls.length, 1);
  }
});

test("fails closed on malformed macOS plutil output and non-object roots", async () => {
  for (const stdout of ["", '{"baseUrl":', "null", "[]", '"managed"', "42"]) {
    const fake = fakeMacOSPolicy({ result: { code: 0, stdout } });
    const message = ["null", "[]", '"managed"', "42"].includes(stdout)
      ? `Managed policy "${macOSPolicyPath}" must contain one JSON object.`
      : `Managed policy "${macOSPolicyPath}" is not valid JSON.`;
    await assertMacOSPolicyError(() => readMacOS(fake), { message });
  }
});

test("fails closed on unknown and invalid macOS managed-preference settings", async () => {
  const unknown = fakeMacOSPolicy({
    result: {
      code: 0,
      stdout: JSON.stringify({ baseUrl: "https://managed.example", unexpected: true }),
    },
  });
  await assertMacOSPolicyError(() => readMacOS(unknown), { key: "unexpected" });

  const invalidSettings = [
    ["baseUrl", 42],
    ["allowedModels", "model"],
    ["allowedAgents", {}],
    ["telemetry", "false"],
    ["selfUpdate", 0],
    ["baseUrl", ""],
    ["baseUrl", "   "],
    ["baseUrl", " https://managed.example"],
    ["baseUrl", "https://managed.example "],
    ["allowedModels", [""]],
    ["allowedModels", [" model"]],
    ["allowedAgents", ["agent "]],
    ["allowedModels", ["valid-model", 42]],
    ["allowedAgents", [null]],
  ];
  for (const [key, value] of invalidSettings) {
    const fake = fakeMacOSPolicy({
      result: {
        code: 0,
        stdout: JSON.stringify({
          baseUrl: "https://managed.example",
          allowedModels: ["valid-model"],
          telemetry: false,
          [key]: value,
        }),
      },
    });
    await assertMacOSPolicyError(() => readMacOS(fake), { key });
  }
});

const WINDOWS_SYSTEM_ROOT = "C:\\Windows";
const WINDOWS_REG_EXE = "C:\\Windows\\System32\\reg.exe";
const WINDOWS_ABSENT = { code: 1, stdout: "" };
const WINDOWS_FULL_HIVES = {
  [WINDOWS_USER_POLICY_KEY]: "HKEY_CURRENT_USER\\Software\\Policies\\aiand\\cli",
  [WINDOWS_MACHINE_POLICY_KEY]: "HKEY_LOCAL_MACHINE\\Software\\Policies\\aiand\\cli",
};

function registryValue(name, type, data) {
  return `    ${name}    ${type}${data === undefined ? "" : `    ${data}`}`;
}

function registryOutput(hive, lines = [], fullHive = false) {
  const header = fullHive ? WINDOWS_FULL_HIVES[hive] : hive;
  return `\r\n${header}\r\n${lines.join("\r\n")}${lines.length > 0 ? "\r\n" : ""}`;
}

function fakeRegistry(results = {}) {
  const calls = [];
  return {
    calls,
    async run(command, args, options) {
      calls.push({ command, args, options });
      const result = Object.hasOwn(results, args[1]) ? results[args[1]] : WINDOWS_ABSENT;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function readWindows(fake) {
  return readWindowsPolicy({
    env: { SystemRoot: WINDOWS_SYSTEM_ROOT },
    run: fake.run,
  });
}

async function assertWindowsPolicyError(readPolicy, { hive = WINDOWS_USER_POLICY_KEY, key } = {}) {
  await assert.rejects(readPolicy, (error) => {
    assert.ok(error instanceof CliError, `Expected CliError, got ${error}`);
    assert.ok(error.message.includes(hive), `Error does not name ${hive}: ${error.message}`);
    if (key !== undefined) {
      assert.ok(error.message.includes(key), `Error does not name ${key}: ${error.message}`);
    }
    return true;
  });
}

function registrySuccess(hive, lines, fullHive = false) {
  return { code: 0, stdout: registryOutput(hive, lines, fullHive) };
}

const allUserRegistryValues = [
  registryValue("baseUrl", "REG_SZ", "https://user.example"),
  registryValue("allowedModels", "REG_MULTI_SZ", "user-model"),
  registryValue("allowedAgents", "REG_MULTI_SZ", "user-agent"),
  registryValue("telemetry", "REG_DWORD", "0x1"),
  registryValue("selfUpdate", "REG_DWORD", "0x1"),
];

test("queries both Windows policy hives through System32 reg.exe", async () => {
  assert.equal(WINDOWS_USER_POLICY_KEY, "HKCU\\Software\\Policies\\aiand\\cli");
  assert.equal(WINDOWS_MACHINE_POLICY_KEY, "HKLM\\Software\\Policies\\aiand\\cli");

  const fake = fakeRegistry({
    [WINDOWS_USER_POLICY_KEY]: WINDOWS_ABSENT,
    [WINDOWS_MACHINE_POLICY_KEY]: WINDOWS_ABSENT,
  });
  await readWindows(fake);

  assert.deepEqual(fake.calls, [
    {
      command: WINDOWS_REG_EXE,
      args: ["query", WINDOWS_USER_POLICY_KEY],
      options: { timeoutMs: 10_000 },
    },
    {
      command: WINDOWS_REG_EXE,
      args: ["query", WINDOWS_MACHINE_POLICY_KEY],
      options: { timeoutMs: 10_000 },
    },
  ]);
});

test("returns an empty lock set when both Windows policy hives are absent", async () => {
  const fake = fakeRegistry({
    [WINDOWS_USER_POLICY_KEY]: { code: 1, stdout: "" },
    [WINDOWS_MACHINE_POLICY_KEY]: { code: 1, stdout: "" },
  });

  assert.deepEqual(await readWindows(fake), { settings: {}, sources: {} });
  assert.equal(fake.calls.length, 2);
});

test("reads Windows registry settings with their hive as lock source", async () => {
  const fake = fakeRegistry({
    [WINDOWS_USER_POLICY_KEY]: registrySuccess(
      WINDOWS_USER_POLICY_KEY,
      [
        registryValue("baseUrl", "REG_SZ", "https://managed.example"),
        registryValue("allowedModels", "REG_MULTI_SZ", "model-a\\0model-b\\0\\0"),
        registryValue("allowedAgents", "REG_MULTI_SZ", "\\0"),
        registryValue("telemetry", "REG_DWORD", "0x1"),
        registryValue("selfUpdate", "REG_DWORD", "0x0"),
      ],
      true,
    ),
    [WINDOWS_MACHINE_POLICY_KEY]: WINDOWS_ABSENT,
  });

  assert.deepEqual(await readWindows(fake), {
    settings: {
      baseUrl: "https://managed.example",
      allowedModels: ["model-a", "model-b"],
      allowedAgents: [],
      telemetry: true,
      selfUpdate: false,
    },
    sources: {
      baseUrl: WINDOWS_USER_POLICY_KEY,
      allowedModels: WINDOWS_USER_POLICY_KEY,
      allowedAgents: WINDOWS_USER_POLICY_KEY,
      telemetry: WINDOWS_USER_POLICY_KEY,
      selfUpdate: WINDOWS_USER_POLICY_KEY,
    },
  });
});

test("Windows machine policy overrides user policy setting by setting", async () => {
  const fake = fakeRegistry({
    [WINDOWS_USER_POLICY_KEY]: registrySuccess(WINDOWS_USER_POLICY_KEY, [
      registryValue("baseUrl", "REG_SZ", "https://user.example"),
      registryValue("allowedModels", "REG_MULTI_SZ", "user-model"),
      registryValue("allowedAgents", "REG_MULTI_SZ", "user-agent"),
      registryValue("telemetry", "REG_DWORD", "0x1"),
      registryValue("selfUpdate", "REG_DWORD", "0x1"),
    ]),
    [WINDOWS_MACHINE_POLICY_KEY]: registrySuccess(WINDOWS_MACHINE_POLICY_KEY, [
      registryValue("baseUrl", "REG_SZ", "https://machine.example"),
      registryValue("allowedModels", "REG_MULTI_SZ"),
      registryValue("telemetry", "REG_DWORD", "0x0"),
    ]),
  });

  assert.deepEqual(await readWindows(fake), {
    settings: {
      baseUrl: "https://machine.example",
      allowedModels: [],
      allowedAgents: ["user-agent"],
      telemetry: false,
      selfUpdate: true,
    },
    sources: {
      baseUrl: WINDOWS_MACHINE_POLICY_KEY,
      allowedModels: WINDOWS_MACHINE_POLICY_KEY,
      allowedAgents: WINDOWS_USER_POLICY_KEY,
      telemetry: WINDOWS_MACHINE_POLICY_KEY,
      selfUpdate: WINDOWS_USER_POLICY_KEY,
    },
  });
});

test("fails closed when a Windows policy hive cannot be read", async () => {
  const failures = [
    { hive: WINDOWS_USER_POLICY_KEY, result: new Error("spawn failed") },
    { hive: WINDOWS_MACHINE_POLICY_KEY, result: { code: null, stdout: "" } },
    { hive: WINDOWS_USER_POLICY_KEY, result: { code: 2, stdout: "" } },
    {
      hive: WINDOWS_MACHINE_POLICY_KEY,
      result: { code: 1, stdout: "ERROR: Access is denied." },
    },
  ];

  for (const { hive, result } of failures) {
    const results = {
      [WINDOWS_USER_POLICY_KEY]: WINDOWS_ABSENT,
      [WINDOWS_MACHINE_POLICY_KEY]: WINDOWS_ABSENT,
      [hive]: result,
    };
    if (hive === WINDOWS_MACHINE_POLICY_KEY) {
      results[WINDOWS_USER_POLICY_KEY] = registrySuccess(
        WINDOWS_USER_POLICY_KEY,
        allUserRegistryValues,
      );
    }
    await assertWindowsPolicyError(() => readWindows(fakeRegistry(results)), { hive });
  }
});

test("fails closed on malformed Windows registry output and invalid policy settings", async () => {
  const baseUrl = registryValue("baseUrl", "REG_SZ", "https://managed.example");
  const malformedOutputs = [
    "\r\nHKEY_CURRENT_USER\\Software\\Policies\\aiand\\other\r\n",
    `\r\n${baseUrl}\r\n`,
    registryOutput(WINDOWS_USER_POLICY_KEY, ["this is not registry output"]),
    registryOutput(WINDOWS_USER_POLICY_KEY, [
      baseUrl,
      "HKEY_CURRENT_USER\\Software\\Policies\\aiand\\cli\\nested",
    ]),
  ];
  for (const stdout of malformedOutputs) {
    const fake = fakeRegistry({ [WINDOWS_USER_POLICY_KEY]: { code: 0, stdout } });
    await assertWindowsPolicyError(() => readWindows(fake));
  }

  const invalidEntries = [
    {
      key: "baseUrl",
      line: [baseUrl, baseUrl],
    },
    {
      key: "unexpected",
      line: [registryValue("unexpected", "REG_SZ", "value")],
    },
    ...[
      registryValue("baseUrl", "REG_DWORD", "0x1"),
      registryValue("allowedModels", "REG_SZ", "model"),
      registryValue("allowedAgents", "REG_DWORD", "0x0"),
      registryValue("telemetry", "REG_SZ", "true"),
      registryValue("selfUpdate", "REG_MULTI_SZ", "\\0"),
    ].map((line) => ({ key: line.trim().split(/\s+/)[0], line: [line] })),
    ...["0x2", "0x10", "1", "true", "0x"].map((data) => ({
      key: "telemetry",
      line: [registryValue("telemetry", "REG_DWORD", data)],
    })),
    ...["valid\\0\\0other", "\\0valid", "valid\\0 agent", "valid\\0agent "].map((data) => ({
      key: "allowedModels",
      line: [registryValue("allowedModels", "REG_MULTI_SZ", data)],
    })),
    ...["", "   ", " https://managed.example", "https://managed.example "].map((data) => ({
      key: "baseUrl",
      line: [registryValue("baseUrl", "REG_SZ", data)],
    })),
  ];

  for (const { key, line } of invalidEntries) {
    const fake = fakeRegistry({
      [WINDOWS_USER_POLICY_KEY]: registrySuccess(WINDOWS_USER_POLICY_KEY, line),
    });
    await assertWindowsPolicyError(() => readWindows(fake), { key });
  }
});
