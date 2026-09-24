// Duration units. The gateway speaks Unix seconds (expires_at, expires_in,
// poll interval); timers and Date speak milliseconds.
export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const MINUTE_SECONDS = 60;
export const HOUR_SECONDS = 60 * MINUTE_SECONDS;
export const DAY_SECONDS = 24 * HOUR_SECONDS;

/** The current Unix time in whole seconds. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / SECOND_MS);
}
