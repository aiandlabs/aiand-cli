import { connect, type Socket } from "node:net";
import type { Trust } from "./pac.js";
import {
  type AuthOptions,
  basicAuthorization,
  CurlHandshake,
  parseChallenges,
  type Scheme,
  schemesToTry,
} from "./proxy-auth.js";
import { type Head, SocketReader } from "./socket-reader.js";

/**
 * One request to the corporate proxy, signed in as needed: a CONNECT for a
 * tunnel, or a plain http request in absolute form (most proxies refuse a
 * CONNECT to port 80). A request is resent unchanged on every sign-in leg,
 * so its body is held in memory.
 */

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_AUTH_LEGS = 5;
/** Sign-in handshakes at once: each starts curl, so a burst of tunnels waits its turn. */
const MAX_HANDSHAKES = 4;

export class TunnelError extends Error {}

export type ProxyRoute = { host: string; port: number; trust?: Trust };

export function connectSocket(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(
      () => socket.destroy(new Error(`timed out connecting to ${host}:${port}`)),
      CONNECT_TIMEOUT_MS,
    );
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** What to send: the request head (without Proxy-Authorization) and any body. */
export type ProxyRequest = {
  /** `CONNECT host:port HTTP/1.1` or `GET http://host/path HTTP/1.1`. */
  line: string;
  headers: [string, string][];
  body: Buffer;
  tunnel: boolean;
};

export type ProxyConnection = { reader: SocketReader; reusable: boolean };

async function openProxy(proxy: ProxyRoute): Promise<ProxyConnection> {
  return { reader: new SocketReader(await connectSocket(proxy.host, proxy.port)), reusable: true };
}

/**
 * Send `request` on `connection` and read the answer's head. A 407, and any
 * non-200 answer to a CONNECT, has its body skipped; any other answer to an
 * http request keeps its body in the reader for the caller to relay.
 */
async function send(
  connection: ProxyConnection,
  request: ProxyRequest,
  authorization: string | null,
): Promise<Head> {
  const lines = [request.line, ...request.headers.map(([k, v]) => `${k}: ${v}`)];
  lines.push("Proxy-Connection: keep-alive");
  if (authorization !== null) lines.push(`Proxy-Authorization: ${authorization}`);
  connection.reader.socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  if (request.body.length > 0) connection.reader.socket.write(request.body);
  const head = await connection.reader.head(true);
  if (head.status === 407 || (request.tunnel && head.status !== 200)) {
    connection.reusable = await connection.reader.skipBody(head).catch(() => false);
  }
  return head;
}

class Gate {
  #free: number;
  readonly #waiting: (() => void)[] = [];
  constructor(size: number) {
    this.#free = size;
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free -= 1;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#free += 1;
    }
  }
}

/** The sign-in each proxy took last, so the next request starts with it. */
export class ProxySessions {
  readonly #schemes = new Map<string, Scheme>();
  readonly #gate = new Gate(MAX_HANDSHAKES);
  readonly #auth: AuthOptions;
  readonly #log: (line: string) => void;

  constructor(auth: AuthOptions, log: (line: string) => void) {
    this.#auth = auth;
    this.#log = log;
  }

  /** What may be offered to `proxy`, by how far it is trusted. */
  #authFor(proxy: ProxyRoute): AuthOptions {
    const trust = proxy.trust ?? "full";
    if (trust === "full") return this.#auth;
    if (trust === "intranet") return { ...this.#auth, credentials: null };
    return { ...this.#auth, credentials: null, curl: null };
  }

  /** Sign in with one scheme, leg by leg on one connection. Resolves the last answer. */
  async #signIn(
    scheme: Scheme,
    connection: ProxyConnection,
    request: ProxyRequest,
    proxy: ProxyRoute,
    auth: AuthOptions,
  ): Promise<Head | null> {
    if (scheme === "Basic") {
      return auth.credentials
        ? send(connection, request, basicAuthorization(auth.credentials))
        : null;
    }
    const curl = auth.curl;
    if (curl === null) return null;
    return this.#gate.run(async () => {
      const handshake = await CurlHandshake.start({
        curl,
        scheme,
        proxy,
        credentials: auth.credentials,
      });
      try {
        let token = await handshake.next(null);
        let last: Head | null = null;
        for (let leg = 0; token !== null && leg < MAX_AUTH_LEGS; leg++) {
          last = await send(connection, request, token);
          if (last.status !== 407 || !connection.reusable) return last;
          const challenge = parseChallenges(last).find(
            (c) => c.scheme.toLowerCase() === scheme.toLowerCase() && c.data !== "",
          );
          if (!challenge) return last;
          token = await handshake.next(`${scheme} ${challenge.data}`);
        }
        return last;
      } finally {
        handshake.close();
      }
    });
  }

  /**
   * Send `request` through `proxy`, signing in as needed. Resolves the
   * connection and the proxy's final answer (200 for a tunnel; for an http
   * request, whatever the origin answered, its body still in the reader).
   */
  async request(
    proxy: ProxyRoute,
    request: ProxyRequest,
  ): Promise<{ connection: ProxyConnection; head: Head }> {
    const name = `${proxy.host}:${proxy.port}`;
    const auth = this.#authFor(proxy);
    const ok = (head: Head): boolean =>
      request.tunnel ? head.status === 200 : head.status !== 407;
    const known = this.#schemes.get(name);
    if (known !== undefined && schemesToTry([{ scheme: known, data: "" }], auth).includes(known)) {
      const connection = await openProxy(proxy);
      const answer = await this.#signIn(known, connection, request, proxy, auth).catch(() => null);
      if (answer !== null && ok(answer)) return { connection, head: answer };
      connection.reader.socket.destroy();
      this.#schemes.delete(name);
    }
    let connection = await openProxy(proxy);
    try {
      let head = await send(connection, request, null);
      if (ok(head)) return { connection, head };
      if (head.status !== 407) {
        throw new TunnelError(
          `the proxy ${name} refused ${request.line.split(" ")[1]} (HTTP ${head.status})`,
        );
      }
      const offered = parseChallenges(head);
      const schemes = schemesToTry(offered, auth);
      if (schemes.length === 0) {
        const names = [...new Set(offered.map((c) => c.scheme))].join(", ") || "none";
        const why =
          (proxy.trust ?? "full") === "none"
            ? `; it was named by an automatically found PAC file and is outside this network's domain, so aiand does not sign in to it`
            : "";
        throw new TunnelError(
          `the proxy ${name} asks for sign-in aiand cannot give (offered: ${names})${why}`,
        );
      }
      for (const scheme of schemes) {
        if (!connection.reusable) {
          connection.reader.socket.destroy();
          connection = await openProxy(proxy);
        }
        const answer = await this.#signIn(scheme, connection, request, proxy, auth);
        this.#log(`proxy ${name} ${scheme}: ${answer ? `HTTP ${answer.status}` : "no token"}`);
        if (answer !== null && ok(answer)) {
          this.#schemes.set(name, scheme);
          return { connection, head: answer };
        }
        if (answer !== null) head = answer;
        connection.reusable = false;
      }
      throw new TunnelError(
        `signing in to the proxy ${name} failed (tried ${schemes.join(", ")}; last answer HTTP ${head.status})`,
      );
    } catch (error) {
      connection.reader.socket.destroy();
      throw error;
    }
  }
}
