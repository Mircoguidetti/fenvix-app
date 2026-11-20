import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { smokeVerdict } from "../lib/smoke.mjs";

describe("the smoke check's verdict (G-2284)", () => {
  it("with the Cloudflare token every failure stops the deploy", () => {
    for (const last of ["HTTP 502", "ENOTFOUND", "ECONNREFUSED"]) assert.equal(smokeVerdict({ strict: true, last }), "stop");
  });
  it("without it, only a name that does not resolve yet is a warning; an API that answers wrong or not at all stops it", () => {
    assert.equal(smokeVerdict({ strict: false, last: "ENOTFOUND" }), "warn");
    assert.equal(smokeVerdict({ strict: false, last: "EAI_AGAIN" }), "warn");
    for (const last of ["HTTP 502", "HTTP 503", "ECONNREFUSED", "CERT_HAS_EXPIRED", "The operation was aborted due to timeout"]) assert.equal(smokeVerdict({ strict: false, last }), "stop", last);
  });
});
