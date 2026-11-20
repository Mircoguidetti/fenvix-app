// The API's certificate is issued BEFORE CDK (deploy/cli.mjs api-certificate, P-037): CloudFormation never waits for a
// DNS record. Without a Cloudflare token the step lists the validation record, waits, and stops naming it; the next run
// finds the same certificate and goes on once the record exists. A fake ACM, no network.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apiCertificate } from "../lib/certificates.mjs";
import { Stop } from "../lib/log.mjs";

const DOMAIN = "api.fenvix.dev";
const ARN = "arn:aws:acm:eu-west-1:865859654353:certificate/12345678-1234-1234-1234-123456789012";
const RECORD = { Name: "_abc.api.fenvix.dev.", Type: "CNAME", Value: "_xyz.acm-validations.aws." };

/** ACM in memory: one region's certificates; `issueAfter` describes until it turns ISSUED (Infinity: never). */
class FakeAcm {
  constructor({ certs = [], issueAfter = Infinity, deny = false } = {}) { this.certs = certs; this.issueAfter = issueAfter; this.deny = deny; this.calls = []; this.described = 0; }
  async send(cmd) {
    const name = cmd.constructor.name, i = cmd.input;
    this.calls.push({ name, input: i });
    if (name === "ListCertificatesCommand") return { CertificateSummaryList: this.certs.filter((c) => i.CertificateStatuses.includes(c.Status)).map((c) => ({ DomainName: c.DomainName, CertificateArn: c.CertificateArn, Status: c.Status })) };
    if (name === "RequestCertificateCommand") {
      if (this.deny) { const e = new Error("User is not authorized to perform: acm:RequestCertificate"); e.name = "AccessDeniedException"; throw e; }
      this.certs.push({ DomainName: i.DomainName, CertificateArn: ARN, Status: "PENDING_VALIDATION", Tags: i.Tags });
      return { CertificateArn: ARN };
    }
    if (name === "DescribeCertificateCommand") {
      const c = this.certs.find((x) => x.CertificateArn === i.CertificateArn);
      if (c.Status === "PENDING_VALIDATION" && ++this.described > this.issueAfter) c.Status = "ISSUED";
      return { Certificate: { Status: c.Status, DomainValidationOptions: [{ ResourceRecord: RECORD }] } };
    }
    throw new Error(`unexpected ${name}`);
  }
}

const fakeCf = () => { const writes = []; return { writes, upsertCname: async (n, v) => { writes.push([n, v]); return "created"; } }; };
const opts = (o = {}) => ({ region: "eu-west-1", waitMs: 50, everyMs: 1, recordLine: (n, v) => `CNAME ${n} → ${v}`, manual: () => {}, ...o });

describe("api-certificate: the API's certificate, before CDK", () => {
  it("no token, record not added in time: STOP naming the exact validation record; nothing else requested", async () => {
    const acm = new FakeAcm();
    const listed = [];
    await assert.rejects(apiCertificate(acm, DOMAIN, opts({ cf: null, manual: (n, v) => listed.push([n, v]) })),
      (e) => e instanceof Stop && /The certificate of api\.fenvix\.dev is PENDING_VALIDATION: its DNS validation record is not in Cloudflare yet\. Nothing else was changed.*Add it: CNAME _abc\.api\.fenvix\.dev → _xyz\.acm-validations\.aws\. Then run the deploy again/.test(e.message));
    assert.deepEqual(listed, [["_abc.api.fenvix.dev", "_xyz.acm-validations.aws"]]);
    const req = acm.calls.filter((c) => c.name === "RequestCertificateCommand");
    assert.equal(req.length, 1);
    assert.deepEqual([req[0].input.DomainName, req[0].input.ValidationMethod], [DOMAIN, "DNS"]);
    assert.deepEqual(req[0].input.Tags, [{ Key: "project", Value: "fenvix" }]);
  });

  it("the next run, once the record exists: the same certificate (no second request), issued, its ARN returned", async () => {
    const acm = new FakeAcm({ certs: [{ DomainName: DOMAIN, CertificateArn: ARN, Status: "PENDING_VALIDATION" }], issueAfter: 2 });
    const d = await apiCertificate(acm, DOMAIN, opts({ cf: null }));
    assert.deepEqual([d.arn, d.status], [ARN, "ISSUED"]);
    assert.equal(acm.calls.filter((c) => c.name === "RequestCertificateCommand").length, 0);
  });

  it("with a Cloudflare token: the validation CNAME is written, then waited for; already issued: kept for renewals", async () => {
    const cf = fakeCf();
    const d = await apiCertificate(new FakeAcm({ issueAfter: 3 }), DOMAIN, opts({ cf }));
    assert.equal(d.status, "ISSUED");
    assert.deepEqual(cf.writes, [["_abc.api.fenvix.dev", "_xyz.acm-validations.aws"]]);
    const cf2 = fakeCf();
    await apiCertificate(new FakeAcm({ certs: [{ DomainName: DOMAIN, CertificateArn: ARN, Status: "ISSUED" }] }), DOMAIN, opts({ cf: cf2 }));
    assert.equal(cf2.writes.length, 1);
  });

  it("a certificate of another name is never used (the retired github.<zone> one stays out)", async () => {
    const acm = new FakeAcm({ certs: [{ DomainName: "github.fenvix.dev", CertificateArn: "arn:aws:acm:eu-west-1:865859654353:certificate/00000000-0000-0000-0000-000000000000", Status: "ISSUED" }], issueAfter: 0 });
    const d = await apiCertificate(acm, DOMAIN, opts({ cf: null }));
    assert.equal(d.arn, ARN);
  });

  it("the deploy role may not request it (fenvix-bootstrap not updated): STOP saying to update the bootstrap stack", async () => {
    await assert.rejects(apiCertificate(new FakeAcm({ deny: true }), DOMAIN, opts({ cf: null })),
      (e) => e instanceof Stop && /may not request the certificate of api\.fenvix\.dev in eu-west-1 \(AccessDeniedException\)\. The fenvix-bootstrap stack is older than this code/.test(e.message));
  });
});
