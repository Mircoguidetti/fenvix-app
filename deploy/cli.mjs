#!/usr/bin/env node
// The deploy pipeline's own steps (.github/workflows/deploy.yml). One subcommand per step:
//   preflight              checks the one-time setup (the founder's SSM parameters; the anon key is public), exports
//                          SUPABASE_URL, VITE_SUPABASE_ANON_KEY (public) and FENVIX_CLOUDFLARE_MANAGED (true/false)
//   migrate                database migrations (the Supabase admin connection string)
//   db-roles               passwords of fenvix_github_app and fenvix_api, their connection strings in SSM
//   secrets                generated secrets in SSM; exports FENVIX_CACHE_SIGNING_PUBLIC_KEY (public)
//   github-app             the GitHub App's values (SSM, typed by the founder): checked; exports the public ones
//   dashboard-certificate  the us-east-1 certificate of the dashboard's host; exports its ARN once issued (only with
//                          FENVIX_DASHBOARD_ON_AWS=true; otherwise it does nothing)
//   api-certificate        the API host's certificate (cdk.json domainName, the stack's region), requested and validated
//                          BEFORE CDK; exports FENVIX_API_CERTIFICATE_ARN once issued. Without a Cloudflare token it
//                          prints the validation record, waits for it, and stops with that record if it is not there
//   recover-failed-creates before CDK: deletes a stack left in ROLLBACK_COMPLETE by a failed first create, and the
//                          dashboard bucket it left behind if no stack holds it and it is empty (lib/recover.mjs)
//   dns                    api.<zone> → AWS (Cloudflare), from the stacks' outputs; removes the retired github.<zone>
//                          CNAME to API Gateway; console.<zone> → CloudFront only with FENVIX_DASHBOARD_ON_AWS=true
//                          (otherwise it is Vercel's record, never touched here). Without a Cloudflare token it prints
//                          the record, waits for it in public DNS, and stops with that record if it is not there
//   smoke                  checks the deployed hosts answer
// Nothing secret is printed by any of them. Exit code 1 with a "STOP:" line names what to do.
//
// The founder's values (the Supabase admin connection string, the Cloudflare token, the anon key, the GitHub App's
// values) are read by each step that needs them, straight from SSM Parameter Store (/fenvix/<env>/bootstrap/*,
// lib/bootstrap.mjs), and masked in the log before any use. GitHub holds no secret: the workflow passes none.
import { readFileSync } from "node:fs";
import { ACMClient } from "@aws-sdk/client-acm";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import pg from "pg";
import { apiCertificate, ensureCertificate, waitIssued } from "./lib/certificates.mjs";
import { Cloudflare } from "./lib/cloudflare.mjs";
import { cnameOf, waitForCname } from "./lib/dns-check.mjs";
import { syncGitHubApp } from "./lib/github-app.mjs";
import { readFounderValue } from "./lib/bootstrap.mjs";
import { exportEnv, info, mask, notice, Stop, summary, warning } from "./lib/log.mjs";
import { migrate, readMigrations } from "./lib/migrate.mjs";
import { recoverFailedCreates } from "./lib/recover.mjs";
import { ensureRoles } from "./lib/roles.mjs";
import { ensureGenerated } from "./lib/secrets.mjs";
import { adminClientConfig, checkAnonKey, parseAdminUrl, parseCaCert } from "./lib/supabase.mjs";

const CDK = JSON.parse(readFileSync(new URL("../infra/github-app/cdk.json", import.meta.url), "utf8")).context;
const ENV = process.env.FENVIX_ENV || CDK.env;
const REGION = CDK.region;
const ZONE = process.env.FENVIX_DNS_ZONE || "fenvix.dev";
/** The API's host: cdk.json domainName, the one source of truth (infra/github-app/lib/settings.ts). */
const API_DOMAIN = CDK.domainName;
/**
 * Names the API answered on before; the dns step removes their CNAME while it still points at API Gateway (so nothing
 * dangles), and leaves them alone otherwise. github.<zone> until 2026-11-20 (P-037); prod only: a staging deploy
 * (FENVIX_ENV, its own domainName) never touches it.
 */
const RETIRED_API_DOMAINS = ENV === "prod" ? [`github.${ZONE}`].filter((d) => d !== API_DOMAIN) : []; // prod's old name only
const API_GATEWAY_TARGET = /\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/;
const APP_DOMAIN = CDK.dashboardDomain;
const local = process.env.FENVIX_DEPLOY_LOCAL_DB === "1";
/**
 * The AWS dashboard switch (deploy.yml: the repository variable FENVIX_DASHBOARD_ON_AWS; the CDK setting
 * dashboardOnAws). Off (the default) the dashboard is on Vercel (docs/DEPLOY-VERCEL.md): no step here requests its
 * certificate or writes console.<zone> in Cloudflare (the founder points it at Vercel).
 */
const DASHBOARD_ON_AWS = process.env.FENVIX_DASHBOARD_ON_AWS === "true";

const args = process.argv.slice(3);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };

let ssmClient;
const ssm = () => (ssmClient ??= new SSMClient({ region: REGION }));
/** One founder value (SSM /fenvix/<env>/bootstrap/..., or the same-named environment variable outside the workflow). */
const founder = (key) => readFounderValue(ssm(), key, { env: ENV });

/** Cloudflare with the founder's token, read from SSM by this step itself; null when there is none. */
async function cloudflare() {
  const token = await founder("cloudflareToken");
  return token ? new Cloudflare({ token, zone: ZONE, zoneId: process.env.CLOUDFLARE_ZONE_ID }) : null;
}

/** Whether the Cloudflare token is set, as preflight exported it for the steps that never read the token. */
const cloudflareManaged = () => process.env.FENVIX_CLOUDFLARE_MANAGED === "true";

async function admin() {
  const a = parseAdminUrl(await founder("dbUrl"), { local });
  mask(a.password);
  const ca = parseCaCert(await founder("caCert"));
  const client = new pg.Client(adminClientConfig(a, { ca }));
  try { await client.connect(); } catch (e) {
    const code = /** @type {{ code?: string }} */ (e).code;
    if (ca && /certificate|self[- ]signed|altnames|UNABLE_TO|CERT_/i.test(`${code ?? ""} ${/** @type {Error} */ (e).message}`)) throw new Stop(`The Supabase pooler's TLS certificate did not verify against SUPABASE_CA_CERT (${code ?? /** @type {Error} */ (e).name}). Nothing was changed. Download the current certificate again (Supabase → Project Settings → Database → SSL Configuration), or delete the parameter /fenvix/${ENV}/bootstrap/supabase-ca-cert to fall back to encrypted-only TLS.`);
    if (code === "28P01" || /password authentication failed/i.test(String(e))) throw new Stop(`Supabase refused the password in the SSM parameter /fenvix/${ENV}/bootstrap/supabase-db-url (the database password: Supabase → Project Settings → Database).`);
    throw new Stop(`Could not connect to Supabase with the SSM parameter /fenvix/${ENV}/bootstrap/supabase-db-url (${code ?? /** @type {Error} */ (e).name}). Check that it is the Session pooler string.`);
  }
  return { a, client };
}

/** A DNS record the founder must add by hand (no Cloudflare token): in the run's summary and as a notice. */
let tableStarted = false;
function manualRecord(why, name, value) {
  if (!tableStarted) { summary("\n**Add these DNS records in Cloudflare** (zone `" + ZONE + "` → DNS → Records → Add record):\n\n| For | Type | Name | Target | Proxy status |\n|---|---|---|---|---|"); tableStarted = true; }
  const rel = name === ZONE ? "@" : name.replace(new RegExp(`\\.${ZONE.replace(/\./g, "\\.")}$`), "");
  summary(`| ${why} | CNAME | \`${rel}\` | \`${value}\` | DNS only |`);
  notice(`Add in Cloudflare (${ZONE} → DNS → Add record): CNAME, Name ${rel}, Target ${value}, Proxy status DNS only (${why}).`);
}

/** The record as one line for a STOP message: what to add, exactly. */
function recordLine(name, value) {
  const rel = name === ZONE ? "@" : name.replace(new RegExp(`\\.${ZONE.replace(/\./g, "\\.")}$`), "");
  return `Cloudflare → ${ZONE} → DNS → Records → Add record (or Edit the existing \`${rel}\` record): Type CNAME, Name ${rel}, Target ${value}, Proxy status DNS only (grey cloud), TTL Auto`;
}

const steps = {
  async preflight() {
    const a = parseAdminUrl(await founder("dbUrl"), { local });
    mask(a.password);
    if (a.supabaseUrl) exportEnv("SUPABASE_URL", a.supabaseUrl);
    info(`Supabase project: ${a.ref ?? "(local)"} via ${a.host}`);
    info(parseCaCert(await founder("caCert")) ? "TLS to the pooler (admin connection): verified against SUPABASE_CA_CERT (verify-full)" : "TLS to the pooler (admin connection): encrypted, certificate not verified (no supabase-ca-cert parameter; docs/DEPLOY-AWS.md, section D)");
    const anon = await founder("anonKey");
    if (!anon) warning(`SUPABASE_ANON_KEY is not set (SSM /fenvix/${ENV}/bootstrap/supabase-anon-key): the dashboard is deployed but its sign-in page says what is missing (docs/DEPLOY-AWS.md, section A step 2).`);
    else info(`SUPABASE_ANON_KEY: a public key (${checkAnonKey(anon, a.ref)}) of this project`);
    // Public (every browser gets it in the bundle) and checked above; masked all the same, so it is never printed.
    exportEnv("VITE_SUPABASE_ANON_KEY", anon);
    const managed = !!(await founder("cloudflareToken"));
    exportEnv("FENVIX_CLOUDFLARE_MANAGED", String(managed));
    info(managed ? "Cloudflare: the pipeline manages the DNS records" : `Cloudflare: no token (SSM /fenvix/${ENV}/bootstrap/cloudflare-api-token): the records to add by hand are listed in the run's summary`);
    readMigrations();
  },

  async migrate() {
    const { client } = await admin();
    try {
      const r = await migrate(client, readMigrations(), { dryRun: args.includes("--dry-run") });
      summary(`**Database:** ${r.found.length ? `recorded as already applied ${r.found[0]}–${r.found.at(-1)}; ` : ""}${r.applied.length ? `applied ${r.applied.join(", ")}` : "nothing new to apply"}.`);
    } finally { await client.end(); }
  },

  async "db-roles"() {
    const { a, client } = await admin();
    try {
      const r = await ensureRoles(client, a, ssm(), { env: ENV });
      summary(`**Database roles:** ${Object.entries(r).map(([k, v]) => `${k} ${v === "kept" ? "unchanged" : "new password (stored in SSM only)"}`).join(", ")}.`);
    } finally { await client.end(); }
  },

  async secrets() {
    const pub = await ensureGenerated(ssm(), ENV);
    exportEnv("FENVIX_CACHE_SIGNING_PUBLIC_KEY", pub);
  },

  async "github-app"() {
    const vars = { ...process.env };
    for (const [key, name] of [["appId", "FENVIX_GITHUB_APP_ID"], ["appSlug", "FENVIX_GITHUB_APP_SLUG"], ["appClientId", "FENVIX_GITHUB_APP_CLIENT_ID"]]) vars[name] = await founder(key);
    const r = await syncGitHubApp(ssm(), vars, ENV);
    exportEnv("FENVIX_CDK_GITHUB_APP_ID", r.id);
    exportEnv("FENVIX_CDK_GITHUB_APP_SLUG", r.slug);
    exportEnv("FENVIX_CDK_GITHUB_CLIENT_ID", r.clientId);
    summary(`**GitHub App:** ${r.configured ? `configured (App ${r.id}, \`${r.slug}\`)` : "not configured yet: its routes answer 503 `github_not_configured` (docs/DEPLOY-AWS.md, \"Connecting the GitHub App\")"}.`);
  },

  async "dashboard-certificate"() {
    if (!DASHBOARD_ON_AWS) { info(`FENVIX_DASHBOARD_ON_AWS is off: the dashboard is on Vercel, no certificate for ${APP_DOMAIN} is requested.`); return; }
    const acm = new ACMClient({ region: "us-east-1" });
    const cf = await cloudflare();
    let d = await ensureCertificate(acm, APP_DOMAIN);
    if (d.status !== "ISSUED" && d.record) {
      if (cf) await cf.upsertCname(d.record.name, d.record.value);
      else manualRecord(`certificate of ${APP_DOMAIN}`, d.record.name, d.record.value);
      d = await waitIssued(acm, d.arn, { timeoutMs: Number(arg("wait-minutes", "30")) * 60_000 });
    } else if (d.record && cf) {
      await cf.upsertCname(d.record.name, d.record.value); // kept for renewals
    }
    if (d.status === "ISSUED") {
      exportEnv("FENVIX_DASHBOARD_CERTIFICATE_ARN", d.arn);
      info(`certificate of ${APP_DOMAIN}: issued`);
    } else {
      warning(`The certificate of ${APP_DOMAIN} is ${d.status}: the dashboard is deployed on its cloudfront.net address this time; the next deploy adds ${APP_DOMAIN} once the certificate is issued.`);
    }
  },

  async "api-certificate"() {
    const d = await apiCertificate(new ACMClient({ region: REGION }), API_DOMAIN, {
      region: REGION, cf: await cloudflare(), waitMs: Number(arg("wait-minutes", "20")) * 60_000,
      manual: (name, value) => manualRecord(`certificate of ${API_DOMAIN}`, name, value), recordLine,
    });
    exportEnv("FENVIX_API_CERTIFICATE_ARN", d.arn);
    info(`certificate of ${API_DOMAIN}: issued (${d.arn})`);
  },

  async "recover-failed-creates"() {
    const account = CDK.account;
    const stacks = [`fenvix-${ENV}-github-app`, `fenvix-${ENV}-dashboard`];
    const r = await recoverFailedCreates(new CloudFormationClient({ region: REGION }), new S3Client({ region: REGION }), {
      stacks, dashboardStack: stacks[1], bucket: `fenvix-${ENV}-dashboard-${account}`, account,
    });
    for (const [what, done] of Object.entries(r)) info(`${what}: ${done}`);
    const acted = Object.entries(r).filter(([, d]) => d === "deleted").map(([w]) => `\`${w}\``);
    if (acted.length) summary(`**Failed first create cleared:** deleted ${acted.join(", ")} (left by an earlier deploy's rollback), so CDK creates them again.`);
  },

  async dns() {
    const outputs = JSON.parse(readFileSync(arg("outputs", "../infra/github-app/cdk-outputs.json"), "utf8"));
    const api = outputs[`fenvix-${ENV}-github-app`]?.DnsTarget;
    const dash = outputs[`fenvix-${ENV}-dashboard`]?.DashboardDnsTarget;
    const cf = await cloudflare();
    const records = [[API_DOMAIN, api, "the API"]];
    // The API's retired names: their CNAME to API Gateway goes (the custom domain behind it is deleted by this deploy).
    for (const old of RETIRED_API_DOMAINS) {
      if (cf) await cf.removeCnameTo(old, API_GATEWAY_TARGET);
      else if (API_GATEWAY_TARGET.test((await cnameOf(old).catch(() => null)) ?? "")) summary(`\n**Remove** the CNAME \`${old.replace(`.${ZONE}`, "")}\` in Cloudflare if it is still there (the API moved to \`${API_DOMAIN}\`; \`${old}\` no longer answers), and the certificate validation CNAME whose name ends in \`.${old.replace(`.${ZONE}`, "")}\`.`);
    }
    // console.<zone> only once CloudFront serves it with its certificate (else browsers would get a certificate error),
    // and never while the dashboard is on Vercel: that record is Vercel's (docs/DEPLOY-VERCEL.md).
    if (!DASHBOARD_ON_AWS) info(`${APP_DOMAIN}: the dashboard is on Vercel (FENVIX_DASHBOARD_ON_AWS is off); its DNS record is left as it is.`);
    else if (process.env.FENVIX_DASHBOARD_CERTIFICATE_ARN) records.push([APP_DOMAIN, dash, "the dashboard"]);
    else warning(`${APP_DOMAIN} is not pointed at CloudFront yet (its certificate is not issued).`);
    for (const [name, target] of records) if (!target) throw new Error(`no DNS target for ${name} in the stack outputs`);
    if (cf) { for (const [name, target] of records) await cf.upsertCname(name, target); return; }
    // No token: the founder adds them by hand. All listed first; then each waited for in public DNS; the run stops with
    // the exact records still missing.
    for (const [name, target, why] of records) manualRecord(why, name, target);
    const end = Date.now() + Number(arg("wait-minutes", "20")) * 60_000;
    const missing = [];
    for (const [name, target, why] of records) {
      info(`${name}: waiting for the CNAME to ${target} in public DNS (until ${new Date(end).toISOString()})`);
      if (await waitForCname(name, target, { timeoutMs: Math.max(0, end - Date.now()) })) info(`DNS ${name} → ${target}: present`);
      else missing.push([name, target, why]);
    }
    if (missing.length) {
      throw new Stop(`${missing.map(([n, t, w]) => `${n} is not a CNAME to ${t} yet (${w})`).join("; ")}. The stacks are deployed; only DNS is missing. Add: ${missing.map(([n, t]) => recordLine(n, t)).join("; ")}. Then run the deploy again (Actions → Deploy → Run workflow, branch main): it finds everything in place and finishes.`);
    }
  },

  async smoke() {
    const deadline = Date.now() + Number(arg("minutes", "10")) * 60_000;
    const checks = [
      { url: `https://${API_DOMAIN}/healthz`, ok: (r) => r.status === 200 },
      // The App's database answers (G-1707); before the GitHub App is configured, its own "not configured" answer.
      { url: `https://${API_DOMAIN}/readyz`, ok: async (r) => r.status === 200 || (r.status === 503 && (await r.json().catch(() => ({}))).github === "not_configured") },
      { url: `https://${API_DOMAIN}/v1/me`, ok: (r) => r.status === 401 },
    ];
    if (DASHBOARD_ON_AWS && process.env.FENVIX_DASHBOARD_CERTIFICATE_ARN) checks.push({ url: `https://${APP_DOMAIN}/`, ok: (r) => r.status === 200 });
    const strict = cloudflareManaged();
    for (const c of checks) {
      let last = "";
      for (;;) {
        try {
          const r = await fetch(c.url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
          if (await c.ok(r)) { info(`${c.url}: ${r.status} (expected)`); break; }
          last = `HTTP ${r.status}`;
        } catch (e) { last = /** @type {Error} */ (e).cause?.code ?? /** @type {Error} */ (e).message; }
        if (Date.now() > deadline) {
          const msg = `${c.url} does not answer as expected yet (${last}).`;
          if (strict) throw new Stop(`${msg} The deploy finished; look at the API's log (docs/DEPLOY-AWS.md, "When something fails").`);
          warning(`${msg} If the DNS records in the summary are not added yet, that is expected.`);
          break;
        }
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
  },
};

const name = process.argv[2];
const step = steps[name];
if (!step) { console.error(`usage: node deploy/cli.mjs <${Object.keys(steps).join("|")}>`); process.exit(2); }
step().catch((e) => {
  if (e instanceof Stop) { process.stdout.write(process.env.GITHUB_ACTIONS === "true" ? `::error::${e.message}\n` : `STOP: ${e.message}\n`); }
  else { process.stdout.write(`${process.env.GITHUB_ACTIONS === "true" ? "::error::" : "ERROR: "}${name}: ${/** @type {Error} */ (e).message}\n`); }
  process.exit(1);
});
