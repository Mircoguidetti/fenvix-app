// ACM certificates. The API's (github.<zone>, eu-west-1) is part of the stack and validated while CloudFormation waits
// for it; the dashboard's (app.<zone>) must be in us-east-1 (CloudFront takes certificates from there only), so the
// pipeline requests it itself before the dashboard stack, which then uses it by ARN. Both are validated by a DNS
// CNAME, which stays in place: ACM renews through it.
import { DescribeCertificateCommand, ListCertificatesCommand, RequestCertificateCommand } from "@aws-sdk/client-acm";

export async function findCertificate(acm, domain) {
  let token;
  const found = [];
  do {
    const r = await acm.send(new ListCertificatesCommand({ CertificateStatuses: ["PENDING_VALIDATION", "ISSUED"], NextToken: token }));
    for (const c of r.CertificateSummaryList ?? []) if (c.DomainName === domain) found.push(c);
    token = r.NextToken;
  } while (token);
  // An issued one first.
  found.sort((a, b) => (a.Status === "ISSUED" ? 0 : 1) - (b.Status === "ISSUED" ? 0 : 1));
  return found[0]?.CertificateArn ?? null;
}

/** { arn, status, record: { name, type, value } | null } */
export async function describe(acm, arn) {
  const c = (await acm.send(new DescribeCertificateCommand({ CertificateArn: arn }))).Certificate ?? {};
  const rr = c.DomainValidationOptions?.[0]?.ResourceRecord;
  return { arn, status: c.Status ?? "UNKNOWN", record: rr?.Name ? { name: rr.Name.replace(/\.$/, ""), type: rr.Type, value: rr.Value.replace(/\.$/, "") } : null };
}

export async function ensureCertificate(acm, domain, tags = [{ Key: "project", Value: "fenvix" }]) {
  let arn = await findCertificate(acm, domain);
  if (!arn) {
    arn = (await acm.send(new RequestCertificateCommand({ DomainName: domain, ValidationMethod: "DNS", IdempotencyToken: domain.replace(/[^a-z0-9]/g, "").slice(0, 32), Tags: tags }))).CertificateArn;
  }
  // ACM fills in the validation record a few seconds after the request.
  for (let i = 0; i < 30; i++) {
    const d = await describe(acm, arn);
    if (d.record || d.status === "ISSUED") return d;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return describe(acm, arn);
}

export async function waitIssued(acm, arn, { timeoutMs, everyMs = 15_000 }) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const d = await describe(acm, arn);
    if (d.status === "ISSUED") return d;
    if (d.status !== "PENDING_VALIDATION") return d;
    if (Date.now() > end) return d;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
