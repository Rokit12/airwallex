import { test } from "node:test";
import assert from "node:assert/strict";
import { handler, operatorFrom } from "./api.ts";

test("the approver is the signed-in operator from the verified token", () => {
  assert.equal(operatorFrom({ email: "ops@example.com", "cognito:username": "abc-123" }), "ops@example.com");
  assert.equal(operatorFrom({ "cognito:username": "abc-123" }), "abc-123");
  assert.equal(operatorFrom({}), null);
  assert.equal(operatorFrom(undefined), null);
});

test("nothing reaches the agent runtime without a sign-in", async () => {
  const res: any = await handler({ rawPath: "/api/approve", body: JSON.stringify({ id: "x", approve: true, by: "operator" }), isBase64Encoded: false, requestContext: { http: { method: "POST" } } } as any);
  assert.equal(res.statusCode, 401);
});
