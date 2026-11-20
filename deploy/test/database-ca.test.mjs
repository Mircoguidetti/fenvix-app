import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { syncDatabaseCa } from "../lib/roles.mjs";
import { MemorySsm } from "./helpers.mjs";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----";
const NAME = "/fenvix/prod/github-app/database-ca-cert";

describe("the services' database CA (G-2323)", () => {
  it("copies the founder's CA as a public String parameter, keeps it when unchanged, removes it when the founder removed theirs", async () => {
    const ssm = new MemorySsm();
    assert.equal(await syncDatabaseCa(ssm, null), "none");
    assert.equal(await syncDatabaseCa(ssm, PEM), "set");
    assert.deepEqual([ssm.params.get(NAME).Value, ssm.params.get(NAME).Type], [PEM, "String"]);
    assert.equal(await syncDatabaseCa(ssm, PEM), "kept");
    assert.equal(await syncDatabaseCa(ssm, null), "removed");
    assert.equal(ssm.params.has(NAME), false);
  });
});
