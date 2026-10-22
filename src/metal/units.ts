/**
 * *USDZ amounts. On chain they are base units with 18 decimals; payments under
 * spending limits are whole cents. Inside the kits we keep every amount in
 * integer cents so no money is lost to floating point.
 */
export const USDZ_DECIMALS = 18n;
const CENT_IN_BASE = 10n ** (USDZ_DECIMALS - 2n);

/** Dollars (major units) → integer cents. Throws on sub-cent amounts. */
export function cents(dollars: number): number {
  const c = Math.round(dollars * 100);
  if (Math.abs(c - dollars * 100) > 1e-6) throw new Error(`${dollars} is not a whole number of cents`);
  return c;
}

/** Integer cents → *USDZ base units (18 decimals). */
export function toBase(c: number): bigint {
  if (!Number.isInteger(c)) throw new Error(`cents must be an integer, got ${c}`);
  return BigInt(c) * CENT_IN_BASE;
}

/** *USDZ base units → integer cents (refuses fractions of a cent). */
export function fromBase(base: bigint): number {
  if (base % CENT_IN_BASE !== 0n) throw new Error(`${base} base units is not a whole number of cents`);
  return Number(base / CENT_IN_BASE);
}

export const fmt = (c: number) => `${c < 0 ? "-" : ""}USDZ ${(Math.abs(c) / 100).toFixed(2)}`;

/**
 * Clearing counts in clearing units: a millionth of *USDZ ("micros"). Providers
 * can charge per chunk at prices far below a cent.
 */
export const MICROS_PER_CENT = 10_000;
const MICRO_IN_BASE = 10n ** (USDZ_DECIMALS - 6n);
export const microsToBase = (m: number) => BigInt(m) * MICRO_IN_BASE;
export const baseToMicros = (b: bigint) => Number(b / MICRO_IN_BASE);
export const fmtMicros = (m: number) => `USDZ ${(m / 1_000_000).toFixed(4)}`;
