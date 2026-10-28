/** Synthetic data for kit 12: an AI research-report service buying every step from x402 providers. */
import type { Kind, Tier, Step } from "./policy.ts";

export interface ProviderSpec {
  id: string;
  name: string;
  kind: Kind;
  tier: Tier;
  priceMicros: number; // per unit: one paragraph, one search, one lookup
  latencyMs: number;
}

export const PROVIDERS: ProviderSpec[] = [
  // The guide's prices: models at 1, 2 and 5 cents a paragraph, a web search 2 cents, a data lookup 3.
  { id: "atlas-large", name: "Atlas Large (premium model)", kind: "model", tier: "premium", priceMicros: 50_000, latencyMs: 60 },
  { id: "beacon-mid", name: "Beacon Mid (standard model)", kind: "model", tier: "standard", priceMicros: 20_000, latencyMs: 40 },
  { id: "cobalt-mini", name: "Cobalt Mini (budget model)", kind: "model", tier: "budget", priceMicros: 10_000, latencyMs: 25 },
  { id: "scout-search", name: "Scout Search", kind: "search", tier: "standard", priceMicros: 20_000, latencyMs: 30 },
  { id: "ledger-data", name: "Ledger Data (filings)", kind: "data", tier: "standard", priceMicros: 30_000, latencyMs: 30 },
];

/** When the budget model slows, each of its chunks takes this long; the SLA below is 1.5 s. */
export const SLOW_LATENCY_MS = 2_500;
export const SLA_MS = 1_500;

export interface JobSpec {
  id: "A" | "B" | "C";
  customer: string;
  title: string;
  holdCents: number;
  depositCents: number;
  steps: Step[];
}

const step = (id: string, kind: Kind, chunks: number, worthPremium = false): Step => ({ id, kind, chunks, worthPremium, slaMs: SLA_MS });

export const JOBS: JobSpec[] = [
  {
    id: "A", customer: "Northwind Retail", title: "EV battery supply-chain brief", holdCents: 100, depositCents: 45,
    steps: [step("plan", "model", 1), step("search", "search", 2), step("lookups", "data", 2), step("draft", "model", 6, true), step("review", "model", 2)],
  },
  {
    id: "B", customer: "Calder Precision Ltd", title: "Competitor pricing scan", holdCents: 75, depositCents: 25,
    steps: [step("plan", "model", 1), step("search", "search", 2), step("lookups", "data", 2), step("draft", "model", 9), step("review", "model", 1)],
  },
  {
    id: "C", customer: "Brightline Creative", title: "Regulatory filings brief", holdCents: 75, depositCents: 30,
    steps: [step("plan", "model", 1), step("search", "search", 2), step("lookups", "data", 4), step("draft", "model", 6), step("review", "model", 2)],
  },
];

/** The operator's *USDZ float: 1.50, less than the 2.50 the three holds could spend. */
export const FLOAT_CENTS = 150;

/** Midway, job B's draft prompt uses four times its budgeted tokens. */
export const OVERRUN = { job: "B" as const, step: "draft", factor: 4 };

/** Job C's filings cannot be found: three lookups in a row come back empty. */
export const MISSING_FILINGS = { job: "C" as const, after: 3 };
