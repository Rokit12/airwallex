import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "./platform.ts";

test("a BALANCE_REPORT CSV is read into numbers per account and currency", () => {
  const rows = parseCsv('﻿account_id,currency,available_balance,reserved_balance,total_balance,last_update\r\nacct_1,USD,1834.5,0,1834.5,"2026-11-05T10:00:00Z"\r\n"acct_2","EUR",0,12.25,12.25,2026-11-05\r\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { account_id: "acct_1", currency: "USD", available_balance: 1834.5, reserved_balance: 0, total_balance: 1834.5, last_update: "2026-11-05T10:00:00Z" });
  assert.equal(rows[1]!.account_id, "acct_2");
  assert.equal(rows[1]!.total_balance, 12.25);
});
