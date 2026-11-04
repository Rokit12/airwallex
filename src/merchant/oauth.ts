/**
 * The merchant's OAuth server for Airwallex Agentic Commerce (ACP), pure parts:
 * discovery document, redirect-URI policy, PKCE check, RS256 JWT signing and
 * the public JWKS. The shopper's assistant registers itself (dynamic client
 * registration), sends the shopper here to sign in (guest checkout), and gets
 * a signed access token that Airwallex verifies against the JWKS.
 */
import { createHash, createPrivateKey, createPublicKey, createSign, randomBytes, type KeyObject } from "node:crypto";

export function discovery(base: string) {
  return {
    issuer: base, // must equal oauth_base
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    jwks_uri: `${base}/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["openid", "email"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  };
}

/** Only HTTPS redirects, or loopback HTTP for desktop assistants (mcp-remote listens on localhost). */
export function allowedRedirect(uri: unknown): boolean {
  if (typeof uri !== "string" || uri.length > 500) return false;
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export function pkceMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128) return false;
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

const b64url = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

export function signJwt(claims: Record<string, unknown>, privateKeyPem: string, kid: string): string {
  const head = b64url({ alg: "RS256", typ: "JWT", kid });
  const body = b64url(claims);
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(createPrivateKey(privateKeyPem)).toString("base64url");
  return `${head}.${body}.${sig}`;
}

export function publicJwks(privateKeyPem: string, kid: string) {
  const pub: KeyObject = createPublicKey(createPrivateKey(privateKeyPem));
  const jwk = pub.export({ format: "jwk" }) as Record<string, string>;
  return { keys: [{ kty: jwk.kty, n: jwk.n, e: jwk.e, kid, alg: "RS256", use: "sig" }] };
}

/** Access token for a guest shopper (no awx_customer_id claim, so Airwallex treats them as a guest). */
export function accessTokenClaims(issuer: string, clientId: string, subject: string, scope: string, now = Math.floor(Date.now() / 1000), ttl = 3600) {
  return { iss: issuer, sub: subject, client_id: clientId, scope, iat: now, exp: now + ttl, jti: randomToken(12) };
}
