import { resolveDefault } from "../catalog.js";
import { detectBinary } from "../detect.js";
import { createSessionOverlay } from "../managed-file.js";
import type { AgentAdapter, DetectResult, SessionLaunchInput } from "../types.js";
import { createPiFamily, PI_MARKER, PI_MARKER_KEY } from "./family.js";
import { PI_KEY_EXPORT_GUARD_PATH } from "./guard.js";
import { PI_PROVIDER_ID } from "./ownership.js";
import { piAgentDir, piSessionDir } from "./paths.js";
import { buildPiProvider, piBaseUrl } from "./provider.js";

const PI_ID = "pi";
const PI_BIN = "pi";

const pi = createPiFamily({
  id: PI_ID,
  label: "Pi",
  agentDir: piAgentDir,
  dirEnv: "PI_CODING_AGENT_DIR",
});

/**
 * The Pi release the install hint pins (check-dist keeps ci.yml in step).
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const PI_VERSION = "0.87.1";

const PI_INSTALL = {
  command: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION}`,
  url: "https://pi.dev",
};

export const piAdapter: AgentAdapter = {
  id: PI_ID,
  label: "Pi",
  bin: PI_BIN,
  install: PI_INSTALL,
  launchModelFlags: ["--model"],
  // No shadowEnv: the only PI_* names Pi consults are
  // PI_CODING_AGENT_DIR — which sessionLaunch sets, so the
  // overlay always wins over an inherited value — and
  // PI_CODING_AGENT_SESSION_DIR, which points at session
  // history, not routing. No inherited name overrides the
  // overlay's models.json/auth.json, so there is nothing to
  // delete: an evidence-based empty, not a guessed sweep.
  // "--model native" leaves the model unpinned instead of
  // catalog-validated (README: `--model native`); the launcher
  // passes the literal through only for adapters that opt in.
  allowUnpinnedModel: true,
  detect(): DetectResult {
    return detectBinary(PI_BIN);
  },
  carriesWiring: pi.carriesWiring,
  managedFiles: pi.managedFiles,
  probe: pi.probe,
  bakedBaseUrl: pi.bakedBaseUrl,
  enableGuard: pi.enableGuard,
  enable: pi.enable,
  disable: pi.disable,
  refreshKey: pi.refreshKey,
  async sessionLaunch(input: SessionLaunchInput) {
    // Works with no prior `on`: a throwaway overlay becomes
    // PI_CODING_AGENT_DIR holding only a generated models.json (the same
    // provider block `on` writes), auth.json with the session key, and a
    // settings.json that loads the key-export tool_call guard. Config files
    // are 0600. The key never rides the child env — the overlay file is how Pi
    // reads it — and cleanup removes the overlay after the child exits.
    // Real session history survives in the user's own session dir, pointed
    // at through PI_CODING_AGENT_SESSION_DIR (Pi treats an empty value as
    // unset): else settings.json `sessionDir`, else Pi's per-cwd default
    // <agent dir>/sessions/--<encoded cwd>--. The overlay would otherwise
    // be the agent dir — its history must not vanish with the throwaway.
    // No Pi config files are written under ~/.pi; history still lands in
    // the user's dir.
    // "--model native" leaves the model unpinned (README: `--model
    // native`): the model stays undefined so Pi starts on its own
    // default within the aiand provider, and --model is dropped from
    // the launch args. Any other undefined model resolves through the
    // catalog as before.
    let model = input.model;
    if (model === "native") {
      model = undefined;
    } else if (model === undefined) {
      model = resolveDefault(input.catalog, input.profileModel);
    }
    const overlay = await createSessionOverlay("aiand-pi-", {
      "models.json": `${JSON.stringify(
        {
          providers: {
            [PI_PROVIDER_ID]: buildPiProvider({
              baseUrl: piBaseUrl(input.baseUrl),
              catalog: input.catalog,
            }),
          },
        },
        null,
        2,
      )}\n`,
      "settings.json": `${JSON.stringify({ extensions: [PI_KEY_EXPORT_GUARD_PATH] }, null, 2)}\n`,
      "auth.json": `${JSON.stringify({
        [PI_PROVIDER_ID]: { type: "api_key", key: input.apiKey, [PI_MARKER_KEY]: PI_MARKER },
      })}\n`,
    });
    // Pi reads --provider only alongside --model; for native, --models
    // scopes its own default pick to the aiand provider. `**`, not `*`:
    // Pi matches with minimatch, where `*` does not cross `/`, and catalog
    // ids contain one (`zai-org/glm-5.3`) — `aiand/*` matches nothing and
    // Pi silently falls back to its own default provider.
    const args = [
      "--provider",
      PI_PROVIDER_ID,
      ...(model === undefined ? ["--models", `${PI_PROVIDER_ID}/**`] : ["--model", model]),
    ];
    // Non-TTY stdin: ask for an explicit one-shot mode. Upstream Pi has had
    // hang bugs with redirected stdin when no mode is set; a piped prompt
    // must process and exit, not sit on an interactive session.
    if (!process.stdin.isTTY) args.push("--print");
    return {
      env: {
        PI_CODING_AGENT_DIR: overlay.dir,
        PI_CODING_AGENT_SESSION_DIR:
          process.env.PI_CODING_AGENT_SESSION_DIR || (await piSessionDir()),
      },
      // --provider/--model pin the routing; a user-supplied --api-key would
      // override the overlay's credential, so it is stripped with the rest
      // of the routing flags (both `--flag value` and `--flag=value`).
      args,
      stripPassthroughFlags: ["--provider", "--model", "--models", "--api-key"],
      cleanup: overlay.cleanup,
    };
  },
};
