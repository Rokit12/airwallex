/**
 * AWS deployment of the Agent Desk (all twelve kits), following the pattern of
 * Airwallex's AWS reference builds (github.com/awx-devx/airwallex-agentic-banking-aws):
 *
 *   browser ──► CloudFront + S3 (console page)
 *          └─► API Gateway HTTP API ── Cognito JWT authorizer (operators sign in)
 *                 └─► Lambda (console API) ── InvokeAgentRuntime (IAM) ──►
 *                        Amazon Bedrock AgentCore Runtime (NODE_22): the kits
 *                           ├─ Claude on Amazon Bedrock (read and explain only)
 *                           ├─ Airwallex sandbox / Metal testnet (keys in Secrets Manager)
 *                           └─ approvals: the signed-in operator, never the agent
 *
 * The runtime has no public endpoint: only the console Lambda may invoke it.
 * Nobody can sign up; operators are added with npm run aws:operator.
 *
 *   npm run aws:deploy -- -c alertEmail=you@example.com
 *
 * Context: region (default us-west-2), alertEmail (budget and alarm emails),
 * modelId / fallbackModelId (Bedrock inference profiles), budgetUsd (100).
 */
import { App, CfnOutput, type CfnResource, Duration, RemovalPolicy, Stack, type StackProps, SecretValue } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PACKAGE = join(ROOT, "dist", "agentcore");

/** Bedrock cross-Region inference profiles by geography, as in the AWS reference builds. */
function defaultModels(region: string): [string, string] {
  const geo = region.startsWith("eu-") ? "eu" : region === "ap-southeast-2" ? "au" : "us";
  return [`${geo}.anthropic.claude-sonnet-5`, `${geo}.anthropic.claude-sonnet-4-5-20250929-v1:0`];
}
/** agent-desk-console-<hash of the runtime package> (AgentCore needs 33+ characters). */
function consoleSessionId(): string {
  const h = createHash("sha256");
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (f.name === "chromium" || f.name === "node_modules") continue; // pinned, large
      const p = join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else h.update(f.name).update(readFileSync(p));
    }
  };
  walk(PACKAGE);
  return `agent-desk-console-${h.digest("hex").slice(0, 24)}`;
}
const foundationModel = (profileId: string) => profileId.replace(/^(us|eu|au|apac|global)\./, "");

interface DeskProps extends StackProps {
  alertEmail?: string;
  modelIds: [string, string];
  budgetUsd: number;
}

class AgentDeskStack extends Stack {
  constructor(scope: Construct, id: string, props: DeskProps) {
    super(scope, id, props);
    if (!existsSync(join(PACKAGE, "runtime.js"))) throw new Error("Build the runtime package first: npm run aws:build");

    // ── Secrets: Airwallex sandbox keys, Metal testnet keys. Seeded out of band (npm run aws:seed).
    const secret = new secrets.Secret(this, "DeskSecret", {
      description: "Agent Desk: Airwallex sandbox and Metal testnet credentials (JSON). Seed with npm run aws:seed.",
      secretStringValue: SecretValue.unsafePlainText("{}"), // placeholder only; never real values in a template
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ── The kits, on AgentCore Runtime (direct code deployment, Node.js 22, arm64).
    const runtime = new agentcore.Runtime(this, "Runtime", {
      runtimeName: "agent_desk",
      description: "Airwallex Agent Desk: twelve agentic-banking kits (model reads, code decides, a person approves)",
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromCodeAsset({
        path: PACKAGE,
        runtime: agentcore.AgentCoreRuntime.NODE_22,
        entrypoint: ["runtime.js"],
      }),
      networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingPublicNetwork(), // outbound to Airwallex sandbox and Metal testnet
      lifecycleConfiguration: { idleRuntimeSessionTimeout: Duration.hours(1), maxLifetime: Duration.hours(8) },
      environmentVariables: {
        AWX_SECRET_ARN: secret.secretArn,
        BEDROCK_MODEL_ID: props.modelIds[0],
        BEDROCK_FALLBACK_MODEL_ID: props.modelIds[1],
        AWX_WORK_DIR: "/tmp/awx",
        AWS_LAMBDA_JS_RUNTIME: "nodejs22.x", // serverless Chromium: unpack its Amazon Linux 2023 libraries
      },
    });
    secret.grantRead(runtime);

    // The model: only the two inference profiles, and the foundation models only through them.
    const invoke = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"];
    const profiles = props.modelIds.map((m) => `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${m}`);
    runtime.addToRolePolicy(new iam.PolicyStatement({ sid: "InvokeDeskModel", actions: invoke, resources: profiles }));
    runtime.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "InvokeDeskModelThroughProfile",
        actions: invoke,
        resources: props.modelIds.map((m) => `arn:aws:bedrock:*::foundation-model/${foundationModel(m)}*`),
        conditions: { StringEquals: { "bedrock:InferenceProfileArn": profiles } },
      }),
    );

    // ── Operators: Cognito, no self sign-up.
    const pool = new cognito.UserPool(this, "Operators", {
      userPoolName: "agent-desk-operators",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: false },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const domain = pool.addDomain("Login", { cognitoDomain: { domainPrefix: `agent-desk-${this.account}` } });

    // ── Console page: private bucket behind CloudFront.
    const site = new s3.Bucket(this, "ConsoleSite", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const cdn = new cloudfront.Distribution(this, "Console", {
      comment: "Agent Desk console",
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // a demo console: always the latest page
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
    });
    const consoleUrl = `https://${cdn.distributionDomainName}/`;

    const client = pool.addClient("Console", {
      generateSecret: false, // a browser app: authorization code with PKCE
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [consoleUrl, "http://localhost:4310/"],
        logoutUrls: [consoleUrl, "http://localhost:4310/"],
      },
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      preventUserExistenceErrors: true,
    });

    // ── Console API: verified sign-in → Lambda → AgentCore.
    const apiFn = new NodejsFunction(this, "ConsoleApi", {
      entry: join(ROOT, "src", "aws", "api.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(29),
      memorySize: 256,
      // A new package gets a new console session, so the console never keeps talking to a
      // session started on the previous code (AgentCore keeps a session's microVM alive until idle).
      environment: { AGENT_RUNTIME_ARN: runtime.agentRuntimeArn, CONSOLE_SESSION_ID: consoleSessionId() },
      bundling: {
        format: OutputFormat.ESM,
        target: "node22",
        externalModules: [], // bundle the AgentCore client: the Lambda runtime SDK may not include it yet
        mainFields: ["module", "main"],
        banner: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
      logGroup: new logs.LogGroup(this, "ConsoleApiLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
    });
    runtime.grantInvokeRuntime(apiFn);

    const api = new apigw.HttpApi(this, "Api", {
      apiName: "agent-desk",
      corsPreflight: {
        allowOrigins: [consoleUrl.replace(/\/$/, ""), "http://localhost:4310"],
        allowHeaders: ["authorization", "content-type"],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST],
        maxAge: Duration.hours(1),
      },
    });
    const authorizer = new HttpJwtAuthorizer("Operators", `https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}`, {
      jwtAudience: [client.userPoolClientId],
    });
    api.addRoutes({
      path: "/api/{proxy+}",
      methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("Desk", apiFn),
      authorizer,
    });
    const stage = api.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 20, throttlingRateLimit: 10 };

    // ── Publish the page with its settings (no secrets: these are public identifiers).
    const config = {
      api: api.apiEndpoint,
      authDomain: `https://${domain.domainName}.auth.${this.region}.amazoncognito.com`,
      clientId: client.userPoolClientId,
    };
    new s3deploy.BucketDeployment(this, "ConsolePage", {
      destinationBucket: site,
      distribution: cdn,
      sources: [
        s3deploy.Source.asset(join(ROOT, "ui")),
        s3deploy.Source.data("config.js", `window.AWX_CONFIG = ${JSON.stringify(config)};\n`),
      ],
    });

    // ── Kit 10: the merchant's endpoints for Airwallex Agentic Commerce (public: Airwallex and
    // the shopper's assistant call them). Create Checkout and webhooks verify Airwallex's
    // HMAC signatures; the OAuth server signs RS256 tokens with a key from Secrets Manager.
    const merchantSecret = new secrets.Secret(this, "MerchantSecret", {
      description: "Kit 10 merchant: checkout HMAC secret, webhook secret, OAuth signing key (JSON). Seeded by npm run aws:merchant -- keys.",
      secretStringValue: SecretValue.unsafePlainText("{}"), // placeholder; real values are generated out of band
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const merchantTable = new dynamodb.Table(this, "MerchantState", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expires_at",
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const merchantFn = new NodejsFunction(this, "MerchantEndpoints", {
      entry: join(ROOT, "src", "aws", "merchant.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: { MERCHANT_TABLE: merchantTable.tableName, MERCHANT_SECRET_ARN: merchantSecret.secretArn, SITE_URL: consoleUrl },
      bundling: {
        format: OutputFormat.ESM,
        target: "node22",
        externalModules: [],
        mainFields: ["module", "main"],
        banner: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
      logGroup: new logs.LogGroup(this, "MerchantLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
    });
    merchantTable.grantReadWriteData(merchantFn);
    merchantSecret.grantRead(merchantFn);
    const merchantApi = new apigw.HttpApi(this, "MerchantApi", {
      apiName: "trailhead-merchant",
      defaultIntegration: new HttpLambdaIntegration("Merchant", merchantFn),
    });
    const merchantStage = merchantApi.defaultStage!.node.defaultChild as apigw.CfnStage;
    merchantStage.defaultRouteSettings = { throttlingBurstLimit: 20, throttlingRateLimit: 10 };

    // Kit 10 on the runtime shops live through Airwallex's merchant MCP endpoint once the merchant is
    // onboarded (npm run aws:merchant -- onboard writes infra/merchant.json; or pass -c acpMcpUrl=...).
    const acpMcpUrl: string | undefined =
      this.node.tryGetContext("acpMcpUrl") ??
      (existsSync(join(ROOT, "infra", "merchant.json")) ? JSON.parse(readFileSync(join(ROOT, "infra", "merchant.json"), "utf8")).acp_mcp_url : undefined);
    const cfnRuntime = runtime.node.defaultChild as CfnResource;
    cfnRuntime.addPropertyOverride("EnvironmentVariables.MERCHANT_URL", merchantApi.apiEndpoint);
    if (acpMcpUrl) cfnRuntime.addPropertyOverride("EnvironmentVariables.ACP_MCP_URL", acpMcpUrl);

    // ── Cost guard, as in the reference builds.
    if (props.alertEmail) {
      const subscribers = [{ subscriptionType: "EMAIL", address: props.alertEmail }];
      new budgets.CfnBudget(this, "Budget", {
        budget: { budgetName: "agent-desk-monthly", budgetType: "COST", timeUnit: "MONTHLY", budgetLimit: { amount: props.budgetUsd, unit: "USD" } },
        notificationsWithSubscribers: [
          { notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 50, thresholdType: "PERCENTAGE" }, subscribers },
          { notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" }, subscribers },
          { notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" }, subscribers },
        ],
      });
    }

    new CfnOutput(this, "ConsoleUrl", { value: consoleUrl });
    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: pool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: client.userPoolClientId });
    new CfnOutput(this, "SecretArn", { value: secret.secretArn });
    new CfnOutput(this, "RuntimeArn", { value: runtime.agentRuntimeArn });
    new CfnOutput(this, "ConsoleSessionId", { value: consoleSessionId() });
    new CfnOutput(this, "MerchantUrl", { value: merchantApi.apiEndpoint });
    new CfnOutput(this, "MerchantSecretArn", { value: merchantSecret.secretArn });
  }
}

const app = new App();
const region = app.node.tryGetContext("region") ?? process.env.AWS_REGION ?? "us-west-2";
const [primary, fallback] = defaultModels(region);
new AgentDeskStack(app, "AgentDesk", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  description: "Airwallex Agent Desk on Amazon Bedrock AgentCore (hackathon demo, sandbox only)",
  alertEmail: app.node.tryGetContext("alertEmail"),
  modelIds: [app.node.tryGetContext("modelId") ?? primary, app.node.tryGetContext("fallbackModelId") ?? fallback],
  budgetUsd: Number(app.node.tryGetContext("budgetUsd") ?? 100),
});
