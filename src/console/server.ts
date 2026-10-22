/**
 * Agent Console: a local web UI for the kits.
 *
 *   npm run console   →  http://localhost:4310
 *
 * GET  /                 the console page
 * GET  /api/kits         kit list
 * GET  /api/events       server-sent events for the current run
 * POST /api/run/:kit     start a kit (one run at a time)
 * POST /api/approve      {"id","approve","by"} answer an approval request
 */
import "../core/env.ts";
import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KITS, startKit, saveRecording, type Run, type KitEvent } from "./runner.ts";

const PORT = Number(process.env.PORT ?? 4310);
const clients = new Set<ServerResponse>();
let current: Run | null = null;

const broadcast = (e: KitEvent) => {
  const data = `data: ${JSON.stringify(e)}\n\n`;
  for (const c of clients) c.write(data);
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

async function readBody(req: import("node:http").IncomingMessage): Promise<any> {
  let s = "";
  for await (const chunk of req) s += chunk;
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(join(process.cwd(), "ui", "index.html")));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/kits") return json(res, 200, { kits: KITS, running: current?.kit.id ?? null });

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    for (const e of current?.events ?? []) res.write(`data: ${JSON.stringify(e)}\n\n`); // catch up on the current run
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  const runMatch = url.pathname.match(/^\/api\/run\/(\d\d)$/);
  if (req.method === "POST" && runMatch) {
    const kit = KITS.find((k) => k.id === runMatch[1]);
    if (!kit) return json(res, 404, { error: "Unknown kit" });
    if (current && current.child.exitCode === null) return json(res, 409, { error: `Kit ${current.kit.id} is still running` });
    current = startKit(kit, broadcast);
    current.done.then(() => current && saveRecording(current));
    return json(res, 202, { runId: current.runId });
  }

  if (req.method === "POST" && url.pathname === "/api/approve") {
    const { id, approve, by } = await readBody(req);
    if (!current || current.child.exitCode !== null) return json(res, 409, { error: "No run is waiting" });
    current.answer(String(id), Boolean(approve), by ? String(by).slice(0, 40) : undefined);
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: "Not found" });
}).listen(PORT, () => {
  console.log(`Agent Console → http://localhost:${PORT}`);
});
