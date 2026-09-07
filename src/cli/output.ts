import { EOL } from "node:os";

const ESC = "\x1b[";

const useColor =
  !process.env.NO_COLOR && process.env.TERM !== "dumb" && process.stdout.isTTY === true;

const wrap = (open: string, close: string) => (s: string) =>
  useColor ? `${ESC}${open}m${s}${ESC}${close}m` : s;

export const style = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan: wrap("36", "39"),
};

export function out(line = ""): void {
  process.stdout.write(line + EOL);
}

export function err(line = ""): void {
  process.stderr.write(line + EOL);
}

export function json(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + EOL);
}

const ANSI_RE = new RegExp(`\\x1b\\[[0-9;]*m`, "g");

/** Visible width, ignoring ANSI escapes so colored cells still align. */
function width(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

function pad(s: string, to: number, align: "left" | "right"): string {
  const gap = " ".repeat(Math.max(0, to - width(s)));
  return align === "right" ? gap + s : s + gap;
}

export type Column<T> = {
  header: string;
  value: (row: T) => string;
  align?: "left" | "right";
};

/** Two-space-separated columns -- greppable, and readable without a pager. */
export function table<T>(rows: T[], columns: Column<T>[]): void {
  if (rows.length === 0) return;
  const cells = rows.map((row) => columns.map((c) => c.value(row)));
  const widths = columns.map((c, i) =>
    Math.max(width(c.header), ...cells.map((r) => width(r[i] ?? "")))
  );

  // An all-blank header row would just print an empty line -- skip it, so a
  // table can also be used for aligned label/value blocks.
  if (columns.some((c) => c.header !== "")) {
    out(
      columns
        .map((c, i) => style.dim(pad(c.header.toUpperCase(), widths[i]!, c.align ?? "left")))
        .join("  ")
        .trimEnd()
    );
  }

  for (const row of cells) {
    out(
      row
        .map((cell, i) => pad(cell, widths[i]!, columns[i]!.align ?? "left"))
        .join("  ")
        .trimEnd()
    );
  }
}

/** Aligned `key: value` block for single-record output. */
export function fields(pairs: [string, string][]): void {
  const keyWidth = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) {
    out(`${style.dim(pad(k, keyWidth, "left"))}  ${v}`);
  }
}

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max === 0) return SPARK[0]!.repeat(values.length);
  return values
    .map((v) => SPARK[Math.min(SPARK.length - 1, Math.round((v / max) * (SPARK.length - 1)))]!)
    .join("");
}

export function num(n: number): string {
  return n.toLocaleString("en-US");
}

/** Signed percentage change, colored by direction. Blank when there's no baseline. */
export function delta(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? style.dim("--") : style.green("new");
  const pct = ((current - previous) / previous) * 100;
  const label = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  return pct >= 0 ? style.green(label) : style.red(label);
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** A dot spinner that stays quiet when stderr is not a TTY. */
export function spinner(text: string): { stop: (final?: string) => void } {
  if (!process.stderr.isTTY) {
    return { stop: (final?: string) => void (final && err(final)) };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const timer = setInterval(() => {
    process.stderr.write(`\r${style.cyan(frames[i++ % frames.length]!)} ${text}`);
  }, 80);
  timer.unref();
  return {
    stop: (final?: string) => {
      clearInterval(timer);
      process.stderr.write(`\r${ESC}2K`);
      if (final) err(final);
    },
  };
}
