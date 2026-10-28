import { createHash, randomBytes } from "node:crypto";
import { type Caller, type Services } from "../context.ts";
import { type Client, iso } from "../db.ts";
import { auditWho, writeAudit } from "../audit.ts";
import { notFound, validation } from "../errors.ts";
import { planFor } from "../limits.ts";
import { signDownload } from "../downloads.ts";
import { isUuid } from "../validate.ts";
import { simplePdf } from "../pdf.ts";

const GIB = 1_073_741_824;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const num = (n: number, digits = 2) => new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };
const money = (currency: string, n: number) => `${SYMBOLS[currency] ?? `${currency} `}${num(n)}`;

// ---------------------------------------------------------------- plans and billing

export async function listPlans(s: Services, caller: Caller) {
  const current = await s.db.tx(caller.workspaceId, async (c) =>
    (await c.query("select plan from public.workspace_settings where workspace_id = $1", [caller.workspaceId])).rows[0]?.plan as string | undefined);
  const currentId = planFor(s.cfg.catalogue, current).id;
  return {
    items: s.cfg.catalogue.plans.map((p) => ({
      id: p.id, name: p.name, price: p.price, period: p.period, description: p.description, features: p.features, current: p.id === currentId,
    })),
  };
}

export async function getBilling(s: Services, caller: Caller, now = new Date()) {
  const rates = s.cfg.catalogue.rates;
  return s.db.tx(caller.workspaceId, async (c) => {
    const st = (await c.query("select plan, currency, payment_brand, payment_last4, payment_expires from public.workspace_settings where workspace_id = $1", [caller.workspaceId])).rows[0];
    if (!st) throw notFound("Billing is not set up for this workspace.");
    const plan = planFor(s.cfg.catalogue, st.plan);
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const u = (await c.query(
      "select coalesce(sum(requests), 0)::bigint as requests, coalesce(sum(storage_bytes), 0)::bigint as storage from public.usage_daily where workspace_id = $1 and day >= $2::date and day <= $3::date",
      [caller.workspaceId, new Date(monthStart).toISOString().slice(0, 10), now.toISOString().slice(0, 10)])).rows[0];
    const gbMonths = Math.round((Number(u.storage) / GIB / dim) * 100) / 100;
    const requests = Number(u.requests);
    const cur = String(st.currency);
    const storageCost = rates.storagePerGbMonth === null ? 0 : Math.round(gbMonths * rates.storagePerGbMonth * 100) / 100;
    const requestCost = rates.requestsPerMillion === null ? 0 : Math.round((requests / 1e6) * rates.requestsPerMillion * 100) / 100;
    const today = now.getUTCDate();
    return {
      currency: cur,
      plan: { name: plan.name, description: plan.description },
      monthToDate: {
        periodLabel: `${MONTHS[now.getUTCMonth()]} 1 to ${today}, ${now.getUTCFullYear()}`,
        lines: [
          { label: "Storage", quantity: `${num(gbMonths)} GB-months`, rate: rates.storagePerGbMonth === null ? "Pricing not set" : `${money(cur, rates.storagePerGbMonth)} per GB-month`, cost: storageCost },
          { label: "Requests", quantity: `${num(requests, 0)} requests`, rate: rates.requestsPerMillion === null ? "Pricing not set" : `${money(cur, rates.requestsPerMillion)} per million`, cost: requestCost },
        ],
        total: Math.round((storageCost + requestCost) * 100) / 100,
      },
      paymentMethod: { brand: String(st.payment_brand), last4: String(st.payment_last4), expires: String(st.payment_expires) },
    };
  });
}

// ---------------------------------------------------------------- invoices

interface InvoiceRow { id: string; number: string; month: Date; issued_at: Date; amount_cents: number; currency: string; status: string }
const toInvoice = (r: InvoiceRow) => ({
  id: r.id, number: r.number, month: new Date(r.month).toISOString().slice(0, 7), issuedAt: iso(r.issued_at)!,
  amount: Number(r.amount_cents) / 100, currency: r.currency, status: r.status as "paid" | "open",
});

export async function listInvoices(s: Services, caller: Caller, page: number, pageSize: number) {
  return s.db.tx(caller.workspaceId, async (c) => {
    const total = (await c.query("select count(*)::bigint as n from public.invoices where workspace_id = $1", [caller.workspaceId])).rows[0].n as number;
    const rows = (await c.query(
      "select * from public.invoices where workspace_id = $1 order by month desc, number desc limit $2 offset $3",
      [caller.workspaceId, pageSize, (page - 1) * pageSize])).rows as InvoiceRow[];
    return { items: rows.map(toInvoice), total, page, pageSize };
  });
}

export function downloadUrl(s: Services, token: string): string {
  return `${s.cfg.apiPublicUrl}/downloads/${token}`;
}

export async function downloadInvoice(s: Services, caller: Caller, id: string, now = new Date()) {
  const inv = await s.db.tx(caller.workspaceId, async (c) => {
    if (!isUuid(id)) return null;
    return ((await c.query("select * from public.invoices where workspace_id = $1 and id = $2", [caller.workspaceId, id])).rows[0] ?? null) as InvoiceRow | null;
  });
  if (!inv) throw notFound("That invoice does not exist.");
  const exp = Math.floor(now.getTime() / 1000) + s.cfg.limits.exportUrlTtlSeconds;
  const token = signDownload(s.cfg.downloadSigningKey, { ws: caller.workspaceId, kind: "invoice-pdf", p: { id }, exp });
  return { filename: `${inv.number}.pdf`, mimeType: "application/pdf", downloadUrl: downloadUrl(s, token) };
}

export async function buildInvoicePdf(s: Services, workspaceId: string, id: string): Promise<{ filename: string; body: string } | null> {
  const row = await s.db.tx(workspaceId, async (c) => {
    if (!isUuid(id)) return null;
    const inv = ((await c.query("select * from public.invoices where workspace_id = $1 and id = $2", [workspaceId, id])).rows[0] ?? null) as InvoiceRow | null;
    if (!inv) return null;
    const ws = (await c.query("select name from public.workspaces where id = $1", [workspaceId])).rows[0]?.name as string;
    return { inv, ws };
  });
  if (!row) return null;
  const t = toInvoice(row.inv);
  return {
    filename: `${t.number}.pdf`,
    body: simplePdf(["FENVIX", "", `Invoice ${t.number}`, `Workspace: ${row.ws}`, `Month: ${t.month}`, `Issued: ${t.issuedAt.slice(0, 10)}`, `Amount: ${t.currency} ${num(t.amount)}`, `Status: ${t.status}`]),
  };
}

// ---------------------------------------------------------------- API keys

interface KeyRow { id: string; name: string; last4: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null; data_access?: string; user_access?: string }
const toKey = (r: KeyRow) => ({
  id: r.id, name: r.name, hint: r.last4, createdAt: iso(r.created_at)!, lastUsedAt: iso(r.last_used_at), revokedAt: iso(r.revoked_at),
  // Data Explorer (migration 0004): "read" unless the key was made with readWrite.
  dataAccess: r.data_access === "read_write" ? "readWrite" as const : "read" as const,
  // Database users (migration 0007): "none" unless the key was made with manage.
  userAccess: r.user_access === "manage" ? "manage" as const : "none" as const,
});

export const hashKey = (secret: string) => createHash("sha256").update(secret).digest("hex");

export async function listApiKeys(s: Services, caller: Caller) {
  return s.db.tx(caller.workspaceId, async (c) => ({
    items: ((await c.query("select * from public.api_keys where workspace_id = $1 order by created_at desc, id", [caller.workspaceId])).rows as KeyRow[]).map(toKey),
  }));
}

export async function createApiKey(s: Services, caller: Caller, name: string, dataAccess: "read" | "readWrite" = "read", userAccess: "none" | "manage" = "none") {
  const clean = name.trim();
  if (clean.length < 1 || clean.length > s.cfg.limits.maxApiKeyNameLength) {
    throw validation(`Use 1 to ${s.cfg.limits.maxApiKeyNameLength} characters for the name.`, "name");
  }
  // 32 random bytes as hex with the prefix people expect; only the hash and the last four characters are stored.
  const secret = `fnx_${randomBytes(32).toString("hex")}`;
  const key = await s.db.tx(caller.workspaceId, async (c) => {
    // data_access exists from migration 0004 on, user_access from 0007 on: a key that leaves one at its default does not
    // name the column, so this works before those migrations too.
    const cols = ["workspace_id", "name", "key_hash", "last4"];
    const vals: unknown[] = [caller.workspaceId, clean, hashKey(secret), secret.slice(-4)];
    if (dataAccess === "readWrite") { cols.push("data_access"); vals.push("read_write"); }
    if (userAccess === "manage") { cols.push("user_access"); vals.push("manage"); }
    const row = (await c.query(`insert into public.api_keys (${cols.join(", ")}) values (${vals.map((_, i) => `$${i + 1}`).join(", ")}) returning *`, vals)).rows[0] as KeyRow;
    await writeAudit(c, auditWho(caller), { action: "api_key.create", targetType: "api_key", targetId: row.id, metadata: { name: clean, dataAccess, userAccess } });
    return toKey(row);
  });
  return { key, secret };
}

export async function revokeApiKey(s: Services, caller: Caller, id: string) {
  return s.db.tx(caller.workspaceId, async (c) => {
    if (!isUuid(id)) throw notFound("That key does not exist.");
    const row = (await c.query(
      "update public.api_keys set revoked_at = coalesce(revoked_at, now()) where workspace_id = $1 and id = $2 returning *", [caller.workspaceId, id])).rows[0] as KeyRow | undefined;
    if (!row) throw notFound("That key does not exist.");
    await writeAudit(c, auditWho(caller), { action: "api_key.revoke", targetType: "api_key", targetId: id });
    return toKey(row);
  });
}

/** Finds the workspace of an API key by its hash. Records use at most once a minute. */
export async function resolveApiKey(s: Services, secret: string): Promise<{ keyId: string; workspaceId: string } | null> {
  const hash = hashKey(secret);
  const found = await s.db.system(async (c) => (await c.query("select * from public.fenvix_cp_resolve_api_key($1)", [hash])).rows[0] as { key_id: string; workspace_id: string; last_used_at: Date | null } | undefined);
  if (!found) return null;
  if (!found.last_used_at || Date.now() - new Date(found.last_used_at).getTime() > 60_000) {
    await s.db.tx(found.workspace_id, (c: Client) => c.query("update public.api_keys set last_used_at = now() where id = $1 and workspace_id = $2", [found.key_id, found.workspace_id])).catch(() => {});
  }
  return { keyId: found.key_id, workspaceId: found.workspace_id };
}

// ---------------------------------------------------------------- settings

export interface Settings { workspaceName: string; idleMinutes: number; emailNotices: boolean }

export async function getSettings(s: Services, caller: Caller): Promise<Settings> {
  return s.db.tx(caller.workspaceId, async (c) => readSettings(c, caller.workspaceId));
}

async function readSettings(c: Client, ws: string): Promise<Settings> {
  const r = (await c.query(
    "select w.name, st.idle_minutes, st.email_notices from public.workspaces w join public.workspace_settings st on st.workspace_id = w.id where w.id = $1", [ws])).rows[0];
  if (!r) throw notFound("Settings are not set up for this workspace.");
  return { workspaceName: String(r.name), idleMinutes: Number(r.idle_minutes), emailNotices: Boolean(r.email_notices) };
}

export async function saveSettings(s: Services, caller: Caller, v: Settings): Promise<Settings> {
  return s.db.tx(caller.workspaceId, async (c) => {
    await c.query("update public.workspaces set name = $2 where id = $1", [caller.workspaceId, v.workspaceName]);
    await c.query("update public.workspace_settings set idle_minutes = $2, email_notices = $3, updated_at = now() where workspace_id = $1", [caller.workspaceId, v.idleMinutes, v.emailNotices]);
    await writeAudit(c, auditWho(caller), { action: "settings.save", metadata: { idleMinutes: v.idleMinutes, emailNotices: v.emailNotices } });
    return readSettings(c, caller.workspaceId);
  });
}
