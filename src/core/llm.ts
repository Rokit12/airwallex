/**
 * The model's job is narrow: read unstructured text, extract fields, and explain
 * a decision. It never sees credentials or card data and never chooses amounts:
 * limits, reserves and state transitions stay in code.
 *
 * With ANTHROPIC_API_KEY set this calls the model; without it each call uses the
 * deterministic fallback, so every kit runs offline and gives the same decision.
 */
import { audit } from "./audit.ts";

const MODEL = process.env.AGENT_MODEL ?? "claude-sonnet-5-5";

/**
 * On AWS the model runs on Amazon Bedrock (BEDROCK_MODEL_ID, an inference
 * profile ID; the defaults are in infra/app.ts), called with the runtime's IAM
 * role, so no model key is stored anywhere. Locally, or on AWS while Bedrock access is
 * unavailable, it is the model provider's API, with the key from .env or Secrets Manager.
 */
const bedrockModel = () => process.env.BEDROCK_MODEL_ID;
export const llmEnabled = () => Boolean(bedrockModel() || process.env.ANTHROPIC_API_KEY);

async function completeBedrock(system: string, user: string, maxTokens: number): Promise<string> {
  const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
  const models = [bedrockModel()!, process.env.BEDROCK_FALLBACK_MODEL_ID].filter(Boolean) as string[];
  let last: unknown;
  for (const modelId of models) {
    try {
      const out = await client.send(
        new ConverseCommand({ modelId, system: [{ text: system }], messages: [{ role: "user", content: [{ text: user }] }], inferenceConfig: { maxTokens } }),
      );
      return (out.output?.message?.content ?? []).map((b) => b.text ?? "").join("");
    } catch (err) {
      last = err; // try the fallback model, then give up and let the caller use its rules
    }
  }
  throw last;
}

/** Set once Bedrock refuses for the account, so later calls go straight to the API key. */
let bedrockRefused = false;

async function complete(system: string, user: string, maxTokens = 600): Promise<string> {
  if (bedrockModel() && !bedrockRefused) {
    try {
      return await completeBedrock(system, user, maxTokens);
    } catch (err) {
      // No API key: let the caller use its rules. With one (kept in Secrets Manager on AWS),
      // use it while Bedrock access is unavailable; Bedrock is tried again on the next run.
      if (!process.env.ANTHROPIC_API_KEY) throw err;
      bedrockRefused = true;
      audit({ kind: "llm_route", from: "bedrock", to: "api", reason: String((err as Error)?.message ?? err).slice(0, 160) });
    }
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  return data.content.map((b) => b.text ?? "").join("");
}

/**
 * Extract structured fields from text. The result must pass `validate`;
 * otherwise the deterministic fallback is used and the mismatch is logged.
 */
export async function extract<T>(task: string, text: string, validate: (v: unknown) => v is T, fallback: () => T): Promise<{ value: T; source: "model" | "rules" }> {
  if (!llmEnabled()) return { value: fallback(), source: "rules" };
  try {
    const out = await complete(
      "You extract facts from finance documents. Reply with one JSON object only, no prose. Use null for anything the text does not state. Never invent numbers.",
      `${task}\n\n<document>\n${text}\n</document>`,
      4000, // room for the model's reasoning as well as the JSON
    );
    const json = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    if (validate(json)) {
      audit({ kind: "llm_extract", task, value: json });
      return { value: json, source: "model" };
    }
    audit({ kind: "llm_extract_rejected", task, value: json });
  } catch (err) {
    audit({ kind: "llm_error", task, error: String(err) });
  }
  return { value: fallback(), source: "rules" };
}

/** Plain-language explanation of a decision code already made. */
export async function explain(facts: Record<string, unknown>, fallback: string): Promise<string> {
  if (!llmEnabled()) return fallback;
  try {
    const out = await complete(
      "You explain a finance agent's decision to an operator in at most two sentences. The decision is final and was made by policy code; do not change it or add numbers that are not in the facts.",
      JSON.stringify(facts),
      1500,
    );
    return out.trim() || fallback;
  } catch {
    return fallback;
  }
}
