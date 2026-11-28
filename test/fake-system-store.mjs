// Preloaded (node --import) into a CLI subprocess to stand in for the
// operating system's certificate store, the two ways src/cli/system-ca.ts
// reads it: tls.getCACertificates("system") (Windows, macOS) and the
// distribution bundle files (Linux) answer with the PEM certificates in
// AIAND_TEST_SYSTEM_STORE. Nothing is added to a real store.
import { readFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const tls = require("node:tls");
const fs = require("node:fs");
const { LINUX_BUNDLES } = await import("../dist/cli/system-ca.js");
const file = process.env.AIAND_TEST_SYSTEM_STORE;
if (file) {
  const pems =
    readFileSync(file, "utf8").match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) ?? [];
  const real = tls.getCACertificates;
  tls.getCACertificates = (type) =>
    type === "system" ? pems.map((pem) => `${pem}\n`) : real.call(tls, type);
  const realRead = fs.readFileSync;
  fs.readFileSync = (path, ...rest) =>
    LINUX_BUNDLES.includes(path) ? pems.join("\n") : realRead.call(fs, path, ...rest);
  syncBuiltinESMExports();
}
