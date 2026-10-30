/**
 * The one-button deploy: .github/workflows/deploy-control-plane.yml and the two policy files of the role it uses
 * (github-deploy-trust.json, github-deploy-guardrails.json). The workflow is never run here; what can be checked
 * without GitHub and without AWS is checked: the YAML parses, every `run` is valid bash, the approval gate is where
 * it has to be, the build is not duplicated, the health check uses the endpoints the control plane really serves, and
 * the trust policy names the repository and the environment that the workflow actually uses.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { synth } from './helpers';

const repoRoot = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');
const readJson = (p: string) => JSON.parse(read(p));

const deployText = read('.github/workflows/deploy-control-plane.yml');
const releaseText = read('.github/workflows/release-control-plane.yml');
const deploy: any = yaml.load(deployText);
const release: any = yaml.load(releaseText);
const cdkJson = readJson('infra/cdk.json');
const trust = readJson('infra/github-deploy-trust.json');
const guardrails = readJson('infra/github-deploy-guardrails.json');

// js-yaml turns the `on:` key into the boolean true (YAML 1.1); GitHub reads it as the string "on".
const triggers = (w: any) => w.on ?? w[true as unknown as string];
const steps = (job: any): any[] => job.steps ?? [];
const runsOf = (w: any): { where: string; script: string }[] =>
  Object.entries<any>(w.jobs).flatMap(([name, job]) =>
    steps(job)
      .map((s, i) => ({ where: `${name}.steps[${i}] ${s.name ?? s.uses ?? ''}`, script: s.run as string }))
      .filter((s) => typeof s.script === 'string'),
  );
const arr = (x: any): any[] => (x === undefined ? [] : [].concat(x));

describe('deploy-control-plane.yml', () => {
  test('runs only when started by hand, one run at a time, with no permission by default', () => {
    expect(Object.keys(triggers(deploy))).toEqual(['workflow_dispatch']);
    expect(deploy.permissions).toEqual({});
    expect(deploy.concurrency['cancel-in-progress']).toBe(false);
    expect(Object.keys(deploy.jobs)).toEqual(['checks', 'release', 'deploy']);
  });

  test('has the inputs the founder needs and nothing that could point it at another repository', () => {
    const inputs = triggers(deploy).workflow_dispatch.inputs;
    expect(Object.keys(inputs).sort()).toEqual(
      ['allow_iam_changes', 'engine_sha256', 'engine_version', 'ref', 'rollback_sha256', 'rollback_version'].sort(),
    );
    expect(inputs.ref.default).toBe('main');
    expect(inputs.allow_iam_changes).toMatchObject({ type: 'boolean', default: false });
    // No input chooses an account, a role, a bucket or a region: those come from the environment and from cdk.json.
    for (const forbidden of ['role', 'account', 'bucket', 'region', 'stack']) {
      expect(Object.keys(inputs).some((k) => k.includes(forbidden))).toBe(false);
    }
  });

  test('exactly one job touches AWS and it is gated by the production environment (one Approve click)', () => {
    const gated = Object.entries<any>(deploy.jobs).filter(([, j]) => j.environment !== undefined);
    // More than one job on the same protected environment would ask the founder to approve more than once.
    expect(gated.map(([n]) => n)).toEqual(['deploy']);
    expect(deploy.jobs.deploy.environment).toBe('production');
    expect(deploy.jobs.deploy.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    // The jobs before it must not be able to ask AWS for anything.
    expect(deploy.jobs.checks.permissions).toEqual({ contents: 'read' });
    expect(runsOf({ jobs: { checks: deploy.jobs.checks } }).every((r) => !/\baws\b/.test(r.script))).toBe(true);
  });

  test('the deploy job runs the tests, the plan and the deploy, in that order, and checks the API at the end', () => {
    const names = steps(deploy.jobs.deploy).map((s) => String(s.name ?? s.uses));
    const idx = (re: RegExp) => names.findIndex((n) => re.test(n));
    const order = [/checkout/, /settings/, /Log in to AWS/, /production runs now/, /plan without touching AWS/, /cdk diff/, /^Deploy/, /API is healthy/, /summary/];
    const positions = order.map((re) => idx(re));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b));
  });

  test('builds and publishes through release-control-plane.yml instead of a second copy of it', () => {
    expect(deploy.jobs.release.uses).toBe('./.github/workflows/release-control-plane.yml');
    expect(deploy.jobs.release.secrets).toBe('inherit');
    expect(deploy.jobs.release.with).toMatchObject({ arch: 'x86_64', publish: true });
    // Comments may name them; no step may.
    const deployCode = deployText.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    for (const duplicated of ['docker build', 'docker save', 'put-object', 'ARTIFACTS_BUCKET', 'AWS_PUBLISH_ROLE_ARN']) {
      expect(deployCode).not.toContain(duplicated);
    }
    // And the release workflow really offers what the deploy job reads back.
    expect(Object.keys(triggers(release).workflow_call.outputs).sort()).toEqual(['key', 'sha256', 'version']);
    expect(release.jobs.build.outputs).toEqual({
      version: '${{ steps.meta.outputs.version }}',
      sha256: '${{ steps.meta.outputs.sha256 }}',
      key: '${{ steps.meta.outputs.key }}',
    });
  });

  test('the engine is left alone: its version and SHA-256 come from the running stack, never from an input', () => {
    const deployStep = steps(deploy.jobs.deploy).find((s) => String(s.name).startsWith('Deploy'));
    expect(deployStep.env.FENVIX_ENGINE_VERSION).toBe('${{ steps.current.outputs.engine_version }}');
    expect(deployStep.env.FENVIX_ENGINE_SHA256).toBe('${{ steps.current.outputs.engine_sha256 }}');
    expect(deployStep.env.FENVIX_CONTROL_PLANE_VERSION).toBe('${{ steps.target.outputs.version }}');
    expect(deployStep.env.FENVIX_CONTROL_PLANE_SHA256).toBe('${{ steps.target.outputs.sha256 }}');
    // The stack outputs it reads for them are the ones the stack publishes.
    const current = steps(deploy.jobs.deploy).find((s) => String(s.name).includes('production runs now'));
    for (const key of ['EngineVersion', 'EngineSha256', 'ControlPlaneVersion', 'ControlPlaneSha256', 'ControlPlaneUrl']) {
      expect(current.run).toContain(key);
    }
  });

  test('the plan is written to the job summary and stops the run on an IAM or security group change', () => {
    const diff = steps(deploy.jobs.deploy).find((s) => s.id === 'diff');
    expect(diff.run).toContain('cdk diff');
    expect(diff.run).toContain('GITHUB_STEP_SUMMARY');
    for (const heading of ['IAM Statement Changes', 'IAM Policy Changes', 'Security Group Changes']) {
      expect(diff.run).toContain(heading);
    }
    expect(diff.env.ALLOW_IAM_CHANGES).toBe('${{ inputs.allow_iam_changes }}');
    expect(diff.run).toMatch(/ALLOW_IAM_CHANGES" != "true"[\s\S]*exit 1/);
    // The deploy step comes after it and never gets a chance to run when the brake fired.
    expect(steps(deploy.jobs.deploy).find((s) => String(s.name).startsWith('Deploy')).if).toBeUndefined();
  });

  test('the summary always says how to go back and that the server is replaced', () => {
    const summary = steps(deploy.jobs.deploy).find((s) => String(s.name).includes('summary'));
    expect(summary.if).toBe('always()');
    expect(summary.env.PREV_VERSION).toBe('${{ steps.current.outputs.previous_version }}');
    expect(summary.env.PREV_SHA).toBe('${{ steps.current.outputs.previous_sha256 }}');
    expect(summary.run).toContain('rollback_version');
    expect(summary.run).toContain('rollback_sha256');
    expect(summary.run).toMatch(/5 to 15 minutes/);
    expect(summary.run).toMatch(/in S3/);
  });

  test('the health check uses the endpoints the control plane really serves', () => {
    const app = read('control-plane/src/app.ts');
    const health = steps(deploy.jobs.deploy).find((s) => s.id === 'health');
    for (const route of ['/healthz', '/readyz']) {
      // Served at the root, not under /v1: fastify.get("/healthz", ...) outside the register({ prefix: "/v1" }).
      expect(app).toContain(`fastify.get("${route}"`);
      expect(health.run).toContain(`${route}"`);
    }
    // /v1 on its own is not a health endpoint (the not-found handler answers it), so it must not be what is checked.
    expect(health.run).not.toMatch(/\/v1(\/|")/);
    expect(health.run).toContain('{"ok":true}');
  });

  test('every action is pinned to a commit and the only local workflow called is the release one', () => {
    for (const w of [deploy, release]) {
      for (const job of Object.values<any>(w.jobs)) {
        for (const u of [...steps(job).map((s) => s.uses), job.uses].filter(Boolean) as string[]) {
          if (u.startsWith('./')) {
            expect(u).toBe('./.github/workflows/release-control-plane.yml');
            continue;
          }
          expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} *$/);
        }
      }
    }
  });

  test('every run block is valid bash', () => {
    for (const { where, script } of [...runsOf(deploy), ...runsOf(release)]) {
      // GitHub substitutes ${{ ... }} before bash sees the script; a quoted placeholder keeps the syntax equivalent.
      const plain = script.replace(/\$\{\{[^}]*\}\}/g, 'PLACEHOLDER');
      try {
        execFileSync('bash', ['-n'], { input: plain, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e: any) {
        throw new Error(`${where}: ${String(e.stderr ?? e.message)}`);
      }
    }
  });

  test('no run block interpolates an input straight into the shell', () => {
    for (const { where, script } of runsOf(deploy)) {
      // Inputs reach the shell as environment variables; `${{ inputs.x }}` inside a run would be an injection point.
      expect({ where, bad: /\$\{\{\s*(inputs|github\.event)\./.test(script) }).toEqual({ where, bad: false });
    }
  });
});

describe('the deploy role for GitHub (github-deploy-trust.json)', () => {
  const stmt = trust.Statement[0];

  test('only GitHub, only this repository, only the production environment, only web identity', () => {
    expect(trust.Statement).toHaveLength(1);
    expect(stmt.Effect).toBe('Allow');
    expect(stmt.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(stmt.Principal.Federated).toBe(
      `arn:aws:iam::${cdkJson.context.account}:oidc-provider/token.actions.githubusercontent.com`,
    );
    expect(stmt.Condition.StringEquals['token.actions.githubusercontent.com:aud']).toBe('sts.amazonaws.com');
    const subs: string[] = arr(stmt.Condition.StringEquals['token.actions.githubusercontent.com:sub']);
    const repo = cdkJson.context.controlPlaneRepo;
    const [owner, name] = repo.split('/');
    const environment = deploy.jobs.deploy.environment;
    expect(subs).toEqual([
      `repo:${repo}:environment:${environment}`,
      `repo:${owner}@${cdkJson.context.githubOwnerId}/${name}@${cdkJson.context.controlPlaneRepoId}:environment:${environment}`,
    ]);
    // StringEquals only, no wildcard: a branch, a tag or a pull request can never assume this role.
    expect(Object.keys(stmt.Condition)).toEqual(['StringEquals']);
    for (const s of subs) expect(s).not.toContain('*');
    expect(JSON.stringify(trust)).not.toContain(':ref:');
    expect(JSON.stringify(trust)).not.toContain('pull_request');
  });
});

describe('the deploy role for GitHub (permissions)', () => {
  test('uses deploy-policy.json unchanged, so the workflow can do no more than the founder in CloudShell', () => {
    // Nothing was added for the workflow: it deploys the same stack with the same actions. The only extra file is the
    // Deny list below, which takes permissions away.
    const policy = readJson('infra/deploy-policy.json');
    expect(policy.Statement.every((s: any) => s.Effect === 'Allow')).toBe(true);
    expect(JSON.stringify(policy)).not.toContain('fenvix-github-deployer');
  });

  test('the guardrails only take away, and take away the three things a release must never do', () => {
    expect(guardrails.Statement.every((s: any) => s.Effect === 'Deny')).toBe(true);
    const account = cdkJson.context.account;
    const byResource = Object.fromEntries(guardrails.Statement.map((s: any) => [s.Resource, arr(s.Action) as string[]]));
    // 1. It cannot give itself more permissions.
    expect(byResource[`arn:aws:iam::${account}:role/fenvix-github-deployer`]).toContain('iam:PutRolePolicy');
    expect(byResource[`arn:aws:iam::${account}:role/fenvix-github-deployer`]).toContain('iam:UpdateAssumeRolePolicy');
    // 2. It cannot change who may log in from GitHub.
    expect(byResource[`arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`]).toContain(
      'iam:UpdateOpenIDConnectProviderThumbprint',
    );
    // 3. It cannot delete production.
    expect(byResource[`arn:aws:cloudformation:${cdkJson.context.regions}:${account}:stack/fenvix-*/*`]).toEqual([
      'cloudformation:DeleteStack',
    ]);
    for (const a of guardrails.Statement.flatMap((s: any) => arr(s.Action) as string[])) expect(a).not.toContain('*');
  });
});

describe('the stack says which releases it is pinned to', () => {
  test('the four pins are outputs, so the workflow can read them back', () => {
    const { json } = synth();
    const outs = json.Outputs;
    expect(outs.EngineVersion.Value).toBe('20261029-628273b0a1b2-r1');
    expect(outs.EngineSha256.Value).toBe('e'.repeat(64));
    expect(outs.ControlPlaneVersion.Value).toBe('20261029-61e1378c3d4e-r1');
    expect(outs.ControlPlaneSha256.Value).toBe('c'.repeat(64));
    // No secret turned into an output by mistake.
    for (const o of Object.values<any>(outs)) expect(JSON.stringify(o)).not.toContain('/fenvix/prod/control-plane');
  });

  test('a stack with nothing published yet has no pin outputs', () => {
    const { json } = synth({ engineVersion: '', engineSha256: '', controlPlaneVersion: '', controlPlaneSha256: '' });
    for (const k of ['EngineVersion', 'EngineSha256', 'ControlPlaneVersion', 'ControlPlaneSha256']) {
      expect(json.Outputs[k]).toBeUndefined();
    }
  });
});
