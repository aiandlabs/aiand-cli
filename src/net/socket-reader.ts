import type { Socket } from "node:net";

const MAX_HEAD_BYTES = 64 * 1024;

/** A parsed HTTP/1.x message head: the first line's parts and the headers in order. */
export type Head = {
  /** Response: the status code; request: 0. */
  status: number;
  /** Request: method and target; response: version and reason. */
  line: string;
  headers: [string, string][];
};

export function header(head: Head, name: string): string[] {
  const wanted = name.toLowerCase();
  return head.headers.filter(([key]) => key.toLowerCase() === wanted).map(([, value]) => value);
}

/**
 * Buffered reads from a socket, for the few messages aiand parses itself (a
 * proxy's answers to CONNECT, the SOCKS greeting). `release` hands the socket
 * back, with whatever was read past the last message, for piping.
 */
export class SocketReader {
  readonly socket: Socket;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #failure: Error | null = null;
  #wake: (() => void) | null = null;
  readonly #onData = (chunk: Buffer): void => {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    this.#notify();
  };
  readonly #onEnd = (): void => {
    this.#closed = true;
    this.#notify();
  };
  readonly #onError = (error: Error): void => {
    this.#failure = error;
    this.#closed = true;
    this.#notify();
  };

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", this.#onData);
    socket.on("end", this.#onEnd);
    socket.on("close", this.#onEnd);
    socket.on("error", this.#onError);
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async #until(ready: () => boolean): Promise<void> {
    while (!ready()) {
      if (this.#closed) throw this.#failure ?? new Error("The connection closed.");
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  /** The next message head (a response if `response`, else a request). */
  async head(response: boolean): Promise<Head> {
    let end = -1;
    await this.#until(() => {
      end = this.#buffer.indexOf("\r\n\r\n");
      if (end === -1 && this.#buffer.length > MAX_HEAD_BYTES) {
        throw new Error("The message head is too large.");
      }
      return end !== -1;
    });
    const text = this.#buffer.subarray(0, end).toString("latin1");
    this.#buffer = this.#buffer.subarray(end + 4);
    const [first = "", ...lines] = text.split("\r\n");
    let status = 0;
    if (response) {
      const match = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(first);
      if (!match) throw new Error("The proxy did not answer with HTTP.");
      status = Number(match[1]);
    }
    const headers: [string, string][] = [];
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
    return { status, line: first, headers };
  }

  async bytes(count: number): Promise<Buffer> {
    await this.#until(() => this.#buffer.length >= count);
    const out = this.#buffer.subarray(0, count);
    this.#buffer = this.#buffer.subarray(count);
    return out;
  }

  async #line(): Promise<string> {
    let end = -1;
    await this.#until(() => {
      end = this.#buffer.indexOf("\r\n");
      return end !== -1;
    });
    const line = this.#buffer.subarray(0, end).toString("latin1");
    this.#buffer = this.#buffer.subarray(end + 2);
    return line;
  }

  /**
   * Read past a response body. Resolves whether the connection can carry
   * another request: false when the body runs to the end of the connection.
   */
  async skipBody(head: Head): Promise<boolean> {
    const length = header(head, "content-length")[0];
    const chunked = header(head, "transfer-encoding").some((v) => /chunked/i.test(v));
    if (chunked) {
      for (;;) {
        const size = Number.parseInt((await this.#line()).split(";")[0]!, 16);
        if (Number.isNaN(size)) throw new Error("The proxy sent a malformed chunked body.");
        if (size === 0) {
          while ((await this.#line()) !== "");
          break;
        }
        await this.bytes(size + 2);
      }
    } else if (length !== undefined) {
      const size = Number(length);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("Bad Content-Length.");
      await this.bytes(size);
    } else {
      return false;
    }
    const connection = [...header(head, "connection"), ...header(head, "proxy-connection")];
    const close = connection.some((v) => /\bclose\b/i.test(v));
    return !close && !/^HTTP\/1\.0 /.test(head.line);
  }

  /** Stop reading; returns the bytes read past the last message. */
  release(): Buffer {
    this.socket.pause();
    this.socket.off("data", this.#onData);
    this.socket.off("end", this.#onEnd);
    this.socket.off("close", this.#onEnd);
    this.socket.off("error", this.#onError);
    const rest = this.#buffer;
    this.#buffer = Buffer.alloc(0);
    return rest;
  }
}
