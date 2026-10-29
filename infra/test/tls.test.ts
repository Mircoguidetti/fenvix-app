import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir, userInfo } from 'os';
import { join } from 'path';
import { ACME_DIRECTORY, DNS_HOOK_SCRIPT, TLS_SCRIPT, tlsEnv } from '../lib/acme';
import { loadConfig } from '../lib/config';
import { BASE_CONTEXT } from './helpers';

/*
 * The real lib/scripts/fenvix-tls.sh and fenvix-acme-dns-hook.sh, run with bash and the real openssl against:
 *   - a fake certbot (issues a certificate signed by a fake CA for the -d names, or fails on demand),
 *   - a fake `aws` (Secrets Manager get/put on a local file, Route 53 change/wait recorded),
 *   - a fake `systemctl` (records restarts).
 * Nothing leaves this machine.
 */
const hasTools = spawnSync('openssl', ['version']).status === 0 && spawnSync('python3', ['--version']).status === 0 && spawnSync('flock', ['--version']).status === 0;
const t = hasTools ? test : test.skip;
const config = loadConfig((k) => BASE_CONTEXT[k]);
const SECRET = 'arn:aws:secretsmanager:eu-west-1:865859654353:secret:TlsStore-AbCdEf';
const root = mkdtempSync(join(tmpdir(), 'fenvix-tls-'));
const work = join(root, 'work');
const bin = join(root, 'bin');
const tls = join(root, 'etc-fenvix-tls');
const state = join(root, 'var-lib-fenvix-acme');
const conf = join(root, 'tls.env');
const outputs: string[] = [];

function writeConf(over: { server?: string; domains?: string } = {}): void {
  const lines = tlsEnv({ config, region: 'eu-west-1', withApi: true, restartUnits: ['fenvix-engine.service', 'fenvix-proxy.service'] }).map((l) => {
    if (over.server && l.startsWith('ACME_SERVER=')) return `ACME_SERVER='${over.server}'`;
    if (over.domains && l.startsWith('ACME_DOMAINS=')) return `ACME_DOMAINS='${over.domains}'`;
    return l;
  });
  writeFileSync(conf, [...lines, `TLS_SECRET_ID='${SECRET}'`, "ACME_ZONE_ID='Z0123456789ABC'"].join('\n') + '\n');
}

function run(...args: string[]) {
  const r = spawnSync('bash', [join(root, 'fenvix-tls'), ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: root,
      FENVIX_TLS_CONF: conf,
      FENVIX_TLS_DIR: tls,
      FENVIX_ACME_STATE: state,
      FENVIX_TLS_OWNER: userInfo().username,
      FENVIX_CERTBOT: join(bin, 'certbot'),
      FENVIX_ACME_HOOK: join(root, 'fenvix-acme-dns-hook'),
    },
  });
  outputs.push(r.stdout + r.stderr);
  return r;
}
const count = (f: string) => (existsSync(join(work, f)) ? readFileSync(join(work, f), 'utf8').split('\n').filter(Boolean).length : 0);
const flag = (f: string, on: boolean) => (on ? writeFileSync(join(work, f), '') : rmSync(join(work, f), { force: true }));
const fingerprint = (f: string) => execFileSync('openssl', ['x509', '-in', f, '-noout', '-fingerprint', '-sha256']).toString().trim();
const secret = () => JSON.parse(readFileSync(join(work, 'secret.json'), 'utf8'));
/** A new server: nothing on its disk (the secret in Secrets Manager stays). */
const newServer = () => {
  rmSync(tls, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
};
const mode = (f: string) => (statSync(f).mode & 0o777).toString(8);

beforeAll(() => {
  if (!hasTools) return;
  mkdirSync(work, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, 'fenvix-tls'), TLS_SCRIPT);
  writeFileSync(join(root, 'fenvix-acme-dns-hook'), DNS_HOOK_SCRIPT);
  chmodSync(join(root, 'fenvix-acme-dns-hook'), 0o755); // as on the server; certbot refuses a hook it cannot run
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(work, 'ca.key'), '-out', join(work, 'ca.crt'), '-days', '400', '-subj', '/CN=Fake Intermediate R99'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(work, 'stca.key'), '-out', join(work, 'stca.crt'), '-days', '400', '-subj', '/CN=(STAGING) Fake Intermediate'], { stdio: 'ignore' });
  writeFileSync(join(work, 'secret.json'), '{}');
  // Fake certbot: same command line as the real one; writes live/fenvix/{fullchain,privkey}.pem under --config-dir.
  writeFileSync(
    join(bin, 'certbot'),
    `#!/bin/bash
set -euo pipefail
W='${work}'
echo "$*" >> "$W/certbot-calls"
[ -f "$W/certbot-fail" ] && { echo "Some challenges have failed."; echo "Certbot failed to authenticate some domains (authenticator: manual)."; exit 1; }
cfg=""; san=""; first=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config-dir) cfg="$2"; shift ;;
    -d) san="$san\${san:+,}DNS:$2"; first="\${first:-$2}"; shift ;;
  esac
  shift
done
ca=ca; [ -f "$W/staging-ca" ] && ca=stca
days="$(cat "$W/days" 2>/dev/null || echo 90)"
d="$cfg/live/fenvix"; mkdir -p "$d"
openssl req -new -newkey rsa:2048 -nodes -keyout "$d/privkey.pem" -subj "/CN=$first" -addext "subjectAltName=$san" -out "$W/csr" 2>/dev/null
openssl x509 -req -in "$W/csr" -CA "$W/$ca.crt" -CAkey "$W/$ca.key" -CAcreateserial -days "$days" -copy_extensions copy -out "$W/leaf.pem" 2>/dev/null
cat "$W/leaf.pem" "$W/$ca.crt" > "$d/fullchain.pem"
echo "Successfully received certificate."
`,
  );
  // Fake aws: Secrets Manager on secret.json, Route 53 recorded.
  writeFileSync(
    join(bin, 'aws'),
    `#!/bin/bash
W='${work}'
echo "$1 $2" >> "$W/aws-calls"
case "$1 $2" in
  "secretsmanager get-secret-value")
    [ -f "$W/sm-read-fail" ] && { echo "An error occurred (AccessDeniedException) when calling the GetSecretValue operation" >&2; exit 254; }
    cat "$W/secret.json"; echo ;;
  "secretsmanager put-secret-value")
    [ -f "$W/sm-write-fail" ] && { echo "An error occurred (AccessDeniedException) when calling the PutSecretValue operation" >&2; exit 254; }
    while [ $# -gt 0 ]; do [ "$1" = --secret-string ] && cp "\${2#file://}" "$W/secret.json"; shift; done
    echo '{"ARN": "x", "VersionId": "v"}' ;;
  "route53 change-resource-record-sets")
    [ -f "$W/r53-fail" ] && { echo "An error occurred (AccessDenied)" >&2; exit 254; }
    while [ $# -gt 0 ]; do [ "$1" = --change-batch ] && cp "\${2#file://}" "$W/batch-$(date +%s%N).json"; [ "$1" = --hosted-zone-id ] && echo "$2" >> "$W/zones"; shift; done
    echo /change/C0123 ;;
  "route53 wait") echo "$*" >> "$W/waits" ;;
  *) echo "unexpected aws call: $*" >&2; exit 1 ;;
esac
`,
  );
  writeFileSync(join(bin, 'systemctl'), `#!/bin/bash\necho "$*" >> '${work}/restarts'\n`);
  for (const f of ['certbot', 'aws', 'systemctl']) chmodSync(join(bin, f), 0o755);
  writeConf();
});

describe('fenvix-tls (real script, fake certbot / Secrets Manager / systemctl)', () => {
  t('first start: requests a certificate, keeps it in Secrets Manager, installs engine.pem (chain + key) and the files for Caddy', () => {
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(count('certbot-calls')).toBe(1);
    const call = readFileSync(join(work, 'certbot-calls'), 'utf8');
    expect(call).toContain(`--server ${ACME_DIRECTORY.production}`);
    expect(call).toContain('-m certs@example.com --server');
    expect(call).toContain('-d *.eu-west-1.db.example.com -d api.example.com');
    expect(call).toContain('--manual --preferred-challenges dns');
    expect(call).toContain(`--manual-auth-hook ${join(root, 'fenvix-acme-dns-hook')} present`);
    expect(call).toContain('--force-renewal');
    expect(r.stdout).toContain('certificate kept in Secrets Manager');
    expect(r.stdout).toContain('certificate installed (none -> ');
    const pem = readFileSync(join(tls, 'engine.pem'), 'utf8');
    expect(pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(pem.indexOf('BEGIN CERTIFICATE')).toBeLessThan(pem.indexOf('BEGIN PRIVATE KEY'));
    expect(pem).not.toContain('ENCRYPTED');
    const mod = (f: string, kind: string) => execFileSync('openssl', [kind, '-in', f, '-noout', '-modulus']).toString();
    expect(mod(join(tls, 'key.pem'), 'rsa')).toBe(mod(join(tls, 'fullchain.pem'), 'x509'));
    expect(mod(join(tls, 'engine.pem'), 'rsa')).toBe(mod(join(tls, 'engine.pem'), 'x509'));
    const s = secret();
    expect(s.server).toBe(ACME_DIRECTORY.production);
    expect(s.fullchain).toContain('BEGIN CERTIFICATE');
    expect(s.key).toContain('PRIVATE KEY');
    expect(count('restarts')).toBe(0);
  });

  t('the key files are 0600 and owned by the service user; the directory is 0700', () => {
    for (const f of ['engine.pem', 'key.pem', 'fullchain.pem']) {
      expect({ f, mode: mode(join(tls, f)) }).toEqual({ f, mode: '600' });
      expect(statSync(join(tls, f)).uid).toBe(userInfo().uid);
    }
    expect(mode(tls)).toBe('700');
  });

  t('valid certificate: nothing requested, nothing read from AWS, nothing restarted', () => {
    const calls = count('aws-calls');
    const r = run('--restart-on-change');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('nothing to do');
    expect(count('certbot-calls')).toBe(1);
    expect(count('aws-calls')).toBe(calls);
    expect(count('restarts')).toBe(0);
  });

  t('replaced server: reuses the certificate kept in Secrets Manager, requests nothing', () => {
    const before = fingerprint(join(tls, 'fullchain.pem'));
    newServer();
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('using the certificate kept in Secrets Manager');
    expect(count('certbot-calls')).toBe(1);
    expect(fingerprint(join(tls, 'fullchain.pem'))).toBe(before);
    expect(mode(join(tls, 'engine.pem'))).toBe('600');
  });

  t('close to expiry (under 30 days): a new certificate, kept, installed, and the engine and Caddy restarted once', () => {
    // Make the installed and the kept certificate a 20-day one.
    writeFileSync(join(work, 'days'), '20');
    writeFileSync(join(work, 'secret.json'), '{}');
    newServer();
    expect(run().status).toBe(0);
    expect(count('certbot-calls')).toBe(2);
    const short = fingerprint(join(tls, 'fullchain.pem'));
    writeFileSync(join(work, 'days'), '90');
    const r = run('--restart-on-change');
    expect(r.status).toBe(0);
    expect(count('certbot-calls')).toBe(3);
    expect(fingerprint(join(tls, 'fullchain.pem'))).not.toBe(short);
    expect(readFileSync(join(work, 'restarts'), 'utf8')).toBe('try-restart fenvix-engine.service fenvix-proxy.service\n');
    expect(r.stdout).toContain('restarted fenvix-engine.service fenvix-proxy.service');
    // And the next check changes nothing.
    expect(run('--restart-on-change').stdout).toContain('nothing to do');
    expect(count('restarts')).toBe(1);
  });

  t('request fails with nothing installed: exits 1 with a clear message and installs nothing; the next try waits (rate limits)', () => {
    flag('certbot-fail', true);
    writeFileSync(join(work, 'secret.json'), '{}');
    newServer();
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Some challenges have failed');
    expect(r.stderr).toContain('the certificate request failed');
    expect(r.stderr).toContain('no valid certificate installed, the services that need TLS do not start');
    expect(existsSync(join(tls, 'engine.pem'))).toBe(false);
    const calls = count('certbot-calls');
    const again = run();
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/last certificate request failed \d+s ago, next attempt in \d+s/);
    expect(count('certbot-calls')).toBe(calls);
    flag('certbot-fail', false);
    rmSync(join(state, 'attempt'));
  });

  t('request fails while the installed certificate is still valid (under 30 days left): keeps serving it, exit 0', () => {
    writeFileSync(join(work, 'days'), '20');
    expect(run().status).toBe(0);
    writeFileSync(join(work, 'days'), '90');
    flag('certbot-fail', true);
    const r = run('--restart-on-change');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('WARNING: the certificate request failed');
    expect(r.stderr).toContain('keeping the installed certificate');
    flag('certbot-fail', false);
    rmSync(join(state, 'attempt'));
  });

  t('Secrets Manager unreadable and nothing installed: exits 1, requests nothing', () => {
    newServer();
    flag('sm-read-fail', true);
    const calls = count('certbot-calls');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`cannot read ${SECRET}: An error occurred (AccessDeniedException)`);
    expect(r.stderr).toContain('the stored certificate cannot be read; no valid certificate installed');
    expect(count('certbot-calls')).toBe(calls);
    expect(existsSync(join(tls, 'engine.pem'))).toBe(false);
    flag('sm-read-fail', false);
  });

  t('Secrets Manager not writable: the certificate is still installed, with a warning', () => {
    writeFileSync(join(work, 'secret.json'), '{}');
    newServer();
    flag('sm-write-fail', true);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('WARNING: cannot keep the certificate');
    expect(existsSync(join(tls, 'engine.pem'))).toBe(true);
    flag('sm-write-fail', false);
  });

  t('a different name list (config changed) means a new certificate', () => {
    expect(run().stdout).toContain('nothing to do');
    const calls = count('certbot-calls');
    writeConf({ domains: '*.eu-west-1.db.example.com api.example.com extra.example.com' });
    const r = run();
    expect(r.status).toBe(0);
    expect(count('certbot-calls')).toBe(calls + 1);
    expect(readFileSync(join(work, 'certbot-calls'), 'utf8').trim().split('\n').pop()).toContain('-d extra.example.com');
    writeConf();
    run();
  });

  t('staging: a staging certificate is never served when production is configured, and the reverse', () => {
    // A certificate from staging (kept and installed while acmeStaging was true)...
    writeConf({ server: ACME_DIRECTORY.staging });
    flag('staging-ca', true);
    writeFileSync(join(work, 'secret.json'), '{}');
    newServer();
    expect(run().status).toBe(0);
    const stagingCopy = secret();
    expect(stagingCopy.server).toBe(ACME_DIRECTORY.staging);
    const calls = count('certbot-calls');
    expect(readFileSync(join(work, 'certbot-calls'), 'utf8').trim().split('\n').pop()).toContain(`--server ${ACME_DIRECTORY.staging}`);
    // ...is replaced as soon as production is configured, even on a new server that finds it in Secrets Manager.
    flag('staging-ca', false);
    writeConf();
    newServer();
    const r = run();
    expect(r.status).toBe(0);
    expect(count('certbot-calls')).toBe(calls + 1);
    expect(execFileSync('openssl', ['x509', '-in', join(tls, 'fullchain.pem'), '-noout', '-issuer']).toString()).not.toContain('STAGING');
    // A copy marked as production whose issuer is a staging one is refused too.
    writeFileSync(join(work, 'secret.json'), JSON.stringify({ ...stagingCopy, server: ACME_DIRECTORY.production }));
    newServer();
    expect(run().status).toBe(0);
    expect(count('certbot-calls')).toBe(calls + 2);
    expect(execFileSync('openssl', ['x509', '-in', join(tls, 'fullchain.pem'), '-noout', '-issuer']).toString()).not.toContain('STAGING');
  });

  t('never prints a private key or any line of it', () => {
    const all = outputs.join('\n');
    expect(all).not.toContain('PRIVATE KEY');
    const keyLines = readFileSync(join(tls, 'key.pem'), 'utf8').split('\n').filter((l) => l.length > 20 && !l.startsWith('-----'));
    for (const l of keyLines) expect(all).not.toContain(l);
    const stored = secret().key.split('\n').filter((l: string) => l.length > 20 && !l.startsWith('-----'));
    for (const l of stored) expect(all).not.toContain(l);
  });
});

describe('fenvix-acme-dns-hook (real script, fake aws)', () => {
  const hook = (domain: string, value: string, action: string, confFile = conf) =>
    spawnSync('bash', [join(root, 'fenvix-acme-dns-hook'), action], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, TMPDIR: root, FENVIX_TLS_CONF: confFile, CERTBOT_DOMAIN: domain, CERTBOT_VALIDATION: value },
    });
  const lastBatch = () => {
    const files = execFileSync('bash', ['-c', `ls ${work}/batch-*.json | sort | tail -1`]).toString().trim();
    return JSON.parse(readFileSync(files, 'utf8'));
  };

  t('present: UPSERT of the TXT record of the wildcard base name in the zone, then waits for Route 53', () => {
    const r = hook('eu-west-1.db.example.com', 'abc_DEF-123', 'present');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(lastBatch()).toEqual({
      Changes: [{ Action: 'UPSERT', ResourceRecordSet: { Name: '_acme-challenge.eu-west-1.db.example.com', Type: 'TXT', TTL: 60, ResourceRecords: [{ Value: '"abc_DEF-123"' }] } }],
    });
    expect(readFileSync(join(work, 'zones'), 'utf8').trim().split('\n').pop()).toBe('Z0123456789ABC');
    expect(readFileSync(join(work, 'waits'), 'utf8')).toContain('route53 wait resource-record-sets-changed --id /change/C0123');
  });

  t('cleanup: DELETE of the same record; a failed cleanup is not an error', () => {
    expect(hook('api.example.com', 'xyz', 'cleanup').status).toBe(0);
    expect(lastBatch().Changes[0]).toMatchObject({ Action: 'DELETE', ResourceRecordSet: { Name: '_acme-challenge.api.example.com', Type: 'TXT' } });
    flag('r53-fail', true);
    const r = hook('api.example.com', 'xyz', 'cleanup');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('could not remove');
    expect(hook('api.example.com', 'xyz', 'present').status).not.toBe(0);
    flag('r53-fail', false);
  });

  t('dnsZone=db: the api challenge goes to the CNAME target inside db.<domain>', () => {
    const dbConf = join(root, 'tls-db.env');
    const c = loadConfig((k) => ({ ...BASE_CONTEXT, dnsZone: 'db' })[k]);
    writeFileSync(dbConf, [...tlsEnv({ config: c, region: 'eu-west-1', withApi: true, restartUnits: [] }), "ACME_ZONE_ID='Z0DB'"].join('\n') + '\n');
    expect(hook('api.example.com', 'v1', 'present', dbConf).status).toBe(0);
    expect(lastBatch().Changes[0].ResourceRecordSet.Name).toBe('_acme-challenge-api.db.example.com');
  });

  t('refuses a name that is not ours and a validation value that is not base64url, without calling AWS', () => {
    const calls = count('aws-calls');
    const r = hook('evil.example.org', 'abc', 'present');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no challenge record configured for 'evil.example.org'");
    expect(hook('api.example.com', 'a"},{"Action":"DELETE', 'present').status).toBe(1);
    expect(count('aws-calls')).toBe(calls);
  });
});

// The real certbot (not installed here by default): FENVIX_TEST_CERTBOT=/path/to/certbot runs fenvix-tls with it
// against a closed local port, to prove certbot accepts the exact command line. It never reaches Let's Encrypt.
const realCertbot = process.env.FENVIX_TEST_CERTBOT;
(realCertbot && hasTools ? test : test.skip)('the real certbot accepts the command line of fenvix-tls (no ACME server reached)', () => {
  const c = join(root, 'tls-real.env');
  writeFileSync(c, readFileSync(conf, 'utf8').replace(/^ACME_SERVER=.*$/m, "ACME_SERVER='http://127.0.0.1:9/directory'"));
  newServer();
  writeFileSync(join(work, 'secret.json'), '{}');
  const r = spawnSync('bash', [join(root, 'fenvix-tls')], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, TMPDIR: root, FENVIX_TLS_CONF: c, FENVIX_TLS_DIR: tls, FENVIX_ACME_STATE: state, FENVIX_TLS_OWNER: userInfo().username, FENVIX_CERTBOT: realCertbot!, FENVIX_ACME_HOOK: join(root, 'fenvix-acme-dns-hook') },
  });
  // eslint-disable-next-line no-console
  console.log('REAL CERTBOT OUTPUT:\n' + r.stderr);
  expect(r.status).toBe(1);
  expect(r.stderr).not.toMatch(/unrecognized arguments|error: argument|usage: certbot/i);
  expect(r.stderr).toMatch(/127\.0\.0\.1|Connection refused|Max retries/i);
  expect(r.stderr).toContain('no valid certificate installed');
});
