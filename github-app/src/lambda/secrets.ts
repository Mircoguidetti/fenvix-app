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
 *   <prefix>/runner-token            RUNNER_TOKEN              HTTP only (and the runner machine)
 *   <prefix>/runner-token-previous   RUNNER_TOKEN_PREVIOUS     HTTP only, optional (during a rotation)
 *
 * <prefix> is SSM_PREFIX, e.g. /fenvix/prod/github-app. infra/github-app/lib/parameters.ts holds the same list.
 */
export const SECRET_PARAMETERS = {
  "database-url": { env: "GITHUB_APP_DATABASE_URL", http: false, required: true },
  "private-key": { env: "GITHUB_APP_PRIVATE_KEY", http: false, required: true },
  "webhook-secret": { env: "GITHUB_WEBHOOK_SECRET", http: true, required: true },
  "client-secret": { env: "GITHUB_CLIENT_SECRET", http: true, required: true },
  "state-signing-key": { env: "STATE_SIGNING_KEY", http: true, required: true },
  "runner-token": { env: "RUNNER_TOKEN", http: true, required: true },
  "runner-token-previous": { env: "RUNNER_TOKEN_PREVIOUS", http: true, required: false },
} as const;

export type Surface = "all" | "worker";

export function parameterNames(prefix: string, surface: Surface): string[] {
  return Object.entries(SECRET_PARAMETERS).filter(([, p]) => surface === "all" || !p.http).map(([name]) => `${prefix}/${name}`);
}

/** The secrets of one surface as environment-style entries. Throws, naming the missing parameters (never a value). */
export async function loadSecrets(client: Pick<SSMClient, "send">, prefix: string, surface: Surface): Promise<Record<string, string>> {
  if (!/^\/[A-Za-z0-9_.\-/]+[^/]$/.test(prefix)) throw new Error(`SSM_PREFIX "${prefix}" is not a parameter path like /fenvix/prod/github-app`);
  const names = parameterNames(prefix, surface);
  const r = await client.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  const out: Record<string, string> = {};
  for (const p of r.Parameters ?? []) {
    const key = p.Name?.slice(prefix.length + 1) as keyof typeof SECRET_PARAMETERS | undefined;
    if (key && key in SECRET_PARAMETERS && typeof p.Value === "string") out[SECRET_PARAMETERS[key].env] = p.Value;
  }
  const missing = names.filter((n) => {
    const spec = SECRET_PARAMETERS[n.slice(prefix.length + 1) as keyof typeof SECRET_PARAMETERS];
    return spec.required && !(spec.env in out);
  });
  if (missing.length) throw new Error(`missing SSM parameters: ${missing.join(", ")}`);
  return out;
}
