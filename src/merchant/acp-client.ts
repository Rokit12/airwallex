/**
 * The shopper's side of Airwallex Agentic Commerce, as a desktop assistant
 * (through mcp-remote) does it:
 *   1. read the MCP endpoint's protected-resource metadata → the merchant's OAuth server
 *   2. register a client, sign in (guest), exchange the code with PKCE
 *   3. call Airwallex's ACP tools over MCP (streamable HTTP) with the bearer token
 *
 * Used by kit 10's live mode. The guest sign-in "clicks" the merchant's
 * Continue-as-guest form, which is what the shopper does in the browser.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export interface AcpConfig { mcpUrl: string; merchantUrl: string }

/** Live mode is on when the merchant has been onboarded (env on AWS, infra files locally). */
export function acpConfig(): AcpConfig | null {
  if (process.env.ACP_MODE === "local") return null;
  let mcpUrl = process.env.ACP_MCP_URL;
  let merchantUrl = process.env.MERCHANT_URL;
  try {
    if (!mcpUrl && existsSync("infra/merchant.json")) mcpUrl = JSON.parse(readFileSync("infra/merchant.json", "utf8")).acp_mcp_url;
    if (!merchantUrl && existsSync("infra/outputs.json")) merchantUrl = JSON.parse(readFileSync("infra/outputs.json", "utf8")).AgentDesk?.MerchantUrl;
  } catch {
    return null;
  }
  return mcpUrl && merchantUrl ? { mcpUrl, merchantUrl: merchantUrl.replace(/\/$/, "") } : null;
}

export class AcpShopper {
  private token = "";
  private session?: string;
  private id = 0;
  authServer = "";
  constructor(readonly mcpUrl: string) {}

  async signIn(clientName = "Shopping assistant"): Promise<string> {
    const u = new URL(this.mcpUrl);
    const meta: any = await (await fetch(`${u.origin}/.well-known/oauth-protected-resource${u.pathname}`)).json();
    this.authServer = meta.authorization_servers?.[0];
    if (!this.authServer) throw new Error("the MCP endpoint names no authorization server");
    const disc: any = await (await fetch(`${this.authServer}/.well-known/openid-configuration`)).json();
    const redirect = "http://localhost:3334/oauth/callback";
    const client: any = await (await fetch(disc.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: clientName, redirect_uris: [redirect], token_endpoint_auth_method: "none" }) })).json();
    const verifier = randomBytes(32).toString("base64url");
    const q = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: randomBytes(8).toString("hex"), scope: "openid email", resource: this.mcpUrl });
    const consent = await fetch(disc.authorization_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: q.toString(), redirect: "manual" });
    const code = new URL(consent.headers.get("location") ?? "about:blank").searchParams.get("code");
    if (!code) throw new Error(`guest sign-in failed (${consent.status})`);
    const tok: any = await (await fetch(disc.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: redirect, code_verifier: verifier, resource: this.mcpUrl }).toString() })).json();
    if (!tok.access_token) throw new Error(`token exchange failed: ${tok.error ?? "no token"}`);
    this.token = tok.access_token;
    return this.authServer;
  }

  private async post(body: unknown) {
    const res = await fetch(this.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${this.token}`, "mcp-protocol-version": "2025-06-18", ...(this.session ? { "mcp-session-id": this.session } : {}) },
      body: JSON.stringify(body),
    });
    this.session = res.headers.get("mcp-session-id") ?? this.session;
    return res;
  }

  async rpc(method: string, params: unknown = {}): Promise<any> {
    const res = await this.post({ jsonrpc: "2.0", id: ++this.id, method, params });
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP ${method} → HTTP ${res.status}`);
    const data = text.match(/^data: (.*)$/m)?.[1] ?? text;
    const msg = JSON.parse(data);
    if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message}`);
    return msg.result;
  }

  async connect() {
    const init = await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-desk-shopper", version: "1" } });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const { tools } = await this.rpc("tools/list");
    return { server: init.serverInfo?.name as string, tools: (tools as any[]).map((t) => t.name as string) };
  }

  /** Calls a tool; returns its structured result, or throws with the tool's own error text. */
  async tool(name: string, args: unknown): Promise<any> {
    const r = await this.rpc("tools/call", { name, arguments: args });
    if (r.isError) throw new Error((r.content ?? []).map((c: any) => c.text).join(" ").slice(0, 400) || `${name} failed`);
    return r.structuredContent ?? r;
  }
}
