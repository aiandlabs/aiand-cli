import { fileURLToPath } from "node:url";

/** The compiled extension Pi loads from persistent settings or a session overlay. */
export const PI_KEY_EXPORT_GUARD_PATH: string = fileURLToPath(
  new URL("./guard.js", import.meta.url),
);

const PI_KEY_EXPORT =
  /(?:^|[\n;&|()])\s*(?:[^\s;&|()]*[\\/])?aiand(?:\.cmd|\.exe)?\s+key\s+export(?=$|[\s;&|()])/i;
const DENIED_REASON = "aiand key export is denied while ai& wiring is active";

/** Decide only direct Bash invocations; other tools and commands pass through. */
async function denyKeyExport(event: {
  toolName: string;
  input: unknown;
}): Promise<{ block: true; reason: string } | undefined> {
  if (event.toolName !== "bash" || typeof event.input !== "object" || event.input === null) {
    return undefined;
  }
  const command = (event.input as { command?: unknown }).command;
  if (typeof command !== "string" || !PI_KEY_EXPORT.test(command)) return undefined;
  return { block: true, reason: DENIED_REASON };
}

export default function guard(pi: {
  on(
    event: "tool_call",
    handler: (event: {
      toolName: string;
      input: unknown;
    }) => Promise<{ block: true; reason: string } | undefined>,
  ): void;
}): void {
  pi.on("tool_call", denyKeyExport);
}
