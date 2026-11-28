import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { Route } from "./pac.js";
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
 * The proxy bridge: a proxy on loopback that this aiand process runs for its
 * own requests and the agents it starts. It routes each connection the way
 * the system settings say (PAC, WPAD or a fixed proxy) and signs in to the
 * corporate proxy for them. It only ever opens CONNECT tunnels, so it never
 * sees inside TLS. A random password in its URL keeps other local users off
 * it, since it signs in as this user.
 */

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_AUTH_LEGS = 5;

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

class TunnelError extends Error {}

function connectSocket(host: string, port: number): Promise<Socket> {
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

function connectRequest(target: string, authorization: string | null): string {
  const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`, "Proxy-Connection: keep-alive"];
  if (authorization !== null) lines.push(`Proxy-Authorization: ${authorization}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

type ProxyConnection = { reader: SocketReader; reusable: boolean };

async function openProxy(host: string, port: number): Promise<ProxyConnection> {
  return { reader: new SocketReader(await connectSocket(host, port)), reusable: true };
}

/** Send CONNECT on `connection` and read the answer, skipping any body. */
async function sendConnect(
  connection: ProxyConnection,
  target: string,
  authorization: string | null,
): Promise<Head> {
  connection.reader.socket.write(connectRequest(target, authorization));
  const head = await connection.reader.head(true);
  if (head.status !== 200)
    connection.reusable = await connection.reader.skipBody(head).catch(() => false);
  return head;
}

/** Sign in with one scheme, leg by leg on one connection. Resolves the last answer. */
async function signIn(
  scheme: Scheme,
  connection: ProxyConnection,
  target: string,
  proxy: { host: string; port: number },
  auth: AuthOptions,
): Promise<Head | null> {
  if (scheme === "Basic") {
    return auth.credentials
      ? sendConnect(connection, target, basicAuthorization(auth.credentials))
      : null;
  }
  if (auth.curl === null) return null;
  const handshake = await CurlHandshake.start({
    curl: auth.curl,
    scheme,
    proxy,
    credentials: auth.credentials,
  });
  try {
    let token = await handshake.next(null);
    let last: Head | null = null;
    for (let leg = 0; token !== null && leg < MAX_AUTH_LEGS; leg++) {
      last = await sendConnect(connection, target, token);
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
}

/** A CONNECT tunnel to `target` through `proxy`, signing in as needed. */
async function tunnelThroughProxy(
  proxy: { host: string; port: number },
  target: string,
  auth: AuthOptions,
  log: (line: string) => void,
): Promise<{ socket: Socket; rest: Buffer }> {
  let connection = await openProxy(proxy.host, proxy.port);
  const done = (): { socket: Socket; rest: Buffer } => ({
    socket: connection.reader.socket,
    rest: connection.reader.release(),
  });
  try {
    let head = await sendConnect(connection, target, null);
    if (head.status === 200) return done();
    if (head.status !== 407)
      throw new TunnelError(
        `the proxy ${proxy.host}:${proxy.port} refused ${target} (HTTP ${head.status})`,
      );
    const offered = parseChallenges(head);
    const schemes = schemesToTry(offered, auth);
    if (schemes.length === 0) {
      const names = [...new Set(offered.map((c) => c.scheme))].join(", ") || "none";
      throw new TunnelError(
        `the proxy ${proxy.host}:${proxy.port} asks for sign-in aiand cannot give (offered: ${names})`,
      );
    }
    for (const scheme of schemes) {
      if (!connection.reusable) {
        connection.reader.socket.destroy();
        connection = await openProxy(proxy.host, proxy.port);
      }
      const answer = await signIn(scheme, connection, target, proxy, auth);
      log(
        `proxy ${proxy.host}:${proxy.port} ${scheme}: ${answer ? `HTTP ${answer.status}` : "no token"}`,
      );
      if (answer?.status === 200) return done();
      if (answer !== null) head = answer;
      connection.reusable = false;
    }
    throw new TunnelError(
      `signing in to the proxy ${proxy.host}:${proxy.port} failed (tried ${schemes.join(", ")}; last answer HTTP ${head.status})`,
    );
  } catch (error) {
    connection.reader.socket.destroy();
    throw error;
  }
}

async function openTunnel(
  routes: Route[],
  host: string,
  port: number,
  auth: AuthOptions,
  log: (line: string) => void,
): Promise<{ socket: Socket; rest: Buffer }> {
  const target = `${host.includes(":") ? `[${host}]` : host}:${port}`;
  let failure: Error = new TunnelError(`no route to ${target}`);
  for (const route of routes) {
    try {
      if (route.kind === "direct") {
        log(`${target}: DIRECT`);
        return { socket: await connectSocket(host, port), rest: Buffer.alloc(0) };
      }
      log(`${target}: PROXY ${route.host}:${route.port}`);
      return await tunnelThroughProxy(route, target, auth, log);
    } catch (error) {
      failure = error as Error;
    }
  }
  throw failure;
}

/** host and port from a CONNECT target (`host:port` or `[v6]:port`). */
function parseTarget(text: string): { host: string; port: number } | null {
  const match = /^(?:\[([0-9a-f:.]+)\]|([^:[\]\s]+)):(\d{1,5})$/i.exec(text);
  if (!match) return null;
  const port = Number(match[3]);
  return port > 0 && port < 65_536 ? { host: (match[1] ?? match[2])!, port } : null;
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
    return openTunnel(routes, host, port, options.auth, log);
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
      if (target.protocol !== "http:") throw new Error("not http");
    } catch {
      res.writeHead(400, { Connection: "close" }).end();
      return;
    }
    const port = Number(target.port || 80);
    tunnelFor(target.hostname.replace(/^\[|\]$/g, ""), port, "http").then(
      ({ socket, rest }) => {
        if (rest.length > 0) socket.unshift(rest);
        const headers = { ...req.headers };
        delete headers["proxy-authorization"];
        delete headers["proxy-connection"];
        const upstream = httpRequest(
          {
            method: req.method,
            path: `${target.pathname}${target.search}`,
            headers,
            createConnection: () => socket,
          },
          (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(res);
          },
        );
        upstream.on("error", () => res.destroy());
        req.pipe(upstream);
      },
      (error) => {
        fail(error);
        res.writeHead(502, { Connection: "close" }).end();
      },
    );
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
