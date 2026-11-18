// Review R-014 (docs/REVIEW-R-014.md): failing unit tests for customer mode on phoenixNAP.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadPnapSettings, SERVER_TYPES, slotsFor } from "../../src/pnap/settings.ts";
import { userData } from "../../src/pnap/userdata.ts";

const ENV = { PNAP_REGIONS: "ASH:0:1", PNAP_CONTROL_URL: "https://github.fenvix.test", PNAP_FIRECRACKER_SHA256: "f".repeat(64), FENVIX_ENV: "rv" };

describe("review R-014", () => {
  it("R2 SMT: two customers' vCPUs never share a physical core, so a host's slots are counted in cores, not hardware threads", () => {
    // Firecracker v1.18.0 docs/prod-host-setup.md, "Disable SMT": "our recommendation is to disable SMT in production
    // scenarios that require tenant separation". R-012 F16 asked for capacity by physical cores; the KVM translation
    // counts hyperthreads (64), so with SMT on, sibling threads of one core run two different tenants' vCPUs.
    const t = SERVER_TYPES["d3.c1.large"]!;
    const slots = slotsFor("d3.c1.large", 2, 8192);
    assert.ok(slots * 2 <= t.cores - 2, `${slots} slots of 2 vCPUs need ${slots * 2} cores; a d3.c1.large has ${t.cores} (2 kept for the host)`);
    assert.ok(loadPnapSettings(ENV).slotsPerHost <= 15);
  });

  it("R3 permissions: the cache service (user fenvix-cache) can reach its key under /etc/fenvix", () => {
    // The colocated cache (fenvix-cache.service, User=fenvix-cache) and the dedicated cache server both read
    // /etc/fenvix/cache/signing-key.json; the user data makes /etc/fenvix 0700 root, so the service cannot open it.
    for (const role of ["runner", "cache"] as const) {
      const ud = userData(loadPnapSettings(ENV), { hostId: "fx-rv-ash-h000001", role, region: "ASH", enrolToken: "fxe1.fx-rv-ash-h000001." + "A".repeat(43) },
        { n: "ab".repeat(256), e: 65537 });
      const m = /install -d -m (0[0-7]{3}) \/etc\/fenvix\b/.exec(ud);
      assert.ok(m, "the user data creates /etc/fenvix");
      assert.ok((parseInt(m![1]!, 8) & 0o001) !== 0, `${role}: /etc/fenvix is ${m![1]}: fenvix-cache cannot traverse it to /etc/fenvix/cache/signing-key.json`);
    }
  });
});
