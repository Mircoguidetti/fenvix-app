// REPORT-deploy-pipeline-4: the founder's values come from SSM Parameter Store (/fenvix/prod/bootstrap/*), never from
// GitHub. Each is masked (::add-mask::) before any use; the deploy role may read exactly these names.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FOUNDER_VALUES, founderParameterNames, readFounderValue } from "../lib/bootstrap.mjs";
import { captured, MemorySsm } from "./helpers.mjs";

const CLI = new URL("../cli.mjs", import.meta.url).pathname;
const ROOT = new URL("../../", import.meta.url).pathname;
const REF = "abcdefghijklmnopqrst";
const PASSWORD = "Sup3r-Secret-Admin-Pw";
const DB_URL = `postgresql://postgres.${REF}:${PASSWORD}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`;
const TOKEN = "cf-token-0123456789abcdefghijklmnopqrstuvw";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (role) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", ref: REF, role, iat: 1700000000, exp: 2000000000 })}.c2lnbmF0dXJl`;
const P = (n) => `/fenvix/prod/bootstrap/${n}`;
const visible = (out) => out.split("\n").filter((l) => !l.startsWith("::add-mask::")).join("\n");

describe("the founder's values: names, and the deploy role's policy", () => {
  it("the deploy role reads exactly these names, by exact ARN, and nothing under bootstrap/ by any other statement", () => {
    const policy = JSON.parse(readFileSync(join(ROOT, "infra/github-app/deploy-policy.json"), "utf8"));
    const st = policy.Statement.find((s) => s.Sid === "ReadFounderValues");
    assert.deepEqual([st.Action].flat(), ["ssm:GetParameter"]);
    assert.deepEqual([st.Resource].flat().sort(), founderParameterNames("prod").map((n) => `arn:aws:ssm:eu-west-1:865859654353:parameter${n}`).sort());
    const others = policy.Statement.filter((s) => s !== st).flatMap((s) => [s.Resource].flat());
    assert.ok(!others.some((r) => /fenvix\/prod\/bootstrap|parameter\/fenvix\/\*|parameter\/fenvix\/prod\/\*|parameter\/\*/.test(r)), "another statement reaches the founder's values");
  });
  it("only the admin connection string and the Cloudflare token are secret (SecureString); the rest are public Strings", () => {
    assert.deepEqual(Object.values(FOUNDER_VALUES).filter((v) => v.type === "SecureString").map((v) => v.name), ["supabase-db-url", "cloudflare-api-token"]);
    assert.deepEqual(Object.values(FOUNDER_VALUES).filter((v) => v.required).map((v) => v.name), ["supabase-db-url"]);
  });
});

describe("readFounderValue", () => {
  it("reads the exact parameter, decrypted, and masks it before returning it", async () => {
    const ssm = new MemorySsm({ [P("cloudflare-api-token")]: `  ${TOKEN}\n` });
    process.env.GITHUB_ACTIONS = "true";
    try {
      const [v, out] = await captured(() => readFounderValue(ssm, "cloudflareToken", { envVars: {} }));
      assert.equal(v, TOKEN);
      assert.deepEqual(ssm.calls.map((c) => [c.name, c.input.Name, c.input.WithDecryption]), [["GetParameterCommand", P("cloudflare-api-token"), true]]);
      assert.equal(out, `::add-mask::${TOKEN}\n`, "masked (trimmed, so every occurrence is hidden), and nothing else printed");
    } finally { delete process.env.GITHUB_ACTIONS; }
  });
  it("a multi-line value (a PEM) is masked line by line", async () => {
    const pem = "-----BEGIN CERTIFICATE-----\nAAAA\nBBBB\n-----END CERTIFICATE-----";
    process.env.GITHUB_ACTIONS = "true";
    try {
      const [, out] = await captured(() => readFounderValue(new MemorySsm({ [P("supabase-ca-cert")]: pem }), "caCert", { envVars: {} }));
      for (const l of pem.split("\n")) assert.ok(out.includes(`::add-mask::${l}\n`));
    } finally { delete process.env.GITHUB_ACTIONS; }
  });
  it("missing: optional values are empty; the admin connection string stops the deploy, naming the parameter", async () => {
    assert.equal(await readFounderValue(new MemorySsm(), "anonKey", { envVars: {} }), "");
    await assert.rejects(readFounderValue(new MemorySsm(), "dbUrl", { envVars: {} }), /SSM parameter \/fenvix\/prod\/bootstrap\/supabase-db-url is missing.*SecureString/);
  });
  it("an SSM error (e.g. the role may not read it) stops, naming the parameter and the error's class only", async () => {
    const ssm = { send: async () => { const e = new Error(`denied for ${PASSWORD}`); e.name = "AccessDeniedException"; throw e; } };
    await assert.rejects(readFounderValue(ssm, "dbUrl", { envVars: {} }), (e) => /supabase-db-url \(AccessDeniedException\)/.test(e.message) && !e.message.includes(PASSWORD));
  });
  it("outside the workflow (SUPABASE_DB_URL in the environment): environment variables only, SSM never called", async () => {
    const ssm = new MemorySsm({ [P("supabase-anon-key")]: "from-ssm" });
    assert.equal(await readFounderValue(ssm, "anonKey", { envVars: { SUPABASE_DB_URL: DB_URL } }), "");
    assert.equal(await readFounderValue(ssm, "dbUrl", { envVars: { SUPABASE_DB_URL: DB_URL } }), DB_URL);
    assert.equal(ssm.calls.length, 0);
  });
});

// The CLI end to end, as the workflow runs it: no value in the environment, AWS SDK pointed at a stand-in SSM endpoint.
describe("deploy/cli.mjs preflight, reading SSM as in the workflow", () => {
  let server, port, params, requested;
  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const target = req.headers["x-amz-target"];
        const input = JSON.parse(body || "{}");
        requested.push([target, input.Name, input.WithDecryption]);
        res.setHeader("content-type", "application/x-amz-json-1.1");
        if (target === "AmazonSSM.GetParameter" && params[input.Name] !== undefined) {
          res.end(JSON.stringify({ Parameter: { Name: input.Name, Type: "SecureString", Value: params[input.Name], Version: 1 } }));
        } else {
          res.statusCode = 400;
          res.end(JSON.stringify({ __type: "ParameterNotFound", message: "not found" }));
        }
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  after(() => server?.close());

  const run = (extra = {}) => new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "fenvix-bootstrap-"));
    const files = { GITHUB_ENV: join(dir, "env"), GITHUB_STEP_SUMMARY: join(dir, "summary") };
    for (const f of Object.values(files)) writeFileSync(f, "");
    const child = spawn(process.execPath, [CLI, "preflight"], {
      env: {
        PATH: process.env.PATH, GITHUB_ACTIONS: "true", ...files,
        AWS_ENDPOINT_URL_SSM: `http://127.0.0.1:${port}`, AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "example", AWS_EC2_METADATA_DISABLED: "true",
        ...extra,
      },
    });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    child.on("close", (status) => resolve({ status, out, env: readFileSync(files.GITHUB_ENV, "utf8") }));
  });

  it("reads only the founder's names, masks each value before printing anything else, exports public values only", async () => {
    requested = [];
    params = { [P("supabase-db-url")]: DB_URL, [P("supabase-anon-key")]: jwt("anon"), [P("cloudflare-api-token")]: TOKEN };
    const r = await run();
    assert.equal(r.status, 0, r.out);
    assert.ok(requested.every(([t, n, d]) => t === "AmazonSSM.GetParameter" && founderParameterNames("prod").includes(n) && d === true), JSON.stringify(requested));
    assert.deepEqual([...new Set(requested.map((x) => x[1]))].sort(), [P("cloudflare-api-token"), P("supabase-anon-key"), P("supabase-ca-cert"), P("supabase-db-url")].sort());
    // Each value is masked before the first line that uses it.
    const lines = r.out.split("\n");
    const at = (re) => lines.findIndex((l) => !l.startsWith("::add-mask::") && re.test(l));
    for (const [v, use] of [[DB_URL, /Supabase project/], [PASSWORD, /Supabase project/], [jwt("anon"), /SUPABASE_ANON_KEY/], [TOKEN, /^Cloudflare:/]]) {
      const i = lines.indexOf(`::add-mask::${v}`);
      assert.ok(i >= 0 && i < at(use), `${v.slice(0, 12)}... masked before it is used`);
    }
    for (const v of [PASSWORD, TOKEN]) assert.ok(!visible(r.out).includes(v));
    assert.ok(!r.env.includes(PASSWORD) && !r.env.includes(TOKEN), "no secret in GITHUB_ENV");
    assert.match(r.env, new RegExp(`^SUPABASE_URL=https://${REF}\\.supabase\\.co$`, "m"));
    assert.match(r.env, /^FENVIX_CLOUDFLARE_MANAGED=true$/m);
    assert.match(r.env, /^VITE_SUPABASE_ANON_KEY=ey/m);
  });

  it("no Cloudflare token: deploys with records listed by hand; no admin connection string: STOP naming the parameter", async () => {
    params = { [P("supabase-db-url")]: DB_URL };
    let r = await run();
    assert.equal(r.status, 0, r.out);
    assert.match(r.env, /^FENVIX_CLOUDFLARE_MANAGED=false$/m);
    params = {};
    r = await run();
    assert.equal(r.status, 1);
    assert.match(r.out, /::error::The SSM parameter \/fenvix\/prod\/bootstrap\/supabase-db-url is missing/);
  });

  it("a service_role key pasted into supabase-anon-key: STOP before anything is built, never printed", async () => {
    params = { [P("supabase-db-url")]: DB_URL, [P("supabase-anon-key")]: jwt("service_role") };
    const r = await run();
    assert.equal(r.status, 1);
    assert.match(r.out, /service_role/);
    assert.ok(!visible(r.out).includes(jwt("service_role")));
    assert.ok(!r.env.includes("VITE_SUPABASE_ANON_KEY"));
  });
});
