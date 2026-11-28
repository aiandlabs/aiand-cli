#!/usr/bin/env node
/**
 * Offline bundles: one archive per platform holding what an install needs
 * from a release, for machines that reach neither GitHub nor npm.
 *
 *   node scripts/offline-bundle.mjs <release-dir> <out-dir>
 *
 * <release-dir> holds a release's SHA256SUMS and the files it lists (what
 * publish.yml attaches to the GitHub release). Every file is checked against
 * that SHA256SUMS before it is bundled. Each bundle is a single top-level
 * directory `aiand-offline-<version>-<platform>/` with the SHA256SUMS
 * verbatim, the npm tarball, install.sh, install.ps1 and, when the release has
 * one, that platform's prebuilt executable: `.zip` for Windows, `.tar.gz`
 * elsewhere. `SHA256SUMS.offline` lists the bundles' own digests.
 * `install.sh --from` and `install.ps1 --from` read the archive or its
 * unpacked directory (docs/it-admin-install.md).
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateRawSync, gzipSync } from "node:zlib";

/** The platforms scripts/build-prebuilt.mjs builds, with their executable names. */
const BUNDLE_PLATFORMS = [
  ["darwin-arm64", "aiand-darwin-arm64"],
  ["darwin-x64", "aiand-darwin-x64"],
  ["linux-x64", "aiand-linux-x64"],
  ["linux-arm64", "aiand-linux-arm64"],
  ["win32-x64", "aiand-win32-x64.exe"],
];

const BUNDLE_SUMS = "SHA256SUMS.offline";

// Fixed timestamps keep a rebuilt bundle byte-identical: 1980-01-01, the
// earliest time a zip entry can carry.
const MTIME = 315532800;
const EXECUTABLES = new Set(["install.sh", ...BUNDLE_PLATFORMS.map(([, name]) => name)]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Parse a release's SHA256SUMS and check every file it lists in `releaseDir`. */
function readRelease(releaseDir) {
  const root = resolve(releaseDir);
  const sums = readRegularFile(root, "SHA256SUMS");
  const listed = new Map();
  for (const line of sums.toString("utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-f]{64}) [ *]([A-Za-z0-9._-]+)$/.exec(line.trim());
    if (!match) throw new Error(`SHA256SUMS has a line that is not "<sha256>  <name>": ${line}`);
    if (listed.has(match[2])) throw new Error(`SHA256SUMS lists ${match[2]} twice`);
    listed.set(match[2], match[1]);
  }
  const tarballs = [...listed.keys()].filter((name) => /^aiand-cli-.+\.tgz$/.test(name));
  if (tarballs.length !== 1) {
    throw new Error(
      `SHA256SUMS must list exactly one aiand-cli-<version>.tgz; it lists ${tarballs.length}`,
    );
  }
  const tarball = tarballs[0];
  const version = tarball.slice("aiand-cli-".length, -".tgz".length);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`SHA256SUMS names an invalid version ${version}`);
  }
  for (const name of ["install.sh", "install.ps1"]) {
    if (!listed.has(name)) throw new Error(`SHA256SUMS does not list ${name}`);
  }
  const files = new Map();
  for (const [name, digest] of listed) {
    const bytes = readRegularFile(root, name);
    if (sha256(bytes) !== digest) {
      throw new Error(`${name} does not match its sha256 in SHA256SUMS`);
    }
    files.set(name, bytes);
  }
  return { version, sums, tarball, files };
}

function readRegularFile(root, name) {
  const path = join(root, name);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) throw new Error(`missing release file: ${name}`);
  if (!stat.isFile()) throw new Error(`release file ${name} is not a regular file`);
  return readFileSync(path);
}

/** The entries of one platform's bundle, in archive order. */
function bundleEntries(release, prebuilt) {
  const names = [release.tarball, "install.sh", "install.ps1"];
  if (release.files.has(prebuilt)) names.push(prebuilt);
  return [
    { name: "SHA256SUMS", bytes: release.sums },
    ...names.map((name) => ({ name, bytes: release.files.get(name) })),
  ];
}

function tarHeader(name, size, mode, type) {
  const header = Buffer.alloc(512);
  if (Buffer.byteLength(name) > 100) throw new Error(`bundle path too long for tar: ${name}`);
  header.write(name, 0, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  header.write(`${MTIME.toString(8).padStart(11, "0")}\0`, 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

/** A gzipped ustar archive of `entries` under the directory `top`. */
function tarGz(top, entries) {
  const parts = [tarHeader(`${top}/`, 0, 0o755, "5")];
  for (const { name, bytes } of entries) {
    parts.push(
      tarHeader(`${top}/${name}`, bytes.length, EXECUTABLES.has(name) ? 0o755 : 0o644, "0"),
    );
    parts.push(bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A deflated zip of `entries` under the directory `top`, with Unix modes. */
function zip(top, entries) {
  const local = [];
  const central = [];
  let offset = 0;
  // 1980-01-01 00:00 in MS-DOS date and time fields.
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  const add = (name, bytes, mode, directory) => {
    const nameBytes = Buffer.from(name, "utf8");
    const data = directory ? Buffer.alloc(0) : deflateRawSync(bytes, { level: 9 });
    const crc = directory ? 0 : crc32(bytes);
    const method = directory ? 0 : 8;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // names are UTF-8
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(directory ? 0 : bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so unzip keeps the mode
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(dosTime, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(directory ? 0 : bytes.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    const type = directory ? 0o040000 : 0o100000;
    entry.writeUInt32LE((((type | mode) << 16) | (directory ? 0x10 : 0)) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  };
  add(`${top}/`, null, 0o755, true);
  for (const { name, bytes } of entries) {
    add(`${top}/${name}`, bytes, EXECUTABLES.has(name) ? 0o755 : 0o644, false);
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length + 1, 8);
  end.writeUInt16LE(entries.length + 1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/**
 * Make `outDir` an empty directory. Whatever is in it is published with the
 * bundles, so a file left by an earlier run or another step must not stay.
 * It may not hold the release directory, and may not be a link.
 */
function emptyOutput(releaseDir, outDir) {
  const release = realpathSync(releaseDir);
  const out = realPathOf(outDir);
  if (sameOrInside(out, release) || sameOrInside(release, out)) {
    throw new Error(
      "the output directory must not be, or contain, or sit inside the release directory",
    );
  }
  const stat = lstatSync(outDir, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new Error(`${outDir} is not a directory`);
  mkdirSync(outDir, { recursive: true });
  // rmSync removes a link itself, never what it points to.
  for (const name of readdirSync(outDir)) {
    rmSync(join(outDir, name), { recursive: true, force: true });
  }
}

/** True when `path` is `base` or below it. Both are resolved real paths. */
function sameOrInside(path, base) {
  const rel = relative(base, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The real path `path` will have: links resolved in the part that exists,
 * so a link cannot make a directory inside the release look like one outside.
 */
function realPathOf(path) {
  let existing = resolve(path);
  const rest = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

/**
 * Write every platform's bundle and SHA256SUMS.offline into `outDir`, which
 * is emptied first.
 * Returns the archive names, in SHA256SUMS.offline order.
 */
export function buildOfflineBundles(releaseDir, outDir) {
  const release = readRelease(releaseDir);
  emptyOutput(releaseDir, outDir);
  const written = [];
  for (const [platform, prebuilt] of BUNDLE_PLATFORMS) {
    const top = `aiand-offline-${release.version}-${platform}`;
    const entries = bundleEntries(release, prebuilt);
    const windows = platform.startsWith("win32");
    const name = `${top}${windows ? ".zip" : ".tar.gz"}`;
    const bytes = windows ? zip(top, entries) : tarGz(top, entries);
    writeFileSync(join(outDir, name), bytes);
    written.push({ name, sha256: sha256(bytes), prebuilt: release.files.has(prebuilt) });
  }
  writeFileSync(
    join(outDir, BUNDLE_SUMS),
    written.map(({ name, sha256: digest }) => `${digest}  ${name}\n`).join(""),
  );
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [releaseDir, outDir] = process.argv.slice(2);
  if (!releaseDir || !outDir) {
    process.stderr.write("usage: node scripts/offline-bundle.mjs <release-dir> <out-dir>\n");
    process.exit(2);
  }
  try {
    for (const { name, prebuilt } of buildOfflineBundles(releaseDir, outDir)) {
      process.stdout.write(`${name}${prebuilt ? "" : " (no prebuilt: needs Node 22 or newer)"}\n`);
    }
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(1);
  }
}
