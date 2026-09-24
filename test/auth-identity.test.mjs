import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { describe } from "node:test";
import {
  MINTED_ACCESS_TOKEN,
  MINTED_REFRESH_TOKEN,
  registerAuthStub,
  STUB_USER_EMAIL,
  state,
} from "./auth-stub.mjs";

// Behavioral tests through the real src/auth modules (dist build), against
// the localhost stub server in ./auth-stub.mjs.
// The shared sign-in probe and its three states.

const authIdentity = await import("../dist/auth/identity.js");
const config = await import("../dist/config.js");

registerAuthStub();

describe("auth identity integration (serial)", { concurrency: 1 }, () => {
  describe("auth probe three states (verified / signed_out / unreachable)", () => {
    /** A loopback port nothing listens on: bind, read the port, close it, so
     * the gateway dial fails fast with ECONNREFUSED (ApiError status 0). */
    async function deadLoopbackPort() {
      const doomed = createServer();
      doomed.listen(0, "127.0.0.1");
      await new Promise((resolve) => doomed.once("listening", resolve));
      const port = doomed.address().port;
      await new Promise((resolve) => doomed.close(resolve));
      return port;
    }

    test("verified: stored key + live gateway resolves identity", async () => {
      await config.saveCredential("default", {
        access_token: MINTED_ACCESS_TOKEN,
        refresh_token: MINTED_REFRESH_TOKEN,
        expires_at: Math.floor(Date.now() / 1000) + 2592000,
        origin: "device",
        storage: "plaintext",
        user: { id: "u1", email: STUB_USER_EMAIL },
        org: { id: "org_1", name: "First" },
      });
      state.orgs = [{ id: "org_1", name: "First" }];
      const identity = await authIdentity.probeIdentity("default");
      assert.equal(identity.reachable, true);
      assert.equal(identity.probeError, null);
      assert.ok(identity.session);
      assert.equal(identity.user.email, STUB_USER_EMAIL);
      const status = await authIdentity.authStatus({ profile: "default" });
      assert.equal(status.signed_in, true);
      assert.equal(status.reachable, true);
    });

    test("local mode with a stored credential stays signed_in (no network)", async () => {
      await config.saveCredential("default", {
        access_token: "sk-abc123",
        origin: "paste",
        storage: "plaintext",
        user: { id: "u1", email: STUB_USER_EMAIL },
        org: { id: "org_1", name: "First" },
      });
      // A dead gateway proves local mode never touches the network.
      const dead = await deadLoopbackPort();
      process.env.AIAND_BASE_URL = `http://127.0.0.1:${dead}`;
      process.env.AIAND_AUTH_URL = `http://127.0.0.1:${dead}`;
      const status = await authIdentity.authStatus({ profile: "default", local: true });
      assert.equal(status.signed_in, true);
      assert.equal(status.reachable, true);
      assert.equal(status.email, STUB_USER_EMAIL);
      assert.equal(status.source, "pasted-key");
    });

    test("signed_out: no credential resolves a null session but stays reachable", async () => {
      const identity = await authIdentity.probeIdentity("default");
      assert.equal(identity.session, null);
      assert.equal(identity.reachable, true);
      const status = await authIdentity.authStatus({ profile: "default" });
      assert.equal(status.signed_in, false);
      assert.equal(status.reachable, true);
    });

    test("unreachable: dead gateway port surfaces reachable=false instead of throwing", async () => {
      await config.saveCredential("default", {
        access_token: "sk-abc123",
        origin: "paste",
        user: { id: "u1", email: "paste@example.com" },
        org: { id: "org_1", name: "First" },
      });
      const dead = await deadLoopbackPort();
      process.env.AIAND_BASE_URL = `http://127.0.0.1:${dead}`;
      process.env.AIAND_AUTH_URL = `http://127.0.0.1:${dead}`;
      const identity = await authIdentity.probeIdentity("default");
      assert.equal(identity.reachable, false);
      assert.ok(identity.probeError);
      assert.equal(identity.probeError.status, 0);
      const status = await authIdentity.authStatus({ profile: "default" });
      assert.equal(status.signed_in, false);
      assert.equal(status.reachable, false);
    });

    test("rejected key (401) still throws instead of reporting unreachable", async () => {
      await config.saveCredential("default", {
        access_token: "sk-bad",
        origin: "paste",
        user: { id: "u1", email: "paste@example.com" },
        org: { id: "org_1", name: "First" },
      });
      state.orgs = [{ id: "org_1", name: "First" }];
      await assert.rejects(authIdentity.probeIdentity("default"), /rejected/);
    });
  });
});
