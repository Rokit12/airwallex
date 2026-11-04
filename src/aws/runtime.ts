/**
 * Amazon Bedrock AgentCore Runtime entrypoint for the Agent Desk.
 *
 * AgentCore's service contract: listen on 0.0.0.0:8080, answer GET /ping and
 * POST /invocations. Each invocation is one JSON action:
 *
 *   {"action":"kits"}                              list kits and the running one
 *   {"action":"run","kit":"03","by":"<user>"}      start a kit (one run at a time)
 *   {"action":"events","since":0}                  events of the current run from seq `since`
 *   {"action":"approve","id","approve","by"}       answer an approval request
 *
 * The runtime is invoked only by the console API Lambda (IAM auth, nothing
 * public), which sets `by` from the operator's verified Cognito sign-in. The
 * kits do the same thing they do locally: the model reads, code decides, and a
 * person other than the proposing agent approves the exact terms.
 *
 * The console shares one runtime session (the API pins the session id), so the
 * in-memory run below survives between invocations the way it does in the
 * local console.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSecrets } from "./secrets.ts";

const PORT = Number(process.env.PORT ?? 8080);

// In the deployment package (npm run aws:build) this file sits next to kits/,
// ui/, node_modules/ and chromium/. Point the runner and the browser at them.
const here = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(here, "kits", "kit01.mjs"))) process.env.KIT_BUNDLE_DIR ??= join(here, "kits");
if (existsSync(join(here, "chromium", "chromium.br"))) process.env.CHROMIUM_PACK ??= join(here, "chromium");
const codeDir = process.env.KIT_BUNDLE_DIR ? dirname(process.env.KIT_BUNDLE_DIR) : process.cwd();

/** The package is read-only on AgentCore: run from a writable copy under /tmp. */
function prepareWorkDir() {
  if (!process.env.KIT_BUNDLE_DIR) return; // local test run: stay in the repo
  const work = process.env.AWX_WORK_DIR ?? "/tmp/awx";
  mkdirSync(join(work, "runs"), { recursive: true });
  for (const name of ["ui", "node_modules"]) {
    const target = join(work, name);
    if (!existsSync(target) && existsSync(join(codeDir, name))) symlinkSync(join(codeDir, name), target);
  }
  process.chdir(work);
}

async function main() {
  prepareWorkDir();
  const loaded = await loadSecrets();
  // Import after the environment is ready: the runner reads it when kits start.
  const { KITS, startKit, saveRecording } = await import("../console/runner.ts");
  type Run = import("../console/runner.ts").Run;
  let current: Run | null = null;

  // AgentCore surfaces a non-200 reply from /invocations as a runtime error, so
  // refusals go back as 200 with {"error","status"} and the API maps the status.
  const send = (res: ServerResponse, status: number, body: unknown) => {
    const invocation = (res.req?.url ?? "").startsWith("/invocations");
    const payload = invocation && status >= 400 ? { ...(body as object), status } : body;
    res.writeHead(invocation ? 200 : status, { "content-type": "application/json" }).end(JSON.stringify(payload));
  };

  async function body(req: IncomingMessage): Promise<any> {
    let s = "";
    for await (const c of req) s += c;
    try {
      return s ? JSON.parse(s) : {};
    } catch {
      return {};
    }
  }

  const running = () => (current && current.child.exitCode === null && current.child.signalCode === null ? current : null);

  createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/ping") {
      // HealthyBusy keeps AgentCore from ending the session while a kit runs.
      return send(res, 200, { status: running() ? "HealthyBusy" : "Healthy", time_of_last_update: Math.floor(Date.now() / 1000) });
    }
    if (req.method !== "POST" || path !== "/invocations") return send(res, 404, { error: "Not found" });

    const msg = await body(req);
    switch (msg.action) {
      case "kits":
        return send(res, 200, { kits: KITS, running: running()?.kit.id ?? null, lastRun: current?.runId ?? null, secrets: loaded });
      case "run": {
        const kit = KITS.find((k) => k.id === String(msg.kit));
        if (!kit) return send(res, 404, { error: "Unknown kit" });
        if (running()) return send(res, 409, { error: `Kit ${current!.kit.id} is still running` });
        current = startKit(kit, () => {});
        const run = current;
        run.done.then(() => {
          try {
            saveRecording(run);
          } catch {
            /* recordings are a convenience */
          }
        });
        return send(res, 202, { runId: current.runId });
      }
      case "events": {
        const since = Number(msg.since ?? 0);
        const events = (current?.events ?? []).filter((e) => (e.seq ?? 0) >= since);
        return send(res, 200, { runId: current?.runId ?? null, kit: current?.kit.id ?? null, running: Boolean(running()), events });
      }
      case "approve": {
        const by = typeof msg.by === "string" ? msg.by.slice(0, 60) : "";
        if (!by) return send(res, 400, { error: "An approval must name the person approving" });
        if (!running()) return send(res, 409, { error: "No run is waiting" });
        current!.answer(String(msg.id), Boolean(msg.approve), by);
        return send(res, 200, { ok: true });
      }
      default:
        return send(res, 400, { error: "Unknown action" });
    }
  }).listen(PORT, "0.0.0.0", () => console.log(`Agent Desk runtime listening on ${PORT} (code ${codeDir})`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
