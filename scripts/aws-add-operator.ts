/**
 * Adds a person who may sign in to the hosted console and approve.
 * Cognito emails them a temporary password; they set their own on first sign-in.
 * Approvals they give are recorded under this email.
 *
 *   npm run aws:operator -- you@example.com
 */
import { existsSync, readFileSync } from "node:fs";
import { CognitoIdentityProviderClient, AdminCreateUserCommand } from "@aws-sdk/client-cognito-identity-provider";

const email = process.argv[2];
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("usage: npm run aws:operator -- you@example.com");
const outputs = existsSync("infra/outputs.json") ? JSON.parse(readFileSync("infra/outputs.json", "utf8")) : {};
const poolId: string | undefined = process.env.DESK_USER_POOL_ID ?? outputs.AgentDesk?.UserPoolId;
if (!poolId) throw new Error("No user pool: deploy first (npm run aws:deploy) or set DESK_USER_POOL_ID");

await new CognitoIdentityProviderClient({ region: poolId.split("_")[0] }).send(
  new AdminCreateUserCommand({
    UserPoolId: poolId,
    Username: email,
    UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
    DesiredDeliveryMediums: ["EMAIL"],
  }),
);
console.log(`invited ${email}: Cognito has emailed a temporary password. Console: ${outputs.AgentDesk?.ConsoleUrl ?? "(see infra/outputs.json)"}`);
