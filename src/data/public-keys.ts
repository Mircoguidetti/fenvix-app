import { ExplorerError } from "./explorer.ts";

/**
 * Keys of the public API (control-plane/docs/public-api.md, "API keys"; routes under /v1/public/api-keys). These are
 * the keys customers use: `fvx_` and 43 characters, shown in full once, in the answer that creates them. The
 * dashboard's own `fnx_` keys are not offered on any screen.
 *
 * Kept free of React and Vite so the rules here can be unit tested in Node.
 */
export type PublicKeyRole = "admin" | "read_only";
export type PublicKeyStatus = "active" | "expired" | "revoked";

export interface PublicApiKey {
  id: string;
  name: string;
  role: PublicKeyRole;
  /** `fvx_` and the next 8 characters. */
  prefix: string;
  /** As the API sent it; the screen derives its own from the dates too (keyStatus), since a key can expire while it is open. */
  status: PublicKeyStatus;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface PublicKeyPage {
  items: PublicApiKey[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface NewPublicKey {
  name: string;
  role: PublicKeyRole;
  /** ISO time, or null for a key that does not expire. */
  expiresAt: string | null;
}

export interface CreatedPublicKey {
  key: PublicApiKey;
  /** The whole key. In this answer only. */
  token: string;
}

/** Said wherever keys would be managed without the control plane (VITE_API_URL), as Members says it. */
export const PUBLIC_API_NOT_SET_UP = "API keys need the FENVIX API, which this dashboard is not set up for (VITE_API_URL).";

/** The API's own limits (control-plane/src/services/apikeys.ts). */
export const NAME_MAX = 60;
export const MAX_ACTIVE_KEYS = 100;
/** The furthest page the API gives at once. */
export const PAGE_LIMIT = 100;

export const ROLE_LABELS: Record<PublicKeyRole, string> = { admin: "Admin", read_only: "Read only" };
export const ROLE_HELP: Record<PublicKeyRole, string> = {
  admin: "Can do everything an organization admin can: create and erase databases, manage users, allowlists and keys.",
  read_only: "Can read databases, users, allowlists and usage. Cannot change anything or see other keys.",
};
export const STATUS_LABELS: Record<PublicKeyStatus, string> = { active: "Active", expired: "Expired", revoked: "Revoked" };

// ---------------------------------------------------------------- expiry

export type ExpiryChoice = "never" | "30" | "90" | "365";
export const EXPIRY_OPTIONS: readonly { value: ExpiryChoice; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "30", label: "In 30 days" },
  { value: "90", label: "In 90 days" },
  { value: "365", label: "In 365 days" },
];

const DAY_MS = 86_400_000;

/** The expiresAt to send for a choice, counted from `now`; null for a key that does not expire. */
export function expiresAtFor(choice: ExpiryChoice, now: Date): string | null {
  if (choice === "never") return null;
  return new Date(now.getTime() + Number(choice) * DAY_MS).toISOString();
}

// ---------------------------------------------------------------- reading what the API sends

const str = (v: unknown) => (typeof v === "string" ? v : "");
const time = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Active, expired or revoked: revoked wins, then an expiry that has passed (by `now`), then what the API said. */
export function keyStatus(k: Pick<PublicApiKey, "revokedAt" | "expiresAt"> & { status?: PublicKeyStatus }, now: Date): PublicKeyStatus {
  if (k.revokedAt || k.status === "revoked") return "revoked";
  if ((k.expiresAt && new Date(k.expiresAt).getTime() <= now.getTime()) || k.status === "expired") return "expired";
  return "active";
}

/** One key as the API sends it (viewKey in control-plane/src/services/apikeys.ts), with every field checked. */
export function mapPublicKey(raw: unknown, now = new Date()): PublicApiKey {
  const r = (raw ?? {}) as Record<string, unknown>;
  const k = {
    id: str(r.id),
    name: str(r.name),
    role: (r.role === "admin" ? "admin" : "read_only") as PublicKeyRole,
    prefix: str(r.prefix),
    createdAt: str(r.createdAt),
    lastUsedAt: time(r.lastUsedAt),
    expiresAt: time(r.expiresAt),
    revokedAt: time(r.revokedAt),
  };
  const sent = r.status === "revoked" || r.status === "expired" || r.status === "active" ? r.status : undefined;
  return { ...k, status: keyStatus({ ...k, status: sent }, now) };
}

export function mapPublicKeyPage(raw: unknown): PublicKeyPage {
  const r = (raw ?? {}) as Record<string, unknown>;
  return { items: Array.isArray(r.items) ? r.items.map((x) => mapPublicKey(x)) : [], nextCursor: typeof r.nextCursor === "string" && r.nextCursor ? r.nextCursor : null };
}

export function mapCreatedKey(raw: unknown): CreatedPublicKey {
  const r = (raw ?? {}) as Record<string, unknown>;
  return { key: mapPublicKey(r.key), token: str(r.token) };
}

// ---------------------------------------------------------------- checks before sending, and errors

/** The API's name rule, checked here first so the person gets the message without a round trip. Null when fine. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name for the key, for example the app or job that will use it.";
  if (n.length > NAME_MAX) return `Use ${NAME_MAX} characters or fewer for the name.`;
  if (/[\u0000-\u001f\u007f]/.test(n)) return "Use one line for the name, with no special characters such as tabs.";
  return null;
}

/**
 * What to tell the person when a key call fails. The API's own messages are already plain and say how to fix the
 * problem, so they are shown as they are, except where they speak to a programmer (a header name) or where the
 * dashboard knows more than the API can say.
 */
export function keyErrorMessage(e: unknown, action: "list" | "create" | "revoke"): string {
  if (!(e instanceof ExplorerError)) return e instanceof Error && e.message ? e.message : fallback(action);
  if (e.field === "X-Fenvix-Workspace") return "Choose an organization from the menu at the top, then try again.";
  // A create whose first answer was lost: the retry with the same Idempotency-Key cannot show the key again.
  if (action === "create" && e.status === 409 && /already completed/i.test(e.message)) {
    return "The key was created, but its answer was lost on the way, and a key is never shown twice. Revoke the new key in the list and create another one.";
  }
  if (action === "create" && e.code === "network") {
    return "Could not reach FENVIX. If the new key appears in the list, revoke it and create another one, because it cannot be shown again.";
  }
  if (action === "revoke" && e.status === 404) return "That key no longer exists. Reload the page to see the current list.";
  return e.message || fallback(action);
}

const fallback = (action: "list" | "create" | "revoke") =>
  action === "list" ? "Could not load the API keys. Try again in a moment." : action === "create" ? "Could not create the key. Try again." : "Could not revoke the key. Try again.";

// ---------------------------------------------------------------- the example shown with a new key

/** The address the public API lives at, from the dashboard's API address (which includes /v1). */
export const publicApiUrl = (apiUrl: string) => `${apiUrl}/public`;
/** Where the machine-readable reference is (GET /v1/openapi.json, no key needed). */
export const openApiUrl = (apiUrl: string) => `${apiUrl}/openapi.json`;

/** A first call with the new key, read from an environment variable: the key itself is never written into it. */
export function curlExample(apiUrl: string): string {
  return [
    `export FENVIX_API=${publicApiUrl(apiUrl)}`,
    "export FENVIX_KEY=...   # paste the key from your secret store; never commit it",
    'curl -sS "$FENVIX_API/databases" -H "Authorization: Bearer $FENVIX_KEY"',
  ].join("\n");
}
