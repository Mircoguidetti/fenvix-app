/**
 * The SSM Parameter Store parameters (SecureString) the founder creates before the first deploy (docs/DEPLOY-AWS.md).
 * The stack never creates or reads their values: it only grants each function the exact ones it needs. No runner
 * machine reads any of them (R-012 F2): a machine's credentials are minted for it and passed in its user data.
 * github-app/src/lambda/secrets.ts reads the same names.
 */
export type Reader = "http" | "worker" | "sweep" | "demo" | "reaper-demo";
export interface Param { name: string; required: boolean; readers: Reader[]; value: string }

export const appPrefix = (env: string) => `/fenvix/${env}/github-app`;
export const runnerPrefix = (env: string) => `/fenvix/${env}/runner`;

export function appParameters(env: string): Param[] {
  const p = appPrefix(env);
  return [
    { name: `${p}/database-url`, required: true, readers: ["http", "worker", "sweep"], value: "Postgres URL of the role fenvix_github_app (Supabase pooler, session mode)" },
    { name: `${p}/private-key`, required: true, readers: ["http", "worker", "sweep", "demo", "reaper-demo"], value: "the App's private key (.pem file content)" },
    { name: `${p}/webhook-secret`, required: true, readers: ["http"], value: "the App's webhook secret (openssl rand -hex 32)" },
    { name: `${p}/client-secret`, required: true, readers: ["http"], value: "the App's OAuth client secret" },
    { name: `${p}/state-signing-key`, required: true, readers: ["http"], value: "openssl rand -hex 32" },
    { name: `${p}/runner-token`, required: true, readers: ["http", "worker", "demo"], value: "openssl rand -hex 32: the key that signs each machine's summary credential (never on a machine)" },
    { name: `${p}/runner-token-previous`, required: false, readers: ["http"], value: "only while rotating runner-token (credentials signed with it stay valid)" },
  ];
}

export const cachePrefix = (env: string) => `/fenvix/${env}/cache`;

/**
 * per-job: the private half of the cache signing key (scripts/cache-tokens.sh). Only the worker reads it, to sign one
 * cache token per job for that customer's organization (write: trusted ref; read: anything else).
 */
export function cacheParameters(env: string): Param[] {
  const p = cachePrefix(env);
  return [
    { name: `${p}/signing-key`, required: false, readers: ["worker"], value: "RSA private key (PEM) that signs per-job cache tokens" },
  ];
}

export const readersOf = (env: string, who: Reader) => [...appParameters(env), ...cacheParameters(env)].filter((p) => p.readers.includes(who)).map((p) => p.name);
