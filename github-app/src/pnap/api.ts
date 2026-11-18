/**
 * phoenixNAP Bare Metal Cloud's public API, the parts the scaler uses. Schemas: the BMC API's OpenAPI description
 * (https://api.phoenixnap.com/bmc/v1, "Bare Metal Cloud API" on developers.phoenixnap.com; the same file ships as
 * bmcapi/api/openapi.yaml in phoenixNAP's go-sdk-bmc) and the Billing API's (https://api.phoenixnap.com/billing/v1).
 * The tests run this client against a fake built from those schemas (tests/helpers/fake-pnap.ts) and validate every
 * request body and every response with them.
 *
 * Authentication: OAuth 2.0 client credentials at auth.phoenixnap.com (realm BMC), scope "bmc" (orders and
 * releases need write access), with the API client the founder creates in the BMC portal. The client id and secret
 * are SSM parameters only the scaler reads.
 */

export const PNAP_LOCATIONS = ["ASH", "PHX", "CHI", "SEA", "NLD"] as const;
export type Region = (typeof PNAP_LOCATIONS)[number];
export const isRegion = (v: unknown): v is Region => typeof v === "string" && (PNAP_LOCATIONS as readonly string[]).includes(v);

/** ServerCreate (the subset we send). */
export interface ServerCreate {
  hostname: string;
  description?: string;
  os: string;
  type: string;
  location: string;
  installDefaultSshKeys?: boolean;
  sshKeyIds?: string[];
  pricingModel?: string;
  networkType?: "PUBLIC_AND_PRIVATE" | "PRIVATE_ONLY" | "PUBLIC_ONLY";
  osConfiguration?: { cloudInit?: { userData: string } };
}

/** Server (the fields we read; the API returns more). */
export interface Server {
  id: string;
  status: string;
  hostname: string;
  type: string;
  location: string;
  pricingModel: string;
  privateIpAddresses: string[];
  publicIpAddresses?: string[];
  provisionedOn?: string;
}

export interface Availability { location: string; availableQuantity: number; minQuantityAvailable: boolean }

export interface PnapApi {
  createServer(body: ServerCreate): Promise<Server>;
  /** null when phoenixNAP no longer knows the server. */
  getServer(id: string): Promise<Server | null>;
  listServers(location?: string): Promise<Server[]>;
  /** Releases the server (and its IP blocks). Already gone: not an error. */
  deprovision(id: string): Promise<void>;
  availability(productCode: string, location: string, minQuantity: number): Promise<Availability | null>;
}

/** 406 on POST /servers: "There are currently no servers available for the selected instance type". */
export class NoCapacity extends Error {}

export class PnapError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface HttpPnapOptions {
  clientId: string;
  clientSecret: string;
  bmcUrl?: string;
  billingUrl?: string;
  tokenUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export class HttpPnapApi implements PnapApi {
  private readonly o: Required<Omit<HttpPnapOptions, "fetch" | "now">> & { fetch: typeof fetch; now: () => number };
  private token: { value: string; until: number } | null = null;

  constructor(o: HttpPnapOptions) {
    if (!o.clientId || !o.clientSecret) throw new Error("the phoenixNAP API client id and secret are required");
    this.o = {
      bmcUrl: "https://api.phoenixnap.com/bmc/v1", billingUrl: "https://api.phoenixnap.com/billing/v1",
      tokenUrl: "https://auth.phoenixnap.com/auth/realms/BMC/protocol/openid-connect/token", timeoutMs: 30_000,
      ...o, fetch: o.fetch ?? fetch, now: o.now ?? Date.now,
    } as typeof this.o;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.o.now() < this.token.until) return this.token.value;
    const basic = Buffer.from(`${encodeURIComponent(this.o.clientId)}:${encodeURIComponent(this.o.clientSecret)}`).toString("base64");
    const r = await this.o.fetch(this.o.tokenUrl, {
      method: "POST", signal: AbortSignal.timeout(this.o.timeoutMs),
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    // Never the response body in an error: it could echo what we sent.
    if (!r.ok) throw new PnapError(r.status, `phoenixNAP token request refused (${r.status}): check the API client in SSM`);
    const j = await r.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof j.access_token !== "string" || !j.access_token) throw new PnapError(502, "phoenixNAP token response without access_token");
    const ttl = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : 300;
    this.token = { value: j.access_token, until: this.o.now() + Math.max(30, ttl - 60) * 1000 };
    return this.token.value;
  }

  private async call<T>(method: string, url: string, body?: unknown, allow: number[] = []): Promise<{ status: number; data: T | null }> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.o.fetch(url, {
        method, signal: AbortSignal.timeout(this.o.timeoutMs),
        headers: { authorization: `Bearer ${await this.accessToken()}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (r.status === 401 && attempt === 0) { this.token = null; continue; }  // expired early: one fresh token
      const text = await r.text();
      if (r.ok || allow.includes(r.status)) {
        let data: T | null = null;
        if (text) { try { data = JSON.parse(text) as T; } catch { data = text as unknown as T; } }
        return { status: r.status, data };
      }
      let msg = "";
      try { msg = String((JSON.parse(text) as { message?: unknown }).message ?? ""); } catch { /* not JSON */ }
      if (r.status === 406 && method === "POST") throw new NoCapacity(msg || "no server of this type available in this location");
      throw new PnapError(r.status, `phoenixNAP ${method} ${new URL(url).pathname} failed (${r.status})${msg ? `: ${msg.slice(0, 200)}` : ""}`);
    }
  }

  async createServer(body: ServerCreate): Promise<Server> {
    const r = await this.call<Server>("POST", `${this.o.bmcUrl}/servers`, body);
    if (!r.data?.id) throw new PnapError(502, "phoenixNAP accepted the order but returned no server id");
    return r.data;
  }

  async getServer(id: string): Promise<Server | null> {
    const r = await this.call<Server>("GET", `${this.o.bmcUrl}/servers/${encodeURIComponent(id)}`, undefined, [404]);
    return r.status === 404 ? null : r.data;
  }

  async listServers(location?: string): Promise<Server[]> {
    const q = location ? `?location=${encodeURIComponent(location)}` : "";
    return (await this.call<Server[]>("GET", `${this.o.bmcUrl}/servers${q}`)).data ?? [];
  }

  async deprovision(id: string): Promise<void> {
    const r = await this.call("POST", `${this.o.bmcUrl}/servers/${encodeURIComponent(id)}/actions/deprovision`, { deleteIpBlocks: true }, [404, 409]);
    if (r.status === 409) {
      // "incompatible state": fine only if it is already on its way out.
      const s = await this.getServer(id);
      if (s && s.status !== "deleting") throw new PnapError(409, `phoenixNAP refused to release ${id} (status ${s.status})`);
    }
  }

  async availability(productCode: string, location: string, minQuantity: number): Promise<Availability | null> {
    const q = new URLSearchParams({ productCategory: "SERVER", productCode, location, minQuantity: String(minQuantity) });
    const r = await this.call<{ productCode: string; locationAvailabilityDetails: Availability[] }[]>("GET", `${this.o.billingUrl}/product-availability?${q}`);
    return (r.data ?? []).find((p) => p.productCode === productCode)?.locationAvailabilityDetails.find((d) => d.location === location) ?? null;
  }
}
