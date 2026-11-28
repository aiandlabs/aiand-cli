import { isIP } from "node:net";
import { Script } from "node:vm";
import { Worker } from "node:worker_threads";
import { PAC_FUNCTIONS } from "./pac-functions.js";

/** Where one request should go, in the order a PAC lists them. */
/**
 * How far a proxy is trusted with the user's sign-in. `full`: one the user or
 * an administrator named (settings, policy, a configured PAC); it may get the
 * explicit username and password as well as integrated sign-in. `intranet`:
 * named by a PAC that WPAD found, but inside the machine's own domain or a
 * private address; integrated sign-in only. `none`: named by WPAD and outside
 * that; no sign-in at all. Absent means `full`, for routes built by hand.
 */
export type Trust = "full" | "intranet" | "none";

export type Route =
  | { kind: "direct" }
  | { kind: "proxy"; host: string; port: number; trust?: Trust };

/** What a PAC may learn about the machine: lookups go through `resolve`. */
export type PacHost = {
  resolve(host: string): Promise<string | null>;
  myIpAddress: string;
  now: () => number;
};

export class PacError extends Error {}

const RUN_TIMEOUT_MS = 1_000;
const WORKER_DEADLINE_MS = 10_000;
const MAX_LOOKUPS = 16;
const MAX_RESULT_LENGTH = 4_096;

/**
 * The evaluator. It runs in a worker of its own, with a memory cap, so a PAC
 * that allocates without end or leaves a rejected promise behind takes down
 * only the worker. Inside it the PAC gets a context with nothing from Node in
 * it (no require, process or timers), no code generation from strings, no
 * dynamic import, a time limit per run and microtasks drained inside that
 * limit. Values cross back only as strings the context made, so no PAC object
 * is ever touched outside the time limit.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const script = new vm.Script(workerData.source, { filename: "proxy.pac" });
const options = { timeout: workerData.timeoutMs, displayErrors: false };
parentPort.on("message", (job) => {
  const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
    name: "proxy.pac",
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  const run = (source) => new vm.Script(source).runInContext(context, options);
  let result = null;
  try {
    run(job.prelude + workerData.functions);
    script.runInContext(context, options);
    const value = run(job.call);
    if (typeof value === "string") result = value;
  } catch {}
  let need = null;
  try {
    const value = run('typeof __aiand_need === "string" ? __aiand_need : ""');
    if (typeof value === "string" && value !== "") need = value;
  } catch {}
  parentPort.postMessage({ id: job.id, result, need });
});
`;

type Job = { id: number; prelude: string; call: string };
type Answer = { id: number; result: string | null; need: string | null };

/** A PAC script, checked for syntax up front and run only in its worker. */
export class PacScript {
  readonly #source: string;
  #worker: Worker | null = null;
  #nextId = 0;
  readonly #pending = new Map<
    number,
    { worker: Worker; settle: (answer: Answer | null) => void }
  >();

  constructor(source: string) {
    try {
      new Script(source, { filename: "proxy.pac" });
    } catch {
      // The engine's message can quote the file, which may not be a PAC at all.
      throw new PacError("The PAC file is not valid JavaScript.");
    }
    this.#source = source;
  }

  /** The PAC's answer for `url`, as the string FindProxyForURL returned. */
  async find(url: URL, host: PacHost): Promise<string> {
    const table: Record<string, string | null> = {};
    for (;;) {
      const { result, need } = await this.#run(pacUrl(url), pacHost(url), table, host);
      if (need === null || Object.hasOwn(table, need)) {
        if (result === null) throw new PacError("FindProxyForURL failed in the PAC file.");
        return result;
      }
      if (Object.keys(table).length >= MAX_LOOKUPS) {
        throw new PacError(`The PAC file looked up more than ${MAX_LOOKUPS} host names.`);
      }
      table[need] = await host.resolve(need).catch(() => null);
    }
  }

  /** Stop the worker; a later find starts a new one. */
  close(): void {
    const worker = this.#worker;
    this.#worker = null;
    void worker?.terminate();
  }

  #start(): Worker {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source: this.#source, functions: PAC_FUNCTIONS, timeoutMs: RUN_TIMEOUT_MS },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      env: {},
    });
    worker.on("message", (answer: Answer) => {
      this.#pending.get(answer.id)?.settle(answer);
    });
    const fail = (): void => {
      if (this.#worker === worker) this.#worker = null;
      for (const job of this.#pending.values()) if (job.worker === worker) job.settle(null);
    };
    worker.on("error", fail);
    worker.on("exit", fail);
    // After the listeners: attaching one refs the worker again.
    worker.unref();
    return worker;
  }

  async #run(
    url: string,
    hostname: string,
    table: Record<string, string | null>,
    host: PacHost,
  ): Promise<{ result: string | null; need: string | null }> {
    this.#worker ??= this.#start();
    const worker = this.#worker;
    const id = this.#nextId++;
    const job: Job = {
      id,
      prelude: [
        `var __aiand_dns = JSON.parse(${JSON.stringify(JSON.stringify(table))});`,
        `var __aiand_ip = ${JSON.stringify(host.myIpAddress)};`,
        `var __aiand_now = ${JSON.stringify(host.now())};`,
      ].join("\n"),
      call: `(function (u, h) {
        var f = typeof FindProxyForURLEx === "function" ? FindProxyForURLEx : FindProxyForURL;
        return String(f(u, h));
      })(${JSON.stringify(url)}, ${JSON.stringify(hostname)})`,
    };
    const answer = await new Promise<Answer | null>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        if (this.#worker === worker) this.close();
        resolve(null);
      }, WORKER_DEADLINE_MS);
      this.#pending.set(id, {
        worker,
        settle: (value) => {
          clearTimeout(timer);
          this.#pending.delete(id);
          resolve(value);
        },
      });
      worker.postMessage(job);
    });
    if (answer === null) throw new PacError("The PAC file stopped responding.");
    return { result: answer.result, need: answer.need };
  }
}

/** The URL a PAC sees: for https only the origin, as browsers pass it. */
export function pacUrl(url: URL): string {
  if (url.protocol === "https:" || url.protocol === "wss:") return `${url.protocol}//${url.host}/`;
  return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
}

function pacHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/**
 * The routes in a FindProxyForURL answer. SOCKS and HTTPS proxies are not
 * supported and are skipped, so the next entry is tried; an answer with
 * nothing usable at all is an error rather than a silent DIRECT.
 */
export function parsePacResult(answer: string): Route[] {
  if (answer.length > MAX_RESULT_LENGTH) throw new PacError("The PAC answer is too long.");
  const routes: Route[] = [];
  let skipped = 0;
  for (const entry of answer.split(";")) {
    const [type = "", target = ""] = entry.trim().split(/\s+/);
    switch (type.toUpperCase()) {
      case "":
        break;
      case "DIRECT":
        routes.push({ kind: "direct" });
        break;
      case "PROXY":
      case "HTTP": {
        const endpoint = parseEndpoint(target, 80);
        if (endpoint) routes.push({ kind: "proxy", ...endpoint });
        else skipped += 1;
        break;
      }
      default:
        skipped += 1;
    }
  }
  if (routes.length === 0 && skipped > 0) {
    throw new PacError(`The PAC answer names only proxies aiand cannot use: ${answer.trim()}`);
  }
  return routes.length === 0 ? [{ kind: "direct" }] : routes;
}

/** `host:port`, `[v6]:port` or a bare host, with an optional http:// prefix. */
export function parseEndpoint(
  text: string,
  defaultPort: number,
): { host: string; port: number } | null {
  const trimmed = text
    .trim()
    .replace(/^http:\/\//i, "")
    .replace(/\/+$/, "");
  if (trimmed === "" || /[\s/@]/.test(trimmed)) return null;
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/i.exec(trimmed);
  if (!match) return null;
  const port = match[2] === undefined ? defaultPort : Number(match[2]);
  if (!(port > 0 && port < 65_536)) return null;
  const host = match[1]!.replace(/^\[|\]$/g, "");
  return isUnspecified(host) ? null : { host, port };
}

/** 0.0.0.0 or :: (in any spelling): the unspecified address, which names no proxy. */
export function isUnspecified(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(name) === 4) return name.split(".").every((octet) => Number(octet) === 0);
  if (isIP(name) === 6) return name.split(/[:.]/).every((part) => part === "" || /^0+$/.test(part));
  return false;
}
