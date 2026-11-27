import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { CliError } from "../dist/cli/errors.js";
import { LINUX_POLICY_PATH, readLinuxPolicy } from "../dist/policy.js";

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
