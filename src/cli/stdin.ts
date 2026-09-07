import { fstatSync } from "node:fs";

/**
 * True when something is actually piped or redirected into stdin.
 *
 * `isTTY` alone is not enough: a non-interactive parent can hand us a character
 * device that never reaches EOF, and reading it would hang the command. Only a
 * pipe (`cmd | aiand`) or a redirected file (`aiand < file`) carries input.
 */
function hasPipedInput(): boolean {
  if (process.stdin.isTTY) return false;
  try {
    const stats = fstatSync(0);
    return stats.isFIFO() || stats.isFile();
  } catch {
    return false;
  }
}

/** Read piped stdin, or return null when nothing was piped in. */
export async function readStdin(): Promise<string | null> {
  if (!hasPipedInput()) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text.length > 0 ? text : null;
}
