import { parse, bool, int, oneOf, str } from "../cli/args.js";
import { err, json, num, out, relativeTime, style, table } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import { openSession, type Session } from "../api/client.js";
import { getLogs, getLogsPaged, LOG_RANGES, type LogEntry } from "../api/logs.js";

export const help = `${style.bold("aiand logs")} -- recent inference requests

Usage
  aiand logs
  aiand logs --errors --range 1h
  aiand logs --follow

Options
  --range <window>    15m, 1h, 6h, 24h (default), 7days, 30days
  --errors            only non-2xx requests
  --limit <n>         rows to fetch, paging as needed (default 20)
  --follow            poll for new requests until interrupted
  --interval <s>      poll interval for --follow (default 5)
  --json              machine-readable output`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    range: { type: "string" },
    errors: { type: "boolean", default: false },
    limit: { type: "string" },
    follow: { type: "boolean", default: false },
    interval: { type: "string" },
  });
  if (bool(parsed, "help")) return out(help);

  const session = await openSession(resolveProfile(str(parsed, "profile")));
  const range = oneOf(parsed, "range", LOG_RANGES, "24h");
  const errorsOnly = bool(parsed, "errors");

  if (bool(parsed, "follow")) {
    return follow(session, {
      range,
      errorsOnly,
      intervalMs: Math.max(1, int(parsed, "interval") ?? 5) * 1000,
      asJson: bool(parsed, "json"),
    });
  }

  const entries = await getLogsPaged(session, {
    range,
    errorsOnly,
    limit: Math.max(1, int(parsed, "limit") ?? 20),
  });

  if (bool(parsed, "json")) return json(entries);

  if (entries.length === 0) {
    out(style.dim(`No ${errorsOnly ? "failed " : ""}requests in the last ${range}.`));
    return;
  }

  printTable(entries);
  out();
  out(style.dim(`${entries.length} request${entries.length === 1 ? "" : "s"} in the last ${range}.`));
}

function printTable(entries: LogEntry[]): void {
  table<LogEntry>(entries, [
    { header: "when", value: (e) => relativeTime(e.created_at) },
    { header: "status", value: (e) => statusCell(e.status_code), align: "right" },
    { header: "model", value: (e) => e.model },
    { header: "in", value: (e) => (e.input_tokens === null ? "-" : num(e.input_tokens)), align: "right" },
    { header: "out", value: (e) => (e.output_tokens === null ? "-" : num(e.output_tokens)), align: "right" },
    { header: "cached", value: (e) => (e.cached_tokens ? num(e.cached_tokens) : style.dim("-")), align: "right" },
    { header: "ttft", value: (e) => (e.ttft_ms === null ? "-" : `${e.ttft_ms}ms`), align: "right" },
    { header: "latency", value: (e) => (e.latency_ms === null ? "-" : `${e.latency_ms}ms`), align: "right" },
    { header: "cost", value: (e) => costCell(e), align: "right" },
    { header: "key", value: (e) => style.dim(e.api_key) },
  ]);
}

function statusCell(status: number): string {
  if (status >= 500) return style.red(String(status));
  if (status >= 400) return style.yellow(String(status));
  return style.green(String(status));
}

function costCell(entry: LogEntry): string {
  if (!entry.cost) return style.dim("-");
  const symbol = entry.currency === "jpy" ? "¥" : entry.currency === "usd" ? "$" : "";
  return `${symbol}${entry.cost}`;
}

async function follow(
  session: Session,
  options: {
    range: (typeof LOG_RANGES)[number];
    errorsOnly: boolean;
    intervalMs: number;
    asJson: boolean;
  }
): Promise<void> {
  const seen = new Set<string>();
  let running = true;
  const stop = () => {
    running = false;
  };
  process.once("SIGINT", stop);

  if (!options.asJson) {
    err(style.dim(`Following ${options.errorsOnly ? "failed " : ""}requests. Ctrl-C to stop.`));
  }

  const seed = await getLogs(session, {
    range: options.range,
    errorsOnly: options.errorsOnly,
    limit: 100,
  });
  for (const entry of seed.data) seen.add(entry.id);

  while (running) {
    await sleep(options.intervalMs);
    if (!running) break;

    const page = await getLogs(session, {
      range: options.range,
      errorsOnly: options.errorsOnly,
      limit: 100,
    });
    const fresh = page.data.filter((entry) => !seen.has(entry.id)).reverse();
    for (const entry of fresh) seen.add(entry.id);
    if (fresh.length === 0) continue;

    for (const entry of fresh) {
      out(options.asJson ? JSON.stringify(entry) : followRow(entry));
    }
  }

  process.removeListener("SIGINT", stop);
}

function followRow(entry: LogEntry): string {
  const tokens = `${entry.input_tokens ?? "-"}/${entry.output_tokens ?? "-"}`;
  const latency = entry.latency_ms === null ? "-" : `${entry.latency_ms}ms`;
  return [
    style.dim(entry.created_at.slice(11, 19)),
    statusCell(entry.status_code),
    entry.model,
    style.dim(`${tokens} tok`),
    style.dim(latency),
    costCell(entry),
  ].join("  ");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
