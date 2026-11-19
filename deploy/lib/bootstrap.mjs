// The values only the founder can provide, typed once into AWS SSM Parameter Store in the AWS console
// (docs/DEPLOY-AWS.md, section A step 2). GitHub stores none of them: the repository is private on GitHub Free, where
// environment secrets and deployment branch rules do not exist, so the pipeline needs no GitHub secret, variable or
// environment for them. The deploy role may read exactly these names (infra/github-app/deploy-policy.json,
// "ReadFounderValues") and may not write any of them.
//
// Every value is masked in the log (::add-mask::) as soon as it is read, before anything uses it, whether it is secret
// or not. A step reads only the values it needs, itself, from SSM: no value is passed between steps.
//
// Outside the workflow (the tests, a local run) the values come from environment variables of the same names instead
// (source "env": chosen when SUPABASE_DB_URL is set in the environment). The workflow sets none of them, so it always
// reads SSM.
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { mask, Stop } from "./log.mjs";

export const bootstrapPrefix = (env) => `/fenvix/${env}/bootstrap`;

/**
 * The founder's values: SSM name (under the prefix), the environment variable that may stand in for it outside the
 * workflow, the SSM type the founder picks in the console, and whether the deploy stops without it.
 */
export const FOUNDER_VALUES = {
  dbUrl: { name: "supabase-db-url", env: "SUPABASE_DB_URL", type: "SecureString", required: true, what: "the Supabase admin connection string (Session pooler)" },
  anonKey: { name: "supabase-anon-key", env: "SUPABASE_ANON_KEY", type: "String", required: false, what: "the Supabase anon (or publishable) key: public" },
  caCert: { name: "supabase-ca-cert", env: "SUPABASE_CA_CERT", type: "String", required: false, what: "Supabase's CA certificate: public, optional" },
  cloudflareToken: { name: "cloudflare-api-token", env: "CLOUDFLARE_API_TOKEN", type: "SecureString", required: false, what: "the Cloudflare API token (DNS of fenvix.dev)" },
  appId: { name: "github-app-id", env: "FENVIX_GITHUB_APP_ID", type: "String", required: false, what: "the GitHub App's App ID" },
  appSlug: { name: "github-app-slug", env: "FENVIX_GITHUB_APP_SLUG", type: "String", required: false, what: "the GitHub App's URL name" },
  appClientId: { name: "github-app-client-id", env: "FENVIX_GITHUB_APP_CLIENT_ID", type: "String", required: false, what: "the GitHub App's Client ID" },
};

/** Every SSM name the deploy role may read for the founder's values (the policy test compares against this). */
export const founderParameterNames = (env = "prod") => Object.values(FOUNDER_VALUES).map((v) => `${bootstrapPrefix(env)}/${v.name}`);

/** Where the values come from: "env" when SUPABASE_DB_URL is in the environment (tests, local runs), else "ssm". */
export const founderSource = (envVars = process.env) => (envVars.SUPABASE_DB_URL ? "env" : "ssm");

/**
 * Reads one founder value: from the environment variable (source "env"), or from the SSM parameter, decrypted.
 * Masks it before returning it. A missing parameter returns "" (or stops, for a required value, naming the parameter
 * and never a value); any other SSM error stops, naming only the error's class.
 */
export async function readFounderValue(ssm, key, { env = "prod", envVars = process.env, source = founderSource(envVars) } = {}) {
  const v = FOUNDER_VALUES[key];
  if (!v) throw new Error(`unknown founder value ${key}`);
  const name = `${bootstrapPrefix(env)}/${v.name}`;
  let value = "";
  if (source === "env") value = envVars[v.env] ?? "";
  else {
    try {
      value = (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter?.Value ?? "";
    } catch (e) {
      const err = /** @type {{ name?: string }} */ (e).name;
      if (err !== "ParameterNotFound") throw new Stop(`Could not read the SSM parameter ${name} (${err ?? "error"}). Nothing was changed. Check that the fenvix-bootstrap stack is up to date (docs/DEPLOY-AWS.md, section A step 1).`);
    }
  }
  value = value.trim();
  mask(value);
  if (!value && v.required) throw new Stop(`The SSM parameter ${name} is missing or empty: ${v.what}. Create it in the AWS console (Systems Manager → Parameter Store → Create parameter, type ${v.type}; docs/DEPLOY-AWS.md, section A step 2). Nothing was changed.`);
  return value;
}
