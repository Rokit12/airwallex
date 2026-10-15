/**
 * Record a kit run for replay without a backend: `npm run record -- 01`.
 * Approvals are answered automatically (APPROVE=yes) and attributed to APPROVER.
 */
import "../core/env.ts";
import { KITS, startKit, saveRecording } from "./runner.ts";

const ids = process.argv.slice(2).length ? process.argv.slice(2) : KITS.map((k) => k.id);
for (const id of ids) {
  const kit = KITS.find((k) => k.id === id.padStart(2, "0"));
  if (!kit) {
    console.error(`Unknown kit ${id}`);
    continue;
  }
  const run = startKit(kit, (e) => e.type !== "raw" && process.stdout.write("."), { APPROVE: "yes", APPROVER: process.env.APPROVER ?? "operator" });
  const code = await run.done;
  console.log(`\nkit ${kit.id}: exit ${code}, ${run.events.length} events → ${saveRecording(run)}`);
}
