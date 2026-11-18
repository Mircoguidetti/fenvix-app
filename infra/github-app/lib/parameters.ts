/**
 * The SSM Parameter Store parameters (SecureString) the founder creates before the first deploy (docs/DEPLOY-AWS.md).
 * The stack never creates or reads their values: it only grants each function and the runner machine the exact ones
 * it needs. github-app/src/lambda/secrets.ts reads the same names.
 */
export type Reader = "http" | "worker" | "sweep" | "runner" | "runner-job";
export interface Param { name: string; required: boolean; readers: Reader[]; value: string }

export const appPrefix = (env: string) => `/fenvix/${env}/github-app`;
export const runnerPrefix = (env: string) => `/fenvix/${env}/runner`;

export function appParameters(env: string): Param[] {
  const p = appPrefix(env);
  return [
    { name: `${p}/database-url`, required: true, readers: ["http", "worker", "sweep"], value: "Postgres URL of the role fenvix_github_app (Supabase pooler, session mode)" },
    { name: `${p}/private-key`, required: true, readers: ["http", "worker", "sweep"], value: "the App's private key (.pem file content)" },
    { name: `${p}/webhook-secret`, required: true, readers: ["http"], value: "the App's webhook secret (openssl rand -hex 32)" },
    { name: `${p}/client-secret`, required: true, readers: ["http"], value: "the App's OAuth client secret" },
    { name: `${p}/state-signing-key`, required: true, readers: ["http"], value: "openssl rand -hex 32" },
    { name: `${p}/runner-token`, required: true, readers: ["http", "runner", "runner-job"], value: "openssl rand -hex 32 (our runner machines send summaries with it)" },
    { name: `${p}/runner-token-previous`, required: false, readers: ["http"], value: "only while rotating runner-token" },
  ];
}

/** One-hour GitHub registration token: the machine reads it once, registers, and deletes the parameter. */
export const registrationTokenName = (env: string) => `${runnerPrefix(env)}/registration-token`;

export const cachePrefix = (env: string) => `/fenvix/${env}/cache`;

/** The shared cache service's two tokens (scripts/cache-tokens.sh): per-job machines read one, chosen per job. */
export function cacheParameters(env: string): Param[] {
  const p = cachePrefix(env);
  return [
    { name: `${p}/write-token`, required: false, readers: ["runner-job"], value: "cache token that may record (jobs on trusted refs)" },
    { name: `${p}/read-token`, required: false, readers: ["runner-job"], value: "cache token that may only look up (pull requests, forks)" },
  ];
}

export const readersOf = (env: string, who: Reader) => [...appParameters(env), ...cacheParameters(env)].filter((p) => p.readers.includes(who)).map((p) => p.name);
