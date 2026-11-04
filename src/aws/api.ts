/**
 * Console API on AWS: API Gateway (HTTP API, Cognito JWT authorizer) → this
 * Lambda → the Agent Desk on AgentCore Runtime (InvokeAgentRuntime, IAM auth).
 *
 *   GET  /api/kits                 kit list and the running kit
 *   GET  /api/events?since=N       events of the current run
 *   POST /api/run/{kit}            start a kit
 *   POST /api/approve              {"id","approve"} answer an approval request
 *   GET  /api/me                   who is signed in
 *
 * API Gateway has already verified the operator's Cognito token before this
 * runs. The approver is taken from that verified token, never from the request
 * body, so an approval always names the person who signed in, and the agent
 * cannot approve its own proposal.
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";

const client = new BedrockAgentCoreClient({});
const RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN!;
// One shared console session (33+ characters), like the single local console.
const SESSION = process.env.CONSOLE_SESSION_ID ?? "agent-desk-console-session-000000001";

async function invoke(payload: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const out = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: RUNTIME_ARN,
      runtimeSessionId: SESSION,
      qualifier: "DEFAULT",
      contentType: "application/json",
      accept: "application/json",
      payload: new TextEncoder().encode(JSON.stringify(payload)),
    }),
  );
  const text = out.response ? await out.response.transformToString() : "{}";
  let body: unknown = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text.slice(0, 200) };
  }
  const refused = body && typeof body === "object" && typeof (body as any).status === "number" ? (body as any).status : undefined;
  return { status: refused ?? out.statusCode ?? 200, body };
}

const reply = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

/** The signed-in operator, from the token API Gateway verified. */
export function operatorFrom(claims: Record<string, unknown> | undefined): string | null {
  if (!claims) return null;
  const name = claims["email"] ?? claims["username"] ?? claims["cognito:username"];
  return typeof name === "string" && name ? `${name}`.slice(0, 60) : null;
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const by = operatorFrom(event.requestContext.authorizer?.jwt?.claims as Record<string, unknown>);
  if (!by) return reply(401, { error: "Sign in first" });
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  let body: any = {};
  try {
    body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body) : {};
  } catch {
    return reply(400, { error: "Body must be JSON" });
  }

  try {
    if (method === "GET" && path === "/api/me") return reply(200, { operator: by });
    if (method === "GET" && path === "/api/kits") {
      const r = await invoke({ action: "kits" });
      return reply(r.status, r.body);
    }
    if (method === "GET" && path === "/api/events") {
      const r = await invoke({ action: "events", since: Number(event.queryStringParameters?.since ?? 0) || 0 });
      return reply(r.status, r.body);
    }
    const run = path.match(/^\/api\/run\/(\d\d)$/);
    if (method === "POST" && run) {
      const r = await invoke({ action: "run", kit: run[1], by });
      return reply(r.status, r.body);
    }
    if (method === "POST" && path === "/api/approve") {
      const r = await invoke({ action: "approve", id: String(body.id ?? ""), approve: body.approve === true, by });
      return reply(r.status, r.body);
    }
    return reply(404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    return reply(502, { error: "The agent runtime did not answer; try again in a few seconds" });
  }
}
