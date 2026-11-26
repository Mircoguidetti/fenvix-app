/*
 * Side-by-side settings (SIDE_BY_SIDE_*): their checks, and the vCPUs read from the instance type's size.
 * Each test states its card: protects=...; fails_when=...; no_claim=...
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sideBySideFromEnv } from "../../src/config.ts";
import { slotsOf, vcpusOf } from "../../src/runners/sizes.ts";

describe("sideBySideFromEnv", () => {
  // protects=the console's vCPU-minutes and the fleet's slots come from the size name; an unknown size is refused
  // rather than guessed; fails_when=a size reads the wrong vCPUs or an unknown one is taken as 8; no_claim=AWS's list.
  it("vCPUs from the size; an unknown size, a bad flag or a bad price is refused", () => {
    for (const [t, v] of [["c6i.large", 2], ["c6i.xlarge", 4], ["c6i.2xlarge", 8], ["c6i.24xlarge", 96], ["m7g.medium", 1]] as const) {
      assert.equal(vcpusOf(t), v, t);
      assert.equal(sideBySideFromEnv({ SIDE_BY_SIDE_INSTANCE_TYPE: t }).vcpus, v, t);
    }
    assert.equal(vcpusOf("c6i.metal"), null);
    assert.throws(() => sideBySideFromEnv({ SIDE_BY_SIDE_INSTANCE_TYPE: "c6i.metal" }), /size/);
    assert.throws(() => sideBySideFromEnv({ SIDE_BY_SIDE_ENABLED: "yes" }), /true or false/);
    assert.throws(() => sideBySideFromEnv({ SIDE_BY_SIDE_USD_PER_HOUR: "-1" }), /price/);
    assert.throws(() => sideBySideFromEnv({ SIDE_BY_SIDE_INSTANCE_TYPE: "c6i" }), /instance type/);
    assert.deepEqual(sideBySideFromEnv({}), { enabled: true, branch: "fenvix/side-by-side", dailyCap: 10, skipDailyCap: 30, instanceType: "c6i.2xlarge", usdPerHour: 0.3648, vcpus: 8 });
  });

  // protects=a machine's slots in the fleet limit: 2 vCPU per slot, at least 1 (an unknown type counts 1);
  // fails_when=a c6i.2xlarge is 1 slot; no_claim=-.
  it("slots: c6i.large 1, c6i.2xlarge 4, unknown 1", () => {
    assert.deepEqual(["c6i.large", "c6i.2xlarge", "m7g.medium", undefined, "c6i.metal"].map((t) => slotsOf(t)), [1, 4, 1, 1, 1]);
  });
});
