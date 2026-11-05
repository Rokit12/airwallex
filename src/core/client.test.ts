import { test } from "node:test";
import assert from "node:assert/strict";
import { AirwallexClient } from "./client.ts";

/** A client whose login and files host are stubbed: each call to fetch takes the next scripted answer. */
function scripted(answers: Array<number | "timeout">) {
  const calls: number[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const a = answers[calls.length] ?? 200;
    calls.push(typeof a === "number" ? a : 0);
    if (a === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const body = a === 200 ? { file_id: `file_${calls.length}` } : { code: a === 429 ? "too_many_requests" : a >= 500 ? "service_unavailable" : "invalid_argument", message: "scripted" };
    return new Response(JSON.stringify(body), { status: a, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new AirwallexClient("test-client", "test-key");
  (client as any).login = async () => "token";
  (client as any).throttle = async () => {};
  return { client, calls, restore: () => (globalThis.fetch = realFetch) };
}

const pdf = new Uint8Array([37, 80, 68, 70]);

test("an upload that fails with 503, a timeout and 429 is retried; only the successful file_id is used", async () => {
  const s = scripted([503, "timeout", 429, 200]);
  try {
    const r = await s.client.uploadFile("evidence.pdf", pdf, "application/pdf");
    assert.equal(r.file_id, "file_4");
    assert.equal(s.calls.length, 4);
  } finally { s.restore(); }
});

test("a 4xx upload error is not retried, and retries stop at the cap", async () => {
  const bad = scripted([400]);
  try {
    await assert.rejects(bad.client.uploadFile("evidence.pdf", pdf, "application/pdf"), /400|invalid_argument/);
    assert.equal(bad.calls.length, 1);
  } finally { bad.restore(); }
  const down = scripted([503, 503, 503, 503, 200]);
  try {
    await assert.rejects(down.client.uploadFile("evidence.pdf", pdf, "application/pdf", undefined, 3));
    assert.equal(down.calls.length, 3);
  } finally { down.restore(); }
});
