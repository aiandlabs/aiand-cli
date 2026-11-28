// A minimal corporate proxy for tests: CONNECT only, behind Basic, NTLM
// (NTLMv2 responses checked against a known password) or Negotiate (a fixed
// fake token, for driving the relay with a stub curl). It records every
// tunnel it opened and every scheme a client signed in with.
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect, createServer } from "node:net";

// MD4 (RFC 1320), which NTLM needs and OpenSSL 3 no longer ships by default.
function md4(input) {
  const msg = Buffer.from(input);
  const length = msg.length;
  const padded = Buffer.alloc((((length + 8) >> 6) + 1) << 6);
  msg.copy(padded);
  padded[length] = 0x80;
  padded.writeUInt32LE((length * 8) >>> 0, padded.length - 8);
  padded.writeUInt32LE(Math.floor((length * 8) / 2 ** 32), padded.length - 4);
  let [a, b, c, d] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const f = (x, y, z) => (x & y) | (~x & z);
  const g = (x, y, z) => (x & y) | (x & z) | (y & z);
  const h = (x, y, z) => x ^ y ^ z;
  for (let offset = 0; offset < padded.length; offset += 64) {
    const x = Array.from({ length: 16 }, (_, i) => padded.readUInt32LE(offset + i * 4));
    const [aa, bb, cc, dd] = [a, b, c, d];
    const r1 = (p, q, r, s, k, n) => rotl((p + f(q, r, s) + x[k]) >>> 0, n);
    const r2 = (p, q, r, s, k, n) => rotl((p + g(q, r, s) + x[k] + 0x5a827999) >>> 0, n);
    const r3 = (p, q, r, s, k, n) => rotl((p + h(q, r, s) + x[k] + 0x6ed9eba1) >>> 0, n);
    for (const k of [0, 4, 8, 12]) {
      a = r1(a, b, c, d, k, 3);
      d = r1(d, a, b, c, k + 1, 7);
      c = r1(c, d, a, b, k + 2, 11);
      b = r1(b, c, d, a, k + 3, 19);
    }
    for (const k of [0, 1, 2, 3]) {
      a = r2(a, b, c, d, k, 3);
      d = r2(d, a, b, c, k + 4, 5);
      c = r2(c, d, a, b, k + 8, 9);
      b = r2(b, c, d, a, k + 12, 13);
    }
    for (const k of [0, 2, 1, 3]) {
      a = r3(a, b, c, d, k, 3);
      d = r3(d, a, b, c, k + 8, 9);
      c = r3(c, d, a, b, k + 4, 11);
      b = r3(b, c, d, a, k + 12, 15);
    }
    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }
  const out = Buffer.alloc(16);
  for (const [i, word] of [a, b, c, d].entries()) out.writeUInt32LE(word, i * 4);
  return out;
}

const utf16 = (text) => Buffer.from(text, "utf16le");

function ntlmField(message, offset) {
  const length = message.readUInt16LE(offset);
  const start = message.readUInt32LE(offset + 4);
  return message.subarray(start, start + length);
}

function type2(challenge) {
  const domain = utf16("CORP");
  const info = Buffer.concat([
    Buffer.from([2, 0]),
    Buffer.from([domain.length, 0]),
    domain,
    Buffer.from([0, 0, 0, 0]),
  ]);
  const head = Buffer.alloc(48);
  head.write("NTLMSSP\0", 0, "latin1");
  head.writeUInt32LE(2, 8);
  head.writeUInt16LE(domain.length, 12);
  head.writeUInt16LE(domain.length, 14);
  head.writeUInt32LE(48, 16);
  head.writeUInt32LE(0x00898205, 20);
  challenge.copy(head, 24);
  head.writeUInt16LE(info.length, 40);
  head.writeUInt16LE(info.length, 42);
  head.writeUInt32LE(48 + domain.length, 44);
  return Buffer.concat([head, domain, info]).toString("base64");
}

/** Whether an NTLM type 3 message proves `password` for its user (NTLMv2). */
function checkType3(message, challenge, password) {
  if (message.subarray(0, 8).toString("latin1") !== "NTLMSSP\0" || message.readUInt32LE(8) !== 3) {
    return null;
  }
  const nt = ntlmField(message, 20);
  const domain = ntlmField(message, 28).toString("utf16le");
  const user = ntlmField(message, 36).toString("utf16le");
  if (nt.length <= 24) return null;
  const key = createHmac("md5", md4(utf16(password)))
    .update(utf16(user.toUpperCase() + domain))
    .digest();
  const blob = nt.subarray(16);
  const proof = createHmac("md5", key)
    .update(Buffer.concat([challenge, blob]))
    .digest();
  return proof.equals(nt.subarray(0, 16)) ? user : null;
}

export const NEGOTIATE_TOKEN = "YIIfake-kerberos-ticket";

/**
 * Start the proxy. `schemes` is what it offers, in order. Tunnels go to
 * loopback only, whatever the CONNECT names: the test network is all local.
 */
export async function startAuthProxy({
  schemes = ["NTLM"],
  username = "alice",
  password = "correct horse",
  closeOn407 = false,
} = {}) {
  const tunnels = [];
  const signIns = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let challenge = null;
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const text = buffer.subarray(0, end).toString("latin1");
        buffer = buffer.subarray(end + 4);
        const [line, ...lines] = text.split("\r\n");
        const match = /^CONNECT (\S+) HTTP\/1\.1$/.exec(line);
        if (!match) {
          socket.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        const auth = lines
          .find((l) => /^proxy-authorization:/i.test(l))
          ?.slice("proxy-authorization:".length)
          .trim();
        const deny = (extra) => {
          const offers = extra
            ? [extra]
            : schemes.map((s) => (s === "Basic" ? 'Basic realm="corp"' : s));
          const body = "sign in";
          socket.write(
            [
              "HTTP/1.1 407 Proxy Authentication Required",
              ...offers.map((o) => `Proxy-Authenticate: ${o}`),
              `Content-Length: ${body.length}`,
              closeOn407 ? "Connection: close" : "Proxy-Connection: keep-alive",
              "",
              body,
            ].join("\r\n"),
          );
          if (closeOn407) socket.end();
        };
        let ok = false;
        let scheme = auth?.split(" ")[0];
        const data = auth?.split(" ")[1] ?? "";
        if (scheme === "Basic" && schemes.includes("Basic")) {
          ok = Buffer.from(data, "base64").toString("utf8") === `${username}:${password}`;
        } else if (scheme === "Negotiate" && schemes.includes("Negotiate")) {
          ok = data === NEGOTIATE_TOKEN;
        } else if (scheme === "NTLM" && schemes.includes("NTLM")) {
          const message = Buffer.from(data, "base64");
          if (message.length >= 12 && message.readUInt32LE(8) === 1) {
            challenge = randomBytes(8);
            deny(`NTLM ${type2(challenge)}`);
            continue;
          }
          ok = challenge !== null && checkType3(message, challenge, password) === username;
        } else {
          scheme = undefined;
        }
        if (!ok) {
          deny();
          continue;
        }
        signIns.push(scheme);
        const [, port] = /:(\d+)$/.exec(match[1]) ?? [];
        socket.off("data", onData);
        tunnels.push(match[1]);
        const upstream = connect(Number(port), "127.0.0.1", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (buffer.length > 0) upstream.write(buffer);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
        sockets.add(upstream);
        upstream.on("close", () => sockets.delete(upstream));
        return;
      }
    };
    socket.on("data", onData);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    tunnels,
    signIns,
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
