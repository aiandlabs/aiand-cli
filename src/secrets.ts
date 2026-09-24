import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CliError } from "./cli/errors.js";
import { configDir, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writeFileAtomic } from "./fsutil.js";
import { SECOND_MS } from "./time.js";

export type Tier = "keychain" | "file" | "plaintext";

const SERVICE = "aiand";
const KEYCHAIN_TIMEOUT_MS = 3 * SECOND_MS;

type SecretMap = Record<string, string>;

/**
 * Where secrets live, tried in this order unless AIAND_KEY_STORAGE pins one:
 * the OS keychain (macOS `security`, Linux Secret Service via `secret-tool`),
 * an AES-256-GCM encrypted file, and a plaintext file only when explicitly
 * requested (tests / CI). Selection never silently falls back to plaintext.
 */

function tierFromEnv(): Tier | null {
  const raw = process.env.AIAND_KEY_STORAGE;
  if (raw === undefined || raw === "") return null;
  if (raw === "keychain" || raw === "file" || raw === "plaintext") return raw;
  throw new CliError(`AIAND_KEY_STORAGE must be one of: keychain, file, plaintext (got "${raw}").`);
}

// The keychain probe spawns OS tools, so its verdict is cached for the process
// lifetime. The env override is deliberately NOT cached: tests flip it between
// tiers in a single process.
let probedTier: "keychain" | "file" | null = null;

export async function detectTier(): Promise<Tier> {
  const forced = tierFromEnv();
  if (forced) return forced;
  if (probedTier === null) probedTier = (await probeKeychain()) ? "keychain" : "file";
  return probedTier;
}

// The keychain error messages name the tool through this one label.
const keychainTool = (): string => (process.platform === "darwin" ? "security" : "secret-tool");

async function run(
  cmd: string,
  args: string[],
  input?: string,
): Promise<{ code: number | null; stdout: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    code: number | null;
    stdout: string;
  }>();
  const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: KEYCHAIN_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout }));
  // A fast-exiting tool (broken dbus, PATH shim) closes stdin before the write
  // lands: without this listener that EPIPE is an unhandled crash, not a
  // fallback to the file tier.
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  return promise;
}

/**
 * The command line handed to `security -i` on stdin, so the secret never
 * appears in the child's argv (same-user `ps` can read argv for the child's
 * lifetime). `security` has no stdin flag for the password itself; the -i
 * mode reads whole commands from stdin. POSIX single-quoting keeps the blob
 * one token under a shell-like tokenizer; under a plain whitespace tokenizer
 * the quotes stay literal, the readback in keychainSet then mismatches, and
 * storeSecret falls back to the encrypted file — the blob is never exposed.
 */
const posixQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function securityInteractiveSetCommand(account: string, secret: string): string {
  return `add-generic-password -s ${SERVICE} -a ${posixQuote(account)} -U -w ${posixQuote(secret)}\n`;
}

async function keychainSet(account: string, secret: string): Promise<void> {
  if (process.platform === "darwin") {
    // `security -i` exit codes are unreliable, so the write counts only when
    // the readback matches. -U replaces an existing item instead of adding a
    // duplicate. On failure storeSecret falls back to the encrypted file;
    // the blob never goes into argv.
    await run("security", ["-i"], securityInteractiveSetCommand(account, secret));
    if ((await keychainGet(account)) !== secret) {
      throw new Error("keychain readback mismatch");
    }
    return;
  }
  const result = await run(
    "secret-tool",
    ["store", "--label=aiand", "service", SERVICE, "account", account],
    secret,
  );
  if (result.code !== 0) {
    throw new Error(`${keychainTool()} could not store the secret (exit ${result.code}).`);
  }
  // A write that cannot be read back is worse than no write.
  if ((await keychainGet(account)) !== secret) {
    throw new Error("keychain readback mismatch");
  }
}

async function keychainGet(account: string): Promise<string> {
  const result =
    process.platform === "darwin"
      ? await run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"])
      : await run("secret-tool", ["lookup", "service", SERVICE, "account", account]);
  if (result.code !== 0) {
    throw new Error(`${keychainTool()} could not read the secret (exit ${result.code}).`);
  }
  return result.stdout.trim();
}

async function keychainDelete(account: string): Promise<void> {
  const result =
    process.platform === "darwin"
      ? await run("security", ["delete-generic-password", "-s", SERVICE, "-a", account])
      : await run("secret-tool", ["clear", "service", SERVICE, "account", account]);
  if (result.code !== 0) {
    throw new Error(`${keychainTool()} could not delete the secret (exit ${result.code}).`);
  }
}

/**
 * Write, read back, and delete a canary: a tool that exists can still fail
 * behind a headless dbus or a locked keyring. No keychain tier on Windows.
 */
async function probeKeychain(): Promise<boolean> {
  if (process.platform === "win32") return false;
  const account = `aiand-probe-${randomBytes(8).toString("hex")}`;
  const secret = randomBytes(16).toString("hex");
  try {
    await keychainSet(account, secret);
    return (await keychainGet(account)) === secret;
  } catch {
    return false;
  } finally {
    await keychainDelete(account).catch(() => {});
  }
}

// The plaintext map is read-modify-write, and Node interleaves async I/O:
// two concurrent stores (or a store racing a delete) would each read the
// same old map and one update would be lost. Every mutation of the file
// tier chains through this lock — writeFileAtomic keeps each single write
// atomic, the chain keeps the read-modify-write sequence serial.
let fileTierLock: Promise<void> = Promise.resolve();

function serialized<T>(op: () => Promise<T>): Promise<T> {
  const next = fileTierLock.then(op, op);
  fileTierLock = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
export async function storeSecret(profile: string, blob: string): Promise<Tier> {
  const tier = await detectTier();
  if (tier === "plaintext") {
    await serialized(async () => {
      const map = readPlaintextMap();
      map[profile] = blob;
      await writePlaintextMap(map);
    });
    return "plaintext";
  }
  if (tier === "file") {
    await serialized(() => fileSet(profile, blob));
    return "file";
  }
  try {
    // keychainSet verifies its own readback; any failure drops to the
    // encrypted file rather than leave the profile unbootable.
    await keychainSet(profile, blob);
    return "keychain";
  } catch {
    process.stderr.write(
      "Warning: OS keychain write failed; stored in the encrypted file instead.\n",
    );
    await serialized(() => fileSet(profile, blob));
    return "file";
  }
}

export async function loadSecret(profile: string, recordedTier?: Tier): Promise<string | null> {
  const tier = recordedTier ?? (await detectTier());
  if (tier === "plaintext") {
    return readPlaintextMap()[profile] ?? null;
  }
  if (tier === "file") {
    const store = await readStore();
    return store[profile] ?? null;
  }
  try {
    return await keychainGet(profile);
  } catch {
    // The keychain probe passed but this read failed (locked keyring, dbus
    // hiccup) — the encrypted file is where the fallback write would have
    // landed, so look there before giving up.
    const store = await readStore();
    return store[profile] ?? null;
  }
}

export async function deleteSecret(profile: string): Promise<void> {
  // A Storage tier change strands the old blob (refresh token included):
  // keychain→file or plaintext→file leaves the previous store holding a
  // still-valid session that logout never revokes. Sweep every tier
  // best-effort instead of trusting the recorded one.
  try {
    await keychainDelete(profile);
  } catch {
    // already absent (or no keychain on this machine) — a no-op
  }
  try {
    await serialized(async () => {
      const store = await readStore();
      if (!(profile in store)) return;
      delete store[profile];
      await writeStore(store);
    });
  } catch {
    // unreadable/missing store means no residue to remove
  }
  try {
    await serialized(async () => {
      const map = readPlaintextMap();
      if (!(profile in map)) return;
      delete map[profile];
      await writePlaintextMap(map);
    });
  } catch {
    // unreadable/missing map means no residue to remove
  }
}

// --- encrypted file tier ---------------------------------------------------
// AES-256-GCM; on-disk format: [version][iv][auth tag][ciphertext]. The
// secrets map is re-encrypted whole-file on every change.
const CIPHER = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const STORE_FORMAT_VERSION = 1;
const IV_OFFSET = 1; // after the version byte
const AUTH_TAG_OFFSET = IV_OFFSET + IV_BYTES;
const CIPHERTEXT_OFFSET = AUTH_TAG_OFFSET + AUTH_TAG_BYTES;
const MASTER_KEY_HEX = new RegExp(`^[0-9a-fA-F]{${KEY_BYTES * 2}}$`);

const SECRET_STORE_FILE = "secret-store.json";
const SECRET_KEY_FILE = "secret-store.key";
const STORE_FILES = `${SECRET_STORE_FILE} and ${SECRET_KEY_FILE}`;

const secretsFilePath = (): string => join(configDir(), SECRET_STORE_FILE);

async function getKeyMaterial(): Promise<Buffer> {
  const envKey = process.env.AIAND_SECRET_STORE_MASTER_KEY;
  if (envKey) {
    if (!MASTER_KEY_HEX.test(envKey)) {
      throw new CliError(
        `AIAND_SECRET_STORE_MASTER_KEY must be ${KEY_BYTES * 2} hex characters (${KEY_BYTES} bytes).`,
      );
    }
    return Buffer.from(envKey, "hex");
  }

  const keyFile = join(configDir(), SECRET_KEY_FILE);
  try {
    const key = await readFile(keyFile);
    if (key.length !== KEY_BYTES) {
      throw new CliError(`${keyFile} must contain exactly ${KEY_BYTES} bytes.`, {
        hint: `Delete ${STORE_FILES} to start over.`,
      });
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const key = randomBytes(KEY_BYTES);
    await mkdir(dirname(keyFile), { recursive: true, mode: PRIVATE_DIR_MODE });
    // Two first runs racing here must agree on one key, or the store
    // encrypted under the loser's key can never be read. Write the key to a
    // private temp file, then publish it with link(), which fails if the key
    // already exists: the key file only ever appears complete, so the loser
    // never reads a half-written one.
    const staged = `${keyFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(staged, key, { mode: PRIVATE_FILE_MODE, flag: "wx" });
      await link(staged, keyFile);
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code === "EEXIST") return getKeyMaterial();
      throw writeError;
    } finally {
      await unlink(staged).catch(() => {});
    }
    return key;
  }
}

async function encryptStore(store: SecretMap): Promise<Buffer> {
  const plaintext = JSON.stringify(store);
  const key = await getKeyMaterial();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const version = Buffer.from([STORE_FORMAT_VERSION]);
  return Buffer.concat([version, iv, authTag, encrypted]);
}

async function decryptStore(data: Buffer): Promise<SecretMap> {
  const version = data[0];
  if (version !== STORE_FORMAT_VERSION) {
    throw new Error(`Unsupported store format version: ${version}`);
  }
  const iv = data.subarray(IV_OFFSET, AUTH_TAG_OFFSET);
  const authTag = data.subarray(AUTH_TAG_OFFSET, CIPHERTEXT_OFFSET);
  const encrypted = data.subarray(CIPHERTEXT_OFFSET);
  const key = await getKeyMaterial();
  const decipher = createDecipheriv(CIPHER, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as SecretMap;
}

async function readStore(): Promise<SecretMap> {
  try {
    const data = await readFile(secretsFilePath());
    return await decryptStore(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    if (error instanceof CliError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code) {
      throw new CliError(
        `${secretsFilePath()}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Wrong-but-valid master key, corrupt ciphertext, bad version, unparseable
    // JSON: all surface here as GCM/format errors. Point at the fix instead of
    // leaking "Unsupported state or unable to authenticate data" as exit 70.
    throw new CliError(`${secretsFilePath()} cannot be decrypted.`, {
      hint: `Check AIAND_SECRET_STORE_MASTER_KEY, or delete ${STORE_FILES} to start over.`,
    });
  }
}

async function writeStore(store: SecretMap): Promise<void> {
  const encrypted = await encryptStore(store);
  await writeFileAtomic(secretsFilePath(), encrypted, { mode: PRIVATE_FILE_MODE });
}

async function fileSet(account: string, secret: string): Promise<void> {
  const store = await readStore();
  store[account] = secret;
  await writeStore(store);
}

// --- plaintext tier (AIAND_KEY_STORAGE=plaintext only) ----------------------

const plaintextPath = (): string => join(configDir(), "credentials-plaintext.json");

function readPlaintextMap(): SecretMap {
  try {
    return JSON.parse(readFileSync(plaintextPath(), "utf8")) as SecretMap;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new CliError(`${plaintextPath()} is not valid JSON.`, {
        hint: "Fix it by hand, or delete it to start over.",
      });
    }
    throw error;
  }
}

async function writePlaintextMap(map: SecretMap): Promise<void> {
  await writeFileAtomic(plaintextPath(), `${JSON.stringify(map, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
}
