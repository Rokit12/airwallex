/**
 * Platform helpers for kits 5–8: open connected accounts for the platform's
 * customers and move money between the platform and them.
 *
 * Follows the hackathon guide's setup table: create (with every known field,
 * including the EIN and the business person, which cannot be added later) →
 * submit → simulate ACTIVE → confirm.
 */
import { AirwallexClient, newRequestId } from "./client.ts";
import { textPdf } from "./pdf.ts";

/** One synthetic, clearly labelled specimen ID document per run, shared by the demo's business owners. */
let specimenFileId: Promise<string> | undefined;
function specimenId(awx: AirwallexClient) {
  specimenFileId ??= awx
    .uploadFile("specimen-passport.pdf", textPdf("SPECIMEN - SYNTHETIC SANDBOX DOCUMENT", ["Not a real identity document.", "Created for Airwallex sandbox KYC testing only."]), "application/pdf", "Sandbox specimen ID")
    .then((f) => f.file_id);
  return specimenFileId;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CustomerSpec {
  name: string;
  email: string;
  /** Synthetic EIN, format NN-NNNNNNN. */
  ein: string;
  person: { first: string; last: string };
  address: { address_line1: string; suburb: string; state: string; postcode: string };
  industry?: string;
  /** What the business sells; required by Airwallex to submit the account. */
  description?: string;
}

export interface ConnectedAccount {
  id: string;
  name: string;
  status: string;
}

export async function openConnectedAccount(awx: AirwallexClient, c: CustomerSpec): Promise<ConnectedAccount> {
  const address = { ...c.address, country_code: "US" };
  const idFile = await specimenId(awx);
  const created = await awx.post("/accounts/create", {
    request_id: newRequestId(),
    primary_contact: { email: c.email },
    customer_agreements: { agreed_to_terms_and_conditions: true, agreed_to_data_usage: true },
    account_details: {
      business_details: {
        business_name: c.name,
        business_name_english: c.name,
        business_structure: "COMPANY",
        business_start_date: "2021-03-01",
        industry_category_code: c.industry ?? "ICCV3_0813XX",
        business_identifiers: [{ country_code: "US", number: c.ein, type: "EIN" }],
        business_address: address,
        registration_address: address,
        operating_country: ["US"],
        state_of_incorporation: c.address.state,
        url: `https://${c.name.toLowerCase().replace(/[^a-z]+/g, "")}.example.com`,
        contact_number: "4155550100",
        description_of_goods_or_services: c.description ?? `${c.name} is a small US business using the Trailhead platform for cards, payroll and payouts.`,
        account_usage: { estimated_monthly_revenue: { amount: "80000", currency: "USD" }, product_reference: ["RECEIVE_TRANSFERS", "MAKE_TRANSFERS"] },
      },
      business_person_details: [
        {
          first_name: c.person.first,
          last_name: c.person.last,
          date_of_birth: "1984-05-12",
          nationality: "US",
          email: c.email,
          roles: ["BENEFICIAL_OWNER", "AUTHORISED_PERSON"],
          residential_address: address,
          identifications: { primary: { identification_type: "PASSPORT", issuing_country_code: "US", passport: { front_file_id: idFile } } },
        },
      ],
    },
  });
  const id: string = created.id;
  await awx.post(`/accounts/${id}/submit`, {});
  await sleep(2000);
  await awx.post(`/simulation/accounts/${id}/update_status`, { next_status: "ACTIVE", force: true });
  let status = "";
  for (let i = 0; i < 10; i++) {
    status = (await awx.get(`/accounts/${id}`)).status;
    if (status === "ACTIVE") break;
    await sleep(1500);
  }
  return { id, name: c.name, status };
}

/** Platform → customer. Returns NEW; poll until SETTLED. */
export async function transferToCustomer(awx: AirwallexClient, p: { to: string; amount: number; currency: string; reason: string; reference: string; requestId?: string }) {
  return awx.post("/connected_account_transfers/create", {
    request_id: p.requestId ?? newRequestId(),
    amount: p.amount,
    currency: p.currency,
    destination: p.to,
    reason: p.reason,
    reference: p.reference,
  });
}

/** Customer → platform (fee, repayment, shortfall recovery). Returns NEW; poll until SETTLED. */
export async function chargeCustomer(awx: AirwallexClient, p: { from: string; amount: number; currency: string; reason: string; reference: string; requestId?: string }) {
  return awx.post("/charges/create", {
    request_id: p.requestId ?? newRequestId(),
    amount: p.amount,
    currency: p.currency,
    source: p.from,
    reason: p.reason,
    reference: p.reference,
  });
}

export async function waitSettled(awx: AirwallexClient, kind: "connected_account_transfers" | "charges", id: string): Promise<string> {
  let status = "";
  for (let i = 0; i < 16; i++) {
    try {
      status = (await awx.get(`/${kind}/${id}`)).status;
    } catch (err) {
      // A just-created transfer or charge can read as 404 for a moment: not visible yet, keep polling.
      if ((err as { status?: number }).status !== 404 || i >= 10) throw err;
      status = "NOT_VISIBLE_YET";
    }
    if (status === "SETTLED" || status === "FAILED") break;
    await sleep(1500);
  }
  return status;
}

/** Open a connected account, give it a USD global account, and fund it (deposit simulation on its behalf). */
export async function onboardAndFund(awx: AirwallexClient, c: CustomerSpec, deposit: number, payer = "Customer funding") {
  const acct = await openConnectedAccount(awx, c);
  const ob = { onBehalfOf: acct.id };
  // A just-activated account can refuse for a few seconds ("Account not ready!" / 401).
  // Retry the same operation with the same request_id, so it can never be created twice.
  const gaBody = { request_id: newRequestId(), country_code: "US", required_features: [{ currency: "USD", transfer_method: "LOCAL" }] };
  let ga: any;
  for (let attempt = 1; ; attempt++) {
    try {
      ga = await awx.post("/global_accounts/create", gaBody, ob);
      break;
    } catch (err) {
      const e = err as { status?: number; message?: string };
      const notReady = e.status === 401 || (e.status === 403 && /not ready/i.test(e.message ?? ""));
      if (!notReady || attempt >= 8) throw err;
      await sleep(2500);
    }
  }
  if (deposit > 0) await awx.post("/simulation/deposit/create", { global_account_id: ga.id, amount: deposit, payer_name: payer }, ob);
  return { ...acct, globalAccountId: ga.id as string };
}

export async function balanceOf(awx: AirwallexClient, acct: string | undefined, currency = "USD"): Promise<number> {
  const res = await awx.get("/balances/current", acct ? { onBehalfOf: acct } : {});
  const items: any[] = Array.isArray(res) ? res : res.items ?? [];
  return Number(items.find((b) => b.currency === currency)?.available_amount ?? 0);
}
