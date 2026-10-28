import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir, userInfo } from 'os';
import { join } from 'path';
import { ACME_DIRECTORY, tlsScript } from '../lib/acme';

/**
 * Runs the real fenvix-tls script with real openssl, a fake `lego` (issues a self-signed certificate for the names it
 * is given, valid for `days` days) and a fake `aws` (SSM get/put on files). Nothing leaves the machine.
 */
const hasTools = ['openssl', 'flock', 'base64', 'tar'].every((t) => spawnSync('which', [t]).status === 0);
const t = hasTools ? test : test.skip;
const root = mkdtempSync(join(tmpdir(), 'fenvix-tls-'));
const bin = join(root, 'bin');
const DOMAINS = ['*.eu-central-1.db.example.com', 'console.example.com'];

const FAKE_LEGO = String.raw`#!/bin/bash
W="$FAKE_DIR"
echo "$*" >> "$W/lego.calls"
echo "AWS_REGION=$AWS_REGION AWS_HOSTED_ZONE_ID=$AWS_HOSTED_ZONE_ID" >> "$W/lego.env"
if [ -f "$W/lego.fail" ]; then
  echo "time=x level=ERROR msg=\"acme: error presenting token\" token=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdEFGH"
  echo "-----BEGIN PRIVATE KEY----- (a broken client printing a key)"
  exit 1
fi
path=""; email=""; doms=()
while [ $# -gt 0 ]; do case "$1" in --path) path="$2"; shift;; --email) email="$2"; shift;; --domains) doms+=("$2"); shift;; esac; shift; done
mkdir -p "$path/certificates" "$path/accounts/acme/$email"
[ -s "$path/accounts/acme/$email/account.key" ] || openssl ecparam -name prime256v1 -genkey -noout -out "$path/accounts/acme/$email/account.key" 2>/dev/null
echo "{\"email\": \"$email\"}" > "$path/accounts/acme/$email/account.json"
san="$(printf 'DNS:%s,' "${'$'}{doms[@]}")"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$path/certificates/fenvix.key" -out "$W/leaf.crt" \
  -days "$(cat "$W/days" 2>/dev/null || echo 90)" -subj "/CN=${'$'}{doms[0]}" -addext "subjectAltName=${'$'}{san%,}" 2>/dev/null
cat "$W/leaf.crt" "$W/issuer.crt" > "$path/certificates/fenvix.crt"
echo "level=INFO msg=\"Server responded with a certificate.\""
`;

const FAKE_AWS = String.raw`#!/bin/bash
W="$FAKE_DIR"
echo "$*" >> "$W/aws.calls"
op="$2"; name=""; value=""
while [ $# -gt 0 ]; do case "$1" in --name) name="$2"; shift;; --value) value="$2"; shift;; esac; shift; done
store="$W/ssm$(echo "$name" | tr / _)"
case "$op" in
  get-parameter)
    [ -f "$W/ssm.read.fail" ] && { echo "An error occurred (AccessDeniedException) when calling the GetParameter operation: not authorized" >&2; exit 254; }
    [ -f "$store" ] || { echo "An error occurred (ParameterNotFound) when calling the GetParameter operation: " >&2; exit 254; }
    cat "$store"; echo;;
  put-parameter)
    [ -f "$W/ssm.put.fail" ] && { echo "An error occurred (AccessDeniedException) when calling the PutParameter operation" >&2; exit 254; }
    case "$value" in file://*) cp "${'$'}{value#file://}" "$store";; *) echo "value not passed as a file" >&2; exit 99;; esac;;
esac
`;

interface Env {
  w: string;
  pem: string;
  data: string;
  script: string;
}

/** A new server: empty disk. `shared` keeps the same SSM store (another instance of the same stack). */
function server(opts: { staging?: boolean; shared?: string; units?: string[] } = {}): Env {
  const w = opts.shared ?? mkdtempSync(join(root, 'srv-'));
  const n = readdirSync(w).filter((f) => f.startsWith('host-')).length;
  const host = join(w, `host-${n}`);
  mkdirSync(join(host, 'tls'), { recursive: true });
  mkdirSync(join(host, 'tmp'), { recursive: true });
  writeFileSync(join(host, 'zone-id'), 'Z0123456789ABC\n');
  if (!existsSync(join(w, 'issuer.crt'))) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(w, 'issuer.key'), '-out', join(w, 'issuer.crt'), '-days', '9', '-subj', '/CN=Fake Intermediate'], { stdio: 'ignore' });
  }
  const pem = join(host, 'tls', 'engine.pem');
  const data = join(host, 'acme');
  const script = join(host, 'fenvix-tls');
  writeFileSync(
    script,
    tlsScript({
      region: 'eu-central-1',
      staging: opts.staging ?? false,
      email: 'certs@example.com',
      domains: DOMAINS,
      stateParameter: '/fenvix-tls/prod/acme-state',
      restartUnits: opts.units ?? ['fenvix-engine.service', 'fenvix-proxy.service'],
      pem,
      dataDir: data,
      owner: userInfo().username,
      tmpBase: join(host, 'tmp'),
      zoneIdFile: join(host, 'zone-id'),
    }),
  );
  return { w, pem, data, script };
}

const outputs: string[] = [];
function run(e: Env, ...args: string[]) {
  const r = spawnSync('bash', [e.script, ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: e.w, HOME: e.w },
  });
  outputs.push(r.stdout + r.stderr);
  return { status: r.status, out: r.stdout + r.stderr, stderr: r.stderr };
}
const calls = (e: Env, f: 'lego.calls' | 'aws.calls') => (existsSync(join(e.w, f)) ? readFileSync(join(e.w, f), 'utf8').trim().split('\n').filter(Boolean) : []);
const puts = (e: Env) => calls(e, 'aws.calls').filter((l) => l.startsWith('ssm put-parameter'));
const fp = (f: string) => execFileSync('openssl', ['x509', '-in', f, '-noout', '-fingerprint', '-sha256']).toString().trim();
const flag = (e: Env, name: string, on: boolean) => (on ? writeFileSync(join(e.w, name), '') : rmSync(join(e.w, name), { force: true }));
const keyBodies = (e: Env): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.key') || f === 'engine.pem') {
        for (const l of readFileSync(p, 'utf8').split('\n')) if (l.length > 20 && !l.startsWith('-----')) out.push(l);
      }
    }
  };
  walk(e.w);
  return out;
};
const allKeys: string[] = [];

beforeAll(() => {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'lego'), FAKE_LEGO);
  writeFileSync(join(bin, 'aws'), FAKE_AWS);
  writeFileSync(join(bin, 'systemctl'), '#!/bin/bash\necho "RESTART $*"\necho "$*" >> "$FAKE_DIR/restarts"\n');
  for (const f of ['lego', 'aws', 'systemctl']) chmodSync(join(bin, f), 0o755);
});

afterEach(() => {
  // Keys of every server made so far: the scripts must never have printed any of them.
  for (const d of readdirSync(root)) if (d.startsWith('srv-')) allKeys.push(...keyBodies({ w: join(root, d) } as Env));
});

describe('fenvix-tls (real script, fake lego and aws CLI)', () => {
  let a: Env;

  t('first start: one request to Let\'s Encrypt, engine PEM = chain + key with mode 0600, saved in SSM, nothing restarted', () => {
    a = server();
    const r = run(a);
    expect(r.status).toBe(0);
    expect(r.out).toContain('no certificate saved in /fenvix-tls/prod/acme-state yet');
    expect(r.out).toContain('certificate installed (none -> ');
    expect(r.out).toContain('certificate saved in /fenvix-tls/prod/acme-state');
    const lego = calls(a, 'lego.calls');
    expect(lego).toHaveLength(1);
    expect(lego[0]).toMatch(/^run --accept-tos --server https:\/\/acme-v02\.api\.letsencrypt\.org\/directory --email certs@example\.com --path \S+ --dns route53 --key-type ec256 --cert\.name fenvix --renew-days 30 --ari-disable --no-random-sleep --force-cert-domains --log\.format text --domains \*\.eu-central-1\.db\.example\.com --domains console\.example\.com$/);
    expect(readFileSync(join(a.w, 'lego.env'), 'utf8')).toBe('AWS_REGION=eu-central-1 AWS_HOSTED_ZONE_ID=Z0123456789ABC\n');
    const pem = readFileSync(a.pem, 'utf8');
    expect(pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(pem).toMatch(/BEGIN (EC )?PRIVATE KEY/);
    expect((statSync(a.pem).mode & 0o777).toString(8)).toBe('600');
    expect((statSync(a.data).mode & 0o777).toString(8)).toBe('700');
    // The key in the PEM belongs to the leaf certificate.
    const pub = (args: string[]) => execFileSync('openssl', args).toString();
    expect(pub(['pkey', '-in', a.pem, '-pubout'])).toBe(pub(['x509', '-in', a.pem, '-noout', '-pubkey']));
    expect(puts(a)).toHaveLength(1);
    expect(puts(a)[0]).toContain('--type SecureString --tier Advanced --overwrite --value file://');
    expect(existsSync(join(a.w, 'restarts'))).toBe(false);
    expect(r.out).not.toMatch(/PRIVATE KEY|BEGIN/);
  });

  t('valid certificate (timer run): reused, no request to Let\'s Encrypt, not saved again, nothing restarted', () => {
    const r = run(a, '--restart-on-change');
    expect(r.status).toBe(0);
    expect(r.out).toContain('certificate valid for more than 30 days: no request to Let\'s Encrypt');
    expect(r.out).toContain('certificate unchanged');
    expect(calls(a, 'lego.calls')).toHaveLength(1);
    expect(puts(a)).toHaveLength(1);
    expect(r.out).not.toContain('RESTART');
  });

  t('replaced instance: certificate and account restored from SSM, no request to Let\'s Encrypt', () => {
    const before = fp(a.pem);
    const b = server({ shared: a.w });
    const r = run(b);
    expect(r.status).toBe(0);
    expect(r.out).toContain('certificate restored from /fenvix-tls/prod/acme-state');
    expect(calls(b, 'lego.calls')).toHaveLength(1);
    expect(fp(b.pem)).toBe(before);
    expect(readdirSync(join(b.data, 'accounts', 'acme'))).toEqual(['certs@example.com']);
    expect(puts(b)).toHaveLength(1);
  });

  t('fewer than 30 days left: renewed on the timer run, installed, engine and terminator restarted once', () => {
    const e = server();
    writeFileSync(join(e.w, 'days'), '20');
    expect(run(e).status).toBe(0);
    writeFileSync(join(e.w, 'days'), '90');
    const old = fp(e.pem);
    const r = run(e, '--restart-on-change');
    expect(r.status).toBe(0);
    expect(calls(e, 'lego.calls')).toHaveLength(2);
    expect(fp(e.pem)).not.toBe(old);
    expect(r.out).toContain('certificate installed (');
    expect(readFileSync(join(e.w, 'restarts'), 'utf8')).toBe('try-restart fenvix-engine.service fenvix-proxy.service\n');
    expect(puts(e)).toHaveLength(2);
    const again = run(e, '--restart-on-change');
    expect(calls(e, 'lego.calls')).toHaveLength(2);
    expect(again.out).not.toContain('RESTART');
  });

  t('restored certificate close to expiry: renewed with the restored account', () => {
    const e = server();
    writeFileSync(join(e.w, 'days'), '10');
    run(e);
    writeFileSync(join(e.w, 'days'), '90');
    const accountKey = readFileSync(join(e.data, 'accounts', 'acme', 'certs@example.com', 'account.key'), 'utf8');
    const b = server({ shared: e.w });
    const r = run(b);
    expect(r.status).toBe(0);
    expect(r.out).toContain('certificate restored');
    expect(calls(b, 'lego.calls')).toHaveLength(2);
    expect(readFileSync(join(b.data, 'accounts', 'acme', 'certs@example.com', 'account.key'), 'utf8')).toBe(accountKey);
  });

  t('issuance fails and there is no certificate: exit 1 with a clear message, no PEM, nothing secret printed, no retry for 20 minutes', () => {
    const e = server();
    flag(e, 'lego.fail', true);
    const r = run(e);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('fenvix-tls: the request to Let\'s Encrypt failed:');
    expect(r.stderr).toContain('fenvix-tls: FATAL: no valid certificate. The engine and the TLS terminator do not start without a certificate');
    expect(r.stderr).toContain('[redacted]');
    expect(r.out).not.toContain('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(r.out).not.toMatch(/PRIVATE KEY|BEGIN/);
    expect(existsSync(e.pem)).toBe(false);
    // systemd restarts the engine every 5 s: the script must not hit Let's Encrypt's failed-validation limit.
    const again = run(e);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('failed less than 20 minutes ago');
    expect(calls(e, 'lego.calls')).toHaveLength(1);
  });

  t('renewal fails while the installed certificate is still valid: kept, exit 0, nothing restarted', () => {
    const e = server();
    writeFileSync(join(e.w, 'days'), '20');
    run(e);
    flag(e, 'lego.fail', true);
    const old = fp(e.pem);
    const r = run(e, '--restart-on-change');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('the request to Let\'s Encrypt failed');
    expect(fp(e.pem)).toBe(old);
    expect(r.out).not.toContain('RESTART');
  });

  t('SSM unreadable and nothing on disk: exit 1 without asking Let\'s Encrypt', () => {
    const e = server();
    flag(e, 'ssm.read.fail', true);
    const r = run(e);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('cannot read /fenvix-tls/prod/acme-state');
    expect(r.stderr).toContain('AccessDeniedException');
    expect(r.stderr).toContain('FATAL: no certificate on this server and the saved one cannot be read.');
    expect(calls(e, 'lego.calls')).toHaveLength(0);
  });

  t('saving to SSM fails: warning, the service starts, saved at the next run', () => {
    const e = server();
    flag(e, 'ssm.put.fail', true);
    const r = run(e);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('WARNING: cannot save the certificate in /fenvix-tls/prod/acme-state');
    flag(e, 'ssm.put.fail', false);
    const r2 = run(e);
    expect(r2.out).toContain('certificate saved in');
    expect(calls(e, 'lego.calls')).toHaveLength(1);
  });

  t('staging and production certificates are not mixed: a saved staging certificate is not used by a production server', () => {
    const s = server({ staging: true });
    expect(run(s).status).toBe(0);
    expect(calls(s, 'lego.calls')[0]).toContain(`--server ${ACME_DIRECTORY.staging} `);
    const p = server({ shared: s.w });
    const r = run(p);
    expect(r.out).toContain('the certificate in /fenvix-tls/prod/acme-state is for other names or another ACME server: not used');
    expect(calls(p, 'lego.calls')).toHaveLength(2);
    expect(calls(p, 'lego.calls')[1]).toContain(`--server ${ACME_DIRECTORY.production} `);
  });

  t('a region without the control plane restarts the engine only', () => {
    const e = server({ units: ['fenvix-engine.service'] });
    writeFileSync(join(e.w, 'days'), '20');
    run(e);
    writeFileSync(join(e.w, 'days'), '90');
    run(e, '--restart-on-change');
    expect(readFileSync(join(e.w, 'restarts'), 'utf8')).toBe('try-restart fenvix-engine.service\n');
  });

  t('no output of any run contains a line of any private key', () => {
    for (const d of readdirSync(root)) if (d.startsWith('srv-')) allKeys.push(...keyBodies({ w: join(root, d) } as Env));
    expect(allKeys.length).toBeGreaterThan(10);
    const all = outputs.join('\n');
    for (const k of allKeys) expect(all.includes(k)).toBe(false);
  });
});
