import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'fs';
import { createServer, Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { ARTIFACT_PREFIXES, ARTIFACT_SCRIPT, controlPlaneKey, engineKey } from '../lib/artifacts';
import { ENGINE_BINARY_NAME } from '../lib/engine-command';
import { publishSubjects } from '../lib/fenvix-stack';
import { b85decode, b85encode } from '../lib/user-data';
import { allStatements, synth, userDataText } from './helpers';

const asArray = (x: any): any[] => (x === undefined ? [] : [].concat(x));
const resourcesOf = (json: any, type: string): [string, any][] => Object.entries<any>(json.Resources).filter(([, r]) => r.Type === type);
const OTHER_BUCKET = 'fenvix-prod-eu-west-1-artifactsbucket1a2b3c4d-0123456789ab';

describe('artifacts bucket: private', () => {
  const { json } = synth();
  const [id, bucket] = resourcesOf(json, 'AWS::S3::Bucket').find(([k]) => k.startsWith('ArtifactsBucket'))!;
  const policy = resourcesOf(json, 'AWS::S3::BucketPolicy').find(([k]) => k.startsWith('ArtifactsBucketPolicy'))![1];
  const stmts: any[] = policy.Properties.PolicyDocument.Statement;

  test('blocks every kind of public access, has no ACLs, no website, no public statement', () => {
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    expect(bucket.Properties.OwnershipControls).toEqual({ Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] });
    expect(bucket.Properties.AccessControl).toBeUndefined();
    expect(bucket.Properties.WebsiteConfiguration).toBeUndefined();
    // Every statement naming everyone ("*") is a Deny.
    for (const s of stmts) if (JSON.stringify(s.Principal) === '{"AWS":"*"}' || s.Principal === '*') expect(s.Effect).toBe('Deny');
    expect(stmts.filter((s) => s.Effect === 'Allow')).toEqual([]);
  });

  test('encrypted, versioned, TLS only, with a lifecycle rule, kept when the stack is deleted', () => {
    expect(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm).toBe('AES256');
    expect(bucket.Properties.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    const rule = bucket.Properties.LifecycleConfiguration.Rules[0];
    expect(rule).toMatchObject({ Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 30 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } });
    expect(stmts).toContainEqual(expect.objectContaining({ Effect: 'Deny', Action: 's3:*', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }));
    expect(bucket.DeletionPolicy).toBe('Retain');
  });

  test('the name cannot be guessed: CloudFormation picks it (stack name + random suffix); the server gets it from the stack', () => {
    expect(bucket.Properties.BucketName).toBeUndefined();
    expect(userDataText(json).header).toContain(`FENVIX_ARTIFACTS_BUCKET='{"Ref":"${id}"}'`);
  });

  test('bucket policy: reads only by the engine roles of this env; each prefix written only by its publisher; nothing else written', () => {
    const read = stmts.find((s) => s.Sid === 'ReadOnlyByEngineRoles');
    expect(read.Effect).toBe('Deny');
    expect(asArray(read.Action)).toEqual(expect.arrayContaining(['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket']));
    const readers = JSON.stringify(read.Condition.ArnNotLike['aws:PrincipalArn']);
    expect(readers).toContain(':role/fenvix-prod-engine-*');
    expect(readers).toContain(':root');
    expect(readers).not.toContain('Publish');
    for (const [sid, prefix, role] of [
      ['WritesToPublishEnginePrefixByItsPublisherOnly', 'engine', 'PublishEngineRole'],
      ['WritesToPublishControlPlanePrefixByItsPublisherOnly', 'control-plane', 'PublishControlPlaneRole'],
    ]) {
      const w = stmts.find((s) => s.Sid === sid);
      expect(w.Effect).toBe('Deny');
      expect(JSON.stringify(w.Resource)).toContain(`/${prefix}/*`);
      const writers = JSON.stringify(w.Condition.ArnNotEquals['aws:PrincipalArn']);
      expect(writers).toContain(role);
      expect(writers).not.toMatch(/"EngineRole[0-9A-F]/);
    }
    const rest = stmts.find((s) => s.Sid === 'OtherWritesByRootOnly');
    expect(rest.Effect).toBe('Deny');
    expect(JSON.stringify(rest.NotResource)).toMatch(/engine\/\*.*control-plane\/\*/);
    expect(JSON.stringify(rest.Condition)).toContain(':root');
  });

  test('the prefixes the code uses are the ones the policies name', () => {
    expect(engineKey('v1', 'x86_64').startsWith(ARTIFACT_PREFIXES.engine)).toBe(true);
    expect(controlPlaneKey('v1', 'aarch64').startsWith(ARTIFACT_PREFIXES.controlPlane)).toBe(true);
    expect(engineKey('v1', 'x86_64')).toBe('engine/v1/x86_64/engine');
    // The key does not carry the binary's name: a rename touches ENGINE_BINARY_NAME only.
    expect(engineKey('v1', 'x86_64')).not.toContain(ENGINE_BINARY_NAME);
    expect(ARTIFACT_SCRIPT).toContain('"engine/$ver/$ARCH/engine"');
    expect(ARTIFACT_SCRIPT).toContain('"control-plane/$ver/$ARCH/control-plane.tar.gz"');
  });
});

describe('instance role: read only', () => {
  const { json } = synth();
  const engine = allStatements(json).filter((s) => s.owner.startsWith('EngineRole') && s.statement.Effect === 'Allow');
  const onArtifacts = engine.filter((s) => JSON.stringify(s.statement.Resource ?? '').includes('ArtifactsBucket'));

  test('GetObject on the engine/ and control-plane/ prefixes, nothing else on the artifacts bucket', () => {
    expect(onArtifacts).toHaveLength(1);
    expect(asArray(onArtifacts[0].statement.Action)).toEqual(['s3:GetObject']);
    const res = JSON.stringify(onArtifacts[0].statement.Resource);
    expect(res).toContain('/engine/*');
    expect(res).toContain('/control-plane/*');
    expect(res).not.toContain('/boot/');
  });

  test('no write, delete, list or ACL action of the engine role can reach the artifacts bucket', () => {
    for (const s of engine) {
      const actions = asArray(s.statement.Action) as string[];
      const write = actions.filter((a) => /^s3:(Put|Delete|List|Abort|Restore|Replicate)/.test(a));
      if (write.length) expect(JSON.stringify(s.statement.Resource)).not.toContain('ArtifactsBucket');
    }
  });

  test('a later region reads the first region bucket by name, read-only, and creates no bucket or publish role of its own', () => {
    const j = synth({ regions: 'eu-west-1,us-east-1', hostedZoneId: 'Z0123456789ABC', artifactsBucket: OTHER_BUCKET });
    void j;
    const { buildApp } = require('./helpers');
    const { stacks } = buildApp({ regions: 'eu-west-1,us-east-1', hostedZoneId: 'Z0123456789ABC', artifactsBucket: OTHER_BUCKET });
    const { Template } = require('aws-cdk-lib/assertions');
    const second = Template.fromStack(stacks[1]).toJSON();
    expect(resourcesOf(second, 'AWS::S3::Bucket').map(([k]) => k).filter((k) => k.startsWith('Artifacts'))).toEqual([]);
    expect(resourcesOf(second, 'AWS::IAM::OIDCProvider')).toEqual([]);
    expect(resourcesOf(second, 'AWS::IAM::Role').map(([, r]) => r.Properties.RoleName)).not.toContainEqual(expect.stringContaining('publish'));
    const read = allStatements(second).find((s) => s.statement.Sid === 'ReadReleaseArtifacts')!;
    expect(asArray(read.statement.Action)).toEqual(['s3:GetObject']);
    expect(JSON.stringify(read.statement.Resource)).toContain(`:s3:::${OTHER_BUCKET}/engine/*`);
    expect(userDataText(second).header).toContain(`FENVIX_ARTIFACTS_BUCKET='${OTHER_BUCKET}'`);
    // The second region installs from the first region's bucket.
    expect(userDataText(second).boot).toContain("ARTIFACTS_REGION='eu-west-1'");
  });
});

describe('publish roles: limited', () => {
  const { json } = synth();
  const roles = resourcesOf(json, 'AWS::IAM::Role').filter(([, r]) => r.Properties.RoleName.includes('publish'));
  const provider = resourcesOf(json, 'AWS::IAM::OIDCProvider');

  test('the stack creates the GitHub OIDC provider for sts.amazonaws.com only (unless one is given)', () => {
    expect(provider).toHaveLength(1);
    expect(provider[0][1].Properties.Url).toBe('https://token.actions.githubusercontent.com');
    expect(provider[0][1].Properties.ClientIdList).toEqual(['sts.amazonaws.com']);
    const arn = 'arn:aws:iam::865859654353:oidc-provider/token.actions.githubusercontent.com';
    const j = synth({ githubOidcProviderArn: arn }).json;
    expect(resourcesOf(j, 'AWS::IAM::OIDCProvider')).toEqual([]);
    for (const [, r] of resourcesOf(j, 'AWS::IAM::Role').filter(([, x]) => x.Properties.RoleName.includes('publish'))) {
      expect(r.Properties.AssumeRolePolicyDocument.Statement[0].Principal).toEqual({ Federated: arn });
    }
  });

  test('two roles, each trusted only by one repository on its named branches, with the exact sub (no wildcard) and aud', () => {
    expect(roles.map(([, r]) => r.Properties.RoleName).sort()).toEqual(['fenvix-prod-publish-control-plane', 'fenvix-prod-publish-engine']);
    const want: Record<string, string[]> = {
      'fenvix-prod-publish-engine': ['repo:Mircoguidetti/fenvix-engine:ref:refs/heads/main'],
      'fenvix-prod-publish-control-plane': ['repo:Mircoguidetti/fenvix-app:ref:refs/heads/main'],
    };
    for (const [, r] of roles) {
      const trust = r.Properties.AssumeRolePolicyDocument.Statement;
      expect(trust).toHaveLength(1);
      expect(trust[0].Action).toBe('sts:AssumeRoleWithWebIdentity');
      expect(trust[0].Principal).toEqual({ Federated: { 'Fn::GetAtt': [expect.stringMatching(/^GithubOidc/), 'Arn'] } });
      expect(Object.keys(trust[0].Condition)).toEqual(['StringEquals']);
      expect(trust[0].Condition.StringEquals).toEqual({
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': want[r.Properties.RoleName],
      });
      expect(JSON.stringify(trust)).not.toMatch(/StringLike|\*/);
      expect(r.Properties.MaxSessionDuration).toBe(3600);
      expect(r.Properties.ManagedPolicyArns).toBeUndefined();
    }
  });

  test('with the GitHub ids set, the roles also trust the id form of the subject GitHub now sends', () => {
    expect(publishSubjects('Mircoguidetti/fenvix-app', ['main'], { ownerId: '17613795', repoId: '1434576189' })).toEqual([
      'repo:Mircoguidetti/fenvix-app:ref:refs/heads/main',
      'repo:Mircoguidetti@17613795/fenvix-app@1434576189:ref:refs/heads/main',
    ]);
    expect(publishSubjects('Mircoguidetti/fenvix-app', ['main'], { ownerId: '17613795' })).toEqual(['repo:Mircoguidetti/fenvix-app:ref:refs/heads/main']);
    expect(() => synth({ githubOwnerId: 'abc' })).toThrow(/must be a number/);
  });

  test('more branches are listed one by one; a wildcard branch is refused', () => {
    expect(publishSubjects('Mircoguidetti/fenvix-engine', ['main', 'release-pipeline'])).toEqual([
      'repo:Mircoguidetti/fenvix-engine:ref:refs/heads/main',
      'repo:Mircoguidetti/fenvix-engine:ref:refs/heads/release-pipeline',
    ]);
    expect(() => synth({ engineRepoBranches: 'main,*' })).toThrow(/no wildcards/);
    expect(() => synth({ controlPlaneRepoBranches: 'feature/*' })).toThrow(/no wildcards/);
    expect(() => synth({ engineRepo: 'Mircoguidetti/*' })).toThrow(/owner\/repository/);
  });

  test('each role may only PutObject under its own prefix: no read, list, delete, nor the other prefix', () => {
    for (const [roleId, r] of roles) {
      const prefix = r.Properties.RoleName.endsWith('engine') ? 'engine' : 'control-plane';
      const other = prefix === 'engine' ? 'control-plane' : 'engine';
      const stmts = allStatements(json).filter((s) => s.type === 'AWS::IAM::Policy' && JSON.stringify(json.Resources[s.owner].Properties.Roles).includes(roleId));
      expect(stmts).toHaveLength(1);
      expect(stmts[0].statement.Action).toBe('s3:PutObject');
      const res = JSON.stringify(stmts[0].statement.Resource);
      expect(res).toContain(`/${prefix}/*`);
      expect(res).not.toContain(`/${other}/`);
      expect(res).not.toContain('DataBucket');
    }
  });
});

describe('fenvix-artifact on the server (run for real with stand-ins for aws, docker and systemctl)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fenvix-art-'));
  const bin = join(root, 'bin');
  const store = join(root, 's3');
  mkdirSync(bin);
  mkdirSync(store);
  let server: Server;
  let port = 0;

  // `aws s3api get-object ... --key K OUT`: copies <store>/K to OUT (as S3 would), fails if absent.
  writeFileSync(join(bin, 'aws'), `#!/bin/bash\nk=""; for ((i=1;i<=$#;i++)); do [ "\${!i}" = --key ] && { j=$((i+1)); k="\${!j}"; }; done\nout="\${@: -1}"\n[ -f "${store}/$k" ] || { echo "NoSuchKey" >&2; exit 254; }\ncp "${store}/$k" "$out"\n`);
  // systemctl: is-active is true when the engine link points at a file whose content starts with "good" (a stand-in for "the new version starts").
  writeFileSync(join(bin, 'systemctl'), `#!/bin/bash\ncase "$1" in\n  is-active) head -c4 "$(readlink -f "${root}/opt/bin/eng")" | grep -q good ;;\n  show) echo 0 ;;\n  *) echo "systemctl $*" >> "${root}/systemctl.log" ;;\nesac\n`);
  writeFileSync(join(bin, 'docker'), `#!/bin/bash\ncase "$1" in\n  load) echo loaded >> "${root}/docker.log" ;;\n  image) [ "$3" != "fenvix-control-plane:missing" ] ;;\n  inspect) echo healthy ;;\nesac\n`);
  for (const f of ['aws', 'systemctl', 'docker']) chmodSync(join(bin, f), 0o755);

  const envFile = join(root, 'artifacts.env');
  const script = join(root, 'fenvix-artifact');
  writeFileSync(script, ARTIFACT_SCRIPT.split('/etc/fenvix/artifacts.env').join(envFile));
  chmodSync(script, 0o755);
  const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
  const put = (key: string, body: string) => {
    mkdirSync(join(store, key, '..'), { recursive: true });
    writeFileSync(join(store, key), body);
    return sha(body);
  };
  const run = (...args: string[]) =>
    spawnSync(script, args, { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HEALTH_TRIES: '3', HEALTH_SLEEP: '0', HEALTH_STABLE: '0' } });
  const link = join(root, 'opt/bin/eng');

  beforeAll(async () => {
    server = createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as any).port;
    mkdirSync(join(root, 'opt/bin'), { recursive: true });
    writeFileSync(
      envFile,
      [
        "ARTIFACTS_BUCKET='b'", "ARTIFACTS_REGION='eu-west-1'", "ARCH='x86_64'", `ENGINE_LINK='${link}'`, `ENGINE_BINARY_NAME='${ENGINE_BINARY_NAME}'`,
        `ENGINE_RELEASES='${root}/opt/releases'`, "CP_REPO='fenvix-control-plane'", `CP_IMAGE_FILE='${root}/cp-image'`, `MONGO_PORT='${port}'`,
      ].join('\n') + '\n',
    );
  });
  afterAll(() => server.close());

  test('the script is valid bash', () => {
    expect(spawnSync('bash', ['-n', script]).status).toBe(0);
  });

  test('a wrong SHA-256 stops the install with a clear message and installs nothing', () => {
    put(engineKey('v1', 'x86_64'), 'good engine v1');
    const r = run('install', 'engine', 'v1', 'f'.repeat(64));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SHA-256 MISMATCH for engine/v1/x86_64/engine: expected ffff');
    expect(existsSync(link)).toBe(false);
    expect(readdirSync(join(root, 'opt/releases/v1'))).toEqual([]);
  });

  test('a wrong SHA-256 stops the boot before any service is enabled (set -e)', () => {
    const boot = join(root, 'boot-tail.sh');
    writeFileSync(boot, `set -euo pipefail\n${script} install engine v1 ${'0'.repeat(64)}\necho SERVICES-ENABLED\n`);
    const r = spawnSync('bash', [boot], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('SERVICES-ENABLED');
    expect(r.stderr).toContain('Nothing installed, nothing started or replaced');
  });

  test('a missing artifact (not published, or no access) stops with its key', () => {
    const r = run('install', 'engine', 'v9', 'a'.repeat(64));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('cannot download s3://b/engine/v9/x86_64/engine');
  });

  test('bad version or hash on the command line is refused before anything is downloaded', () => {
    expect(run('install', 'engine', "v1;rm -rf /", 'a'.repeat(64)).stderr).toContain('bad version');
    expect(run('install', 'engine', 'v1', 'A'.repeat(64)).stderr).toContain('64 lowercase hex');
  });

  test('the right SHA-256 installs the binary under its version and points the engine path at it', () => {
    const h = sha('good engine v1');
    const r = run('install', 'engine', 'v1', h);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`engine/v1/x86_64/engine: SHA-256 ${h} matches`);
    expect(readlinkSync(link)).toBe(join(root, 'opt/releases/v1', ENGINE_BINARY_NAME));
  });

  test('update: a version that does not come up is replaced by the previous one, which is restarted', () => {
    const h2 = put(engineKey('v2', 'x86_64'), 'bad! engine v2');
    const r = run('update', 'engine', 'v2', h2);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('did not come up healthy: going back to the previous version');
    expect(r.stderr).toContain('rolled back: the previous version runs again');
    expect(readlinkSync(link)).toBe(join(root, 'opt/releases/v1', ENGINE_BINARY_NAME));
    expect(readFileSync(join(root, 'systemctl.log'), 'utf8').match(/restart fenvix-engine.service/g)).toHaveLength(2);
  });

  test('update: a healthy new version stays, the old one is kept for a rollback', () => {
    const h3 = put(engineKey('v3', 'x86_64'), 'good engine v3');
    const r = run('update', 'engine', 'v3', h3);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('update done: engine v3 is running');
    expect(readlinkSync(link)).toBe(join(root, 'opt/releases/v3', ENGINE_BINARY_NAME));
    expect(readFileSync(join(root, 'opt/releases/previous'), 'utf8').trim()).toBe(join(root, 'opt/releases/v1', ENGINE_BINARY_NAME));
    const back = run('rollback', 'engine');
    expect(back.stdout).toContain('rollback done');
    expect(readlinkSync(link)).toBe(join(root, 'opt/releases/v1', ENGINE_BINARY_NAME));
  });

  test('control plane: archive checked, loaded, and the unit pointed at the loaded tag; a wrong hash loads nothing', () => {
    const h = put(controlPlaneKey('c1', 'x86_64'), 'image archive c1');
    expect(run('install', 'control-plane', 'c1', 'e'.repeat(64)).stderr).toContain('SHA-256 MISMATCH');
    expect(existsSync(join(root, 'docker.log'))).toBe(false);
    expect(run('install', 'control-plane', 'c1', h).status).toBe(0);
    expect(readFileSync(join(root, 'cp-image'), 'utf8')).toBe('CONTROL_PLANE_IMAGE=fenvix-control-plane:c1\n');
    const hm = put(controlPlaneKey('missing', 'x86_64'), 'archive without the tag');
    expect(run('install', 'control-plane', 'missing', hm).stderr).toContain('did not contain the image fenvix-control-plane:missing');
    expect(readFileSync(join(root, 'cp-image'), 'utf8')).toBe('CONTROL_PLANE_IMAGE=fenvix-control-plane:c1\n');
  });
});

describe('boot script and user data', () => {
  const { json } = synth();
  const { boot } = userDataText(json);
  const lines = boot.split('\n');
  const at = (p: (l: string) => boolean) => lines.findIndex(p);

  test('both artifacts are installed (and checked) before any service is enabled; the hash comes from the stack settings', () => {
    const eng = at((l) => l === '/usr/local/bin/fenvix-artifact install engine "$ENGINE_VERSION" "$ENGINE_SHA256"');
    const cp = at((l) => l === '/usr/local/bin/fenvix-artifact install control-plane "$CONTROL_PLANE_VERSION" "$CONTROL_PLANE_SHA256"');
    const enable = at((l) => l.startsWith('systemctl enable --now fenvix-engine.service'));
    expect(eng).toBeGreaterThan(0);
    expect(cp).toBeGreaterThan(eng);
    expect(enable).toBeGreaterThan(cp);
    expect(boot).toContain(`ENGINE_SHA256='${'e'.repeat(64)}'`);
    expect(boot).toContain(`CONTROL_PLANE_SHA256='${'c'.repeat(64)}'`);
    // Nothing in the bucket (no .sha256 file, no listing) is a source of the expected hash.
    expect(ARTIFACT_SCRIPT).not.toMatch(/\.sha256|SHA256SUMS|list-objects|head-object/);
  });

  test('the control plane runs the loaded image, never pulls one; nothing installs from the network but the bucket', () => {
    expect(boot).toContain('EnvironmentFile=/etc/fenvix/control-plane-image');
    expect(boot).toContain('--env-file /etc/fenvix/control-plane.env ${CONTROL_PLANE_IMAGE}');
    expect(boot).not.toMatch(/docker pull [^\n]*control-plane/);
    expect(boot).not.toMatch(/ghcr\.io|registry/);
  });

  test('the server refuses an architecture other than the one the stack was made for', () => {
    expect(boot).toContain(`[ "$(uname -m)" = 'x86_64' ]`);
    expect(userDataText(synth({ instanceType: 'c7g.large' }).json).boot).toContain("ARCH='aarch64'");
  });

  test('settings: all four release pins or none', () => {
    expect(() => synth({ engineSha256: '' })).toThrow(/all of engineVersion, engineSha256, controlPlaneVersion, controlPlaneSha256 or none.*engineSha256/);
    expect(() => synth({ engineVersion: '', engineSha256: '', controlPlaneVersion: '', controlPlaneSha256: '' })).not.toThrow();
  });

  test('base85 is the same as Python base64.b85encode, and decodes back', () => {
    const data = Buffer.from(Array.from({ length: 1003 }, (_, i) => (i * 7919 + 13) % 256));
    const ours = b85encode(data);
    const py = spawnSync('python3', ['-I', '-c', 'import base64,sys; sys.stdout.write(base64.b85encode(sys.stdin.buffer.read()).decode())'], { input: data });
    expect(py.status).toBe(0);
    expect(ours).toBe(py.stdout.toString());
    expect(b85decode(ours).equals(data)).toBe(true);
    for (const n of [0, 1, 2, 3, 4, 5]) expect(b85decode(b85encode(data.subarray(0, n))).equals(data.subarray(0, n))).toBe(true);
  });
});
