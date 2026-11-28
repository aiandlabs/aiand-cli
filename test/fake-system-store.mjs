// Preloaded (node --import) into a CLI subprocess to stand in for the
// operating system's certificate store: tls.getCACertificates("system")
// answers with the PEM certificates in AIAND_TEST_SYSTEM_STORE, which is how
// src/cli/system-ca.ts reads the store. Nothing is added to a real store.
import { readFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const tls = createRequire(import.meta.url)("node:tls");
const file = process.env.AIAND_TEST_SYSTEM_STORE;
if (file) {
  const pems =
    readFileSync(file, "utf8").match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) ?? [];
  const real = tls.getCACertificates;
  tls.getCACertificates = (type) =>
    type === "system" ? pems.map((pem) => `${pem}\n`) : real.call(tls, type);
  syncBuiltinESMExports();
}
