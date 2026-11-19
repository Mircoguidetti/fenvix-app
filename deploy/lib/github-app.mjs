// The GitHub App's values, configured last (docs/DEPLOY-AWS.md, "Connecting the GitHub App"), all typed by the founder
// into SSM Parameter Store in the AWS console, none in GitHub:
//   - the three public ones (App ID, URL name, Client ID): String parameters /fenvix/<env>/bootstrap/github-app-*,
//     read by the pipeline (bootstrap.mjs) and built into the stack;
//   - the two secret ones (private key, client secret): SecureString parameters /fenvix/<env>/github-app/private-key
//     and client-secret, where the App's functions read them. The pipeline reads them only to check their shape
//     (masked first, never printed) and never copies them.
// All five present: the stack is built with the App; none: without it. Anything in between stops the deploy, naming
// what is missing (never a value). Outside the workflow (tests, local runs) the secrets may be given as environment
// variables; they are then stored in SSM (compared first).
import { createPrivateKey } from "node:crypto";
import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { info, mask, Stop, warning } from "./log.mjs";
import { bootstrapPrefix } from "./bootstrap.mjs";
import { appPrefix } from "./secrets.mjs";

export const VARIABLES = { id: "FENVIX_GITHUB_APP_ID", slug: "FENVIX_GITHUB_APP_SLUG", clientId: "FENVIX_GITHUB_APP_CLIENT_ID" };
const PARAMETER = { id: "github-app-id", slug: "github-app-slug", clientId: "github-app-client-id" };
export const SECRETS = [
  { env: "FENVIX_GITHUB_APP_PRIVATE_KEY", parameter: "private-key", what: "the App's private key (.pem)" },
  { env: "FENVIX_GITHUB_APP_CLIENT_SECRET", parameter: "client-secret", what: "the App's client secret" },
];

/** Checks a secret's shape without printing it. */
export function checkSecret(env, value, label = env) {
  if (env === "FENVIX_GITHUB_APP_PRIVATE_KEY") {
    let k;
    try { k = createPrivateKey(value.includes("\\n") && !value.includes("\n") ? value.replace(/\\n/g, "\n") : value); } catch { throw new Stop(`${label} is not a PEM private key: paste the whole content of the .pem file GitHub downloaded (from -----BEGIN to -----END).`); }
    if (k.asymmetricKeyType !== "rsa") throw new Stop(`${label} must be the App's RSA private key.`);
  } else if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Stop(`${label} does not look like a GitHub App client secret (40 hexadecimal characters).`);
  }
}

/** Returns { configured, id, slug, clientId }; stores secrets given as environment variables (local runs) in SSM. */
export async function syncGitHubApp(ssm, envVars = process.env, env = "prod") {
  const id = (envVars[VARIABLES.id] ?? "").trim(), slug = (envVars[VARIABLES.slug] ?? "").trim(), clientId = (envVars[VARIABLES.clientId] ?? "").trim();
  const given = SECRETS.filter((s) => (envVars[s.env] ?? "").trim());

  for (const s of given) {
    const value = envVars[s.env].trim();
    mask(value);
    checkSecret(s.env, value);
    const name = `${appPrefix(env)}/${s.parameter}`;
    let current = null;
    try { current = (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter?.Value ?? null; } catch (e) {
      if (/** @type {{ name?: string }} */ (e).name !== "ParameterNotFound") throw new Error(`${name}: could not be read (${/** @type {{ name?: string }} */ (e).name})`);
    }
    if (current !== null) mask(current);
    if (current !== null && current.trim() === value) { info(`${name}: same as ${s.env} (kept)`); continue; }
    await ssm.send(new PutParameterCommand({ Name: name, Type: "SecureString", Value: value, Overwrite: true, Description: `fenvix: ${s.what}. Stored from ${s.env} by a local run of the deploy pipeline.` }));
    info(`${name}: stored from ${s.env} (the value is not shown anywhere)`);
  }

  const ids = [id, slug, clientId];
  if (!ids.some(Boolean)) {
    if (given.length) warning(`${given.map((s) => s.env).join(", ")} stored, but the App is not configured until its three public values are set too.`);
    info("GitHub App: not configured (the App's routes answer 503 github_not_configured; everything else is deployed)");
    return { configured: false, id: "", slug: "", clientId: "" };
  }
  const missingVars = Object.entries(VARIABLES).filter(([k]) => !{ id, slug, clientId }[k]).map(([k, v]) => `the SSM parameter ${bootstrapPrefix(env)}/${PARAMETER[k]} (${v})`);
  const missingSecrets = [];
  for (const s of SECRETS) {
    const name = `${appPrefix(env)}/${s.parameter}`;
    let value = "";
    try { value = (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter?.Value ?? ""; } catch (e) {
      if (/** @type {{ name?: string }} */ (e).name !== "ParameterNotFound") throw new Error(`${name}: could not be read (${/** @type {{ name?: string }} */ (e).name})`);
    }
    value = value.trim();
    mask(value);
    if (!value) { missingSecrets.push(`the SSM parameter ${name} (${s.what}, SecureString)`); continue; }
    checkSecret(s.env, value, name);
  }
  if (missingVars.length || missingSecrets.length) {
    throw new Stop(`The GitHub App is half configured: missing ${[...missingVars, ...missingSecrets].join(", ")}. Add them in Parameter Store (docs/DEPLOY-AWS.md, "Connecting the GitHub App"), or delete the App's parameters to deploy without it.`);
  }
  if (!/^\d+$/.test(id)) throw new Stop(`${VARIABLES.id} (${bootstrapPrefix(env)}/${PARAMETER.id}) must be the App's numeric App ID.`);
  if (!/^[a-z0-9][a-z0-9-]{0,33}$/.test(slug)) throw new Stop(`${VARIABLES.slug} (${bootstrapPrefix(env)}/${PARAMETER.slug}) must be the App's URL name (https://github.com/apps/<this>).`);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(clientId)) throw new Stop(`${VARIABLES.clientId} (${bootstrapPrefix(env)}/${PARAMETER.clientId}) must be the App's Client ID.`);
  info(`GitHub App: configured (App ${id}, ${slug})`);
  return { configured: true, id, slug, clientId };
}
