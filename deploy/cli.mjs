#!/usr/bin/env node
// The deploy pipeline's own steps (.github/workflows/deploy.yml). One subcommand per step:
//   preflight              checks the one-time setup (names only), exports SUPABASE_URL
//   migrate                database migrations (SUPABASE_DB_URL)
//   db-roles               passwords of fenvix_github_app and fenvix_api, their connection strings in SSM
//   secrets                generated secrets in SSM; exports FENVIX_CACHE_SIGNING_PUBLIC_KEY (public)
//   github-app             the GitHub App's values (environment variables and secrets) → SSM; exports the public ones
//   dashboard-certificate  the us-east-1 certificate of the dashboard's host; exports its ARN once issued
//   watch-certificate      while the stack deploys: puts the API certificate's validation record in Cloudflare
//   dns                    github.<zone> and app.<zone> → AWS (Cloudflare), from the stacks' outputs
//   smoke                  checks the deployed hosts answer
// Nothing secret is printed by any of them. Exit code 1 with a "STOP:" line names what to do.
import { readFileSync } from "node:fs";
import { ACMClient } from "@aws-sdk/client-acm";
import { SSMClient } from "@aws-sdk/client-ssm";
import pg from "pg";
import { describe, ensureCertificate, findCertificate, waitIssued } from "./lib/certificates.mjs";
import { Cloudflare } from "./lib/cloudflare.mjs";
import { syncGitHubApp } from "./lib/github-app.mjs";
import { exportEnv, info, mask, notice, Stop, summary, warning } from "./lib/log.mjs";
import { migrate, readMigrations } from "./lib/migrate.mjs";
import { ensureRoles } from "./lib/roles.mjs";
import { ensureGenerated } from "./lib/secrets.mjs";
import { adminClientConfig, parseAdminUrl } from "./lib/supabase.mjs";

const CDK = JSON.parse(readFileSync(new URL("../infra/github-app/cdk.json", import.meta.url), "utf8")).context;
const ENV = process.env.FENVIX_ENV || CDK.env;
const REGION = CDK.region;
const API_DOMAIN = CDK.domainName;
const APP_DOMAIN = CDK.dashboardDomain;
const ZONE = process.env.FENVIX_DNS_ZONE || "fenvix.dev";
const local = process.env.FENVIX_DEPLOY_LOCAL_DB === "1";

const args = process.argv.slice(3);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };

const ssm = () => new SSMClient({ region: REGION });
const cloudflare = () => process.env.CLOUDFLARE_API_TOKEN
  ? (mask(process.env.CLOUDFLARE_API_TOKEN), new Cloudflare({ token: process.env.CLOUDFLARE_API_TOKEN, zone: ZONE, zoneId: process.env.CLOUDFLARE_ZONE_ID }))
  : null;

async function admin() {
  const a = parseAdminUrl(process.env.SUPABASE_DB_URL ?? "", { local });
  mask(a.password);
  const client = new pg.Client(adminClientConfig(a));
  try { await client.connect(); } catch (e) {
    const code = /** @type {{ code?: string }} */ (e).code;
    if (code === "28P01" || /password authentication failed/i.test(String(e))) throw new Stop("Supabase refused the password in SUPABASE_DB_URL (the database password: Supabase → Project Settings → Database).");
    throw new Stop(`Could not connect to Supabase with SUPABASE_DB_URL (${code ?? /** @type {Error} */ (e).name}). Check that it is the Session pooler string.`);
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

const steps = {
  async preflight() {
    const a = parseAdminUrl(process.env.SUPABASE_DB_URL ?? "", { local });
    mask(a.password);
    if (a.supabaseUrl) exportEnv("SUPABASE_URL", a.supabaseUrl);
    info(`Supabase project: ${a.ref ?? "(local)"} via ${a.host}`);
    if (!process.env.SUPABASE_ANON_KEY) warning("The environment variable SUPABASE_ANON_KEY is not set: the dashboard is deployed but its sign-in page says what is missing (docs/DEPLOY-AWS.md, section A step 3).");
    info(process.env.CLOUDFLARE_API_TOKEN ? "Cloudflare: the pipeline manages the DNS records" : "Cloudflare: no CLOUDFLARE_API_TOKEN: the records to add by hand are listed in the run's summary");
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
    const r = await syncGitHubApp(ssm(), process.env, ENV);
    exportEnv("FENVIX_CDK_GITHUB_APP_ID", r.id);
    exportEnv("FENVIX_CDK_GITHUB_APP_SLUG", r.slug);
    exportEnv("FENVIX_CDK_GITHUB_CLIENT_ID", r.clientId);
    summary(`**GitHub App:** ${r.configured ? `configured (App ${r.id}, \`${r.slug}\`)` : "not configured yet: its routes answer 503 `github_not_configured` (docs/DEPLOY-AWS.md, \"Connecting the GitHub App\")"}.`);
  },

  async "dashboard-certificate"() {
    const acm = new ACMClient({ region: "us-east-1" });
    const cf = cloudflare();
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

  async "watch-certificate"() {
    const domain = arg("domain", API_DOMAIN);
    const acm = new ACMClient({ region: arg("region", REGION) });
    const cf = cloudflare();
    const end = Date.now() + Number(arg("timeout-minutes", "90")) * 60_000;
    let placed = false;
    while (Date.now() < end) {
      const arn = await findCertificate(acm, domain);
      if (arn) {
        const d = await describe(acm, arn);
        if (d.record && !placed) {
          if (cf) await cf.upsertCname(d.record.name, d.record.value);
          else manualRecord(`certificate of ${domain}`, d.record.name, d.record.value);
          placed = true;
        }
        if (d.status === "ISSUED" && placed) { info(`certificate of ${domain}: issued`); return; }
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
    warning(`certificate of ${domain}: not issued within the wait`);
  },

  async dns() {
    const outputs = JSON.parse(readFileSync(arg("outputs", "../infra/github-app/cdk-outputs.json"), "utf8"));
    const api = outputs[`fenvix-${ENV}-github-app`]?.DnsTarget;
    const dash = outputs[`fenvix-${ENV}-dashboard`]?.DashboardDnsTarget;
    const cf = cloudflare();
    const records = [[API_DOMAIN, api, "the API"]];
    // app.<zone> only once CloudFront serves it with its certificate (else browsers would get a certificate error).
    if (process.env.FENVIX_DASHBOARD_CERTIFICATE_ARN) records.push([APP_DOMAIN, dash, "the dashboard"]);
    else warning(`${APP_DOMAIN} is not pointed at CloudFront yet (its certificate is not issued).`);
    for (const [name, target, why] of records) {
      if (!target) throw new Error(`no DNS target for ${name} in the stack outputs`);
      if (cf) await cf.upsertCname(name, target);
      else manualRecord(why, name, target);
    }
  },

  async smoke() {
    const deadline = Date.now() + Number(arg("minutes", "10")) * 60_000;
    const checks = [
      { url: `https://${API_DOMAIN}/healthz`, ok: (r) => r.status === 200 },
      { url: `https://${API_DOMAIN}/v1/me`, ok: (r) => r.status === 401 },
    ];
    if (process.env.FENVIX_DASHBOARD_CERTIFICATE_ARN) checks.push({ url: `https://${APP_DOMAIN}/`, ok: (r) => r.status === 200 });
    const strict = !!process.env.CLOUDFLARE_API_TOKEN;
    for (const c of checks) {
      let last = "";
      for (;;) {
        try {
          const r = await fetch(c.url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
          if (c.ok(r)) { info(`${c.url}: ${r.status} (expected)`); break; }
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
