/**
 * Single color-enable policy for the UI layer. Honors NO_COLOR, FORCE_COLOR,
 * TERM=dumb, and TTY — per no-color.org and common Node/chalk conventions.
 * An empty `NO_COLOR` does not disable color (no-color.org: only a non-empty value does).
 */
export function colorsEnabled(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") {
    return true;
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return false;
  }
  if (env.TERM === "dumb") {
    return false;
  }
  return Boolean(stream?.isTTY);
}
