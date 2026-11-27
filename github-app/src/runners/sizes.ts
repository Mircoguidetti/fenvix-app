/**
 * EC2 instance sizes, read from the type's name: vCPUs (medium 1, large 2, xlarge 4, Nxlarge 4N) and slots of the
 * fleet limit (one slot = one c6i.large, 2 vCPU). The fleet limit (RUNNER_MAX_RUNNING) counts slots, so a bigger
 * machine (a side-by-side job's c6i.2xlarge: 4 slots) takes its share of the account's vCPU quota.
 */
export function vcpusOf(instanceType: string): number | null {
  const size = instanceType.split(".")[1] ?? "";
  if (size === "medium") return 1;
  if (size === "large") return 2;
  if (size === "xlarge") return 4;
  const m = /^(\d+)xlarge$/.exec(size);
  return m ? 4 * Number(m[1]) : null;
}

/** A machine's slots: its vCPUs / 2, at least 1. No type (the launch template's) or an unknown one: 1. */
export function slotsOf(instanceType: string | undefined): number {
  const v = instanceType ? vcpusOf(instanceType) : null;
  return v === null ? 1 : Math.max(1, Math.ceil(v / 2));
}
