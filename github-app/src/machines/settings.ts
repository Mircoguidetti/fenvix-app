/**
 * The machine pool's settings (FENVIX_POOL, JSON; set by infra/github-app from cdk.json). The design of 2026-11-20:
 * one always-on machine (c7a.xlarge, 4 physical cores), a reserve of prepared machines kept stopped, spot capacity for
 * bursts, per-customer caps. Every number here is configurable; these defaults are the founder's design.
 */
export interface PoolSize {
  /** The EC2 type (x86_64 only, go-live scope). */
  instanceType: string;
  /** Jobs of the SAME customer that may share one machine, each in its own sandbox. */
  slots: number;
}

export interface PoolSettings {
  sizes: Record<string, PoolSize>;
  /** The size of `runs-on: fenvix`; a job asks for another one with a second label `fenvix-<size>`. */
  defaultSize: string;
  /** Clean running machines kept ready for the next job with no start delay. */
  alwaysOn: number;
  /** Prepared machines kept stopped (only their disk is paid). */
  reserve: number;
  /** All machines of the region, any state but gone. */
  maxMachines: number;
  /** Above this many running machines in the region, new machines are spot (bursts). */
  spotAbove: number;
  /** Defaults per customer (workspaces.max_machines and max_concurrent_jobs override them). */
  machinesPerCustomer: number;
  jobsPerCustomer: number;
  /** A customer's empty machine waits this long for its next job, then is terminated (never given to another). */
  lingerMinutes: number;
  /** A machine that has not said hello, or not polled, for this long is terminated and its work re-queued. */
  silentMinutes: number;
  /** An offered lease not taken in this time is lost and the job re-queued. */
  offerMinutes: number;
  /** Hard limit of a machine's life. */
  maxHours: number;
  /**
   * Whether the installed engine honours FENVIX_MODE=shadow and FENVIX_SKIP=0 (docs/data-contract.md "The engine
   * contract"). Until it does (false), a shadow run or a project with skip-with-proof off gets NO shared-cache
   * credential: with a fresh slot and no cache nothing can be reused, so every test runs (audit G-0187, G-0191).
   */
  engineHonoursMode: boolean;
}

export const DEFAULT_POOL: PoolSettings = {
  sizes: { standard: { instanceType: "c7a.xlarge", slots: 2 }, large: { instanceType: "c7a.2xlarge", slots: 4 } },
  defaultSize: "standard",
  alwaysOn: 1,
  reserve: 2,
  maxMachines: 8,
  spotAbove: 4,
  machinesPerCustomer: 3,
  jobsPerCustomer: 6,
  lingerMinutes: 10,
  silentMinutes: 10,
  offerMinutes: 5,
  maxHours: 6,
  engineHonoursMode: false,
};

const SIZE = /^[a-z][a-z0-9-]{0,30}$/;
const TYPE = /^(c7a|c6i|m6i|t3)\.(large|xlarge|2xlarge|4xlarge|medium)$/;

export function parsePool(raw: string | undefined): PoolSettings {
  if (!raw || !raw.trim()) return DEFAULT_POOL;
  let v: Record<string, unknown>;
  try { v = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error("FENVIX_POOL is not JSON"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("FENVIX_POOL must be an object");
  const out: PoolSettings = { ...DEFAULT_POOL, ...(v as Partial<PoolSettings>) };
  if (!out.sizes || typeof out.sizes !== "object" || !Object.keys(out.sizes).length) throw new Error("FENVIX_POOL.sizes: at least one size");
  for (const [name, s] of Object.entries(out.sizes)) {
    if (!SIZE.test(name)) throw new Error(`FENVIX_POOL.sizes: bad size name "${name}"`);
    if (!s || !TYPE.test(s.instanceType)) throw new Error(`FENVIX_POOL.sizes.${name}.instanceType must be an x86_64 type like c7a.xlarge`);
    if (!Number.isInteger(s.slots) || s.slots < 1 || s.slots > 16) throw new Error(`FENVIX_POOL.sizes.${name}.slots must be 1 to 16`);
  }
  if (!out.sizes[out.defaultSize]) throw new Error(`FENVIX_POOL.defaultSize "${out.defaultSize}" is not a size`);
  const ints: [keyof PoolSettings, number, number][] = [["alwaysOn", 0, 20], ["reserve", 0, 50], ["maxMachines", 1, 200], ["spotAbove", 0, 200],
    ["machinesPerCustomer", 1, 100], ["jobsPerCustomer", 1, 400], ["lingerMinutes", 0, 120], ["silentMinutes", 2, 120], ["offerMinutes", 1, 60], ["maxHours", 1, 72]];
  for (const [k, lo, hi] of ints) {
    const n = out[k] as unknown;
    if (!Number.isInteger(n) || (n as number) < lo || (n as number) > hi) throw new Error(`FENVIX_POOL.${k} must be an integer from ${lo} to ${hi}`);
  }
  if (typeof out.engineHonoursMode !== "boolean") throw new Error("FENVIX_POOL.engineHonoursMode must be true or false");
  if (out.alwaysOn + out.reserve > out.maxMachines) throw new Error("FENVIX_POOL: alwaysOn + reserve must fit in maxMachines");
  return out;
}

/** The size a job asks for: `fenvix-<size>` among its labels, else the default. Unknown sizes are refused (null). */
export function sizeOfLabels(labels: string[], runsOn: string, pool: PoolSettings): string | null {
  const asked = labels.filter((l) => l.startsWith(`${runsOn}-`)).map((l) => l.slice(runsOn.length + 1));
  if (!asked.length) return pool.defaultSize;
  if (asked.length > 1) return null;
  return pool.sizes[asked[0]!] ? asked[0]! : null;
}
