import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { Route } from "./pac.js";
import type { AuthOptions } from "./proxy-auth.js";
import { connectSocket, ProxySessions, TunnelError } from "./proxy-session.js";
import type { Head } from "./socket-reader.js";

/**
 * The proxy bridge: a proxy on loopback that this aiand process runs for its
 * own requests and the agents it starts. It routes each connection the way
 * the system settings say (PAC, WPAD or a fixed proxy) and signs in to the
 * corporate proxy for them. https goes through CONNECT tunnels, so it never
 * sees inside TLS; plain http goes to the proxy as an ordinary request. A random password in its URL keeps other local users off
 * it, since it signs in as this user.
 */

const MAX_PLAIN_BODY = 8 * 1024 * 1024;

export type BridgeOptions = {
  routes(url: URL): Promise<Route[]>;
  auth: AuthOptions;
  log?: (line: string) => void;
};

export type Bridge = {
  /** `http://aiand:<password>@127.0.0.1:<port>`: for HTTPS_PROXY and HTTP_PROXY only. */
  url: string;
  /** Why connections failed, one line per distinct reason, without any credential. */
  failures(): string[];
  close(): Promise<void>;
};

function bracket(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

async function openTunnel(
  routes: Route[],
  host: string,
  port: number,
  sessions: ProxySessions,
  log: (line: string) => void,
): Promise<{ socket: Socket; rest: Buffer }> {
  const target = `${bracket(host)}:${port}`;
  let failure: Error = new TunnelError(`no route to ${target}`);
  for (const route of routes) {
    try {
      if (route.kind === "direct") {
        log(`${target}: DIRECT`);
        return { socket: await connectSocket(host, port), rest: Buffer.alloc(0) };
      }
      log(`${target}: PROXY ${route.host}:${route.port}`);
      const { connection } = await sessions.request(route, {
        line: `CONNECT ${target} HTTP/1.1`,
        headers: [["Host", target]],
        body: Buffer.alloc(0),
        tunnel: true,
      });
      return { socket: connection.reader.socket, rest: connection.reader.release() };
    } catch (error) {
      failure = error as Error;
    }
  }
  throw failure;
}

const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** A client's request headers as sent on: hop-by-hop ones dropped, the body's length set. */
function forwardHeaders(req: IncomingMessage, body: Buffer): [string, string][] {
  const headers: [string, string][] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "content-length") continue;
    headers.push([name, req.rawHeaders[i + 1]!]);
  }
  if (body.length > 0 || req.method === "POST" || req.method === "PUT") {
    headers.push(["Content-Length", String(body.length)]);
  }
  return headers;
}

/** A run long enough to be a key, a refresh token or a signature. */
const TOKEN_RUN = /[A-Za-z0-9_-]{24,}/;

/** Headers a plain fetch needs, and nothing that could carry a credential. */
const PLAIN_SAFE_HEADERS = new Set([
  "host",
  "accept",
  "accept-encoding",
  "accept-language",
  "user-agent",
  "cache-control",
  "pragma",
  "if-modified-since",
  "if-none-match",
  "range",
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "keep-alive",
  "te",
]);

/**
 * Whether a plain http request may go through a proxy, which can read it.
 * Only a plain fetch qualifies: no body, no header outside a short
 * allowlist, no user name or password, no query parameter named like a
 * credential, and no long token-like run in a header value, the path or the
 * query (where keys, refresh tokens and signed links travel).
 * Anything else needs https, where it stays inside a tunnel.
 */
function plainFetchMayUseProxy(req: IncomingMessage, target: URL, body: Buffer): boolean {
  if (body.length > 0 || target.username !== "" || target.password !== "") return false;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    if (!PLAIN_SAFE_HEADERS.has(name)) return false;
    // The bridge's own sign-in and hop-by-hop headers are not sent on.
    if (HOP_BY_HOP.has(name)) continue;
    if (TOKEN_RUN.test(req.rawHeaders[i + 1]!)) return false;
  }
  for (const name of target.searchParams.keys()) {
    if (/auth|token|key|secret|session|passw|credential|sig|code/i.test(name)) return false;
  }
  return !TOKEN_RUN.test(`${target.pathname}${target.search}`);
}

/** A response head to write straight to the client, closing the connection after it. */
function rawHead(head: Head): string {
  const lines = [head.line];
  for (const [name, value] of head.headers) {
    if (!["connection", "proxy-connection", "keep-alive"].includes(name.toLowerCase())) {
      lines.push(`${name}: ${value}`);
    }
  }
  lines.push("Connection: close");
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PLAIN_BODY) {
        resolve(null);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(size > MAX_PLAIN_BODY ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * A plain http request: direct, or to the proxy in absolute form (signed in
 * as for a tunnel), the answer passed back raw and the connection closed.
 */
async function forwardPlain(
  req: IncomingMessage,
  target: URL,
  body: Buffer,
  routes: Route[],
  sessions: ProxySessions,
  log: (line: string) => void,
  started: { value: boolean },
): Promise<void> {
  const client = req.socket;
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const port = Number(target.port || 80);
  const headers = forwardHeaders(req, body);
  const method = req.method ?? "GET";
  let failure: Error = new TunnelError(`no route to ${target.host}`);
  for (const route of routes) {
    try {
      if (route.kind === "direct") {
        log(`${target.host}: DIRECT`);
        const socket = await connectSocket(host, port);
        const lines = [`${method} ${target.pathname}${target.search} HTTP/1.1`];
        for (const [name, value] of headers) lines.push(`${name}: ${value}`);
        lines.push("Connection: close");
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (body.length > 0) socket.write(body);
        socket.on("error", () => client.destroy());
        started.value = true;
        socket.pipe(client);
        return;
      }
      log(`${target.host}: PROXY ${route.host}:${route.port}`);
      // Plain http to a proxy is readable by the proxy: only a plain fetch
      // is sent that way. https keeps everything else inside a tunnel.
      if (!plainFetchMayUseProxy(req, target, body)) {
        throw new TunnelError(
          `a plain http request to ${target.host} could carry credentials (a body, headers beyond a plain fetch, or a token-like path), so aiand does not send it through the proxy ${route.host}:${route.port}; use https`,
        );
      }
      const { connection, head } = await sessions.request(route, {
        line: `${method} ${target.href} HTTP/1.1`,
        headers,
        body,
        tunnel: false,
      });
      started.value = true;
      client.write(rawHead(head));
      await connection.reader.relayBody(head, method, (chunk) => client.write(chunk));
      connection.reader.socket.destroy();
      client.end();
      return;
    } catch (error) {
      failure = error as Error;
    }
  }
  throw failure;
}

/** host and port from a CONNECT target (`host:port` or `[v6]:port`). */
function parseTarget(text: string): { host: string; port: number } | null {
  // Host name characters only: no userinfo (`a@b`), path or percent-escape
  // can make the name routed differ from the name connected to.
  const match = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?)):(\d{1,5})$/i.exec(
    text,
  );
  if (!match) return null;
  const port = Number(match[3]);
  const host = (match[1] ?? match[2])!;
  if (match[1] !== undefined && isIP(host) !== 6) return null;
  return port > 0 && port < 65_536 ? { host, port } : null;
}

function plainResponse(status: number, reason: string, extra: string[] = []): string {
  return [
    `HTTP/1.1 ${status} ${reason}`,
    ...extra,
    "Content-Length: 0",
    "Connection: close",
    "",
    "",
  ].join("\r\n");
}

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const password = randomBytes(24).toString("base64url");
  const expected = Buffer.from(`Basic ${Buffer.from(`aiand:${password}`).toString("base64")}`);
  const failures = new Set<string>();
  const log = options.log ?? (() => {});
  const sockets = new Set<Duplex>();
  const sessions = new ProxySessions(options.auth, log);

  const authorized = (req: IncomingMessage): boolean => {
    const given = Buffer.from(req.headers["proxy-authorization"] ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const fail = (error: unknown): TunnelError => {
    const tunnelError =
      error instanceof TunnelError ? error : new TunnelError((error as Error).message);
    failures.add(tunnelError.message);
    log(`failed: ${tunnelError.message}`);
    return tunnelError;
  };
  const tunnelFor = async (host: string, port: number, scheme: "http" | "https") => {
    const routes = await options.routes(
      new URL(`${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}/`),
    );
    return openTunnel(routes, host, port, sessions, log);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!authorized(req)) {
      res
        .writeHead(407, { "Proxy-Authenticate": 'Basic realm="aiand"', Connection: "close" })
        .end();
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? "");
      if (target.protocol !== "http:" || target.username || target.password) {
        throw new Error("not a plain http URL");
      }
    } catch {
      res.writeHead(400, { Connection: "close" }).end();
      return;
    }
    void (async () => {
      const body = await readBody(req).catch(() => null);
      if (body === null) {
        res.writeHead(413, { Connection: "close" }).end();
        return;
      }
      const started = { value: false };
      try {
        const routes = await options.routes(target);
        await forwardPlain(req, target, body, routes, sessions, log, started);
      } catch (error) {
        fail(error);
        if (!started.value) {
          res.writeHead(502, { Connection: "close" }).end();
        } else {
          req.socket.destroy();
        }
      }
    })();
  });

  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    if (!authorized(req)) {
      client.end(
        plainResponse(407, "Proxy Authentication Required", [
          'Proxy-Authenticate: Basic realm="aiand"',
        ]),
      );
      return;
    }
    const target = parseTarget(req.url ?? "");
    if (!target) {
      client.end(plainResponse(400, "Bad Request"));
      return;
    }
    const scheme = target.port === 80 ? "http" : "https";
    tunnelFor(target.host, target.port, scheme).then(
      ({ socket, rest }) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => client.destroy());
        client.on("close", () => socket.destroy());
        socket.on("close", () => client.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length > 0) client.write(rest);
        if (head.length > 0) socket.write(head);
        socket.pipe(client);
        client.pipe(socket);
        socket.resume();
      },
      (error) => {
        // 407 would read as "sign in to aiand's bridge" to the client: report a bad gateway.
        fail(error);
        client.end(plainResponse(502, "Bad Gateway"));
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.unref();
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://aiand:${password}@127.0.0.1:${port}`,
    failures: () => [...failures],
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
