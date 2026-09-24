import { spawnSync } from "node:child_process";

import type { DetectResult } from "./types.js";

/**
 * Probe whether a coding-agent binary is on PATH. `which`/`where` exit 0 only
 * when the binary resolves, and the first output line is the resolved path.
 */
export function detectBinary(bin: string): DetectResult {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
    encoding: "utf8",
  });
  if (probe.error || probe.status !== 0) return { installed: false, path: null };
  const firstLine = probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return { installed: true, path: firstLine ?? null };
}

/**
 * The OpenCode release CI and the install hint pin (check-dist keeps ci.yml in step).
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const OPENCODE_VERSION = "1.18.32";

/**
 * Per-agent install commands and docs, shown when `detectBinary` misses.
 * Keyed by agent id.
 */
export const INSTALL_HINTS: Record<string, { command: string; url: string }> = {
  opencode: {
    command: `npm install -g opencode-ai@${OPENCODE_VERSION}`,
    url: "https://opencode.ai",
  },
};
