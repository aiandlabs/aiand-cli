import { publicJson, requestJson, type Session } from "./client.js";

/** `/v1/models` in its OpenAI-compatible projection, plus the ai& extensions. */
export type Model = {
  id: string;
  name: string;
  object: "model";
  created: number;
  owned_by: string;
  provider: string;
  context_window: number;
  capabilities: string[];
  reasoning_efforts: string[] | null;
  reasoning_effort_default: string | null;
  description: string | null;
  currency: "usd" | "jpy";
  input_per_1m: string;
  output_per_1m: string;
  cached_input_per_1m: string | null;
};

type ModelList = { object: "list"; data: Model[] };

/**
 * Auth is optional on this route -- anonymous callers get USD pricing, an
 * authenticated one gets their org's billing currency. We send the key when we
 * have it so the prices shown are the prices billed.
 */
export async function listModels(session: Session | null, apiUrl: string): Promise<Model[]> {
  const body = session
    ? await requestJson<ModelList>(session, { path: "/v1/models" })
    : await publicJson<ModelList>(`${apiUrl}/v1/models`);
  return body.data;
}
