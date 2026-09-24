import { fstatSync } from "node:fs";

type StdinStats = {
  isFIFO(): boolean;
  isFile(): boolean;
  isSocket(): boolean;
  mode: number;
};

/** Exported so tests can cover Windows anonymous-pipe mode bits (4096) on Linux CI. */
export function stdinLooksPiped(stats: StdinStats, isTTY: unknown): boolean {
  if (isTTY) return false;
  if (stats.isFIFO() || stats.isFile() || stats.isSocket()) return true;
  return (stats.mode & 0o170000) === 0o10000;
}

function hasPipedInput(): boolean {
  if (process.stdin.isTTY) return false;
  try {
    const stats = fstatSync(0);
    // FIFOs are shell pipes, files are redirections, and sockets are Node
    // child_process pipes (AF_UNIX socketpairs). Windows anonymous pipes set
    // S_IFIFO in the mode bits while isFIFO() stays false, so stdinLooksPiped
    // checks the mode too.
    return stdinLooksPiped(stats, false);
  } catch {
    return false;
  }
}

export async function readStdin(): Promise<string | null> {
  if (!hasPipedInput()) return null;
  if (typeof process.stdin.resume === "function") process.stdin.resume();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text.length > 0 ? text : null;
}
