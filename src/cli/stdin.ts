import { fstatSync } from "node:fs";

function hasPipedInput(): boolean {
  if (process.stdin.isTTY) return false;
  try {
    const stats = fstatSync(0);
    return stats.isFIFO() || stats.isFile();
  } catch {
    return false;
  }
}

export async function readStdin(): Promise<string | null> {
  if (!hasPipedInput()) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text.length > 0 ? text : null;
}
