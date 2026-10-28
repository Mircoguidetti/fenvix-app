import { FenvixConfig } from './config';

/** Where things live on the server. Shared by the boot script, the systemd units and the tests. */
export const PATHS = {
  engineBinary: '/opt/fenvix/bin/fenvix-engine',
  /** Written at every engine start from SSM (0600, owner fenvix); /run/fenvix disappears when the engine stops. */
  adminTokenFile: '/run/fenvix/admin-token',
  /**
   * Certificate chain + private key in one PEM file (0600, owner fenvix, directory 0700 fenvix), from Let's Encrypt
   * (lib/acme.ts). The TLS terminator reads the same file (directory mounted read-only).
   */
  enginePem: '/etc/fenvix/tls/engine.pem',
} as const;

/**
 * Docker's default bridge address, pinned in /etc/docker/daemon.json. The engine's admin interface listens here
 * only: reachable from the host and its containers (as host.docker.internal), never from the network, whatever the
 * security group says. The admin interface is plain HTTP with an all-powerful token, so it never binds 0.0.0.0.
 */
export const DOCKER_BRIDGE_IP = '172.17.0.1';

export interface EngineCommandInput {
  config: FenvixConfig;
  region: string;
  /** Bucket name; may be a CDK token. */
  bucketName: string;
}

/**
 * The engine's command line: the ONLY place that knows the engine's flag names. The engine (Mircoguidetti/test5,
 * `mongo-server`) reads no FENVIX_* variable: every setting is a clap flag. Checked against:
 *   - fusion-ops @ e98ed24 (merge-engine + control-ops): --listen, --store, --bucket, --endpoint, --idle-secs,
 *     --admin-listen, --admin-token-file (ctl/mod.rs CtlArgs);
 *   - compat-gaps @ 5df2720: --auth, --tls-mode, --tls-certificate-key-file (main.rs, tls.rs).
 * No published binary has both sets yet. If the final binary renames a flag, change it here and in
 * test/engine-command.test.ts, nowhere else.
 *
 * Deliberately absent: --endpoint (the engine's default is a local MinIO; the final binary must use the AWS default
 * endpoint when it is unset, see results-infra.md), --no-leases, --unsafe-skip-ownership-checks, --ack-before-durable,
 * --no-ctl-recovery (test controls), --admin-token (a command line is visible to every local user), --log-commands.
 * There is no "production mode" flag in the engine: production is this set of flags plus none of the test controls.
 */
export function engineArgs(i: EngineCommandInput): string[] {
  const c = i.config;
  return [
    // MongoDB wire protocol, the only port open to the internet.
    `--listen=0.0.0.0:${c.mongoPort}`,
    // Admin interface (plain HTTP): Docker bridge only, see DOCKER_BRIDGE_IP.
    `--admin-listen=${DOCKER_BRIDGE_IP}:${c.adminPort}`,
    `--admin-token-file=${PATHS.adminTokenFile}`,
    // Authentication (SCRAM users) and TLS required on the MongoDB port.
    '--auth',
    '--tls-mode=requireTLS',
    `--tls-certificate-key-file=${PATHS.enginePem}`,
    // Object store: the region's bucket. Region and credentials come from the environment and the instance role
    // (AWS_REGION in the unit, IMDSv2); no endpoint, so the final binary talks to the AWS endpoint of the region.
    '--store=s3',
    `--bucket=${i.bucketName}`,
  ];
}

/** Environment of the engine process: the region only. Never a secret. */
export function engineEnvironment(region: string): Record<string, string> {
  return { AWS_REGION: region, AWS_DEFAULT_REGION: region };
}
