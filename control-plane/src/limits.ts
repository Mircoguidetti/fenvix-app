import { readFileSync } from "node:fs";

export interface Limits {
  nameMinLength: number;
  nameMaxLength: number;
  maxTagsPerDatabase: number;
  maxIdsListIds: number;
  maxIdsBulk: number;
  maxIdsExport: number;
  maxPageSize: number;
  defaultPageSize: number;
  invoicePageSize: number;
  maxUsageExportRows: number;
  maxApiKeyNameLength: number;
  maxWorkspaceNameLength: number;
  allowedIdleMinutes: number[];
  exportUrlTtlSeconds: number;
  idempotencyTtlHours: number;
  emailLinksPerAddressPerHour: number;
}

export interface PlanLimits {
  maxDatabases: number | null;
  maxStorageGb: number | null;
  retentionDays: number | null;
}

export interface Plan {
  id: string;
  name: string;
  price: string;
  period: string;
  description: string;
  features: string[];
  limits: PlanLimits;
}

export interface Rates {
  storagePerGbMonth: number | null;
  requestsPerMillion: number | null;
}

export interface Catalogue {
  defaultPlan: string;
  rates: Rates;
  plans: Plan[];
}

const NO_LIMITS: PlanLimits = { maxDatabases: null, maxStorageGb: null, retentionDays: null };

function fail(file: string, why: string): never {
  throw new Error(`${file}: ${why}`);
}

export function parseLimits(raw: unknown, file = "limits"): Limits {
  const o = raw as Record<string, unknown>;
  const num = (k: keyof Limits): number => {
    const v = o[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) fail(file, `${k} must be a positive integer`);
    return v;
  };
  const idle = o.allowedIdleMinutes;
  if (!Array.isArray(idle) || idle.length === 0 || !idle.every((n) => Number.isInteger(n) && n > 0)) {
    fail(file, "allowedIdleMinutes must be a list of positive integers");
  }
  return {
    nameMinLength: num("nameMinLength"),
    nameMaxLength: num("nameMaxLength"),
    maxTagsPerDatabase: num("maxTagsPerDatabase"),
    maxIdsListIds: num("maxIdsListIds"),
    maxIdsBulk: num("maxIdsBulk"),
    maxIdsExport: num("maxIdsExport"),
    maxPageSize: num("maxPageSize"),
    defaultPageSize: num("defaultPageSize"),
    invoicePageSize: num("invoicePageSize"),
    maxUsageExportRows: num("maxUsageExportRows"),
    maxApiKeyNameLength: num("maxApiKeyNameLength"),
    maxWorkspaceNameLength: num("maxWorkspaceNameLength"),
    allowedIdleMinutes: idle as number[],
    exportUrlTtlSeconds: num("exportUrlTtlSeconds"),
    idempotencyTtlHours: num("idempotencyTtlHours"),
    emailLinksPerAddressPerHour: num("emailLinksPerAddressPerHour"),
  };
}

export function parseCatalogue(raw: unknown, file = "plans"): Catalogue {
  const o = raw as Record<string, unknown>;
  const nullableNumber = (v: unknown, what: string): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(file, `${what} must be null or a number of 0 or more`);
    return v;
  };
  const rates = (o.rates ?? {}) as Record<string, unknown>;
  const plansRaw = o.plans;
  if (!Array.isArray(plansRaw) || plansRaw.length === 0) fail(file, "plans must be a non-empty list");
  const plans: Plan[] = plansRaw.map((p: Record<string, unknown>, i: number) => {
    if (typeof p.id !== "string" || typeof p.name !== "string") fail(file, `plans[${i}] needs an id and a name`);
    const l = (p.limits ?? {}) as Record<string, unknown>;
    return {
      id: p.id,
      name: p.name,
      price: typeof p.price === "string" ? p.price : "",
      period: typeof p.period === "string" ? p.period : "",
      description: typeof p.description === "string" ? p.description : "",
      features: Array.isArray(p.features) ? p.features.map(String) : [],
      limits: {
        maxDatabases: nullableNumber(l.maxDatabases, `${p.id}.maxDatabases`),
        maxStorageGb: nullableNumber(l.maxStorageGb, `${p.id}.maxStorageGb`),
        retentionDays: nullableNumber(l.retentionDays, `${p.id}.retentionDays`),
      },
    };
  });
  const defaultPlan = typeof o.defaultPlan === "string" ? o.defaultPlan : plans[0]!.id;
  if (!plans.some((p) => p.id === defaultPlan)) fail(file, `defaultPlan ${defaultPlan} is not in plans`);
  return {
    defaultPlan,
    rates: {
      storagePerGbMonth: nullableNumber(rates.storagePerGbMonth, "rates.storagePerGbMonth"),
      requestsPerMillion: nullableNumber(rates.requestsPerMillion, "rates.requestsPerMillion"),
    },
    plans,
  };
}

export function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The plan with this id, or the default plan. Unknown plan ids never block a customer. */
export function planFor(catalogue: Catalogue, id: string | null | undefined): Plan {
  return (
    catalogue.plans.find((p) => p.id === id) ??
    catalogue.plans.find((p) => p.id === catalogue.defaultPlan) ?? { ...catalogue.plans[0]!, limits: NO_LIMITS }
  );
}
