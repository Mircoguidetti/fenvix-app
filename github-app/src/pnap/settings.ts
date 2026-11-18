import { isRegion, type Region } from "./api.ts";

/**
 * Customer mode on phoenixNAP: every setting is plain configuration (the infra sets it from cdk.json); none is a
 * secret. docs/CUSTOMER-MODE-PNAP.md explains each one.
 */
export interface RegionLimits { min: number; max: number }

export interface PnapSettings {
  /** Hostname prefix of every server we rent: fx-<env>-<region>-<random>. Servers with this prefix that the
   * database does not know are released (orphans cost money). */
  env: string;
  regions: Partial<Record<Region, RegionLimits>>;
  /** Region of an installation that has none set (null: such jobs wait, they never run in another region). */
  defaultRegion: Region | null;
  serverType: string;
  os: string;
  pricingModel: string;
  vcpus: number;
  memMib: number;
  scratchGib: number;
  slotsPerHost: number;
  jobTimeoutMinutes: number;
  /** An idle host is drained after this many minutes without a job (and released once drained). */
  idleMinutes: number;
  /** Hourly billing: release an idle host only in the last minutes of the hour already paid for. */
  hourAware: boolean;
  releaseWindowMinutes: number;
  /** A server that has not enrolled this long after the order is released (its install failed or hangs). */
  provisionTimeoutMinutes: number;
  /** A ready host silent this long is considered dead: released, its unstarted jobs queued again. */
  heartbeatTimeoutSeconds: number;
  maxHostsTotal: number;
  maxOrdersPerRun: number;
  /** After phoenixNAP answers 406 (no server of this type available), no order in that region for this long. */
  noCapacityBackoffMinutes: number;
  cacheMode: "off" | "colocated" | "dedicated";
  cacheServerType: string;
  cachePort: number;
  /** The App's public URL (agents call /v1/hosts/*; summaries go to /v1/runner/summaries). */
  controlUrl: string;
  sshKeyIds: string[];
  installDefaultSshKeys: boolean;
  pins: {
    firecrackerVersion: string; firecrackerSha256: string;
    kernelUrl: string; kernelSha256: string;
    baseUrl: string; baseSha256: string;
    guestImageUrl: string; guestImageSha256: string;
    engineCommit: string;
  };
}

/** What we know of the server types we may rent (phoenixNAP's product metadata, read 2026-11-18). */
export const SERVER_TYPES: Record<string, { cores: number; threads: number; memGiB: number; disk: string }> = {
  "d3.c1.large": { cores: 32, threads: 64, memGiB: 256, disk: "2x 2TB NVMe" },
  "s1.c1.small": { cores: 6, threads: 12, memGiB: 64, disk: "1x 1TB NVMe" },
  "s1.c1.medium": { cores: 6, threads: 12, memGiB: 128, disk: "2x 1TB NVMe" },
};
/** Kept for the host itself: the agent, the cache in colocated mode, the kernel. */
export const HOST_RESERVE = { cores: 2, memMib: 16 * 1024 };
export const VMM_OVERHEAD_MIB = 512;

/** How many microVMs of this size a host runs at once: one vCPU per PHYSICAL core (no CPU overcommit), and the guest
 * memory plus the VMM's overhead (no memory overcommit). The host runs with SMT off (install-host.sh; the agent
 * refuses to enrol otherwise), as Firecracker's production guidance asks when tenants share a host: no core ever runs
 * two customers' vCPUs on its sibling threads (R-012 F16, R-014 R2). d3.c1.large with 2 vCPUs / 8 GiB:
 * min((32 - 2) / 2, 240 GiB / 8.5 GiB) = min(15, 28) = 15. */
export function slotsFor(serverType: string, vcpus: number, memMib: number): number {
  const t = SERVER_TYPES[serverType];
  if (!t) throw new Error(`unknown server type ${serverType}: set PNAP_SLOTS_PER_HOST`);
  return Math.max(0, Math.min(Math.floor((t.cores - HOST_RESERVE.cores) / vcpus),
    Math.floor((t.memGiB * 1024 - HOST_RESERVE.memMib) / (memMib + VMM_OVERHEAD_MIB))));
}

type Env = Record<string, string | undefined>;

function num(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

const SHA = /^[0-9a-f]{64}$/;

/** The part the worker needs to place jobs (PNAP_REGIONS, PNAP_DEFAULT_REGION). */
export function loadPlacementSettings(env: Env): Pick<PnapSettings, "regions" | "defaultRegion"> {
  const regions: Partial<Record<Region, RegionLimits>> = {};
  // PNAP_REGIONS="ASH:0:3,NLD:0:2"  (region:min:max)
  for (const part of (env.PNAP_REGIONS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [r, min, max] = part.split(":");
    const lo = Number(min), hi = Number(max);
    if (!isRegion(r) || !Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo || hi > 50) {
      throw new Error(`PNAP_REGIONS: "${part}" is not REGION:MIN:MAX with a region of ASH, PHX, CHI, SEA, NLD`);
    }
    regions[r] = { min: lo, max: hi };
  }
  if (!Object.keys(regions).length) throw new Error("PNAP_REGIONS is required (e.g. ASH:0:3,NLD:0:2)");
  const defaultRegion = env.PNAP_DEFAULT_REGION ? env.PNAP_DEFAULT_REGION : null;
  if (defaultRegion !== null && (!isRegion(defaultRegion) || !regions[defaultRegion])) throw new Error("PNAP_DEFAULT_REGION must be one of PNAP_REGIONS");
  return { regions, defaultRegion: defaultRegion as Region | null };
}

export function loadPnapSettings(env: Env): PnapSettings {
  const { regions, defaultRegion } = loadPlacementSettings(env);
  const serverType = env.PNAP_SERVER_TYPE ?? "d3.c1.large";
  const vcpus = num(env, "PNAP_VM_VCPUS", 2, 1, 32);
  const memMib = num(env, "PNAP_VM_MEM_MIB", 8192, 1024, 131072);
  const fit = SERVER_TYPES[serverType] ? slotsFor(serverType, vcpus, memMib) : 250;
  // An explicit PNAP_SLOTS_PER_HOST may lower the count, never raise it above the physical cores (R-014 R2).
  const slotsPerHost = env.PNAP_SLOTS_PER_HOST ? num(env, "PNAP_SLOTS_PER_HOST", 1, 1, fit) : slotsFor(serverType, vcpus, memMib);
  if (slotsPerHost < 1) throw new Error(`a ${serverType} has no room for a ${vcpus} vCPU / ${memMib} MiB microVM`);
  const controlUrl = (env.PNAP_CONTROL_URL ?? "").replace(/\/+$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(controlUrl) && !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(controlUrl)) {
    throw new Error("PNAP_CONTROL_URL must be the App's public https origin");
  }
  const cacheMode = (env.PNAP_CACHE_MODE ?? "colocated") as PnapSettings["cacheMode"];
  if (!["off", "colocated", "dedicated"].includes(cacheMode)) throw new Error("PNAP_CACHE_MODE: off, colocated or dedicated");
  const envName = env.FENVIX_ENV ?? "prod";
  if (!/^[a-z0-9]{1,12}$/.test(envName)) throw new Error("FENVIX_ENV: lower-case letters and digits");
  const pins = {
    firecrackerVersion: env.PNAP_FIRECRACKER_VERSION ?? "v1.18.0",
    firecrackerSha256: env.PNAP_FIRECRACKER_SHA256 ?? "",
    kernelUrl: env.PNAP_GUEST_KERNEL_URL ?? "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.15/x86_64/vmlinux-6.1.155",
    kernelSha256: env.PNAP_GUEST_KERNEL_SHA256 ?? "e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2",
    baseUrl: env.PNAP_GUEST_BASE_URL ?? "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.15/x86_64/ubuntu-24.04.squashfs",
    baseSha256: env.PNAP_GUEST_BASE_SHA256 ?? "68321e0482baeb3844dafe8a6b08a6902401a7afc41fbfd8c3d9ea08aadd244f",
    guestImageUrl: env.PNAP_GUEST_IMAGE_URL ?? "",
    guestImageSha256: env.PNAP_GUEST_IMAGE_SHA256 ?? "",
    engineCommit: env.PNAP_ENGINE_CLI_COMMIT ?? "732f4560bcd1ead3433caac44f8a011d3115e2fc",
  };
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(pins.firecrackerVersion)) throw new Error("PNAP_FIRECRACKER_VERSION like v1.18.0");
  if (!SHA.test(pins.firecrackerSha256)) throw new Error("PNAP_FIRECRACKER_SHA256 is required: the SHA-256 of the release archive (docs/CUSTOMER-MODE-PNAP.md)");
  for (const [k, v] of [["kernelSha256", pins.kernelSha256], ["baseSha256", pins.baseSha256]] as const) if (!SHA.test(v)) throw new Error(`${k}: a SHA-256`);
  if (pins.guestImageUrl && !SHA.test(pins.guestImageSha256)) throw new Error("PNAP_GUEST_IMAGE_SHA256 is required with PNAP_GUEST_IMAGE_URL");
  for (const u of [pins.kernelUrl, pins.baseUrl, pins.guestImageUrl].filter(Boolean)) if (!/^https:\/\/[^\s'"\\$`]+$/.test(u)) throw new Error(`not an https URL: ${u}`);
  if (!/^[0-9a-f]{40}$/.test(pins.engineCommit)) throw new Error("PNAP_ENGINE_CLI_COMMIT: a full commit id");
  const sshKeyIds = (env.PNAP_SSH_KEY_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (sshKeyIds.some((k) => !/^[A-Za-z0-9]{1,64}$/.test(k))) throw new Error("PNAP_SSH_KEY_IDS: phoenixNAP SSH key ids, comma separated");
  return {
    env: envName, regions, defaultRegion, serverType,
    os: env.PNAP_OS ?? "ubuntu/noble",
    pricingModel: env.PNAP_PRICING_MODEL ?? "HOURLY",
    vcpus, memMib, scratchGib: num(env, "PNAP_VM_SCRATCH_GIB", 50, 4, 1024), slotsPerHost,
    jobTimeoutMinutes: num(env, "PNAP_JOB_TIMEOUT_MINUTES", 360, 5, 1440),
    idleMinutes: num(env, "PNAP_IDLE_MINUTES", 20, 0, 24 * 60),
    hourAware: (env.PNAP_HOUR_AWARE ?? "true") !== "false",
    releaseWindowMinutes: num(env, "PNAP_RELEASE_WINDOW_MINUTES", 10, 1, 59),
    provisionTimeoutMinutes: num(env, "PNAP_PROVISION_TIMEOUT_MINUTES", 90, 10, 600),
    heartbeatTimeoutSeconds: num(env, "PNAP_HEARTBEAT_TIMEOUT_SECONDS", 300, 30, 3600),
    maxHostsTotal: num(env, "PNAP_MAX_HOSTS_TOTAL", 10, 0, 200),
    maxOrdersPerRun: num(env, "PNAP_MAX_ORDERS_PER_RUN", 2, 1, 20),
    noCapacityBackoffMinutes: num(env, "PNAP_NO_CAPACITY_BACKOFF_MINUTES", 15, 1, 600),
    cacheMode, cacheServerType: env.PNAP_CACHE_SERVER_TYPE ?? "s1.c1.small", cachePort: num(env, "PNAP_CACHE_PORT", 8787, 1, 65535),
    controlUrl, sshKeyIds, installDefaultSshKeys: (env.PNAP_INSTALL_DEFAULT_SSH_KEYS ?? "true") !== "false", pins,
  };
}
