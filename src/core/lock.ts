/**
 * Duplicate-payment lock, one per obligation (invoice, payroll line, payout).
 *
 * The lock records which transfer is currently allowed to settle the obligation.
 * A new transfer may be created only when the lock is free or the transfer it
 * holds has reached a final failure. The file is written before the API call
 * (with the request_id), so a crash between the two can be recovered by
 * querying Airwallex for that request_id instead of paying again.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LockState = "INTENT" | "IN_FLIGHT" | "PAID" | "FAILED";

export interface LockRecord {
  obligation: string;
  attempts: { requestId: string; transferId?: string; state: LockState; note?: string; at: string }[];
}

const dir = join(process.cwd(), "runs", "locks");
mkdirSync(dir, { recursive: true });
const file = (obligation: string) => join(dir, `${obligation.replace(/[^\w.-]/g, "_")}.json`);

export function readLock(obligation: string): LockRecord {
  return existsSync(file(obligation)) ? JSON.parse(readFileSync(file(obligation), "utf8")) : { obligation, attempts: [] };
}

function save(rec: LockRecord) {
  writeFileSync(file(rec.obligation), JSON.stringify(rec, null, 2));
}

/** The attempt that could still settle the obligation, if any. */
export function liveAttempt(rec: LockRecord) {
  return rec.attempts.find((a) => a.state === "INTENT" || a.state === "IN_FLIGHT" || a.state === "PAID");
}

/** Reserve the obligation for a new attempt. Throws if another attempt could still pay. */
export function acquire(obligation: string, requestId: string, note?: string): LockRecord {
  const rec = readLock(obligation);
  const live = liveAttempt(rec);
  if (live) {
    throw new Error(`Duplicate lock: ${obligation} already has attempt ${live.transferId ?? live.requestId} in state ${live.state}`);
  }
  rec.attempts.push({ requestId, state: "INTENT", note, at: new Date().toISOString() });
  save(rec);
  return rec;
}

export function update(obligation: string, requestId: string, patch: Partial<LockRecord["attempts"][number]>) {
  const rec = readLock(obligation);
  const a = rec.attempts.find((x) => x.requestId === requestId);
  if (!a) throw new Error(`No attempt ${requestId} on ${obligation}`);
  Object.assign(a, patch, { at: new Date().toISOString() });
  save(rec);
}

/** Start a demo from a clean slate. */
export function resetLock(obligation: string) {
  save({ obligation, attempts: [] });
}
