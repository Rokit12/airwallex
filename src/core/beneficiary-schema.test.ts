import { test } from "node:test";
import assert from "node:assert/strict";
import { invalidFields, missingRequired } from "./beneficiary-schema.ts";

const schema = {
  "create_beneficiary_request": { required: true },
  "create_beneficiary_request.beneficiary": { required: true },
  "create_beneficiary_request.beneficiary.bank_details": { required: true },
  "create_beneficiary_request.beneficiary.bank_details.iban": { required: true },
  "create_beneficiary_request.beneficiary.bank_details.bank_name": { required: true },
  "create_beneficiary_request.beneficiary.bank_details.account_routing_value1": { required: false },
  "create_beneficiary_request.beneficiary.nickname": { required: true, relevant: false },
  "create_beneficiary_request.payment_methods": { required: true },
};

test("the schema check finds required fields the beneficiary leaves out", () => {
  const draft = { transfer_methods: ["SWIFT"], beneficiary: { bank_details: { iban: "DE89370400440532013000" } } };
  assert.deepEqual(missingRequired(schema, draft), ["beneficiary.bank_details.bank_name"]);
});

test("a complete beneficiary passes, and transfer_methods satisfies payment_methods", () => {
  const draft = { transfer_methods: ["SWIFT"], beneficiary: { bank_details: { iban: "DE89370400440532013000", bank_name: "Commerzbank AG" } } };
  assert.deepEqual(missingRequired(schema, draft), []);
});

test("empty strings and empty lists do not count as filled", () => {
  const draft = { transfer_methods: [], beneficiary: { bank_details: { iban: "", bank_name: "X" } } };
  assert.deepEqual(missingRequired(schema, draft), ["beneficiary.bank_details.iban", "payment_methods"]);
});

test("validation failures are reported field by field", () => {
  assert.deepEqual(invalidFields({ errors: [{ code: "010", source: "beneficiary.bank_details.account_routing_value1" }] }), ["beneficiary.bank_details.account_routing_value1 (010)"]);
  assert.deepEqual(invalidFields({}), []);
});
