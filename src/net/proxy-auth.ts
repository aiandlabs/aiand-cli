import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { windowsSystemTool } from "../cli/win-spawn.js";
import { type Head, header, SocketReader } from "./socket-reader.js";

/**
 * Proxy sign-in. Basic is answered here. NTLM and Negotiate (Kerberos) need
 * the operating system's own sign-in: SSPI on Windows, GSS-API on macOS and
 * Linux. Node has no binding to either, so aiand asks the system's curl to
 * produce each token: curl is told the corporate proxy sits behind a SOCKS
 * server on loopback that aiand runs, so every Proxy-Authorization curl
 * writes comes to aiand, which relays it on its own connection to the proxy
 * and relays the proxy's challenge back. curl never reaches the network.
 * Windows ships curl.exe in System32 (signed, in the default application
 * allowlist, unaffected by PowerShell's language mode), macOS in /usr/bin.
 */

export type Scheme = "Negotiate" | "NTLM" | "Basic";
export type Challenge = { scheme: string; data: string };
export type ProxyCredentials = { username: string; password: string };

/** Each scheme and its data from the Proxy-Authenticate headers. */
export function parseChallenges(head: Head): Challenge[] {
  const challenges: Challenge[] = [];
  for (const value of header(head, "proxy-authenticate")) {
    for (const part of value.split(/,\s*(?=(?:Negotiate|NTLM|Basic|Digest|Kerberos|Bearer)\b)/i)) {
      const match = /^\s*([A-Za-z0-9-]+)(?:\s+(.*))?$/.exec(part);
      if (match) challenges.push({ scheme: match[1]!, data: (match[2] ?? "").trim() });
    }
  }
  return challenges;
}

export type AuthOptions = {
  platform: NodeJS.Platform;
  /** The system curl, or null when there is none. */
  curl: string | null;
  credentials: ProxyCredentials | null;
};

/**
 * The schemes to try, strongest first, from what the proxy offered and what
 * this machine can answer. NTLM without a password needs Windows' SSPI.
 */
export function schemesToTry(offered: Challenge[], options: AuthOptions): Scheme[] {
  const names = new Set(offered.map((c) => c.scheme.toLowerCase()));
  const schemes: Scheme[] = [];
  if (options.curl !== null && names.has("negotiate")) schemes.push("Negotiate");
  if (
    options.curl !== null &&
    names.has("ntlm") &&
    (options.platform === "win32" || options.credentials !== null)
  ) {
    schemes.push("NTLM");
  }
  if (options.credentials !== null && names.has("basic")) schemes.push("Basic");
  return schemes;
}

export function basicAuthorization(credentials: ProxyCredentials): string {
  const pair = `${credentials.username}:${credentials.password}`;
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
}

/** The system curl that can speak to the OS's sign-in, or null. */
export function systemCurl(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (platform === "win32") {
    const curl = windowsSystemTool("curl.exe", env);
    return exists(curl) ? curl : null;
  }
  return ["/usr/bin/curl", "/bin/curl", "/usr/local/bin/curl"].find(exists) ?? null;
}

/**
 * What curl needs to find the system and the user's sign-in (the Windows
 * profile, a Kerberos ticket cache), and nothing else: no key, no proxy
 * password, no proxy variable, no curl config.
 */
const CURL_ENV = new Set([
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "USERNAME",
  "USERDOMAIN",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "KRB5CCNAME",
  "KRB5_CONFIG",
  "NODEFAULTCURRENTDIRECTORYINEXEPATH",
]);

export function curlEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (CURL_ENV.has(name.toUpperCase())) next[name] = value;
  }
  return next;
}

/** A value for a curl config file line, quoted. */
function curlQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("A proxy credential cannot contain a line break.");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * One sign-in handshake through curl. `next` returns the next
 * Proxy-Authorization value curl wants to send, given the proxy's latest
 * challenge (none for the first); null when curl has nothing more to send.
 */
export class CurlHandshake {
  readonly #server: Server;
  readonly #child: ReturnType<typeof spawn>;
  readonly #scheme: Scheme;
  #reader: SocketReader | null = null;
  #ready: Promise<SocketReader | null>;
  #closed = false;

  private constructor(
    server: Server,
    child: ReturnType<typeof spawn>,
    scheme: Scheme,
    proxyHost: string,
  ) {
    this.#server = server;
    this.#child = child;
    this.#scheme = scheme;
    this.#ready = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), HANDSHAKE_TIMEOUT_MS);
      timer.unref();
      child.once("exit", () => resolve(null));
      child.once("error", () => resolve(null));
      server.once("connection", (socket: Socket) => {
        server.close();
        socket.on("error", () => {});
        acceptSocks(socket, proxyHost).then(
          (reader) => {
            clearTimeout(timer);
            this.#reader = reader;
            resolve(reader);
          },
          () => {
            socket.destroy();
            resolve(null);
          },
        );
      });
    });
  }

  static async start(options: {
    curl: string;
    scheme: Exclude<Scheme, "Basic">;
    proxy: { host: string; port: number };
    credentials: ProxyCredentials | null;
    env?: NodeJS.ProcessEnv;
  }): Promise<CurlHandshake> {
    const user = options.credentials
      ? `${options.credentials.username}:${options.credentials.password}`
      : ":";
    // The credentials reach curl on stdin, never on its command line.
    const config = `proxy-user = ${curlQuote(user)}\n`;
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const proxyHost = options.proxy.host.includes(":")
      ? `[${options.proxy.host}]`
      : options.proxy.host;
    const args = [
      "-q",
      "-s",
      "-o",
      process.platform === "win32" ? "NUL" : "/dev/null",
      "-K",
      "-",
      "--max-time",
      String(HANDSHAKE_TIMEOUT_MS / 1000),
      "--preproxy",
      `socks5h://127.0.0.1:${port}`,
      "--proxy",
      `http://${proxyHost}:${options.proxy.port}`,
      options.scheme === "Negotiate" ? "--proxy-negotiate" : "--proxy-ntlm",
      "http://aiand.invalid/",
    ];
    const env = curlEnv(options.env ?? process.env);
    const child = spawn(options.curl, args, {
      stdio: ["pipe", "ignore", "ignore"],
      env,
      windowsHide: true,
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(config);
    return new CurlHandshake(server, child, options.scheme, options.proxy.host);
  }

  /** curl's next Proxy-Authorization value, after passing it `challenge`. */
  async next(challenge: string | null): Promise<string | null> {
    const reader = await this.#ready;
    if (reader === null || this.#closed) return null;
    if (challenge !== null) reader.socket.write(challengeResponse(challenge));
    try {
      for (;;) {
        const head = await withTimeout(reader.head(false), HANDSHAKE_TIMEOUT_MS);
        if (head === null) return null;
        const authorization = header(head, "proxy-authorization")[0];
        if (authorization === undefined) {
          reader.socket.write(challengeResponse(this.#scheme));
          continue;
        }
        if (!authorization.toLowerCase().startsWith(`${this.#scheme.toLowerCase()} `)) return null;
        return authorization;
      }
    } catch {
      return null;
    }
  }

  close(): void {
    this.#closed = true;
    this.#server.close();
    this.#reader?.socket.destroy();
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill();
  }
}

function challengeResponse(challenge: string): string {
  return [
    "HTTP/1.1 407 Proxy Authentication Required",
    `Proxy-Authenticate: ${challenge}`,
    "Content-Length: 0",
    "Proxy-Connection: keep-alive",
    "",
    "",
  ].join("\r\n");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Answer curl's SOCKS5 greeting and CONNECT, as a server that accepts only
 * "no authentication" and only the proxy host aiand named.
 */
async function acceptSocks(socket: Socket, proxyHost: string): Promise<SocketReader> {
  const reader = new SocketReader(socket);
  const [version, count] = await reader.bytes(2);
  if (version !== 5 || count === undefined) throw new Error("not SOCKS5");
  const methods = await reader.bytes(count);
  if (!methods.includes(0)) throw new Error("no usable SOCKS method");
  socket.write(Buffer.from([5, 0]));
  const [, command, , type] = await reader.bytes(4);
  if (command !== 1) throw new Error("not a SOCKS CONNECT");
  let host: string;
  if (type === 3) {
    const [length = 0] = await reader.bytes(1);
    host = (await reader.bytes(length)).toString("latin1");
  } else if (type === 1) {
    host = [...(await reader.bytes(4))].join(".");
  } else if (type === 4) {
    const raw = await reader.bytes(16);
    host = Array.from({ length: 8 }, (_, i) => raw.readUInt16BE(i * 2).toString(16)).join(":");
  } else {
    throw new Error("unknown SOCKS address type");
  }
  await reader.bytes(2);
  if (type === 3 && host.toLowerCase() !== proxyHost.toLowerCase())
    throw new Error("unexpected host");
  socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
  return reader;
}
