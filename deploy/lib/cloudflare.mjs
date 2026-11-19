// DNS on Cloudflare (zone fenvix.dev) with the API token the founder put in SSM (/fenvix/prod/bootstrap/cloudflare-api-token) (permissions:
// Zone · Zone · Read and Zone · DNS · Edit, on that zone only). The pipeline only ever touches the exact names it owns:
// github.<zone> and console.<zone> (CNAMEs to AWS) and the two certificate validation CNAMEs. Every record "DNS only":
// AWS serves its own certificates. It never deletes any other record.
import { info } from "./log.mjs";

const API = "https://api.cloudflare.com/client/v4";

export class Cloudflare {
  /** @param {{ token: string, zone: string, zoneId?: string, fetch?: typeof fetch }} o */
  constructor(o) {
    this.token = o.token; this.zone = o.zone; this.zoneId = o.zoneId || null; this.fetch = o.fetch ?? globalThis.fetch;
  }

  async call(method, path, body) {
    const r = await this.fetch(`${API}${path}`, {
      method, headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let j;
    try { j = await r.json(); } catch { j = null; }
    if (!r.ok || !j?.success) {
      const errs = (j?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
      throw new Error(`Cloudflare ${method} ${path.replace(/\?.*$/, "")}: HTTP ${r.status}${errs ? ` (${errs})` : ""}. The token needs Zone · Zone · Read and Zone · DNS · Edit on ${this.zone}.`);
    }
    return j.result;
  }

  async zoneIdOf() {
    if (!this.zoneId) {
      const zones = await this.call("GET", `/zones?name=${encodeURIComponent(this.zone)}`);
      if (!zones?.length) throw new Error(`Cloudflare: the token sees no zone ${this.zone} (give it Zone · Zone · Read on ${this.zone}, or set the variable CLOUDFLARE_ZONE_ID)`);
      this.zoneId = zones[0].id;
    }
    return this.zoneId;
  }

  /**
   * One CNAME at exactly `name` (a full name inside the zone), pointing at `target`, DNS only. A record already there
   * with the same target is kept; a CNAME with another target is updated; A/AAAA records at that exact name (a CNAME
   * cannot sit beside them) are replaced. Returns "kept", "updated" or "created".
   */
  async upsertCname(name, target) {
    const fqdn = name.replace(/\.$/, "").toLowerCase();
    const content = target.replace(/\.$/, "").toLowerCase();
    if (fqdn !== this.zone && !fqdn.endsWith(`.${this.zone}`)) throw new Error(`${fqdn} is not in the zone ${this.zone}`);
    const zid = await this.zoneIdOf();
    const existing = (await this.call("GET", `/zones/${zid}/dns_records?name=${encodeURIComponent(fqdn)}&per_page=100`)).filter((r) => r.name.toLowerCase() === fqdn);
    const record = { type: "CNAME", name: fqdn, content, proxied: false, ttl: 1, comment: "fenvix deploy pipeline (.github/workflows/deploy.yml)" };
    const cname = existing.find((r) => r.type === "CNAME");
    const others = existing.filter((r) => r.type === "A" || r.type === "AAAA");
    for (const r of others) {
      await this.call("DELETE", `/zones/${zid}/dns_records/${r.id}`);
      info(`DNS ${fqdn}: removed the ${r.type} record ${r.content} (a CNAME replaces it)`);
    }
    if (cname && cname.content.toLowerCase() === content && cname.proxied === false) { info(`DNS ${fqdn} → ${content}: present`); return "kept"; }
    if (cname) {
      await this.call("PUT", `/zones/${zid}/dns_records/${cname.id}`, record);
      info(`DNS ${fqdn} → ${content}: updated (was ${cname.content}${cname.proxied ? ", proxied" : ""})`);
      return "updated";
    }
    await this.call("POST", `/zones/${zid}/dns_records`, record);
    info(`DNS ${fqdn} → ${content}: created`);
    return "created";
  }
}
