// Our machines (P-047): the pieces without a database. docs/REPORT-our-machines.md.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seal, unseal } from "../../src/machines/seal.ts";
import { DEFAULT_POOL, parsePool } from "../../src/machines/settings.ts";
import { signMachineCredential, verifyMachineCredential } from "../../src/runners/credentials.ts";
import { parseWork } from "../../src/work.ts";

const KEY = "runner-token-for-tests-0123456789abcdef";

describe("our machines: settings, sealed leases, machine credentials, stop", () => {
  it("the pool's defaults are the founder's design; bad settings are refused", () => {
    assert.deepEqual({ type: DEFAULT_POOL.sizes[DEFAULT_POOL.defaultSize]!.instanceType, alwaysOn: DEFAULT_POOL.alwaysOn, reserve: DEFAULT_POOL.reserve }, { type: "c7a.xlarge", alwaysOn: 1, reserve: 2 });
    assert.throws(() => parsePool("{"), /not JSON/);
    assert.throws(() => parsePool(JSON.stringify({ alwaysOn: 9, reserve: 9, maxMachines: 4 })), /fit in maxMachines/);
    assert.throws(() => parsePool(JSON.stringify({ sizes: { s: { instanceType: "c7a.xlarge", slots: 17 } }, defaultSize: "s" })), /1 to 16/);
    assert.equal(parsePool(JSON.stringify({ reserve: 0 })).reserve, 0);
  });

  it("a lease's payload is sealed to its lease: another lease id, a changed byte or another key opens nothing", () => {
    const s = seal(KEY, 7, { jitConfig: "abc=", summaryToken: "fxr1.x.y" });
    assert.doesNotMatch(s, /abc=|fxr1/, "nothing readable at rest");
    assert.deepEqual(unseal([KEY], 7, s), { jitConfig: "abc=", summaryToken: "fxr1.x.y" });
    assert.throws(() => unseal([KEY], 8, s), /cannot be opened/);
    assert.throws(() => unseal(["another-key-0123456789abcdefghij"], 7, s), /cannot be opened/);
    const parts = s.split(".");
    parts[2] = parts[2]!.slice(0, -2) + (parts[2]!.endsWith("A") ? "BB" : "AA");
    assert.throws(() => unseal([KEY], 7, parts.join(".")), /cannot be opened/);
    assert.deepEqual(unseal(["new-key-0123456789abcdefghijklmn", KEY], 7, s), { jitConfig: "abc=", summaryToken: "fxr1.x.y" }, "the previous key still opens during a rotation");
  });

  it("a machine credential names one machine and one session; tampered, expired or of another key: refused", () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const t = signMachineCredential(KEY, { machineId: 12, gen: 3, exp });
    assert.deepEqual(verifyMachineCredential([KEY], `Bearer ${t}`), { machineId: 12, gen: 3, exp });
    assert.equal(verifyMachineCredential(["other-key-0123456789abcdefghijk"], `Bearer ${t}`), null);
    const [p, body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ m: 13, g: 3, e: exp })).toString("base64url");
    assert.equal(verifyMachineCredential([KEY], `Bearer ${p}.${forged}.${sig}`), null);
    assert.equal(verifyMachineCredential([KEY], `Bearer ${signMachineCredential(KEY, { machineId: 12, gen: 3, exp: Math.floor(Date.now() / 1000) - 1 })}`), null);
    assert.equal(verifyMachineCredential([KEY], `Bearer fxr1.${body}.${sig}`), null, "a job credential is not a machine credential");
  });

  it("stop_run work: a run id and now, first_failure or off", () => {
    const id = "0f1e2d3c-4b5a-4968-8776-655443322110";
    assert.deepEqual(parseWork({ kind: "stop_run", runId: id, when: "first_failure" }), { kind: "stop_run", runId: id, when: "first_failure" });
    assert.throws(() => parseWork({ kind: "stop_run", runId: id, when: "later" }), /not a work message/);
    assert.throws(() => parseWork({ kind: "stop_run", runId: "1; drop", when: "now" }), /not a work message/);
  });
});
