import { FenvixConfig } from './config';

/**
 * File name of the engine binary: the ONLY place that holds it (code and tests read it from here). It is the name the
 * engine has in Mircoguidetti/test5 (Cargo package of the final engine); when the engine is renamed, change this line.
 */
export const ENGINE_BINARY_NAME = 'mongo-server';

/** Where things live on the server. Shared by the boot script, the systemd units and the tests. */
export const PATHS = {
  /** The downloaded engine binary (whatever the release file is called, it is saved under this name). */
  engineBinary: `/opt/fenvix/bin/${ENGINE_BINARY_NAME}`,
  /** Written at every engine start from SSM (0600, owner fenvix); /run/fenvix disappears when the engine stops. */
  adminTokenFile: '/run/fenvix/admin-token',
  /** Let's Encrypt certificate and key (lib/scripts/fenvix-tls.sh). Directory and files owned by fenvix, files 0600. */
  tlsDir: '/etc/fenvix/tls',
  /** Certificate chain + private key in one PEM file: what the engine loads. */
  enginePem: '/etc/fenvix/tls/engine.pem',
  /** The same certificate and key as two files, for the TLS terminator in front of the control plane. */
  fullchainPem: '/etc/fenvix/tls/fullchain.pem',
  keyPem: '/etc/fenvix/tls/key.pem',
} as const;

/**
 * Docker's default bridge address, pinned in /etc/docker/daemon.json. The engine's admin interface listens here
 * only: reachable from the host and its containers (as host.docker.internal), never from the network, whatever the
 * security group says. The admin interface is plain HTTP with an all-powerful token, so it never binds 0.0.0.0.
 */
export const DOCKER_BRIDGE_IP = '172.17.0.1';

/**
 * Stands for the EC2 instance id in the engine unit as written; the boot script replaces it with the id it read from
 * IMDSv2 (checked against ^i-[0-9a-f]+$) before the unit is enabled.
 */
export const INSTANCE_ID_PLACEHOLDER = '@INSTANCE_ID@';

export interface EngineCommandInput {
  config: FenvixConfig;
  region: string;
  /** Bucket name; may be a CDK token. */
  bucketName: string;
  /** Lease holder id: the instance id (or INSTANCE_ID_PLACEHOLDER in the unit file). */
  holder: string;
}

/**
 * The engine's command line: the ONLY place that knows the engine's flag names. The engine reads no FENVIX_*
 * variable: every setting is a clap flag. Checked against the source of the final engine, Mircoguidetti/test5
 * branch final-engine, commit 41ed169, engine crate: src/main.rs (struct Args), src/ctl/mod.rs (CtlArgs), src/tls.rs.
 * If the engine renames a flag, change it here and in test/engine-command.test.ts only.
 *
 * Left at the engine's default on purpose (not passed): --endpoint (empty = AWS), --lease-ttl-secs 30,
 * --replica-set (empty = standalone), --process-lease (off), --ttl-* (no sleeping tenant is woken for expiry),
 * --wal-flush-ms 0 (acknowledged = durable), --writer-poll-secs, --wal-gc-secs, --sst-gc-*, --group-commit-*,
 * --durable-reads true, --max-concurrent-wakes, --retention-interval/prune/usage/pin/export timers.
 * Never passed: the test controls (--no-leases, --unsafe-skip-ownership-checks, --ack-before-durable,
 * --no-ctl-recovery, --no-maintenance, --no-ttl, --gc-control-delete-live, --l0-*, --serialize-reads,
 * --no-group-commit), --admin-token (a command line is visible to every local user), --log-commands, --store local
 * or memory, --tls-ca-file (only for client certificates; with it every client would need one).
 */
export function engineArgs(i: EngineCommandInput): string[] {
  const c = i.config;
  return [
    // MongoDB wire protocol, the only port open to the internet.
    `--listen=0.0.0.0:${c.mongoPort}`,
    // Admin interface (plain HTTP): Docker bridge only, see DOCKER_BRIDGE_IP. Token from a file (also accepted:
    // MONGO_ADMIN_TOKEN, but an environment variable is shown by `systemctl show` and inherited by child processes).
    `--admin-listen=${DOCKER_BRIDGE_IP}:${c.adminPort}`,
    `--admin-token-file=${PATHS.adminTokenFile}`,
    // Authentication (SCRAM users) and TLS required on the MongoDB port. One PEM file: chain + key. No CA file: the
    // engine would then ask every client for a certificate.
    '--auth',
    '--tls-mode=requireTLS',
    `--tls-certificate-key-file=${PATHS.enginePem}`,
    // Object store: the region's bucket on AWS. Credentials: none given, so the S3 client takes the instance role
    // through IMDSv2. The region is required by the engine; it is also in the unit's environment.
    '--store=s3',
    `--bucket=${i.bucketName}`,
    `--region=${i.region}`,
    // Lease owner: the instance id. Stable across restarts of the engine on this instance (a restarted engine takes
    // its own leases back at once instead of waiting for them to expire), different on every other instance (a
    // replacement server waits for the old one's leases). Only one engine runs per instance (systemd).
    `--holder=${i.holder}`,
    // A database's tenant is closed after 60 s without commands (the engine's default, the value the engine was
    // verified with): an idle database costs no S3 request.
    '--idle-secs=60',
    // Restore points for databases the control plane did not set (it sets the same value on every new database).
    `--retention-window-secs=${c.engineRetentionWindowSecs}`,
    // WAL cleanup: bulk is the engine's default and the only one that keeps restores exact (slatedb mode loses WAL
    // objects a restore needs). Pinned so that a change of the default cannot change it here.
    '--wal-gc-mode=bulk',
  ];
}

/** Environment of the engine process: the region only. Never a secret. */
export function engineEnvironment(region: string): Record<string, string> {
  return { AWS_REGION: region, AWS_DEFAULT_REGION: region };
}
