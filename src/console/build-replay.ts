/**
 * Build a standalone console page that replays the latest recorded run of each
 * kit, with no server: `npm run build:replay` → preview/agent-console.html
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "runs", "console");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const latest = new Map<string, any>();
for (const f of files) {
  const rec = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const finished = rec.events.find((e: any) => e.type === "run_finished");
  if (finished && finished.code === 0) latest.set(rec.kit.id, rec); // later files win
}
const runs = [...latest.values()]
  .sort((a, b) => a.kit.id.localeCompare(b.kit.id))
  .map((r) => ({ kit: r.kit, events: r.events.filter((e: any) => e.type !== "raw") }));

let html = readFileSync(join(process.cwd(), "ui", "index.html"), "utf8");
html = html.replace(/<meta charset[^>]*>\n?/, "").replace(/<meta name="viewport"[^>]*>\n?/, "");
const payload = JSON.stringify({ builtAt: new Date().toISOString(), runs }).replace(/</g, "\\u003c");
html = html.replace("<script>", `<script>window.__REPLAY__ = ${payload};</script>\n<script>`);
mkdirSync(join(process.cwd(), "preview"), { recursive: true });
writeFileSync(join(process.cwd(), "preview", "agent-console.html"), html);
console.log(`preview/agent-console.html · kits ${runs.map((r) => r.kit.id).join(", ")} · ${(html.length / 1024).toFixed(0)} KB`);
