// Loaded into every Node process of a test run (test files and the CLI
// subprocesses they spawn) through NODE_OPTIONS, set by test/setup.mjs.
// Any fetch to a non-loopback host fails the way an offline machine would
// (TypeError "fetch failed", cause ECONNREFUSED), so a test that forgot to
// point the CLI at a stub degrades deterministically instead of reaching
// api.aiand.com or real DNS. Tests that stub globalThis.fetch replace this
// wrapper and restore it afterwards, as before.
//
// AIAND_TEST_ALLOW_NETWORK=1 lifts the guard (test/e2e-live.test.mjs).
// AIAND_TEST_NET_LOG=<file> appends each blocked URL, for auditing a run.
import { appendFileSync } from "node:fs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const realFetch = globalThis.fetch;

if (typeof realFetch === "function") {
  globalThis.fetch = function guardedFetch(input, init) {
    if (process.env.AIAND_TEST_ALLOW_NETWORK !== "1") {
      const href = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const { hostname, host } = new URL(href);
      if (!LOOPBACK.has(hostname)) {
        if (process.env.AIAND_TEST_NET_LOG) {
          appendFileSync(process.env.AIAND_TEST_NET_LOG, `${href}\n`);
        }
        const cause = Object.assign(new Error(`connect ECONNREFUSED ${host} (blocked by test/net-guard.mjs)`), {
          code: "ECONNREFUSED",
        });
        return Promise.reject(new TypeError("fetch failed", { cause }));
      }
    }
    return realFetch(input, init);
  };
}
