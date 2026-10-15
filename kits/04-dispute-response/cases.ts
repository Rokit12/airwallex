/**
 * Synthetic merchant data for three disputed orders. Notes are the unstructured
 * text the agent reads; `facts` is the ground truth the rules fallback uses when
 * no model is configured (and the check the model's extraction is compared to).
 */
import type { Evidence } from "./policy.ts";

export interface DemoCase {
  key: "A" | "B" | "C";
  label: string;
  orderId: string;
  amount: number;
  currency: "USD";
  visaReason: "10.4" | "13.1" | "13.6";
  stage: "RFI" | "CHARGEBACK";
  dueInHours: number;
  customer: { name: string; email: string; ip: string; deviceId: string; address: string };
  notes: string;
  facts: Evidence;
  documents: { name: string; type: "PRIMARY" | "ORDER" | "CUSTOMER" | "OTHER"; title: string; lines: string[] }[];
}

export const CASES: DemoCase[] = [
  {
    key: "A",
    label: "Large fraud claim, strong evidence",
    orderId: "ORD-88412",
    amount: 1450,
    currency: "USD",
    visaReason: "10.4",
    stage: "RFI",
    dueInHours: 72,
    customer: { name: "Dana Whitfield", email: "dana.whitfield@example.com", ip: "203.0.113.42", deviceId: "dev_7f3a9c", address: "118 Larch St, Portland, OR 97205" },
    notes: `Order ORD-88412, 1x Ridgeway 3-person expedition tent + accessories, USD 1,450.
Fraud review log: device fingerprint dev_7f3a9c and IP 203.0.113.42 match three earlier orders
(ORD-71120, ORD-76003, ORD-80951), none disputed. Billing and shipping address identical to those orders.
Carrier: UPS 1Z999AA10123456784, delivered 2026-10-02 14:12, signed by "D WHITFIELD".
No support tickets from this customer. No refund issued.`,
    facts: { priorOrdersSameDevice: 3, ipMatchesPriorOrders: true, deliveryScanned: true, deliverySigned: true, unansweredSupportContacts: 0, refundAlreadyIssued: false },
    documents: [
      {
        name: "A_order_history.pdf",
        type: "CUSTOMER",
        title: "Customer purchase history - dev_7f3a9c",
        lines: [
          "ORD-71120  2026-03-14  USD 220.00  delivered  no dispute",
          "ORD-76003  2026-06-02  USD 89.00   delivered  no dispute",
          "ORD-80951  2026-08-19  USD 310.00  delivered  no dispute",
          "ORD-88412  2026-09-29  USD 1,450.00 delivered  DISPUTED (10.4)",
          "Same device fingerprint, IP 203.0.113.42, same billing/shipping address on all four.",
        ],
      },
      {
        name: "A_proof_of_delivery.pdf",
        type: "PRIMARY",
        title: "Proof of delivery - UPS 1Z999AA10123456784",
        lines: ["Delivered 2026-10-02 14:12 to 118 Larch St, Portland, OR 97205", "Signed by: D WHITFIELD"],
      },
    ],
  },
  {
    key: "B",
    label: "Small not-received claim, no signature",
    orderId: "ORD-90277",
    amount: 18,
    currency: "USD",
    visaReason: "13.1",
    stage: "CHARGEBACK",
    dueInHours: 48,
    customer: { name: "Sam Okafor", email: "sam.okafor@example.com", ip: "198.51.100.7", deviceId: "dev_11b2e0", address: "4 Hill Rd, Austin, TX 78701" },
    notes: `Order ORD-90277, 2x trail mix multipack, USD 18.00, first order from this customer.
Carrier: USPS 9400100000000000000000, scanned "delivered, in/at mailbox" 2026-10-05. No signature required.
No support tickets. No refund issued.`,
    facts: { priorOrdersSameDevice: 0, ipMatchesPriorOrders: false, deliveryScanned: true, deliverySigned: false, unansweredSupportContacts: 0, refundAlreadyIssued: false },
    documents: [],
  },
  {
    key: "C",
    label: "Credit not processed, support never replied",
    orderId: "ORD-89530",
    amount: 260,
    currency: "USD",
    visaReason: "13.6",
    stage: "RFI",
    dueInHours: 36,
    customer: { name: "Priya Raman", email: "priya.raman@example.com", ip: "192.0.2.88", deviceId: "dev_c40d17", address: "77 Bay Ave, Seattle, WA 98101" },
    notes: `Order ORD-89530, insulated jacket, USD 260.00. Return label issued 2026-09-20; warehouse shows return
received 2026-09-26.
Support inbox: customer emailed 2026-09-28 ("received my return? still no refund") and 2026-10-04
("second time asking, please refund"). Neither email has a reply. No refund has been issued.`,
    facts: { priorOrdersSameDevice: 1, ipMatchesPriorOrders: true, deliveryScanned: true, deliverySigned: false, unansweredSupportContacts: 2, refundAlreadyIssued: false },
    documents: [],
  },
];

/** Shown to the issuer after rejection: the evidence added for the second response. */
export const SECOND_ROUND_DOCS: DemoCase["documents"] = [
  {
    name: "A_session_log.pdf",
    type: "CUSTOMER",
    title: "Account activity - Dana Whitfield",
    lines: [
      "2026-09-29 18:02 login from dev_7f3a9c / 203.0.113.42 (2FA passed)",
      "2026-09-29 18:09 order ORD-88412 placed, CVV and AVS match",
      "2026-10-03 09:41 login from dev_7f3a9c, viewed order tracking for ORD-88412",
    ],
  },
];
