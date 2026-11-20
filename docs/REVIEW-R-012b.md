FIX 3

# Review R-012b: second and last round of R-012 (AWS deploy kit)

Reviewed: `claude/github-app` at `44d2a33` (fix commits `bf79801` and `44d2a33` on top of `98cb03e`), against the 18
findings of `docs/REVIEW-R-012.md` (branch `claude/review-r012`) and the fix report `docs/REPORT-aws-deploy-2.md`.
Branch `claude/review-r012b`. Threat model unchanged: the job runs hostile customer code. Nothing was deployed.

**Verdict.** All 18 findings are really fixed in code, policy or text, not only made green. The fixes opened **3 new
defects**, each with a failing test on this branch:

- **N1** (Medium, customer-mode spike): F9 class again. The host reads the result disk through a path that the
  jail's uid controls.
- **N3** (Medium, customer-mode design and spike): the F17 fix is incomplete. A jailed Firecracker can reach the
  parent's metadata service.
- **N2** (Low, all modes): the new permissions boundary is wider than the execution policy for EC2.

None of the three touches demo mode at run time.

**Demo mode is SAFE TO DEPLOY.** F5 is fixed, as are F8 and F13, which round 1 asked to fix before the first demo.
No secret is reachable by job code or by the image build. N2 only limits what a malicious *deployer* could do, and
the deployer is the founder. One condition: the boundary is checked only against templates, never against a live
account. Watch the first deploy, the first image build and the first demo for `AccessDenied` (see "Not verified").
Per-job mode is fine for our own repositories and design partners, as the fix report says. Customer mode stays a
spike: fix N1 and N3 before it runs on a real host.

## What I ran (this container)

| Check | Result |
|---|---|
| Reviewer test files on `44d2a33` | byte-identical to `claude/review-r012` (`diff`: no difference) |
| Reviewer tests on `98cb03e` (worktree, the two files copied in, scratch Postgres 16) | github-app **0/5**, infra **0/11**: each fails for the reason stated in round 1 |
| Reviewer tests on `44d2a33` | github-app **5/5**, infra **11/11** |
| github-app `npm test` (typecheck, unit, integration; Postgres 16 scratch DB through `scripts/prepare-test-db.sh`) | typecheck ok, **unit 59/59**, **integration 68/68** |
| infra/github-app `npm test` (typecheck, all tests, cdk-nag in both modes) | **52/52** before my test file was added. With `test/review-r012b.test.ts` it now fails 3 tests, as intended |
| `npx --no-install cdk synth --quiet`, demo mode (sample App settings, `demoRepository` set) | exit 0. cdk-nag: no error, no `CdkNagValidationFailure`. One CloudFormation-Validate warning (pinned AZ) |
| same, per-job mode (`cacheSigningPublicKey` from a fresh RSA-2048 key, pinned `cacheAmiId`) | exit 0. cdk-nag: no error, no `CdkNagValidationFailure`. Warnings: pinned AZ ×2, pinned AMI |
| Synthesized roles (both modes) | 8 in each mode (demo has the Demo role, per-job the Cache role). Every one carries the boundary. Job role: no statement. Build role: Deny on `parameter/fenvix/*`. Each function reads only its listed parameters. In demo mode the worker reads neither `runner-token` nor `signing-key` |
| New tests on `44d2a33` | `infra/github-app/test/review-r012b.test.ts`: **0/3 pass**. With a minimal fix applied to a scratch copy (setpriv read, uid-owner IMDS rules, boundary Deny on type and tag condition on terminate) **3/3 pass**. That fix was reverted and is not on this branch |
| shellcheck | not installed here (not run) |

## The 18 findings

"Test before / after" refers to the reviewer's test, or, for F15 to F18, to the author's own test or the text.
"New hole?" covers secrets reachable by job code or the image build, cross-tenant access, IAM wider than needed, and
a wrong DEPLOY-AWS.md step or cost.

| # | Sev | Really fixed? | Test before / after | New hole of the same class? |
|---|---|---|---|---|
| F1 | High | **Yes.** `fxr1.` credential, HMAC-SHA256 under `runner-token`, constant-time compare, prefix bound into the MAC, expiry checked. The App takes repository, runner name and (per job) run **from the credential**. A body that disagrees gets 403. The bare fleet token gets 401. Per-job credentials are bound to `runnerName`, `repositoryId` and `runId`. Demo credentials are bound to the demo repository's id and the demo runner name | fail / pass | No. The demo credential has no run id, but it is bound to the demo repository (F13). Rotation: see note 1 |
| F2 | High | **Yes.** `FleetJobRole` has no statement at all, and the AWS CLI is gone from the image. Everything a machine holds is per machine and in root-only user data. A local root escalation now yields only the job's own credentials (own run, own installation's cache organization) | fail / pass | No |
| F3 | High | **Yes.** `gh-<installation id>` per customer. The worker signs RSA tokens (`fxs1.`). The cache machine holds only the public key. The wrapper checks PKCS#1 v1.5 by comparing the whole encoded block (no parser to forge against), requires an `exp`, and refuses static `tokens.json` tokens (`Service.tokens` is replaced). `write` only on a trusted ref. The installation id comes from the signed webhook | fail / pass | No. Within one installation, every repository shares one organization: same customer, accepted |
| F4 | Medium | **Yes.** `CreateRole`, `PutRolePolicy`, `Attach`/`Detach`/`DeleteRolePolicy` only with `iam:PermissionsBoundary` = the boundary. Removing or rewriting a boundary, and new policy versions, are denied. The parent-image parameter read is scoped to `parameter/aws/service/canonical/*`. Step 11 now says what is true | fail ×2 / pass ×2 | **N2** (Low): the boundary allows `RunInstances` of any type and `TerminateInstances` on any instance in the region |
| F5 | High | **Yes.** An explicit Deny on `ssm:GetParameter*` for `parameter/fenvix/*` beats the managed Allow on `*`. `AmazonSSMManagedInstanceCore` has no `GetParametersByPath`, so the path-recursion caveat does not apply. `installdependencies.sh` is never run: the runner's libraries are installed by name, as root, before step 4. After step 4, root runs nothing the `fenvix` user owns: the hooks' `.env` is written via `runuser -u fenvix`; at boot, `fenvix-jit-prepare` and `fenvix-register` write into the job user's home as that user | fail / pass | No. Residual, inherent and not a regression: third-party build code can still alter the `fenvix` user's own files in the image (engine-cli, runner). That is the job's own privilege level, not root, and it reaches no secret |
| F6 | Low | **Yes.** Terminate, wait until gone (90 s), then delete, retrying 422 for 60 s. The demo reaper deregisters the runners of `shutting-down`/`terminated` demo machines, named from the launch-time tags. Lambda timeout 180 s, CLI read timeout 200 s | fail / pass | No. The reaper reads the private key, already in the boundary, and only in demo mode |
| F7 | Medium | **Yes.** `instance/*` needs the launch template **and** the configured `ec2:InstanceType`. `volume/*` and `network-interface/*` need the launch template | fail / pass | No (but see N2 for the boundary) |
| F8 | Medium | **Yes.** Default `c6i.large`, with no credit option; a T3 type runs unlimited. The image build uses the same type. The figures are recomputed and consistent: demo 20 × $0.0998 = $2.00, total ≈ $2.73; per-job ≈ $21.66 at 1,000 jobs; image build ≈ $0.08 | fail / pass | No |
| F9 | High | **Yes, as stated.** No mount. The ids and runner name come from the host's job record. The record is length-prefixed and capped at 8 MiB, and is parsed as `fenvix-parse`. `trap cleanup EXIT` | fail ×2 / pass ×2 | **N1** (Medium): the new read path follows a symlink planted by the jail's uid |
| F10 | Medium | **Yes.** `-i fctap+` rules in `FENVIX-SBX`, FORWARD DROP, a per-TAP source rule, `rp_filter=1`, link-local limited to `169.254.169.253:53`, `INPUT -i fctap+ DROP`, IPv6 off and dropped, `connlimit` plus `hashlimit`, Firecracker rate limiters, and a larger `nf_conntrack_max` | fail / pass | No |
| F11 | Medium | **Yes.** The script stops without `nitro_enclaves.mempool=` on `/proc/cmdline` or with an empty pool. It writes 12 slots. README step 0 has `grubby` and the reboot | fail / pass | No |
| F12 | Low | **Yes.** `hasCapacity()` is checked before `generate-jitconfig`. The just-in-time runner is deleted when the launch fails or EC2 returns the existing machine | fail / pass | No. The check-then-act race across two workers remains (noted in round 1) |
| F13 | Medium | **Yes.** `demoRepository` is required in demo mode. Up, down and status refuse any other repository. `down`/`status` without a repository use only launch-time tags, which only the demo function can set | fail / pass | No |
| F14 | Low | **Yes.** `requireImdsv2` gives the cache instance a launch template. EC26 now evaluates instead of being suppressed (no `CdkNagValidationFailure` in the per-job synth) | fail / pass | No. `ec2:CreateLaunchTemplate` is in the fleet execution policy |
| F15 | Medium | **Yes.** `refreshing()` rebuilds config and secrets after 300 s, closes the old instance only after the new one is ready, and keeps the old one if SSM fails. The rotation procedure is documented per secret | own test pass | Note 1 (Low, not counted) |
| F16 | Medium | **Yes.** The fallback is nested virtualization on the same C7i, ≈ $147.86/host/month. One full-speed 2-vCPU sandbox per c7i.xlarge. c7i.2xlarge for three: $0.38304 × 730 + $8.05 = $287.67. The arithmetic checks | n/a | No |
| F17 | High | **Partly.** Jailer per sandbox (own uid, chroot, cgroup v2, seccomp), the TAP owned by the jail uid, `fenvix-post` and `fenvix-parse` separated. Not covered: the jail uids still share the parent's network namespace with nothing between them and IMDS | own test pass | **N3** (Medium) |
| F18 | Low | **Yes**, all 7 items. `npm ci` comes before `npx --no-install cdk bootstrap`. A SCRAM verifier is computed locally. Removal order: demo-down, empty the bucket, destroy. Image build ≈ $0.08. The API Gateway free-tier credits note is in. Stale nag reasons are gone. The request log drops the query string (`loggerOptions`) | own tests pass | No |

## New defects (failing tests: `infra/github-app/test/review-r012b.test.ts`)

### N1. The host follows a symlink to read the guest's result (Medium, customer spike; F9 class)

`run-job.sh` runs `chown -R "$uid:$uid" "$jail"`, so the jail root directory belongs to the jail's uid. After the
sandbox it reads the result as root:

```
result="$(runuser -u fenvix-parse -- python3 -I "$here/read-result.py" <"$jail/result.img")"
```

The redirect is opened by the **root** shell, which follows symlinks. A Firecracker that escaped its guest is
exactly the case the jailer is there for (F17). It runs as the jail uid, and it can replace `result.img` with a
symlink to `/srv/jailer/firecracker/fenvix-sbx-2/root/result.img`. The host then parses **another tenant's** result
and posts it with this job's credential, into the attacker's own pull request. This is the same defect as round 1's
`summary.json` symlink, on the new path. (`protected_symlinks` does not help, because the directory is not
world-writable and sticky.)

**Fix:** read the disk as the jail's uid, which cannot traverse another jail (each jail root is 0700, owned by
another uid). For example:
`setpriv --reuid "$uid" --regid "$uid" --clear-groups cat -- "$jail/result.img" | runuser -u fenvix-parse -- python3 -I read-result.py`.
Alternatively, open it in Python with `O_NOFOLLOW`, then `fstat` it: it must be a regular file owned by the jail
uid. Add a symlinked `result.img` to host test 5.

### N3. A jailed Firecracker can reach the parent's metadata service (Medium, customer design and spike; F17)

The jailer runs without `--netns`, so every Firecracker process is in the parent's network namespace.
`host-setup.sh` has no `OUTPUT` rule for the jail uids, unlike the runner machines' `fenvix-imds-block`. "Hop limit
1" stops forwarded packets only. A local process on the parent still gets a token.

After a VMM escape, the **queue role's** credentials are one HTTP call away. That queue carries every customer's
just-in-time configuration and per-job credentials: take another customer's job, and you get its `GITHUB_TOKEN` and
secrets. DEPLOY-AWS.md's own rule, "One escape there must not reach other tenants or our credentials", is therefore
not met. Firecracker's seccomp filter is the only layer left. It very probably refuses `AF_INET` sockets, so this is
defense in depth, but defense in depth is what F17 asked for.

**Fix:** a network namespace per jail (`jailer --netns /var/run/netns/fenvix-sbx-<N>`, with the TAP created inside
it and a veth to the parent). Or, at minimum:
`iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner 20001-20250 -j REJECT` and the `ip6tables` equivalent
for `fd00:ec2::254`. Better still, keep the queue poller off the sandbox host's IMDS role entirely. Add the jail uid
to host test 2 ("as the jail's uid, `curl 169.254.169.254` fails").

### N2. The permissions boundary is wider than needed for EC2 (Low, all modes; F4 and F7 class)

`permissions-boundary.json`'s `RunnerMachines` statement allows `ec2:RunInstances` and `ec2:TerminateInstances` on
`"*"`, limited only by region. The boundary is the ceiling of any role a deployer's template can create. Such a role
may start **any instance type** (F7's class: `p5.48xlarge`), although `cfn-exec-policy-fleet.json` denies every type
but its list to CloudFormation itself. It may also terminate **any instance in the region**, not only `fenvix:role`
machines.

None of the stack's own roles uses this: they are narrower. The exposure is a malicious or compromised deployer, so
cost and availability, not secrets.

**Fix:** a Deny on `instance/*` with `StringNotEquals ec2:InstanceType` and the fleet policy's list, and
`TerminateInstances` only with `aws:ResourceTag/fenvix:role`.

## Notes (not counted)

1. **Rotating `runner-token`** (DEPLOY-AWS.md "Rotating a secret"). Signers (worker, demo) and verifiers (HTTP)
   reload independently within 5 minutes. A credential signed with the new key can reach an HTTP container that
   still holds `{old}` and get 401. `fenvix-summary-poster` treats 401 as final and moves the summary to
   `rejected/`. The window is short and per-job summaries arrive minutes after launch, so this is minor. Possible
   fixes: the poster retries 401 for about 10 minutes, or the doc says to put the new key in
   `runner-token-previous` first, wait 5 minutes, then swap.
2. **Boundary completeness and KMS are not verified against a live account.** Every action in the synthesized
   policies is inside the boundary, as are the two managed policies of the build role. Two things a template cannot
   show:
   - SecureString reads through `aws/ssm`, whose key policy names `"AWS": "*"`. These should not need `kms:Decrypt`
     in the boundary: the IAM doc says boundaries do not limit grants made directly to the session.
   - the Image Builder agent's calls.

   On the first deploy, check the logs of `http`, `worker`, `demo` and `reaper`, and the image build log, for
   `AccessDenied`.
3. `cdk.json` still has `cacheOrg`, `cacheTokenSha256Write` and `cacheTokenSha256Read`. They are unused and harmless;
   delete them to avoid confusion with the per-installation organizations.
4. Within one demo, one job can still alter the next one on the same machine (persistent runner). This is accepted
   and documented, now enforced by F13 to the founder's own repository.

## Run the new tests

```
cd infra/github-app && node --test test/review-r012b.test.ts     # 0/3 pass on 44d2a33
```

`infra/github-app`'s `npm test` includes them and fails until N1, N2 and N3 are fixed. That is intended.
