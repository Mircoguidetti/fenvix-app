// The GitHub App's values, configured last (docs/DEPLOY-AWS.md, "Connecting the GitHub App"). The three public ones
// are environment variables of the GitHub environment "production"; the two secret ones are environment secrets
// (copied into SSM by the pipeline, compared without printing) or typed straight into SSM in the AWS console. All
// five present: the stack is built with the App; none: without it. Anything in between stops the deploy, naming what
// is missing (never a value).
import { createPrivateKey } from "node:crypto";
import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { info, mask, Stop, warning } from "./log.mjs";
import { appPrefix, exists } from "./secrets.mjs";

export const VARIABLES = { id: "FENVIX_GITHUB_APP_ID", slug: "FENVIX_GITHUB_APP_SLUG", clientId: "FENVIX_GITHUB_APP_CLIENT_ID" };
export const SECRETS = [
  { env: "FENVIX_GITHUB_APP_PRIVATE_KEY", parameter: "private-key", what: "the App's private key (.pem)" },
  { env: "FENVIX_GITHUB_APP_CLIENT_SECRET", parameter: "client-secret", what: "the App's client secret" },
];

/** Checks a secret's shape without printing it. */
export function checkSecret(env, value) {
  if (env === "FENVIX_GITHUB_APP_PRIVATE_KEY") {
    let k;
    try { k = createPrivateKey(value.includes("\\n") && !value.includes("\n") ? value.replace(/\\n/g, "\n") : value); } catch { throw new Stop(`${env} is not a PEM private key: paste the whole content of the .pem file GitHub downloaded (from -----BEGIN to -----END).`); }
    if (k.asymmetricKeyType !== "rsa") throw new Stop(`${env} must be the App's RSA private key.`);
  } else if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Stop(`${env} does not look like a GitHub App client secret (40 hexadecimal characters).`);
  }
}

/** Returns { configured, id, slug, clientId } and stores the secrets given as GitHub secrets in SSM. */
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
    await ssm.send(new PutParameterCommand({ Name: name, Type: "SecureString", Value: value, Overwrite: true, Description: `fenvix: ${s.what}. Copied from the GitHub environment secret ${s.env} by the deploy pipeline.` }));
    info(`${name}: stored from ${s.env} (the value is not shown anywhere)`);
  }

  const ids = [id, slug, clientId];
  if (!ids.some(Boolean)) {
    if (given.length) warning(`${given.map((s) => s.env).join(", ")} stored, but the App is not configured until the variables ${Object.values(VARIABLES).join(", ")} are set too.`);
    info("GitHub App: not configured (the App's routes answer 503 github_not_configured; everything else is deployed)");
    return { configured: false, id: "", slug: "", clientId: "" };
  }
  const missingVars = Object.entries(VARIABLES).filter(([k]) => !{ id, slug, clientId }[k]).map(([, v]) => v);
  const missingSecrets = [];
  for (const s of SECRETS) if (!(await exists(ssm, `${appPrefix(env)}/${s.parameter}`))) missingSecrets.push(`${s.env} (or the SSM parameter ${appPrefix(env)}/${s.parameter})`);
  if (missingVars.length || missingSecrets.length) {
    throw new Stop(`The GitHub App is half configured: missing ${[...missingVars.map((v) => `the variable ${v}`), ...missingSecrets.map((v) => `the secret ${v}`)].join(", ")}. Add them (docs/DEPLOY-AWS.md, "Connecting the GitHub App"), or remove the App's variables to deploy without it.`);
  }
  if (!/^\d+$/.test(id)) throw new Stop(`${VARIABLES.id} must be the App's numeric App ID.`);
  if (!/^[a-z0-9][a-z0-9-]{0,33}$/.test(slug)) throw new Stop(`${VARIABLES.slug} must be the App's URL name (https://github.com/apps/<this>).`);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(clientId)) throw new Stop(`${VARIABLES.clientId} must be the App's Client ID.`);
  info(`GitHub App: configured (App ${id}, ${slug})`);
  return { configured: true, id, slug, clientId };
}
