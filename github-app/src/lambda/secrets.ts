import { GetParametersCommand, type SSMClient } from "@aws-sdk/client-ssm";

/**
 * The secrets live in SSM Parameter Store (SecureString), never in the code, the template or a Lambda environment
 * variable. Each function reads only its own at cold start, by exact name (its IAM policy names the same parameters):
 *
 *   <prefix>/database-url            GITHUB_APP_DATABASE_URL   all functions
 *   <prefix>/private-key             GITHUB_APP_PRIVATE_KEY    all functions
 *   <prefix>/webhook-secret          GITHUB_WEBHOOK_SECRET     HTTP only
 *   <prefix>/webhook-secret-previous GITHUB_WEBHOOK_SECRET_PREVIOUS  HTTP only, optional (during a rotation)
 *   <prefix>/client-secret           GITHUB_CLIENT_SECRET      HTTP only
 *   <prefix>/state-signing-key       STATE_SIGNING_KEY         HTTP and the dashboard API (signs the install link)
 *   <prefix>/runner-token            RUNNER_TOKEN              HTTP (verifies), the per-job worker and the demo
 *                                                              function (sign each machine's credential); never a
 *                                                              machine
 *   <prefix>/runner-token-previous   RUNNER_TOKEN_PREVIOUS     HTTP only, optional (during a rotation)
 *   <prefix>/api-database-url        API_DATABASE_URL          the dashboard API only (role fenvix_api, pooler,
 *                                                              transaction mode); the API reads nothing else but the
 *                                                              state signing key: no App key, webhook or client
 *                                                              secret, no runner token
 *
 * The per-job worker also reads the cache signing key, by its full name (CACHE_SIGNING_KEY_PARAM, /fenvix/<env>/cache/
 * signing-key). Every function reloads its secrets after SECRETS_TTL_SECONDS (runtime.ts), so a rotation takes
 * effect without a deploy.
 *
 * <prefix> is SSM_PREFIX, e.g. /fenvix/prod/github-app. infra/github-app/lib/parameters.ts holds the same list.
 */
/**
 * "all": the HTTP function. "launcher": the per-job worker. "worker": the demo-mode worker and the sweep. "api": the
 * dashboard API (src/lambda/api.ts).
 */
export type Surface = "all" | "launcher" | "worker" | "api";

export const SECRET_PARAMETERS: Record<string, { env: string; surfaces: Surface[]; required: boolean }> = {
  "database-url": { env: "GITHUB_APP_DATABASE_URL", surfaces: ["all", "launcher", "worker"], required: true },
  "private-key": { env: "GITHUB_APP_PRIVATE_KEY", surfaces: ["all", "launcher", "worker"], required: true },
  "webhook-secret": { env: "GITHUB_WEBHOOK_SECRET", surfaces: ["all"], required: true },
  "webhook-secret-previous": { env: "GITHUB_WEBHOOK_SECRET_PREVIOUS", surfaces: ["all"], required: false },
  "client-secret": { env: "GITHUB_CLIENT_SECRET", surfaces: ["all"], required: true },
  "state-signing-key": { env: "STATE_SIGNING_KEY", surfaces: ["all", "api"], required: true },
  "runner-token": { env: "RUNNER_TOKEN", surfaces: ["all", "launcher"], required: true },
  "runner-token-previous": { env: "RUNNER_TOKEN_PREVIOUS", surfaces: ["all"], required: false },
  "api-database-url": { env: "API_DATABASE_URL", surfaces: ["api"], required: true },
};

export function parameterNames(prefix: string, surface: Surface): string[] {
  return Object.entries(SECRET_PARAMETERS).filter(([, p]) => p.surfaces.includes(surface)).map(([name]) => `${prefix}/${name}`);
}

/** The secrets of one surface as environment-style entries. Throws, naming the missing parameters (never a value). */
export async function loadSecrets(client: Pick<SSMClient, "send">, prefix: string, surface: Surface): Promise<Record<string, string>> {
  if (!/^\/[A-Za-z0-9_.\-/]+[^/]$/.test(prefix)) throw new Error(`SSM_PREFIX "${prefix}" is not a parameter path like /fenvix/prod/github-app`);
  const names = parameterNames(prefix, surface);
  const r = await client.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  const out: Record<string, string> = {};
  for (const p of r.Parameters ?? []) {
    const key = p.Name?.slice(prefix.length + 1);
    if (key && key in SECRET_PARAMETERS && typeof p.Value === "string") out[SECRET_PARAMETERS[key]!.env] = p.Value;
  }
  const missing = names.filter((n) => {
    const spec = SECRET_PARAMETERS[n.slice(prefix.length + 1)]!;
    return spec.required && !(spec.env in out);
  });
  if (missing.length) throw new Error(`missing SSM parameters: ${missing.join(", ")}`);
  return out;
}

/** One more parameter by its full name (the cache signing key lives outside the App's prefix). */
export async function loadParameter(client: Pick<SSMClient, "send">, name: string): Promise<string> {
  if (!/^\/[A-Za-z0-9_.\-/]+[^/]$/.test(name)) throw new Error(`"${name}" is not a parameter name`);
  const r = await client.send(new GetParametersCommand({ Names: [name], WithDecryption: true }));
  const v = r.Parameters?.[0]?.Value;
  if (typeof v !== "string" || !v) throw new Error(`missing SSM parameters: ${name}`);
  return v;
}
