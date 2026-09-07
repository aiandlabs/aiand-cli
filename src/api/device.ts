import { ApiError, CliError } from "../cli/errors.js";
import { userAgent } from "./client.js";

/**
 * OAuth 2.0 device authorization grant (RFC 8628), served under /auth/device.
 * The `access_token` it returns is an organization-scoped `sk-` API key rather
 * than a JWT, so it authenticates every other request the CLI makes.
 */

const CLIENT_ID = "aiand-cli";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  /** Relative to the auth origin -- the server documents it that way. */
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
};

type TokenErrorBody = { error: string; error_description?: string };

async function postJson(url: string, body: unknown): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": userAgent(),
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new ApiError(0, `Could not reach ${new URL(url).origin}: ${reason}`, {
      hint: "Check your network, or pick another environment with --env.",
    });
  }
}

export async function startDeviceAuthorization(authUrl: string): Promise<DeviceCodeResponse> {
  const response = await postJson(`${authUrl}/auth/device/code`, { client_id: CLIENT_ID });
  if (!response.ok) {
    throw new ApiError(response.status, "Could not start a device login.", {
      hint: `${authUrl} did not accept the request (HTTP ${response.status}).`,
    });
  }
  return (await response.json()) as DeviceCodeResponse;
}

/** Absolute URL to open in the browser; the server redirects it to the console. */
export function verificationUrl(authUrl: string, device: DeviceCodeResponse): string {
  const path = device.verification_uri_complete || device.verification_uri;
  return path.startsWith("http") ? path : `${authUrl}${path}`;
}

export type PollOptions = {
  /** Called when the server asks us to back off, so the UI can say so. */
  onSlowDown?: (intervalSeconds: number) => void;
  signal?: AbortSignal;
};

/**
 * Poll until the user approves in the browser. Honours the server's `interval`
 * and gives up when `expires_in` elapses.
 */
export async function pollForToken(
  authUrl: string,
  device: DeviceCodeResponse,
  options: PollOptions = {}
): Promise<TokenResponse> {
  const deadline = Date.now() + device.expires_in * 1000;
  let interval = Math.max(1, device.interval);

  for (;;) {
    if (options.signal?.aborted) throw new CliError("Login cancelled.", { exitCode: 130 });
    if (Date.now() >= deadline) {
      throw new CliError("The login code expired before it was approved.", {
        hint: "Run `aiand login` again.",
      });
    }

    await sleep(interval * 1000, options.signal);

    const response = await postJson(`${authUrl}/auth/device/token`, {
      grant_type: DEVICE_GRANT,
      device_code: device.device_code,
    });

    if (response.ok) return (await response.json()) as TokenResponse;

    const body = (await response.json().catch(() => ({}))) as Partial<TokenErrorBody>;
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        options.onSlowDown?.(interval);
        continue;
      case "access_denied":
        throw new CliError("Login was denied in the browser.", { exitCode: 3 });
      case "expired_token":
        throw new CliError("The login code expired before it was approved.", {
          hint: "Run `aiand login` again.",
        });
      default:
        throw new ApiError(
          response.status,
          body.error_description ?? body.error ?? "Device login failed.",
          { hint: "Run `aiand login` again." }
        );
    }
  }
}

export async function rotateTokens(
  authUrl: string,
  refreshToken: string
): Promise<TokenResponse> {
  const response = await postJson(`${authUrl}/auth/device/token`, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (!response.ok) {
    throw new CliError("Your CLI session could not be refreshed.", {
      exitCode: 2,
      hint: "Run `aiand login` to sign in again.",
    });
  }
  return (await response.json()) as TokenResponse;
}

/** Revokes the minted key server-side. Best-effort: logout must still succeed offline. */
export async function revokeTokens(authUrl: string, refreshToken: string): Promise<boolean> {
  try {
    const response = await postJson(`${authUrl}/auth/device/logout`, {
      refresh_token: refreshToken,
    });
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new CliError("Login cancelled.", { exitCode: 130 }));
      },
      { once: true }
    );
  });
}
