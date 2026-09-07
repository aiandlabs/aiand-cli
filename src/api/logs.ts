import { requestJson, type Session } from "./client.js";

export const LOG_RANGES = ["15m", "1h", "6h", "24h", "7days", "30days"] as const;
export type LogRange = (typeof LOG_RANGES)[number];

export type LogEntry = {
  id: string;
  model: string;
  api_key: string;
  status_code: number;
  ttft_ms: number | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cost: string | null;
  currency: string | null;
  created_at: string;
};

export type LogPage = {
  data: LogEntry[];
  has_more: boolean;
  next_after: string | null;
  next_after_id: string | null;
};

export type LogQuery = {
  range?: LogRange;
  errorsOnly?: boolean;

  limit?: number;
  after?: string;
  afterId?: string;
};

export function getLogs(session: Session, query: LogQuery = {}): Promise<LogPage> {
  return requestJson<LogPage>(session, {
    path: "/logs",
    query: {
      range: query.range,
      errors: query.errorsOnly ? "true" : undefined,
      limit: query.limit,
      after: query.after,
      after_id: query.afterId,
    },
  });
}

export async function getLogsPaged(
  session: Session,
  query: LogQuery & { limit: number }
): Promise<LogEntry[]> {
  const collected: LogEntry[] = [];
  let after = query.after;
  let afterId = query.afterId;

  while (collected.length < query.limit) {
    const page = await getLogs(session, {
      ...query,
      limit: Math.min(100, query.limit - collected.length),
      after,
      afterId,
    });
    collected.push(...page.data);
    if (!page.has_more || !page.next_after || !page.next_after_id) break;
    after = page.next_after;
    afterId = page.next_after_id;
  }

  return collected;
}
