import { FenvixConfig } from './config';

/** Port the control plane listens on inside its container (plain HTTP; only the TLS terminator reaches it). */
export const CONTROL_PLANE_INTERNAL_PORT = 3000;
/** Name the container has on the private Docker network the TLS terminator reaches it by. */
export const CONTROL_PLANE_CONTAINER = 'fenvix-control-plane';
/** How the container reaches the engine on its host (`--add-host=host.docker.internal:host-gateway`). */
export const ENGINE_HOST_FROM_CONTAINER = 'host.docker.internal';

export interface ControlPlaneEnvInput {
  config: FenvixConfig;
  region: string;
}

/**
 * Public host of the control-plane API (DNS record, certificate name, Caddy site, API_PUBLIC_URL). Not console.<domain>:
 * that name is the dashboard on Vercel, outside this stack, and only appears here as a dashboardOrigins entry.
 */
export function apiHost(c: FenvixConfig): string {
  return `api.${c.baseDomain}`;
}

/** Name the control plane checks the engine's certificate against (covered by `*.<region>.db.<domain>`). */
export function engineTlsServerName(c: FenvixConfig, region: string): string {
  return `engine.${region}.db.${c.baseDomain}`;
}

/**
 * Every NON-secret variable of the control-plane container, in one list. Secrets are not here: they come from SSM
 * (lib/parameters.ts) into a second env file at each start. To add a variable, add one entry. Names and meanings:
 * control-plane/src/config.ts, control-plane/README.md, control-plane/.env.example.
 */
export function controlPlaneEnvironment(i: ControlPlaneEnvInput): [string, string][] {
  const c = i.config;
  const engine = ENGINE_HOST_FROM_CONTAINER;
  return [
    ['NODE_ENV', 'production'],
    ['HOST', '0.0.0.0'],
    ['PORT', String(CONTROL_PLANE_INTERNAL_PORT)],
    ['REGIONS', i.region],
    ['API_PUBLIC_URL', `https://${apiHost(c)}/v1`],
    ['DASHBOARD_ORIGINS', c.dashboardOrigins.join(',')],
    // Only the TLS terminator on the same host reaches the container; it sets X-Forwarded-For to the client address.
    ['TRUST_PROXY', 'true'],
    // Real engine: admin interface (plain HTTP on the Docker bridge, never on the network).
    ['ENGINE_DRIVER', 'real'],
    ['ENGINE_ADMIN_ENDPOINTS', `http://${engine}:${c.adminPort}`],
    ['ENGINE_ADMIN_ALLOW_PLAIN_HTTP', 'true'],
    ['ENGINE_RETENTION_WINDOW_SECS', String(c.engineRetentionWindowSecs)],
    // What customers are told: host per database, port, the engine's own database name.
    ['BASE_DOMAIN', c.baseDomain],
    ['HOST_TEMPLATE', '<name>-<workspace>.<region>.db.<BASE_DOMAIN>'],
    ['CONNECTION_PORT', String(c.mongoPort)],
    ['CONNECTION_DB_NAME', 'engine'],
    // Data Explorer and provisioner: the engine's MongoDB port, TLS checked against a name the certificate covers.
    ['DATA_ENGINE_ENDPOINTS', `${engine}:${c.mongoPort}`],
    ['DATA_ENGINE_TLS', 'true'],
    ['DATA_ENGINE_TLS_SERVER_NAME', engineTlsServerName(c, i.region)],
    ['ENGINE_PROVISIONER_USERNAME', 'fenvix_provisioner'],
    ['ENGINE_PROVISIONER_AUTH_SOURCE', 'admin'],
    ['DATA_COMMAND_TIMEOUT_MS', '10000'],
    ['DATA_REGEX_TIMEOUT_MS', '2000'],
    ['DATA_DEFAULT_PAGE_SIZE', '25'],
    ['DATA_MAX_PAGE_SIZE', '100'],
    ['DATA_RATE_LIMIT_PER_MINUTE', '120'],
    ['DATA_WRITE_RATE_LIMIT_PER_MINUTE', '30'],
  ];
}
