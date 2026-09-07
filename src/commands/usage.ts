import { parse, bool, oneOf, str } from "../cli/args.js";
import { delta, json, num, out, sparkline, style, table } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import { openSession } from "../api/client.js";
import {
  ANALYTICS_RANGES,
  getMetrics,
  getSummary,
  type AnalyticsMetric,
} from "../api/analytics.js";

export const help = `${style.bold("aiand usage")} -- request and token usage for your org

Usage
  aiand usage
  aiand usage --range 30days
  aiand usage --metrics

Options
  --range <window>    1h, 24h, 7days (default), 30days, 3months
  --metrics           show the full metric breakdown instead of the summary
  --json              machine-readable output

Percentages compare the window against the one immediately before it.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    range: { type: "string" },
    metrics: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const session = await openSession(resolveProfile(str(parsed, "profile")));
  const range = oneOf(parsed, "range", ANALYTICS_RANGES, "7days");

  if (bool(parsed, "metrics")) {
    const metrics = await getMetrics(session, range);
    if (bool(parsed, "json")) return json(metrics);
    return printMetrics(metrics, range);
  }

  const summary = await getSummary(session, range);
  if (bool(parsed, "json")) return json(summary);

  const { current, previous } = summary;
  const totalTokens = current.input_tokens + current.output_tokens;
  const previousTokens = previous.input_tokens + previous.output_tokens;

  const rows: { label: string; current: number; previous: number }[] = [
    { label: "requests", current: current.requests, previous: previous.requests },
    { label: "input tokens", current: current.input_tokens, previous: previous.input_tokens },
    { label: "output tokens", current: current.output_tokens, previous: previous.output_tokens },
    { label: "total tokens", current: totalTokens, previous: previousTokens },
  ];

  out(style.bold(`Last ${range}`));
  out();
  table(rows, [
    { header: "", value: (r) => style.dim(r.label) },
    { header: "", value: (r) => num(r.current), align: "right" },
    { header: "", value: (r) => delta(r.current, r.previous), align: "right" },
    { header: "", value: (r) => style.dim(`was ${num(r.previous)}`) },
  ]);

  if (summary.timeseries.length > 1) {
    out();
    out(style.dim("tokens  ") + style.cyan(sparkline(summary.timeseries.map((p) => p.tokens))));
    const first = summary.timeseries[0]!;
    const last = summary.timeseries[summary.timeseries.length - 1]!;
    out(style.dim(`        ${first.timestamp.replace("T", " ")}  to  ${last.timestamp.replace("T", " ")}`));
  }
}

function printMetrics(metrics: AnalyticsMetric[], range: string): void {
  if (metrics.length === 0) {
    out(style.dim("No metrics for this window."));
    return;
  }

  out(style.bold(`Last ${range}`));
  out();
  table<AnalyticsMetric>(metrics, [
    { header: "metric", value: (m) => m.summary[0]?.display_name ?? m.metric_name },
    {
      header: "value",
      value: (m) => {
        const value = m.summary[0]?.value ?? 0;
        return `${Number.isInteger(value) ? num(value) : value.toFixed(2)}${m.unit === "percent" ? "%" : ""}`;
      },
      align: "right",
    },
    { header: "unit", value: (m) => style.dim(m.unit) },
    { header: "trend", value: (m) => style.cyan(sparkline(m.timeseries.map((p) => p.value))) },
  ]);
}
