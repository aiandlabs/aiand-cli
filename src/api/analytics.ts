import { requestJson, type Session } from "./client.js";

export const ANALYTICS_RANGES = ["1h", "24h", "7days", "30days", "3months"] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export type AnalyticsTotals = {
  requests: number;
  input_tokens: number;
  output_tokens: number;
};

export type AnalyticsSummary = {
  current: AnalyticsTotals;
  previous: AnalyticsTotals;
  timeseries: { timestamp: string; tokens: number }[];
};

export type AnalyticsMetric = {
  metric_name: string;
  unit: string;
  aggregation: string;
  timeseries: { timestamp: string; value: number }[];
  summary: { display_name: string; value: number }[];
  info: string | null;
};

export function getSummary(session: Session, range: AnalyticsRange): Promise<AnalyticsSummary> {
  return requestJson<AnalyticsSummary>(session, { path: "/analytics/summary", query: { range } });
}

export async function getMetrics(
  session: Session,
  range: AnalyticsRange
): Promise<AnalyticsMetric[]> {
  const body = await requestJson<{ object: "list"; data: AnalyticsMetric[] }>(session, {
    path: "/analytics/metrics",
    query: { range },
  });
  return body.data;
}
