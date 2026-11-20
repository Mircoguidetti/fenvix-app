// ACM certificates, requested by the pipeline itself before CDK, then used by the stacks by ARN: the API's (cdk.json
// domainName, api.<zone>, in the stack's region; apiCertificate below) and the dashboard's (console.<zone>, in us-east-1:
// CloudFront takes certificates from there only). So CloudFormation never waits for a DNS record: a missing record
// stops the pipeline step, naming it. Both are validated by a DNS CNAME, which stays in place: ACM renews through it.
import { DescribeCertificateCommand, ListCertificatesCommand, RequestCertificateCommand } from "@aws-sdk/client-acm";
import { Stop } from "./log.mjs";

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

const isAccessDenied = (e) => /AccessDenied|not authorized/i.test(`${/** @type {Error} */ (e).name} ${/** @type {Error} */ (e).message}`);

/**
 * The API's certificate, issued, before CDK: found or requested; its validation CNAME put in Cloudflare (`cf`), or
 * handed to `manual` (listed for the founder); waited for up to `waitMs`. Not issued then: Stop, naming the record
 * (`recordLine(name, value)` words it). Nothing else is changed, so the next run picks up where this one stopped.
 * @returns {Promise<{ arn: string, status: string, record: { name: string, value: string } | null }>}
 */
export async function apiCertificate(acm, domain, { region, cf, manual, recordLine, waitMs, everyMs }) {
  let d;
  try { d = await ensureCertificate(acm, domain); } catch (e) {
    if (isAccessDenied(e)) throw new Stop(`The deploy role may not request the certificate of ${domain} in ${region} (${/** @type {Error} */ (e).name}). The fenvix-bootstrap stack is older than this code: update it with infra/bootstrap/fenvix-bootstrap.json (docs/DEPLOY-AWS.md, section A, step 1, last paragraph), then run the deploy again.`);
    throw e;
  }
  if (d.status === "ISSUED") {
    if (d.record && cf) await cf.upsertCname(d.record.name, d.record.value); // kept for renewals
    return d;
  }
  if (d.status !== "PENDING_VALIDATION" || !d.record) {
    throw new Stop(`The certificate of ${domain} (${d.arn}) is ${d.status}${d.record ? "" : " and has no validation record yet"}. Look at it in ACM (${region}); if it FAILED (often CAA: if the zone has CAA records in Cloudflare, one must allow amazon.com), fix the cause, delete the certificate there and run the deploy again (a new one is requested).`);
  }
  if (cf) await cf.upsertCname(d.record.name, d.record.value);
  else manual(d.record.name, d.record.value);
  d = await waitIssued(acm, d.arn, { timeoutMs: waitMs, ...(everyMs ? { everyMs } : {}) });
  if (d.status === "ISSUED") return d;
  const rec = d.record ? recordLine(d.record.name, d.record.value) : "(see ACM)";
  throw new Stop(`The certificate of ${domain} is ${d.status}: its DNS validation record is ${cf ? "in Cloudflare but not seen by ACM yet (it can take up to 30 minutes)" : "not in Cloudflare yet"}. Nothing else was changed and the API keeps running as it is. ${cf ? "" : `Add it: ${rec}. `}Then run the deploy again (Actions → Deploy → Run workflow, branch main).`);
}
