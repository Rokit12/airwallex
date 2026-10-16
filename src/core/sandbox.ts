/**
 * Every sandbox-only simulation call lives behind this one interface, so the
 * decision logic never imports a simulation endpoint and could be pointed at
 * real events (webhooks) without changes.
 */
import { AirwallexClient, AwxError, newRequestId } from "./client.ts";

export interface Balance {
  currency: string;
  available_amount: number;
  pending_amount?: number;
  reserved_amount?: number;
  total_amount?: number;
}

export class Sandbox {
  constructor(private readonly awx: AirwallexClient) {}

  // ── Wallet ───────────────────────────────────────────────────────────────
  async balances(onBehalfOf?: string): Promise<Balance[]> {
    const res = await this.awx.get<Balance[] | { items: Balance[] }>("/balances/current", { onBehalfOf });
    return Array.isArray(res) ? res : res.items ?? [];
  }

  async available(currency: string, onBehalfOf?: string): Promise<number> {
    return (await this.balances(onBehalfOf)).find((b) => b.currency === currency)?.available_amount ?? 0;
  }

  async globalAccounts(onBehalfOf?: string): Promise<any[]> {
    const res = await this.awx.get<{ items: any[] }>("/global_accounts", { onBehalfOf });
    return res.items ?? [];
  }

  /** Reuse a USD LOCAL global account, or create one only when none exists. */
  async usdGlobalAccount(onBehalfOf?: string): Promise<string> {
    const existing = (await this.globalAccounts(onBehalfOf)).find(
      (a) => a.currency === "USD" || (a.required_features ?? a.supported_features ?? []).some?.((f: any) => f.currency === "USD"),
    );
    if (existing) return existing.id;
    const created = await this.awx.post(
      "/global_accounts/create",
      { request_id: newRequestId(), country_code: "US", required_features: [{ currency: "USD", transfer_method: "LOCAL" }] },
      { onBehalfOf },
    );
    return created.id;
  }

  /** Make sure at least `minimum` USD is available; deposits only the shortfall. */
  async ensureUsd(minimum: number, onBehalfOf?: string): Promise<number> {
    const have = await this.available("USD", onBehalfOf);
    if (have >= minimum) return have;
    const ga = await this.usdGlobalAccount(onBehalfOf);
    await this.deposit(ga, Math.ceil(minimum - have), "Seed funding", onBehalfOf);
    return this.available("USD", onBehalfOf);
  }

  // ── Simulations ──────────────────────────────────────────────────────────
  /** Deposit posts immediately even though the response says PENDING. */
  deposit(globalAccountId: string, amount: number, payerName: string, onBehalfOf?: string) {
    return this.awx.post("/simulation/deposit/create", { global_account_id: globalAccountId, amount, payer_name: payerName }, { onBehalfOf });
  }

  cardAuthorization(p: { card_id: string; amount: number; currency: string; mcc?: string; merchant?: string; singlePhase?: boolean }, onBehalfOf?: string) {
    return this.awx.post(
      "/simulation/issuing/create",
      {
        card_id: p.card_id,
        transaction_amount: p.amount,
        transaction_currency: p.currency,
        merchant_category_code: p.mcc,
        merchant_info: p.merchant,
        single_phase: p.singlePhase ?? false,
      },
      { onBehalfOf },
    );
  }

  cardCapture(transactionId: string, onBehalfOf?: string) {
    return this.awx.post(`/simulation/issuing/${transactionId}/capture`, {}, { onBehalfOf });
  }

  cardReverse(transactionId: string, onBehalfOf?: string) {
    return this.awx.post(`/simulation/issuing/${transactionId}/reverse`, {}, { onBehalfOf });
  }

  /**
   * The sandbox sometimes answers 5xx yet applies the transition. Treat that as
   * unconfirmed: re-read the transfer, and retry (with growing waits, up to
   * four attempts) only if it did not move. A transfer created a moment ago can
   * briefly refuse transitions with 500 while the sandbox is still booking it.
   */
  async transferTransition(transferId: string, nextStatus: "SENT" | "PAID" | "FAILED" | "CANCELLED", failureType?: string, onBehalfOf?: string): Promise<any> {
    const body = { next_status: nextStatus, ...(failureType ? { failure_type: failureType } : {}) };
    const reached = (s: string) => s === nextStatus || (nextStatus === "FAILED" && s === "CANCELLED");
    const waits = [1500, 3000, 5000, 8000];
    for (let attempt = 1; attempt <= waits.length; attempt++) {
      try {
        return await this.awx.post(`/simulation/transfers/${transferId}/transition`, body, { onBehalfOf });
      } catch (err) {
        if (!(err instanceof AwxError) || err.status < 500) throw err;
        await new Promise((r) => setTimeout(r, waits[attempt - 1]));
        const now = await this.awx.get(`/transfers/${transferId}`, { onBehalfOf });
        if (reached(now.status)) return { ...now, _confirmedByRead: true };
        if (attempt === waits.length) throw err;
      }
    }
  }

  createDispute(p: { payment_intent_id: string; stage: "RFI" | "CHARGEBACK" | "PRE_CHARGEBACK" | "PRE_ARBITRATION"; reason_code: string; due_at: string; amount?: number; comment?: string }) {
    return this.awx.post("/simulation/pa/payment_disputes/create", p);
  }

  /** Issuer rejects the merchant's evidence and moves the dispute on. */
  escalateDispute(id: string, p: { due_at: string; comment?: string; amount?: number }) {
    return this.awx.post(`/simulation/pa/payment_disputes/${id}/escalate`, p);
  }

  resolveDispute(id: string, p: { in_favor_of: "MERCHANT" | "CUSTOMER"; amount?: number; comment?: string }) {
    return this.awx.post(`/simulation/pa/payment_disputes/${id}/resolve`, p);
  }
}

/** ISO timestamp in the format the dispute simulator uses: 2025-05-20T13:14:00+0000 */
export const awxTime = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "+0000");
export const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);
