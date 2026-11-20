// DNS on Cloudflare (zone fenvix.dev) with the API token the founder put in SSM (/fenvix/prod/bootstrap/cloudflare-api-token) (permissions:
// Zone · Zone · Read and Zone · DNS · Edit, on that zone only). The pipeline only ever touches the exact names it owns:
// api.<zone> and console.<zone> (CNAMEs to AWS) and the two certificate validation CNAMEs; and it removes the API's
// retired name github.<zone> only while that is still a CNAME to API Gateway (removeCnameTo). Every record "DNS only":
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
    // A CNAME cannot sit beside any other record. A/AAAA (an old address for the name) are replaced below; anything
    // else (TXT, MX, ...) is someone's data: stop and name it, never delete it.
    const blocking = existing.filter((r) => !["CNAME", "A", "AAAA"].includes(r.type));
    if (blocking.length) {
      throw new Error(`DNS ${fqdn}: ${blocking.map((r) => `${r.type} ${r.content}`).join(", ")} already ${blocking.length > 1 ? "exist" : "exists"} at this name, and a CNAME cannot sit beside ${blocking.length > 1 ? "them" : "it"}. Nothing was changed. Remove ${blocking.length > 1 ? "them" : "it"} in Cloudflare (${this.zone} → DNS → Records) if nothing uses ${blocking.length > 1 ? "them" : "it"}, then run the deploy again.`);
    }
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

  /**
   * Removes the CNAME at exactly `name` only if its target matches `target` (a retired name of ours, e.g. github.<zone>
   * once the API moved to api.<zone>: its target is an API Gateway domain that no longer exists). Any other record at
   * that name, or a CNAME pointing elsewhere, is left alone. Returns "removed", "absent" or "kept (<why>)".
   */
  async removeCnameTo(name, target) {
    const fqdn = name.replace(/\.$/, "").toLowerCase();
    if (fqdn !== this.zone && !fqdn.endsWith(`.${this.zone}`)) throw new Error(`${fqdn} is not in the zone ${this.zone}`);
    const zid = await this.zoneIdOf();
    const existing = (await this.call("GET", `/zones/${zid}/dns_records?name=${encodeURIComponent(fqdn)}&per_page=100`)).filter((r) => r.name.toLowerCase() === fqdn);
    const cname = existing.find((r) => r.type === "CNAME");
    if (!cname) { info(`DNS ${fqdn}: no CNAME (nothing to remove)`); return "absent"; }
    if (!target.test(cname.content.toLowerCase())) { info(`DNS ${fqdn} → ${cname.content}: not ours, left as it is`); return `kept (points at ${cname.content})`; }
    await this.call("DELETE", `/zones/${zid}/dns_records/${cname.id}`);
    info(`DNS ${fqdn} → ${cname.content}: removed (retired name)`);
    return "removed";
  }
}
