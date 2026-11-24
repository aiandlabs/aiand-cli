import { publicJson, requestJson, type Session } from "./client.js";

export type Model = {
  id: string;
  name: string;
  object: "model";
  created: number;
  owned_by: string;
  provider: string;
  context_window: number;
  max_output_tokens: number | null;
  capabilities: string[];
  reasoning_efforts: string[] | null;
  reasoning_effort_default: string | null;
  description: string | null;
  currency: "usd" | "jpy";
  input_per_1m: string;
  output_per_1m: string;
  cached_input_per_1m: string | null;
  // Origin fields. Optional: an older gateway sends none of them,
  // and a set exclude-origin then fails closed on every model.
  /** Every ISO 3166-1 alpha-2 country in the model's lineage, its own included. */
  origins?: string[];
  developer?: { name: string; country: string };
  base_models?: { id: string; developer: string; country: string }[];
  /**
   * Which agent slots the catalog recommends the model for, as a rank (1 is
   * first). Replaces the CLI's own preferred lists; a model without a rank
   * for a slot is never picked for it by default.
   */
  recommended?: { main?: number; fast?: number };
};

/** The org's origin policy, on an authenticated listing only. */
type ModelPolicy = { exclude_origins: string[] };

export type ModelList = { object: "list"; data: Model[]; policy?: ModelPolicy };

export async function listModels(session: Session | null, apiUrl: string): Promise<Model[]> {
  const body = session
    ? await requestJson<ModelList>(session, { path: "/v1/models" })
    : await publicJson<ModelList>(`${apiUrl}/v1/models`);
  return body.data;
}
