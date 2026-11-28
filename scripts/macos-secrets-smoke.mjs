// Real-macOS check of the keychain tier, which the unit suite can only drive
// through stubs. Run on macos-latest after a build, with a throwaway keychain
// set as the user's default (ci.yml's macos-keychain job creates it; the runner's
// login keychain is never touched): node scripts/macos-secrets-smoke.mjs
// - a secret stores in the keychain and a fresh process reads it back;
// - credentials.json does not hold the plaintext, and status says "keychain";
// - the secret sits in the throwaway keychain under the "aiand" service;
// - clearing the credential (what logout does) removes it from the keychain.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "darwin") {
  console.log("macos-secrets-smoke: skipped (not macOS)");
  process.exit(0);
}

const keychain = process.env.AIAND_SMOKE_KEYCHAIN;
if (!keychain) {
  console.error(
    "macos-secrets-smoke: set AIAND_SMOKE_KEYCHAIN to a throwaway keychain that is the default",
  );
  process.exit(2);
}
const defaultKeychain = execFileSync("security", ["default-keychain", "-d", "user"], {
  encoding: "utf8",
});
assert.ok(
  defaultKeychain.includes(keychain),
  `the default keychain is ${defaultKeychain.trim()}, not the throwaway ${keychain}`,
);

const dist = (rel) => pathToFileURL(join(import.meta.dirname, "..", "dist", rel)).href;
const SECRET = `sk-smoke-${Date.now()}`;
const credential = {
  access_token: SECRET,
  origin: "paste",
  user: { id: "u", email: "smoke@example.com" },
  org: { id: "o", name: "Smoke" },
};

// The credential reaches the child on stdin as `input`, never in its argv or
// env, the same way the CLI hands secrets to the tools it runs.
function child(cfg, body, input = null) {
  const script = `
    const config = await import(${JSON.stringify(dist("config.js"))});
    const identity = await import(${JSON.stringify(dist("auth/identity.js"))});
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw);
    process.stdout.write(JSON.stringify(await (async () => { ${body} })()));
  `;
  const childEnv = { ...process.env, AIAND_CONFIG_DIR: cfg };
  delete childEnv.AIAND_KEY_STORAGE;
  delete childEnv.AIAND_API_KEY;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: childEnv,
    encoding: "utf8",
    input: JSON.stringify(input),
  });
  return out === "" ? undefined : JSON.parse(out);
}

// Whether the throwaway keychain holds an "aiand" item for this secret. The
// item is the JSON blob saveCredential writes, so its access_token is compared.
function inKeychain() {
  const r = spawnSync("security", ["find-generic-password", "-s", "aiand", "-w", keychain], {
    encoding: "utf8",
  });
  if (r.status !== 0) return false;
  try {
    return JSON.parse(r.stdout.trim()).access_token === SECRET;
  } catch {
    return false;
  }
}

const root = mkdtempSync(join(tmpdir(), "aiand-mac-smoke-"));
try {
  const cfg = join(root, "cfg");
  assert.equal(
    child(cfg, `return await config.saveCredential("default", input);`, credential),
    "keychain",
  );
  assert.equal(child(cfg, `return (await config.loadCredential("default")).access_token;`), SECRET);
  assert.ok(
    !readFileSync(join(cfg, "credentials.json"), "utf8").includes(SECRET),
    "credentials.json holds plaintext",
  );
  assert.ok(inKeychain(), "the secret is not in the throwaway keychain under the aiand service");

  const status = child(cfg, "return await identity.authStatus({ local: true });");
  assert.equal(status.storage, "keychain");

  child(cfg, `await config.clearCredential("default"); return null;`);
  assert.equal(child(cfg, `return await config.loadCredential("default");`), null);
  assert.ok(!inKeychain(), "clearing the credential left the secret in the keychain");
  console.log("macos-secrets-smoke: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
