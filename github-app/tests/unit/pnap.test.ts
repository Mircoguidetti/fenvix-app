import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { HttpPnapApi, NoCapacity, PnapError } from "../../src/pnap/api.ts";
import { HOST_BUNDLE_SHA256, HOST_BUNDLE_TGZ_BASE64 } from "../../src/pnap/host-bundle.generated.ts";
import { enrolHostId, newEnrolSecret, sha256, signHostCredential, verifyHostCredential } from "../../src/pnap/hostcred.ts";
import { minutesIntoHour, planRegion, type HostView, type RegionView } from "../../src/pnap/scaler.ts";
import { loadPnapSettings, slotsFor, type PnapSettings } from "../../src/pnap/settings.ts";
import { hostBundleOk, userData } from "../../src/pnap/userdata.ts";
import { FakePnap } from "../helpers/fake-pnap.ts";

const FC_SHA = "a".repeat(64);
export const ENV = { PNAP_REGIONS: "ASH:0:3,NLD:1:2", PNAP_CONTROL_URL: "https://github.fenvix.dev", PNAP_FIRECRACKER_SHA256: FC_SHA, FENVIX_ENV: "test" };
const S: PnapSettings = loadPnapSettings(ENV);
const T0 = new Date("2026-11-18T10:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function host(id: string, o: Partial<HostView> = {}): HostView {
  return { hostId: id, role: "runner", state: "ready", running: 0, leased: 0, orderedAt: at(-120), provisionedAt: at(-110), enrolledAt: at(-100),
    lastSeenAt: at(0), lastJobAt: null, drainRequestedAt: null, detail: null, ...o };
}
const view = (o: Partial<RegionView> = {}): RegionView => ({ region: "ASH", min: 0, max: 3, hold: 0, demand: 0, hosts: [], lastNoCapacityAt: null, ...o });
const kinds = (a: { kind: string }[]) => a.map((x) => x.kind);

describe("phoenixNAP settings", () => {
  it("d3.c1.large holds 15 microVMs of 2 vCPUs / 8 GiB: one vCPU per physical core, SMT off (R-014 R2), no memory overcommit", () => {
    assert.equal(slotsFor("d3.c1.large", 2, 8192), 15, "core-bound: (32 cores - 2 for the host) / 2");
    assert.equal(slotsFor("d3.c1.large", 4, 16384), 7, "core-bound: 30 / 4");
    assert.equal(slotsFor("d3.c1.large", 1, 16384), 14, "memory-bound: (256 GiB - 16 GiB) / (16 GiB + 512 MiB)");
    assert.equal(S.slotsPerHost, 15);
    assert.throws(() => loadPnapSettings({ ...ENV, PNAP_SLOTS_PER_HOST: "28" }), /PNAP_SLOTS_PER_HOST must be an integer from 1 to 15/,
      "an explicit slot count never puts two tenants' vCPUs on one core");
    assert.deepEqual(S.regions, { ASH: { min: 0, max: 3 }, NLD: { min: 1, max: 2 } });
    assert.equal(S.serverType, "d3.c1.large");
    assert.equal(S.os, "ubuntu/noble");
    assert.equal(S.pricingModel, "HOURLY");
  });

  it("refuses what would be wrong or unsafe", () => {
    for (const [k, v] of [["PNAP_REGIONS", "FRA:0:1"], ["PNAP_REGIONS", "ASH:3:1"], ["PNAP_REGIONS", ""], ["PNAP_CONTROL_URL", "http://example.com"],
      ["PNAP_FIRECRACKER_SHA256", ""], ["PNAP_DEFAULT_REGION", "PHX"], ["PNAP_GUEST_KERNEL_URL", "https://x/$(id)"], ["PNAP_SSH_KEY_IDS", "a;b"],
      ["PNAP_CACHE_MODE", "shared"], ["PNAP_VM_VCPUS", "0"]] as const) {
      assert.throws(() => loadPnapSettings({ ...ENV, [k]: v }), Error, `${k}=${v}`);
    }
  });
});

describe("the scaler's plan for one region", () => {
  it("orders ceil(demand / slots) hosts, within max, the global cap and the per-run limit", () => {
    assert.deepEqual(kinds(planRegion(view({ demand: 1 }), S, T0, 0)), ["order"]);
    assert.deepEqual(kinds(planRegion(view({ demand: 29 }), S, T0, 0)), ["order", "order"]);
    assert.deepEqual(kinds(planRegion(view({ demand: 500 }), S, T0, 0)), ["order", "order"], "maxOrdersPerRun 2");
    assert.deepEqual(kinds(planRegion(view({ demand: 500, hosts: [host("a"), host("b")] }), S, T0, 2)), ["order"], "max 3");
    assert.deepEqual(kinds(planRegion(view({ demand: 500 }), S, T0, 9)), ["order"], "maxHostsTotal 10");
    assert.deepEqual(planRegion(view({ demand: 500 }), S, T0, 10), []);
    const a = planRegion(view({ demand: 1 }), S, T0, 0)[0]!;
    assert.deepEqual(a, { kind: "order", region: "ASH", role: "runner" });
  });

  it("counts hosts still being installed as capacity (no double order)", () => {
    assert.deepEqual(planRegion(view({ demand: 5, hosts: [host("p", { state: "provisioning", enrolledAt: null })] }), S, T0, 1), []);
    assert.deepEqual(planRegion(view({ demand: 5, hosts: [host("o", { state: "ordering" })] }), S, T0, 1), []);
  });

  it("keeps min and a hold as a floor, with no demand", () => {
    assert.deepEqual(kinds(planRegion(view({ min: 1 }), S, T0, 0)), ["order"]);
    assert.deepEqual(kinds(planRegion(view({ hold: 1 }), S, T0, 0)), ["order"]);
    assert.deepEqual(planRegion(view({ hold: 1, hosts: [host("a", { lastJobAt: at(-500), provisionedAt: at(-55) })] }), S, T0, 1), []);
  });

  it("no order for a while after phoenixNAP had no capacity in the region", () => {
    assert.deepEqual(planRegion(view({ demand: 3, lastNoCapacityAt: at(-5) }), S, T0, 0), []);
    assert.deepEqual(kinds(planRegion(view({ demand: 3, lastNoCapacityAt: at(-20) }), S, T0, 0)), ["order"]);
  });

  it("takes a draining host back before ordering a new one", () => {
    const d = host("d", { state: "draining", drainRequestedAt: at(-2), running: 1 });
    assert.deepEqual(planRegion(view({ demand: 3, hosts: [d] }), S, T0, 0), [{ kind: "undrain", hostId: "d" }]);
  });

  it("drains an idle host only after idleMinutes and, billed by the hour, only near the end of the hour paid for", () => {
    // provisioned 105 min ago: 45 min into its hour; release window 10 min -> not yet
    const idle = host("i", { lastJobAt: at(-30), provisionedAt: at(-105) });
    assert.deepEqual(planRegion(view({ hosts: [idle] }), S, T0, 1), []);
    const late = host("i", { lastJobAt: at(-30), provisionedAt: at(-115) });
    assert.deepEqual(planRegion(view({ hosts: [late] }), S, T0, 1), [{ kind: "drain", hostId: "i", why: "idle 20+ min" }]);
    const recent = host("i", { lastJobAt: at(-10), provisionedAt: at(-115) });
    assert.deepEqual(planRegion(view({ hosts: [recent] }), S, T0, 1), [], "idle only 10 min");
    const s2 = { ...S, hourAware: false };
    assert.deepEqual(kinds(planRegion(view({ hosts: [idle] }), s2, T0, 1)), ["drain"], "without hour awareness: after idleMinutes");
    assert.equal(Math.round(minutesIntoHour(at(-115), T0)), 55);
  });

  it("never drains a busy host, and keeps the floor", () => {
    assert.deepEqual(planRegion(view({ hosts: [host("b", { running: 3, provisionedAt: at(-115), lastJobAt: at(-60) })] }), S, T0, 1), []);
    assert.deepEqual(planRegion(view({ hosts: [host("b", { leased: 1, provisionedAt: at(-115), lastJobAt: at(-60) })] }), S, T0, 1), []);
    assert.deepEqual(planRegion(view({ min: 1, hosts: [host("m", { provisionedAt: at(-115), lastJobAt: at(-60) })] }), S, T0, 1), []);
  });

  it("releases a drained host, and in dedicated cache mode orders the region's cache server once", () => {
    const d = host("d", { state: "draining", drainRequestedAt: at(-2) });
    assert.deepEqual(planRegion(view({ hosts: [d] }), S, T0, 0), [{ kind: "release", hostId: "d", why: "drained" }]);
    const ded = { ...S, cacheMode: "dedicated" as const };
    assert.deepEqual(planRegion(view({ demand: 1 }), ded, T0, 0).map((a) => a.kind === "order" ? a.role : a.kind), ["runner", "cache"]);
    const withCache = view({ demand: 1, hosts: [host("c", { role: "cache" })] });
    assert.deepEqual(planRegion(withCache, ded, T0, 0).map((a) => a.kind === "order" ? a.role : a.kind), ["runner"]);
  });
});

describe("host credentials", () => {
  const KEY = "host-signing-key-for-tests-0123456789abcdef";
  it("enrolment secrets: single host, stored as a hash", () => {
    const e = newEnrolSecret("fx-test-ash-h1a2b3c");
    assert.match(e.token, /^fxe1\.fx-test-ash-h1a2b3c\.[A-Za-z0-9_-]{43}$/);
    assert.equal(e.sha256, sha256(e.token));
    assert.deepEqual(enrolHostId(`Bearer ${e.token}`), { hostId: "fx-test-ash-h1a2b3c", sha256: e.sha256 });
    assert.equal(enrolHostId(`Bearer fxe1.x.short`), null);
    assert.equal(enrolHostId(undefined), null);
  });

  it("a host credential names its host and region, expires, and does not survive tampering or another key", () => {
    const now = Date.now();
    const c = signHostCredential(KEY, { hostId: "fx-test-ash-h1", region: "ASH", gen: 1, exp: Math.floor(now / 1000) + 60 });
    assert.deepEqual({ ...verifyHostCredential([KEY], `Bearer ${c}`, now)!, exp: 0 }, { hostId: "fx-test-ash-h1", region: "ASH", gen: 1, exp: 0 });
    assert.equal(verifyHostCredential(["another-key-for-tests-0123456789abcdef"], `Bearer ${c}`, now), null);
    assert.equal(verifyHostCredential([KEY], `Bearer ${c}`, now + 61_000), null);
    const [, body, sig] = c.split(".");
    const forged = Buffer.from(JSON.stringify({ h: "fx-test-ash-h1", r: "NLD", g: 1, e: Math.floor(now / 1000) + 60 })).toString("base64url");
    assert.equal(verifyHostCredential([KEY], `Bearer fxh1.${forged}.${sig}`, now), null, "another region with the old signature");
    assert.ok(body);
    assert.ok(verifyHostCredential(["old-or-unset", KEY], `Bearer ${c}`, now), "during a rotation: previous key too");
  });
});

describe("cloud-init user data and the host bundle", () => {
  const e = newEnrolSecret("fx-test-ash-h1a2b3c");

  it("carries the bundle (checked by SHA-256 on the server), the pins, the App's URL and the single-use enrolment secret; nothing else secret", () => {
    const ud = userData(S, { hostId: "fx-test-ash-h1a2b3c", role: "runner", region: "ASH", enrolToken: e.token });
    assert.ok(hostBundleOk());
    assert.ok(ud.startsWith("#!/bin/bash\n"));
    assert.ok(ud.includes(`echo '${HOST_BUNDLE_SHA256}  /var/tmp/fenvix-host.tgz' | sha256sum -c --quiet -`));
    assert.ok(ud.includes(`printf '%s' '${e.token}' >/etc/fenvix/enrol`));
    assert.ok(ud.includes(`export FIRECRACKER_SHA256='${FC_SHA}'`));
    assert.ok(ud.includes("export GUEST_KERNEL_SHA256='e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2'"));
    assert.ok(ud.includes("bash /opt/fenvix-host/install-host.sh"));
    assert.doesNotMatch(ud, /fxh1\.|fxr1\.|fxs1\.|BEGIN [A-Z ]*PRIVATE KEY/);
    assert.ok(Buffer.byteLength(ud) < 200 * 1024, `user data ${Buffer.byteLength(ud)} bytes`);
    execFileSync("bash", ["-n"], { input: ud });
  });

  it("refuses a value that could break out of the script", () => {
    assert.throws(() => userData({ ...S, pins: { ...S.pins, guestImageUrl: "https://x/'$(reboot)'" } }, { hostId: "fx-test-ash-h1", role: "runner", region: "ASH", enrolToken: e.token }));
    assert.throws(() => userData(S, { hostId: "fx-test-ash-h1", role: "runner", region: "ASH", enrolToken: "fxe1.x.'; reboot; '" }));
  });

  it("the bundle unpacks to the host package, the guest build and the cache service, and is up to date", () => {
    const tar = gunzipSync(Buffer.from(HOST_BUNDLE_TGZ_BASE64, "base64"));
    assert.equal(createHash("sha256").update(Buffer.from(HOST_BUNDLE_TGZ_BASE64, "base64")).digest("hex"), HOST_BUNDLE_SHA256);
    const names: string[] = [];
    for (let off = 0; off + 512 <= tar.length;) {
      const name = tar.subarray(off, off + 100).toString("utf8").replace(/\0.*$/s, "");
      if (!name) break;
      const size = parseInt(tar.subarray(off + 124, off + 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
      if (!name.startsWith("PaxHeader") && !name.includes("/PaxHeaders")) names.push(name);
      off += 512 + Math.ceil(size / 512) * 512;
    }
    for (const f of ["install-host.sh", "fenvix_host/agent.py", "fenvix_host/netplan.py", "guest/build-guest.sh", "cache/fenvix_cache_auth.py", "systemd/fenvix-agent.service"]) {
      assert.ok(names.includes(f), `${f} in the bundle (${names.join(", ")})`);
    }
    execFileSync("python3", ["-I", fileURLToPath(new URL("../../../infra/customer-mode/pnap/bundle.py", import.meta.url)), "--check"]);
  });
});

describe("the phoenixNAP API client against a fake built from phoenixNAP's OpenAPI descriptions", () => {
  const fake = new FakePnap();
  let api: HttpPnapApi;
  before(async () => {
    await fake.start();
    api = new HttpPnapApi({ clientId: fake.clientId, clientSecret: fake.clientSecret, bmcUrl: `${fake.url}/bmc/v1`, billingUrl: `${fake.url}/billing/v1`,
      tokenUrl: `${fake.url}/auth/realms/BMC/protocol/openid-connect/token` });
  });
  after(() => fake.stop());

  it("orders, reads, lists and releases a server; every request and response matches the schemas", async () => {
    const s = await api.createServer({ hostname: "fx-test-ash-h1", os: "ubuntu/noble", type: "d3.c1.large", location: "ASH", pricingModel: "HOURLY",
      networkType: "PUBLIC_AND_PRIVATE", installDefaultSshKeys: true, osConfiguration: { cloudInit: { userData: Buffer.from("#!/bin/bash\n").toString("base64") } } });
    assert.equal(s.status, "creating");
    fake.tick(); fake.tick();
    const up = (await api.getServer(s.id))!;
    assert.equal(up.status, "powered-on");
    assert.match(up.privateIpAddresses[0]!, /^10\./);
    assert.deepEqual((await api.listServers("ASH")).map((x) => x.id), [s.id]);
    assert.deepEqual(await api.listServers("NLD"), []);
    await api.deprovision(s.id);
    await api.deprovision(s.id); // already deleting: fine
    fake.tick();
    assert.equal(await api.getServer(s.id), null);
    await api.deprovision(s.id); // gone: fine
    assert.deepEqual(fake.problems, []);
    assert.equal(fake.tokensIssued, 1, "one token, reused");
  });

  it("406 is NoCapacity; an expired token is renewed once; a bad body is a 400 with the schema's reason", async () => {
    fake.capacity.set("d3.c1.large@SEA", 0);
    await assert.rejects(api.createServer({ hostname: "fx-test-sea-h1", os: "ubuntu/noble", type: "d3.c1.large", location: "SEA" }), NoCapacity);
    fake.expireTokens();
    assert.ok(Array.isArray(await api.listServers()));
    assert.equal(fake.tokensIssued, 2);
    await assert.rejects(api.createServer({ hostname: "not_a_valid_hostname!", os: "ubuntu/noble", type: "d3.c1.large", location: "ASH" }),
      (e: Error) => e instanceof PnapError && e.status === 400 && /pattern/.test(e.message));
    assert.equal((await api.availability("d3.c1.large", "SEA", 1))?.availableQuantity, 0);
    assert.equal((await api.availability("d3.c1.large", "ASH", 1))?.minQuantityAvailable, true);
  });

  it("wrong client credentials: a clear error without the secret", async () => {
    const bad = new HttpPnapApi({ clientId: "x", clientSecret: "the-wrong-secret", bmcUrl: `${fake.url}/bmc/v1`, tokenUrl: `${fake.url}/auth/realms/BMC/protocol/openid-connect/token` });
    await assert.rejects(bad.listServers(), (e: Error) => /token request refused \(401\)/.test(e.message) && !e.message.includes("the-wrong-secret"));
  });
});

describe("what each phoenixNAP function reads from SSM (least privilege)", async () => {
  const { parameterNames } = await import("../../src/lambda/secrets.ts");
  const { hostsApp, scalerDeps } = await import("../../src/lambda/runtime.ts");
  const { GetParametersCommand } = await import("@aws-sdk/client-ssm");
  const { generateKeyPairSync } = await import("node:crypto");
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const values: Record<string, string> = {
    "/fx/database-url": "postgresql://u:p@127.0.0.1:1/x", "/fx/private-key": pem, "/fx/runner-token": "r".repeat(40),
    "/fx/host-signing-key": "h".repeat(40), "/fenvix/test/cache/signing-key": pem, "/fenvix/test/pnap/client-id": "id", "/fenvix/test/pnap/client-secret": "secret",
  };
  const fakeSsm = () => {
    const asked: string[] = [];
    return { asked, send: async (c: InstanceType<typeof GetParametersCommand>) => {
      const names = c.input.Names ?? [];
      asked.push(...names);
      return { Parameters: names.filter((n) => n in values).map((Name) => ({ Name, Value: values[Name] })) };
    } };
  };

  it("hosts: the database, the App key, RUNNER_TOKEN, the host and cache signing keys; never the webhook, OAuth or state secrets", async () => {
    assert.deepEqual(parameterNames("/fx", "hosts"), ["/fx/database-url", "/fx/private-key", "/fx/runner-token", "/fx/host-signing-key", "/fx/host-signing-key-previous"]);
    for (const s of ["all", "worker", "launcher"] as const) assert.ok(!parameterNames("/fx", s).some((n) => n.includes("host-signing")), s);
  });

  it("scaler: the database URL and the phoenixNAP API client only (no GitHub secret)", async () => {
    const ssm = fakeSsm();
    const d = await scalerDeps({ ...ENV, SSM_PREFIX: "/fx", PNAP_CLIENT_ID_PARAM: "/fenvix/test/pnap/client-id", PNAP_CLIENT_SECRET_PARAM: "/fenvix/test/pnap/client-secret" }, ssm);
    assert.deepEqual(ssm.asked.sort(), ["/fenvix/test/pnap/client-id", "/fenvix/test/pnap/client-secret", "/fx/database-url"]);
    await d.close();
  });

  it("the hosts app starts with its secrets and refuses to start without the host signing key", async () => {
    const env = { ...ENV, SSM_PREFIX: "/fx", GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "fenvix", GITHUB_CLIENT_ID: "Iv1.x", DASHBOARD_URL: "https://app.fenvix.test",
      SUPABASE_URL: "https://p.supabase.invalid", CACHE_SIGNING_KEY_PARAM: "/fenvix/test/cache/signing-key", LOG_LEVEL: "silent" };
    const a = await hostsApp(env, fakeSsm() as never);
    const r = await a.fastify.inject({ method: "POST", url: "/v1/hosts/lease", payload: {} });
    assert.equal(r.statusCode, 401);
    await a.close();
    delete values["/fx/host-signing-key"];
    await assert.rejects(hostsApp({ ...env }, fakeSsm() as never), /host-signing-key/);
  });
});
