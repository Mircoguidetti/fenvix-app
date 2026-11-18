import { GetParametersCommand, type SSMClient } from "@aws-sdk/client-ssm";

/**
 * The secrets live in SSM Parameter Store (SecureString), never in the code, the template or a Lambda environment
 * variable. Each function reads only its own at cold start, by exact name (its IAM policy names the same parameters):
 *
 *   <prefix>/database-url            GITHUB_APP_DATABASE_URL   all functions
 *   <prefix>/private-key             GITHUB_APP_PRIVATE_KEY    all functions
 *   <prefix>/webhook-secret          GITHUB_WEBHOOK_SECRET     HTTP only
 *   <prefix>/client-secret           GITHUB_CLIENT_SECRET      HTTP only
 *   <prefix>/state-signing-key       STATE_SIGNING_KEY         HTTP only
 *   <prefix>/runner-token            RUNNER_TOKEN              HTTP (verifies), the per-job worker and the demo
 *                                                              function (sign each machine's credential); never a
 *                                                              machine
 *   <prefix>/runner-token-previous   RUNNER_TOKEN_PREVIOUS     HTTP only, optional (during a rotation)
 *   <prefix>/host-signing-key        HOST_SIGNING_KEY          the phoenixNAP hosts function only (signs and verifies
 *                                                              host credentials); never a host
 *   <prefix>/host-signing-key-previous                         the same, optional (during a rotation)
 *
 * The phoenixNAP scaler reads only the database URL and the phoenixNAP API client (PNAP_CLIENT_ID_PARAM,
 * PNAP_CLIENT_SECRET_PARAM: /fenvix/<env>/pnap/client-id and client-secret), by full name; it holds no GitHub secret.
 *
 * The per-job worker also reads the cache signing key, by its full name (CACHE_SIGNING_KEY_PARAM, /fenvix/<env>/cache/
 * signing-key). Every function reloads its secrets after SECRETS_TTL_SECONDS (runtime.ts), so a rotation takes
 * effect without a deploy.
 *
 * <prefix> is SSM_PREFIX, e.g. /fenvix/prod/github-app. infra/github-app/lib/parameters.ts holds the same list.
 */
/**
 * "all": the HTTP function. "launcher": the per-job worker. "worker": the demo-mode worker, the sweep and the
 * customer-mode (phoenixNAP) worker, which only places jobs. "hosts": the phoenixNAP host routes (mint each leased
 * job's runner and credentials, sign host credentials).
 */
export type Surface = "all" | "launcher" | "worker" | "hosts";

export const SECRET_PARAMETERS: Record<string, { env: string; surfaces: Surface[]; required: boolean }> = {
  "database-url": { env: "GITHUB_APP_DATABASE_URL", surfaces: ["all", "launcher", "worker", "hosts"], required: true },
  "private-key": { env: "GITHUB_APP_PRIVATE_KEY", surfaces: ["all", "launcher", "worker", "hosts"], required: true },
  "webhook-secret": { env: "GITHUB_WEBHOOK_SECRET", surfaces: ["all"], required: true },
  "client-secret": { env: "GITHUB_CLIENT_SECRET", surfaces: ["all"], required: true },
  "state-signing-key": { env: "STATE_SIGNING_KEY", surfaces: ["all"], required: true },
  "runner-token": { env: "RUNNER_TOKEN", surfaces: ["all", "launcher", "hosts"], required: true },
  "runner-token-previous": { env: "RUNNER_TOKEN_PREVIOUS", surfaces: ["all"], required: false },
  "host-signing-key": { env: "HOST_SIGNING_KEY", surfaces: ["hosts"], required: true },
  "host-signing-key-previous": { env: "HOST_SIGNING_KEY_PREVIOUS", surfaces: ["hosts"], required: false },
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
