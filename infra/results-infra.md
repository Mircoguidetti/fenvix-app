# FENVIX AWS infrastructure: results

## Update: Let's Encrypt instead of ACM exportable (branch `infra-align`)

- **Certificate.** ACM exportable certificates (paid at every issue and renewal) are gone, with `acm:ExportCertificate`, `fenvix-cert-refresh` and its timer. The server gets a free Let's Encrypt certificate (`*.<region>.db.<domain>` + `api.<domain>` in the first region; was `console.<domain>` until the address change, see report-infra-align.md section 8) with certbot 5.8.0 (PyPI, every wheel pinned by SHA-256, venv on the host) and DNS-01 in Route 53 (`lib/scripts/fenvix-tls.sh`, `lib/scripts/fenvix-acme-dns-hook.sh`). Same files for the engine (`engine.pem`) and Caddy (`fullchain.pem`, `key.pem`), `/etc/fenvix/tls` owned by `fenvix`, files 0600. Timer twice a day; renewal under 30 days; restart only when the certificate changed.
- **Persistence.** Certificate and key are kept in the Secrets Manager secret `fenvix-<env>-tls-<region>` (stack-created with `{}`); a replaced server reuses it. Failed requests are retried after 20 minutes at the earliest; without a valid certificate the engine and Caddy do not start.
- **IAM.** Engine role: `route53:ChangeResourceRecordSets` on the stack's zone only, conditions TXT + the region's `_acme-challenge` names + UPSERT/DELETE; `route53:GetChange` on `change/*`; `secretsmanager:GetSecretValue`/`PutSecretValue` on its secret. No `Resource: "*"` for Route 53 or Secrets Manager.
- **Settings.** `acmeEmail` (required), `acmeStaging` (default false), `dnsZone` (`db` default: zone `db.<domain>`; `domain`: whole domain).
- **User data.** The boot script (~25 KB) is gzip + base64 in the user data (~13.9 KB), SHA-256 checked, copy at `/opt/fenvix/boot.sh`. Still no assets and no CDK bootstrap.
- Full detail and test numbers: `report-infra-align.md`, section 7.

## Update: branch `infra-align` (aligned with the real engine and control plane)

Branch `infra-align` from `origin/e2e-engine` @ `0fde489`; only `infra/` changed. Nothing deployed, no AWS call. Full report of this work: [`report-infra-align.md`](report-infra-align.md). What changed against the sections below:

- **Engine start.** The engine reads no `FENVIX_*` variable (only clap flags and `MONGO_ADMIN_TOKEN`). `ExecStart` now passes the flags, all in `lib/engine-command.ts`: `--listen=0.0.0.0:27018 --admin-listen=172.17.0.1:8443 --admin-token-file=/run/fenvix/admin-token --auth --tls-mode=requireTLS --tls-certificate-key-file=/etc/fenvix/tls/engine.pem --store=s3 --bucket=<bucket>`; `AWS_REGION` in the unit. The token file is written at each start from SSM (0600, owner `fenvix`, in a runtime directory that disappears when the engine stops).
- **Ports.** 27018 (MongoDB, TLS required) and 443 open to the internet; the admin port 8443 is in **no** security-group rule and listens on the Docker bridge only (reachable from the server and its containers).
- **Certificate.** One ACM exportable certificate per region for `*.<region>.db.<domain>` (+ `console.<domain>` in the first region); exported at start and by a daily timer, which restarts the engine (and the TLS terminator) only when the certificate changed. `BASE_DOMAIN` is now required (no certificate, no engine). The old `*.db.<domain>` certificate and record are gone (they did not cover `<name>-<ws>.<region>.db.<domain>`).
- **Secrets.** `lib/parameters.ts`: 8 required SecureStrings + 1 optional; `session-secret` dropped (unused); the two admin tokens are checked to be equal before the control plane starts.
- **Control plane.** Environment in `lib/control-plane-env.ts` (real driver, admin and data endpoints through `host.docker.internal`, `CONNECTION_*`, `HOST_TEMPLATE`, `DATA_*`); no published port; behind a Caddy TLS terminator on 443 using the exported certificate (before, plain HTTP was published on 443). Only in the first region. IMDS hop limit stays 1.
- **IAM.** Engine role S3 actions reduced to `GetObject`, `PutObject`, `DeleteObject`, `AbortMultipartUpload`, `ListBucket`; `acm:ExportCertificate` on its own certificate only.
- **Tests.** 8 suites, 101 tests, all passed (`npx jest`). `cdk synth` with the real CLI, AWS variables unset and the network pointed at a dead proxy: one template, 38.4 KB; user data 13.4 KB of the 16 KB limit. cdk-nag raw findings: 10 (same rules as before), 0 unsuppressed.

The sections below are the original `infra-aws` report; lines that no longer hold are marked **(changed on infra-align)**.

Branch `infra-aws`, folder `infra/` only (`src/` and `control-plane/` untouched; `control-plane/` does not exist in this repo). Nothing was deployed and no AWS API call was made on purpose. Every number below comes from a run in this session; where something was not run, it says so.

## What each file creates

| File | Role |
|---|---|
| `infra/bin/fenvix.ts` | CDK app. Reads settings, creates one stack `fenvix-<env>-<region>` per entry of `regions`. Refuses to run if the CLI's account differs from the configured one. Uses `BootstraplessSynthesizer` (no assets, so no `cdk bootstrap`). |
| `infra/lib/config.ts` | Settings loader and validation (instance type allow-list, region/email/domain/port/URL checks). Env var beats `cdk.json`/`-c`. |
| `infra/lib/fenvix-stack.ts` | The stack, per region: VPC (one public subnet, no NAT, S3 gateway endpoint), security group, S3 data bucket + bucket policy, engine IAM role, EC2 instance (IMDSv2, encrypted gp3 volume, Elastic IP, recovery alarm), budget + budget action + its role, hosted zone (or existing zone id), DNS-validated exportable certificate for `*.<region>.db.<domain>` (+ `console.<domain>` in the first region), A records **(changed on infra-align: was `*.db.<domain>`, only with `BASE_DOMAIN`)**. Tags `project=fenvix`, `env=<env>` on everything. |
| `infra/lib/user-data.ts` | The boot script: installs Docker, downloads the engine from the given URL (optional SHA-256 check), writes two systemd units with `Restart=always`, and a helper that reads SecureString parameters from SSM into root-only env files at every service start. Refuses to run with the placeholder release location. |
| `infra/lib/nag-suppressions.ts` | Accepted cdk-nag findings, each with a written reason. |
| `infra/deploy-policy.json` | Least-privilege inline policy for the deploy role (account 865859654353, eu-central-1). |
| `infra/README.md` | Founder deploy and teardown guide. |
| `infra/test/*.test.ts` | Tests below. |

## Test results (all run in this session)

- `npx tsc --noEmit`: no errors.
- `npx jest` (5 suites, **64 tests, 64 passed**): `infra.test.ts` 43, `deploy-policy.test.ts` 10, `config.test.ts` 4, `user-data.test.ts` 4, `nag.test.ts` 3.
- Requirement coverage in `infra.test.ts`: bucket public access blocked + encrypted + versioned + lifecycle days follow the parameter + Retain; TLS-deny policy; engine-role allow and deny-everyone-else (root exempt); security group opens exactly 27017 and 443 to the internet; admin port 27018 is in no internet rule (also checked as part of any range, and with a different `adminPort`); admin port rule has the group itself as source **(changed on infra-align: 27018 and 443 open, admin port 8443 in no rule at all)**; no port 22 and no key pair; instance types; arm64 image for c7g; encrypted gp3 volume; IMDSv2; no wildcard action in any IAM statement; `Resource: *` only on APIs without resource-level permissions; S3 statements name only the project bucket and SSM only `/fenvix/<env>`; tags `project`/`env` on every taggable resource and the string `fenvix-tests` appears nowhere; budget amount/email, 50/80/100 notifications, action stops the instance at 100%; **no Route 53 or ACM resource when `BASE_DOMAIN` is unset, empty or blank** **(changed on infra-align: `BASE_DOMAIN` is required)**; with it set: zone, certificate, records; no Lambda/custom resource/asset; no `SSM::Parameter` resources.
- Mutation check: I broke the stack three ways (open a port range covering 27018 to the internet, weaken the public access block, `kms:*`). Each made the matching tests fail; I then restored the file.
- `user-data.test.ts` runs the generated script through `bash -n`, runs the placeholder guard, and executes the real embedded Python config fetcher against a fake `aws`. `shellcheck -S warning` on the generated script: clean.
- `cdk synth` with the real CLI, no credentials, outbound network pointed at a dead proxy: `-c regions=eu-central-1,us-east-1` produced both templates (bucket `fenvix-prod-data-865859654353-eu-central-1` / `...-us-east-1`, budgets filtered to their region). `regions=eu-central-1,eu-west-2` with `baseDomain=example.com` produced DNS resources in the first stack only. Template sizes 27.6 to 29.9 KB (limit for inline deploy: 51.2 KB).
- Policy lint: `parliament` 1.6.4 with community auditors on `deploy-policy.json`: 15 findings (2 HIGH, 11 MEDIUM, 2 LOW), listed below.
- cdk-nag `AwsSolutions` pack: 10 raw findings before suppressions; 0 unsuppressed after (test enforces it for default, `BASE_DOMAIN` and two-region configs).

## Findings not fixed, and why

### cdk-nag (raw list, all `Error`)
| Rule | Resource | Decision |
|---|---|---|
| VPC7 flow logs | VPC | Not fixed. Logging an internet-facing database port is mostly scanner noise plus CloudWatch cost. Add later if security monitoring is needed. |
| EC23 0.0.0.0/0 inbound | security group | By design (27018 and 443 must be public). Admin port in no rule, tested. |
| S1 access logs | data bucket | Not fixed. Needs a second bucket (which would itself trip S1). Use CloudTrail data events if object-level audit is required. |
| EC29 termination protection | instance | Not fixed. It would make CloudFormation unable to replace the server on a settings change and would block teardown. Node is stateless. |
| IAM5 x4 (engine role) | `bucket/*`; `parameter/fenvix/<env>/*`; `kms key/*` limited by `kms:ViaService`; `*` for Session Manager APIs | Unavoidable or needed; reason in `nag-suppressions.ts`. The key id of the AWS-managed `aws/ssm` key is not known at synth, hence `key/*`. |
| IAM5 x2 (budget role) | `ec2:DescribeInstanceStatus` on `*`; SSM automation definition `AWS-StopEC2Instance:*` | Needed; stop is limited to the one instance ARN. |

CloudFormation validate warnings printed by synth, not fixed: W2508 (0.0.0.0/0 on the MongoDB port, same reason as EC23) and W3010 (hardcoded AZ `<region>a`, done on purpose so synth never does an AWS lookup).

### Other known gaps in the stack
1. **(Fixed on infra-align: exported at start and daily, see above.)** **ACM certificate is not delivered to the engine.** Public ACM certs cannot be copied to an EC2 server unless exportable; I set `CertificateExport: ENABLED` (extra ACM fee), but the server has no permission or script to export it. The engine always starts with `FENVIX_TLS_MODE=self-signed`; with a domain it only gets `FENVIX_ACM_CERTIFICATE_ARN` as information. Needs a follow-up (export step or Let's Encrypt DNS-01) and a decision which one.
2. **Budget filter is by region, not by tag.** A tag filter reads zero until the tag is activated for cost allocation (manual, up to a day), so the 100% stop would silently never fire. Cost: other spending in that region of the account counts too. Also, budgets update a few times a day, so the stop can be late.
3. **(Fixed on infra-align: checked against the engine code and control-plane/src/config.ts.)** **Engine and control-plane interfaces are assumptions.** Neither the engine nor `control-plane/` is in this repo. Env var names (`FENVIX_S3_BUCKET`, `FENVIX_LISTEN`, `FENVIX_ADMIN_LISTEN`, `FENVIX_TLS_MODE`, `FENVIX_ADMIN_TOKEN`, `SESSION_SECRET`...), admin port default 27018, container port 8443, the two required secret names and the `/fenvix/<env>/...` layout are my choice and must be matched by the services (or changed here).
4. **(Fixed on infra-align: binds the Docker bridge 172.17.0.1, no SG rule.)** **Admin port binds `0.0.0.0` on the instance**, protected by the security group only (self-referencing rule). With a single node nobody else is in that group, so effectively closed, but a second node in the group could reach it.
5. **Bucket deny can lock out legitimate tools.** Only the engine role, the account root (and optional extra ARNs passed in code via `bucketAdminPrincipalArns`, not wired to a setting) can read/write/list. Teardown needs the root user or deleting the bucket policy first (documented).
6. **Default security group of the VPC is not restricted** (the CDK feature needs a Lambda and a bootstrap bucket). Nothing uses it.
7. **Changing `engineUrl`, `controlPlaneImage`, ports etc. replaces the server** (user-data change), with a few minutes of downtime. Intentional: keeps the machine reproducible.
8. Detailed EC2 monitoring is on (small monthly fee), plus a public IPv4 address charge. I did not compute a monthly cost.
9. **(Changed on infra-align: every region has its own certificate and `*.<region>.db.<domain>` record; more than one region needs `hostedZoneId`; the control plane runs in the first region and manages only that engine.)** DNS and certificate are created only in the first region of the list; per-region hostnames for later regions are not designed.

### `deploy-policy.json` (parliament findings and limits)
- HIGH x2: `iam:PassRole`+`ec2:RunInstances` and `iam:PassRole`+`cloudformation:CreateStack`. Inherent to deploying a role-using stack. Limited to roles named `fenvix-*` and to EC2/Budgets. **Real risk left:** someone with this role can create a `fenvix-*` role with an arbitrary inline policy and launch an instance with it. Fix later with a permissions boundary condition; not done.
- MEDIUM: S3 `PutBucketPolicy`/`PutLifecycleConfiguration` "resource policy escalation" (needed to create the bucket policy), permission-management actions (needed), and "no resources match for the given action" on statements that deliberately mix resource types or use the empty-account public SSM ARN (tool limitation, AWS-documented ARN form). `ec2:*` change/delete actions use `arn:...:*/*` plus `aws:ResourceTag/project=fenvix`.
- LOW: `ec2:DescribeInstanceAttribute`, `DescribeVpcAttribute`, `cloudwatch:DescribeAlarms` on `*`.
- It is 7.2 KB, above the 6,144-character managed-policy limit, so the README says to paste it as an inline policy (inline limit 10,240).
- Only eu-central-1. Adding a region needs hand edits (documented); there is no generator.
- The test suite checks its shape (no wildcard actions, tag/ARN scoping, a create action for every resource type the stack produces) but that is not proof AWS accepts every call CloudFormation makes.

## What could not be verified without real AWS
- That `cdk deploy` with the bootstrapless synthesizer, run through CloudShell, works end to end; that the stack creates (names, limits, quotas, region support of `t3`/`c6i`/`c7g`).
- That the deploy policy is sufficient and not over-broad: tag-condition behaviour of CloudFormation's `RunInstances`/volume/ENI tagging, the extra permissions CloudWatch needs for the EC2 `recover` alarm action (e.g. a service-linked role), billing/Budgets console access for IAM roles, and any action I missed. Expect one or two iterations on the first real deploy.
- The budget action: that `Subtype STOP_EC2_INSTANCES` with `RUN_SSM_DOCUMENTS` and the role I wrote (`ec2:StopInstances` on the instance, `ssm:StartAutomationExecution` on `AWS-StopEC2Instance`) is exactly what AWS Budgets needs; and that it fires at 100%.
- Email delivery of budget alerts.
- That the boot script works on Amazon Linux 2023 (package name `docker`, systemd hardening options, `ProtectSystem=strict` with the engine's real write paths), that the engine and container start, that the container image and engine URL are reachable anonymously, and that Session Manager connects.
- IAM behaviour of the S3 deny statement (e.g. `aws:PrincipalArn` for the instance role) and `kms:Decrypt` through `kms:ViaService` for `aws/ssm`.
- DNS validation timing and the NS delegation step in the README; ACM exportable certificate availability and fee.
- CloudShell specifics in the README (Node version, `npm ci` there, cloning a private repo).
- Anything about the real engine/control-plane (see gap 3).

## Disclosure
The sandbox had `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` set in its environment (I never read their values). My first few `cdk synth` runs happened with them present, before I pinned the availability zone; those runs reported "no credentials" for the one lookup they attempted and the stack code itself makes no AWS call. All later synths ran with the AWS variables unset and the network pointed at a dead proxy and succeeded, so no AWS access is needed to synth. I ran no `cdk deploy`, no `cdk bootstrap`, no `aws` CLI command.

## Commits
Small steps on `infra-aws`: scaffold + stack; assertion tests + nag; deploy policy + tests; user-data tests; README; settings precedence fix; this report. Not merged, no pull request opened.
