import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pg from "pg";
import { pgTls } from "../../src/db-tls.ts";

const URL_ = "postgresql://fenvix_github_app.ref:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true";
const PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----";

describe("database TLS (G-2323)", () => {
  it("without the CA: the stored string as it is (encrypted only)", () => {
    assert.deepEqual(pgTls(URL_, undefined), { connectionString: URL_ });
    assert.deepEqual(pgTls(URL_, "  "), { connectionString: URL_ });
  });

  it("with the CA: verify-full, and node-postgres keeps it (the string's sslmode no longer overrides it)", () => {
    const t = pgTls(URL_, PEM);
    assert.doesNotMatch(t.connectionString!, /sslmode|uselibpqcompat/);
    assert.deepEqual(t.ssl, { ca: PEM, rejectUnauthorized: true, servername: "aws-0-eu-west-1.pooler.supabase.com" });
    const c = new pg.Client(t) as unknown as { connectionParameters: { ssl: unknown; user: string; host: string } };
    assert.deepEqual(c.connectionParameters.ssl, t.ssl);
    assert.equal(c.connectionParameters.user, "fenvix_github_app.ref");
    // The control: with the original string, node-postgres turns certificate checks off whatever `ssl` says.
    const raw = new pg.Client({ connectionString: URL_, ssl: t.ssl }) as unknown as { connectionParameters: { ssl: { rejectUnauthorized?: boolean } } };
    assert.equal(raw.connectionParameters.ssl.rejectUnauthorized, false);
  });

  it("anything but a PEM certificate is refused", () => {
    assert.throws(() => pgTls(URL_, "not a cert"), /PEM/);
  });
});
