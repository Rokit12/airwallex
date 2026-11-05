/**
 * Checks a beneficiary with Airwallex before creating it, in the guide's order:
 *  1. POST /beneficiaries/schema: which fields this country, currency and
 *     transfer method require (are any missing?)
 *  2. POST /beneficiaries/validate: do the values pass Airwallex's checks
 *     (an invented routing code fails here with code 010, field by field)
 * so a payout never starts from a beneficiary Airwallex would reject.
 *
 * The endpoint takes the draft wrapped as `create_beneficiary_request` and
 * answers with a flat map of field paths ("create_beneficiary_request.
 * beneficiary.bank_details.iban") marked `required`.
 */
import { AwxError, type AirwallexClient } from "./client.ts";

type FieldRule = { required?: boolean; relevant?: boolean; schema_unknown_reason?: string };
const PREFIX = "create_beneficiary_request.";
/** The schema calls the methods `payment_methods`; beneficiaries/create also accepts `transfer_methods`. */
const ALIASES: Record<string, string> = { payment_methods: "transfer_methods" };

const valueAt = (o: unknown, path: string) => path.split(".").reduce<any>((a, k) => (a == null ? undefined : a[k]), o);
const present = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

/** Required leaf fields the draft does not fill. Pure: unit-tested. */
export function missingRequired(schema: Record<string, FieldRule>, draft: Record<string, unknown>): string[] {
  const required = Object.entries(schema)
    .filter(([path, r]) => r.required && r.relevant !== false && path.startsWith(PREFIX))
    .map(([path]) => path.slice(PREFIX.length));
  // A parent object counts as filled when any of its required children is checked; check leaves only.
  const leaves = required.filter((p) => !required.some((q) => q !== p && q.startsWith(p + ".")));
  return leaves.filter((p) => !present(valueAt(draft, p)) && !(ALIASES[p] && present(valueAt(draft, ALIASES[p]!))));
}

/** Rules the schema could not resolve, e.g. because a field it depends on is missing. */
export function unresolved(schema: Record<string, FieldRule>): string[] {
  return Object.entries(schema).filter(([, r]) => r.schema_unknown_reason).map(([p]) => p.slice(PREFIX.length));
}

/** Field-level failures from beneficiaries/validate, e.g. ["beneficiary.bank_details.account_routing_value1 (010)"]. */
export function invalidFields(details: unknown): string[] {
  const errs = (details as any)?.errors;
  return Array.isArray(errs) ? errs.map((e: any) => `${e.source ?? "?"} (${e.code ?? "?"})`) : [];
}

export async function checkBeneficiary(awx: AirwallexClient, draft: Record<string, unknown>, onBehalfOf?: string): Promise<{ missing: string[]; invalid: string[]; checked: number }> {
  const res = await awx.post<any>("/beneficiaries/schema", { create_beneficiary_request: draft });
  const schema: Record<string, FieldRule> = res.schema ?? {};
  const required = Object.values(schema).filter((r) => r.required && r.relevant !== false).length;
  const missing = missingRequired(schema, draft);
  if (missing.length) return { missing, invalid: [], checked: required };
  try {
    // {beneficiary, transfer_methods}, as beneficiaries/create takes it; validate accepts x-on-behalf-of (kit 6).
    await awx.post("/beneficiaries/validate", draft, onBehalfOf ? { onBehalfOf } : {});
    return { missing: [], invalid: [], checked: required };
  } catch (err) {
    if (err instanceof AwxError && err.code === "validation_failed") return { missing: [], invalid: invalidFields(err.details), checked: required };
    throw err;
  }
}
