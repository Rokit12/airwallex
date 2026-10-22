/** Three employers on the payroll platform and their contractors (synthetic). */
import type { CustomerSpec } from "../../src/core/platform.ts";
import type { Contractor } from "./policy.ts";

export interface Employer {
  key: "ATLAS" | "BEACON" | "COBALT";
  spec: CustomerSpec;
  deposit: number;
  /** Deposit that lands mid-run (into this employer only). */
  midRunDeposit?: number;
  contractors: Contractor[];
}

export const EMPLOYERS: Employer[] = [
  {
    key: "ATLAS",
    spec: { name: "Atlas Robotics Inc", email: "payroll@atlasrobotics.example", ein: "47-2201001", person: { first: "Grace", last: "Wu" }, address: { address_line1: "1 Foundry Way", suburb: "Pittsburgh", state: "PA", postcode: "15222" } },
    deposit: 12000,
    contractors: [
      { name: "Lena Fischer", country: "DE", currency: "EUR", amount: 4000, method: "SWIFT" },
      { name: "Tom Hale", country: "US", currency: "USD", amount: 3500, method: "LOCAL" },
    ],
  },
  {
    key: "BEACON",
    spec: { name: "Beacon Health Co", email: "payroll@beaconhealth.example", ein: "47-2201002", person: { first: "Omar", last: "Haddad" }, address: { address_line1: "77 Harbor Rd", suburb: "Boston", state: "MA", postcode: "02110" } },
    deposit: 5800,
    contractors: [
      { name: "Kai Chen", country: "US", currency: "USD", amount: 2600, method: "LOCAL" },
      { name: "Marta Silva", country: "DE", currency: "EUR", amount: 3000, method: "SWIFT" },
    ],
  },
  {
    key: "COBALT",
    spec: { name: "Cobalt Games LLC", email: "payroll@cobaltgames.example", ein: "47-2201003", person: { first: "Leo", last: "Brandt" }, address: { address_line1: "9 Pixel Ln", suburb: "Seattle", state: "WA", postcode: "98101" } },
    deposit: 0,
    midRunDeposit: 9000,
    contractors: [{ name: "Owen Price", country: "GB", currency: "GBP", amount: 2800, method: "LOCAL" }],
  },
];

/** Beneficiary payloads by country; account numbers are synthetic, routing formats are real. */
export function beneficiaryFor(c: Contractor) {
  const address = {
    DE: { street_address: "Torstrasse 10", city: "Berlin", postcode: "10119", country_code: "DE" },
    US: { street_address: "200 Pine St", city: "San Francisco", state: "CA", postcode: "94104", country_code: "US" },
    GB: { street_address: "5 Brick Lane", city: "London", postcode: "E1 6PU", country_code: "GB" },
  }[c.country]!;
  const bank =
    c.country === "DE"
      ? { account_currency: "EUR", account_name: c.name, iban: "DE89370400440532013000", swift_code: "COBADEFFXXX", bank_country_code: "DE" }
      : c.country === "GB"
        ? { account_currency: "GBP", account_name: c.name, account_number: "31926819", account_routing_type1: "sort_code", account_routing_value1: "601613", bank_name: "NatWest", bank_country_code: "GB" }
        : { account_currency: "USD", account_name: c.name, account_number: "000777123456", account_routing_type1: "aba", account_routing_value1: "021000021", bank_country_code: "US", bank_account_category: "Checking", local_clearing_system: "ACH" };
  const [first, ...rest] = c.name.split(" ");
  return { transfer_methods: [c.method], beneficiary: { entity_type: "PERSONAL", first_name: first, last_name: rest.join(" "), address, bank_details: bank } };
}
