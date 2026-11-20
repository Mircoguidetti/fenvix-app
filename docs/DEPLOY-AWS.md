# Deploying fenvix on AWS

This page is for the founder. **Deploying is: open a pull request, merge it on `main`. That is the whole deploy.**
The GitHub Actions workflow `.github/workflows/deploy.yml` runs every test, then deploys the database, the secrets, the
API, the runners, the dashboard and the DNS records. Nobody runs a command, a migration or a clone from a laptop.

Before the first deploy there are four one-time setups, all in a web browser (section A): a CloudFormation stack, a few
values in AWS Parameter Store, a Cloudflare token, and two Supabase addresses. Nothing is set in GitHub (the repository
is private on GitHub Free). The GitHub App comes last (section C): until it exists, everything else is deployed and
works, and the App's routes answer "not configured".

> **The dashboard is on Vercel for now** (decision of 2026-11-20): the AWS account cannot create CloudFront resources
> until AWS verifies it. The founder's setup is `docs/DEPLOY-VERCEL.md`. Everything on this page about the dashboard's
> hosting (its us-east-1 certificate, S3 + CloudFront, the upload, the `console` DNS record) is off behind ONE switch,
> the repository variable `FENVIX_DASHBOARD_ON_AWS` (GitHub → Settings → Secrets and variables → Actions → Variables):
> unset or `false` (the default) the deploy creates and updates the API stack only and never touches
> `console.fenvix.dev` in Cloudflare; `true` brings the AWS dashboard back (take the domain off Vercel first). The API,
> its CORS origin (`https://console.fenvix.dev`) and the Supabase URLs are the same either way.

Account `865859654353`, region `eu-west-1` (Ireland). The dashboard's certificate is the only thing in `us-east-1`
(CloudFront takes certificates from there only).

**Nothing here has been deployed yet.** Everything was built and tested without the real AWS account, Supabase project
or Cloudflare zone: `docs/REPORT-deploy-pipeline.md` says what was tested and what was not.

## What gets created

```
GitHub (push to main) ──▶ GitHub Actions "Deploy": tests, then OpenID Connect → AWS role fenvix-github-deployer
                          (no AWS key stored anywhere), Supabase (migrations, role passwords), Cloudflare (DNS)

browser ──HTTPS──▶ console.fenvix.dev   (CloudFront, certificate in us-east-1) ──▶ private S3 bucket: the dashboard build
browser ──HTTPS──▶ api.fenvix.dev/v1/*  (API Gateway HTTP API, ACM certificate)
                    └▶ Lambda "api": the dashboard API (openapi/fenvix-api.yaml): checks the Supabase session, the
                       membership and the role, reads and writes Postgres as fenvix_api (pooler, transaction mode)
GitHub ──HTTPS──▶ api.fenvix.dev  (webhooks, /github/setup, /healthz, /v1/runner/*)
                    └▶ Lambda "http": checks the signature or the machine's summary credential, puts the work on SQS,
                       answers 202. Without the GitHub App: /healthz answers, everything else 503 github_not_configured
                 SQS "work" queue  (failed 5 times → "dead-letters" queue + alarm; payloads over 200 KB go via S3)
                    └▶ Lambda "worker": stores the event, opens the onboarding PR, publishes the check run, the PR
                       comment, ci_runs, usage events; starts one runner machine per queued fenvix job
                 EventBridge Scheduler: "sweep" every minute, "warmup" every minute, "reaper" every 10 minutes
Runner image: EC2 Image Builder (Ubuntu 24.04 + build tools, uv, Python, Rust, the engine, the GitHub runner, the
   hooks); built by the pipeline when its recipe changes
Job machines (c6i.large, one per job, deleted after it; no inbound port, an IAM role with no permission) and the
   shared cache machine (t4g.nano, private address only, one cache organization per customer installation)
Supabase (yours): the role fenvix_github_app writes gh_*, ci_projects, ci_runs, ci_usage_events; the role fenvix_api
   (the dashboard API) reads its organization's rows and changes settings, members and invitations; the browser
   reaches no table (row level security checks the API's membership and role again)
```

| Piece | Detail |
|---|---|
| Deploy access | GitHub's OpenID Connect token is exchanged for a short-lived AWS session of the role `fenvix-github-deployer`, which trusts **only** a job of `.github/workflows/deploy.yml` on the branch `main` of this repository: subject `repo:Mircoguidetti@17613795/fenvix-app@1434576189:ref:refs/heads/main` (GitHub's immutable format, with the owner and repository ids), `repository_id` `1434576189` and `job_workflow_ref` `Mircoguidetti/fenvix-app/.github/workflows/deploy.yml@refs/heads/main`; no GitHub environment. There is no AWS access key anywhere. The role's policy is `infra/github-app/deploy-policy.json`: it can submit the stacks through CloudFormation (whose own role carries the policies `cfn-exec-policy-*.json`), write the SSM parameters it generates, read the founder's values by exact name, upload the dashboard and start the image build. It is not an administrator. It deploys the App's code, which reads the App's secrets, so treat it as able to read them. |
| Secrets | SSM Parameter Store only; GitHub holds none. **Yours** (typed once in the AWS console): `/fenvix/prod/bootstrap/*` (the Supabase admin connection string, the Cloudflare token, the anon key, the GitHub App's public values) and the App's private key and client secret under `/fenvix/prod/github-app/`. The deploy role reads these by exact name and changes none; each step reads only what it needs and masks it in the log before using it. **Generated** by the pipeline, type SecureString, under `/fenvix/prod/github-app/` and `/fenvix/prod/cache/`: the webhook secret, the state signing key, the runner token, the cache signing key and both database passwords. No value is ever printed, logged, written to a file or put in git. Each Lambda reads only its own, by exact name, and reloads them every 5 minutes. **No machine reads any of them.** |
| Database passwords | Generated by the pipeline (256 bits). Supabase receives only the SCRAM verifier (`alter role ... password 'SCRAM-SHA-256$...'`), never the password. The whole connection string is stored in SSM only. |
| IAM | Every role the stacks create carries the permissions boundary `fenvix-prod-github-app-boundary` (`permissions-boundary.json`), and CloudFormation may create or change a role only with it. The dashboard stack creates no role and no Lambda. |
| Logs | CloudWatch log groups `/aws/lambda/fenvix-prod-github-app-{http,api,worker,sweep,reaper,warmup}` and `/aws/apigateway/fenvix-prod-github-app-api`, kept **14 days**. The deploy's own log is the workflow run on GitHub (Actions tab). |
| Runner modes | **Per-job (default):** each queued fenvix job gets its own machine, deleted after the job. **Demo (an option, off):** one machine per demo, started and stopped by hand (section E). **Customer mode:** a design, not built (below). |

## A. The one-time setup (browser only)

Four steps, once, in a web browser, then merge the pull request that brought this page. Nothing in GitHub's settings:
the repository is private on **GitHub Free**, where environments' secrets and deployment branch rules do not exist, so
the pipeline uses no GitHub environment, no GitHub secret and no GitHub variable that you must set. Every value only you
can provide goes into **AWS Systems Manager Parameter Store**, in one place, typed once in the AWS console.

### Step 1. AWS: create the stack `fenvix-bootstrap` (CloudFormation)

It creates, in one go: GitHub's OpenID Connect provider, the deploy role `fenvix-github-deployer`, the permissions
boundary, the CloudFormation execution role with its four policies, and what CDK needs to deploy (an assets bucket, a
deploy role, a publishing role, a version parameter). No access key, no user.

The deploy role trusts exactly one thing: a job of `.github/workflows/deploy.yml` of `Mircoguidetti/fenvix-app`
running on the branch `main`. AWS checks three claims of GitHub's OpenID Connect token: the subject
`repo:Mircoguidetti@17613795/fenvix-app@1434576189:ref:refs/heads/main` (GitHub's immutable format: this repository was created after
2026-07-15, so its tokens carry the owner id and the repository id), `repository_id` = `1434576189`, and
`job_workflow_ref` = `Mircoguidetti/fenvix-app/.github/workflows/deploy.yml@refs/heads/main`. The template's
parameters `GitHubOwnerId` and `GitHubRepositoryId` already hold these ids: leave them as they are. A pull request, a
fork, a tag, any other branch, or any other workflow file is refused by AWS. Of the values you type (steps 2 and 3, sections C and D) it may read exactly
the seven names under `/fenvix/prod/bootstrap/` and the GitHub App's two secret parameters, by exact name, and may
change none of them.

1. Open <https://github.com/Mircoguidetti/fenvix-app/blob/claude/deploy-pipeline/infra/bootstrap/fenvix-bootstrap.json>
   (the pull request's branch: this step comes before the merge, and `main` does not have the file yet; after the
   merge the same path on `main` holds the same file) and click **Download raw file** (the download icon above the
   file, on the right).
2. Sign in to the AWS console as an administrator of account 865859654353 and open
   <https://eu-west-1.console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks/create>.
3. **Prerequisite - Prepare template:** "Choose an existing template". **Specify template:** "Upload a template file"
   → **Choose file** → the downloaded `fenvix-bootstrap.json` → **Next**.
4. **Stack name:** `fenvix-bootstrap`. Leave the parameters as they are (`GitHubOwner` Mircoguidetti,
   `GitHubRepository` fenvix-app, `CreateOidcProvider` true) → **Next**.
5. **Configure stack options:** change nothing → **Next**.
6. **Review:** at the bottom, tick **"I acknowledge that AWS CloudFormation might create IAM resources with custom
   names."** → **Submit**.
7. Wait for **CREATE_COMPLETE** (about 2 minutes; the page refreshes by itself).

If it fails with "Provider with url https://token.actions.githubusercontent.com already exists": the account has
GitHub's provider already. Delete the failed stack (Delete button), then repeat with `CreateOidcProvider` **false**.

Why not a single link: CloudFormation's one-click ("quick create") links only load templates from an S3 bucket, and
the account has none before this stack exists. Uploading the file is the same thing in two more clicks.

(Already created from an earlier version of this file, for example the one that trusted a GitHub environment?
CloudFormation → `fenvix-bootstrap` → **Update** → "Replace current template" → upload the new file → Next → Next →
tick the acknowledgement → **Submit**.)

### Step 2. AWS: the Supabase values in Parameter Store

Open <https://eu-west-1.console.aws.amazon.com/systems-manager/parameters/create?region=eu-west-1> (Systems Manager →
Parameter Store → **Create parameter**; check that the region at the top right is **Europe (Ireland) eu-west-1**). For
each row: **Name** exactly as written, **Tier** Standard, **Type** as written (for SecureString leave "KMS key source:
My current account" and "KMS Key ID: alias/aws/ssm"), **Data type** text, **Value** → **Create parameter**. Then
**Create parameter** again for the next row.

| Name | Type | Value |
|---|---|---|
| `/fenvix/prod/bootstrap/supabase-db-url` | **SecureString** | Supabase → your project → **Connect** (top bar) → **Session pooler** → copy the URI (`postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`) and replace `[YOUR-PASSWORD]` with the database password (Project Settings → Database → Database password; reset it there if you do not have it). Not the "Direct connection": it is IPv6 only, and GitHub's machines cannot reach it. |
| `/fenvix/prod/bootstrap/supabase-anon-key` | **String** | Supabase → Project Settings → **API Keys** → the **`anon` `public`** key (or the **publishable** key, `sb_publishable_...`). **Not** `service_role` and **not** a secret key (`sb_secret_...`): those bypass row level security, and this key is built into the public dashboard. The deploy refuses them (and a key of another project) before building anything, and never prints the value. |

The Supabase URL is not a parameter: the pipeline derives it from the connection string (`https://<ref>.supabase.co`).

Why these and nothing more: the database connection string is the only way into your Supabase project (the pipeline
runs the migrations and sets the two roles' passwords with it); the anon key cannot be read from the database, and
fetching it would need a Supabase management token, which can do far more than a public key.

### Step 3. Cloudflare: an API token for the DNS records (then into Parameter Store)

The pipeline creates and keeps four DNS records in the zone `fenvix.dev`: `api` and `console` (CNAMEs to AWS) and
the two certificate validation CNAMEs; it removes the API's retired name `github` only while that is still a CNAME to
API Gateway. It touches no other record.

1. <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → template **Edit zone DNS** → **Use template**.
2. **Permissions:** the first row is already `Zone` · `DNS` · `Edit`. Click **+ Add more** and set `Zone` · `Zone` ·
   `Read`.
3. **Zone Resources:** `Include` · `Specific zone` · `fenvix.dev`.
4. **Continue to summary** → **Create Token** → **Copy** the token (it is shown once).
5. In Parameter Store (the link of step 2) → **Create parameter**: Name `/fenvix/prod/bootstrap/cloudflare-api-token`,
   Tier Standard, Type **SecureString**, Value = the token → **Create parameter**.

(Without a token the pipeline still deploys: it lists each record to add by hand in the run's summary, waits up to 20
minutes for it, and if it is not there it stops with a red line naming the exact record. Add it, then **Run workflow**
again: that run finds it and goes on. The token is what makes it hands-off.)

### Step 4. Supabase: the dashboard's address for sign-in links

Supabase sends people back to the dashboard after signing in (email links, providers) only to addresses it knows.

1. Supabase → your project → **Authentication** → **URL Configuration**.
2. **Site URL:** `https://console.fenvix.dev` → **Save**.
3. **Redirect URLs → Add URL:** `https://console.fenvix.dev/**` → **Save URLs**. (If an address from an earlier setup is
   listed, such as the dashboard's former host, remove it: the trash icon on its row.)

The pipeline cannot set this itself without a Supabase management token, which would give it control of the whole
Supabase account.

### Not available on GitHub Free: a rule that forces pull requests on `main`

Branch protection and rulesets ("Require a pull request before merging", "Block force pushes") are not available for
private repositories on GitHub Free, so this page no longer asks for one. Consequence: anyone with write access to the
repository (a person, or a token or agent with `contents: write`) can push to `main` directly, and that push deploys.
Give write access only to whom you would let deploy. See "What keeps other code away from AWS" below.

### Then: merge

Merge the pull request. The workflow **Deploy** starts (GitHub → **Actions**). The first run takes longer (about
30 to 60 minutes: certificates, CloudFront). Its summary page lists what it did.

If you merged before steps 1 and 2, the first run stops at "AWS credentials" or "Check the one-time setup", changing
nothing: do the steps, then **Actions → Deploy → Run workflow** (branch `main`) → **Run workflow** (or merge the next
pull request).

### What keeps other code away from AWS (and what does not)

- **AWS enforces "only `deploy.yml` on `main`":** the role's trust accepts only the token of a job on
  `refs/heads/main` of this repository (by its id), and only from the workflow file `.github/workflows/deploy.yml`
  (`job_workflow_ref`). A branch, even with an edited workflow, a pull request (also from a fork), a tag, or a new
  workflow file on `main` (`workflow_run`, `issue_comment`, `schedule`, ...) cannot assume it.
- **In the repository:** only `deploy.yml` may ask GitHub for that token (`id-token: write`); it runs on a push to
  `main` or "Run workflow" only, and its deploy job only on `refs/heads/main`. `test.yml` (pull requests) gets no token
  and no credential. `infra/github-app/test/workflows.test.ts` parses the workflows with a real YAML parser (strict,
  no anchors, aliases, tags, merge keys, second documents or multi-line quoted strings) and fails if a workflow gains
  `id-token: write` or `write-all`, if `deploy.yml` gains a job or a trigger (`pull_request_target`, `workflow_run`,
  `issue_comment`, `schedule`, ...), if its `if` stops requiring `main`, or if any workflow reads a GitHub secret or
  names an environment.
- **Residual risk, plainly:** a change to `deploy.yml` itself, or to code it runs (the npm packages it installs, the
  CDK app, the scripts under `deploy/`), that reaches `main` runs with the deploy role on its first run, before any
  test can object: a direct push (GitHub Free cannot forbid it on a private repository) or a pull request merged
  without reading it. The role can deploy code that reads the App's secrets and can read the Supabase admin
  connection string and the Cloudflare token. This is the same power as merging any change to the code, so: give
  write access only to people and tools you would let deploy, and read every change before merging it. A paid plan
  would add a ruleset on `main` (pull request required, no force push) and a GitHub environment as a second check; it
  is not needed for the pipeline to work.
- **UNKNOWN until the first real run:** GitHub documents `job_workflow_ref` for reusable workflows; the value it puts
  there for a job written directly in `deploy.yml` is expected to be the file itself on `refs/heads/main`, but has not
  been seen. If it differs, the first deploy stops at "AWS credentials" and changes nothing (fail safe).
- **GitHub Actions minutes:** private repositories on GitHub Free have a monthly quota of Actions minutes. The first
  deploy takes about 30 to 60 minutes and every pull request runs the Tests; see the repository's **Settings →
  Billing and plans** (or your account's **Settings → Billing and licensing**) for the remaining minutes.

## B. What one push to `main` does

The workflow **Tests** (`.github/workflows/test.yml`) runs on every pull request, with a read-only token and no
credential. The workflow **Deploy** (`.github/workflows/deploy.yml`) runs on every push to `main` (and on "Run
workflow"): first the same tests, then the job **Deploy to production**, only on `main`. In order:

1. **Tests:** actionlint on the workflow; the one-click template matches the policy files; the GitHub App and the
   dashboard API (typecheck, unit, integration against a local Supabase); the row level security tests; the
   infrastructure (CDK synth, cdk-nag, policies); the deploy steps (migrations, secrets, DNS); the dashboard (contract
   check, typecheck, build, unit tests). Any failure stops everything: nothing is deployed.
2. **AWS credentials** by OpenID Connect (a session of at most 2 hours for `fenvix-github-deployer`). The account is
   checked to be 865859654353.
3. **Check the one-time setup:** reads your values from Parameter Store (`/fenvix/prod/bootstrap/*`; each masked in
   the log before any use; a missing connection string stops, naming the parameter); the Supabase connection string's
   form (session pooler) and the Supabase URL derived from it; the anon key is public (a publishable key, or a JWT
   whose role is `anon`) and of the same project (stops on a `service_role` or `sb_secret_` key, never printing the
   value); whether the Cloudflare token is there.
4. **Database migrations** (`deploy/lib/migrate.mjs`): `supabase/migrations/NNNN_*.sql`, each once, in order, each in
   its own transaction with its record in `fenvix_deploy.schema_migrations` (version, file, SHA-256, when, how). A
   failing migration is rolled back whole and stops the deploy. **The first run** finds what was applied by hand: your
   project has 0001 to 0010 (the earlier product) and 0011 to 0017 (pasted in the SQL editor on 2026-11-19). It checks
   the objects each of 0011 to 0017 creates, records 0001 to 0017 as already applied ("found") and runs none of them
   again. Each probe checks a migration's first objects **and its last effects**: a migration that ran only partly
   (first there, last missing) stops the deploy, changing nothing, as does a database where a later migration's
   objects exist but an earlier one's do not. An applied migration whose file changes stops the deploy too: a change goes in a new migration file.
5. **Database roles** (`deploy/lib/roles.mjs`): logs in as `fenvix_github_app` (pooler, session mode, port 5432) and
   `fenvix_api` (pooler, transaction mode, port 6543) with the connection strings stored in SSM. The first time (none
   stored), or if the database answers "wrong password" (SQLSTATE 28P01) to the stored string four times in a row
   (10 seconds apart): a new 256-bit password, its SCRAM verifier set on the role in a transaction that is committed
   only once the new connection string is stored in SSM (`database-url`, `api-database-url`), then the login checked.
   Any other failure (network, timeout, the pooler's "Tenant or user not found") never changes a password: the step
   stops and the next run tries again.
6. **Generated secrets** (`deploy/lib/secrets.mjs`): `webhook-secret`, `state-signing-key`, `runner-token` and the
   cache signing key pair, created in SSM if missing, never overwritten, never printed.
7. **GitHub App:** if its five parameters are in Parameter Store (section C), the private key and client secret are
   checked for their shape (masked, never printed, never copied) and the stack is built with the App; if none is
   there, without it; half set stops the deploy, naming the missing parameters.
8. **Dashboard certificate:** requested in us-east-1 for `console.fenvix.dev` (once), its validation record put in
   Cloudflare, waited for (first run only).
9. **API certificate** (`node deploy/cli.mjs api-certificate`): requested in eu-west-1 for the API's host (once; the
   host is `infra/github-app/cdk.json` `domainName`, `api.fenvix.dev`), its validation record put in Cloudflare (or,
   without a token, listed in the summary), waited for up to 20 minutes. Not issued by then: the run **stops here**
   with the exact record to add, having changed nothing else; the next run finds the certificate and goes on.
   CloudFormation therefore never waits for DNS.
10. **CDK deploy** of both stacks: `fenvix-prod-github-app` (API Gateway with the certificate of step 9, Lambdas, SQS,
   schedules, runner image pipeline, launch template, cache machine) and `fenvix-prod-dashboard` (S3, CloudFront).
11. **DNS:** `api.fenvix.dev` → API Gateway, `console.fenvix.dev` → CloudFront (CNAMEs, DNS only); the retired
    `github.fenvix.dev` CNAME is removed while it still points at API Gateway. Without a token: the record is listed,
    waited for in public DNS up to 20 minutes, and the run stops with the exact record if it is not there (the stacks
    are deployed by then; the next run finishes).
12. **Dashboard:** built with `VITE_API_URL` = the stack's output `DashboardApiUrl` (`https://api.fenvix.dev/v1`), the Supabase URL and the anon key, uploaded
    to the bucket (hashed files cached a year, `index.html` never), CloudFront's cache refreshed.
13. **Runner image:** if no image of the current recipe exists, its build is started (30 to 45 minutes; the deploy
    does not wait; jobs queued meanwhile wait for it).
14. **Check:** `https://api.fenvix.dev/healthz` answers 200, `/v1/me` answers 401, `https://console.fenvix.dev/`
    answers 200.

Runs never overlap: a push during a deploy waits for it. Only runs on `main` are in the deploy queue: a "Run workflow"
started on another branch deploys nothing and can neither cancel nor replace a deploy waiting there; pull requests run
in the other workflow (Tests).

## B2. L'API passa da `github.fenvix.dev` a `api.fenvix.dev` (una volta, 2026-11-20)

Per il founder, in italiano. L'API (webhook di GitHub, API della dashboard, report dei runner) cambia solo **nome**:
da `github.fenvix.dev` a `api.fenvix.dev`. È come cambiare l'insegna del negozio: il negozio (lo stack AWS
`fenvix-prod-github-app`, le funzioni, le code, i log) resta lo stesso, con lo stesso nome interno. Il vecchio nome
`github.fenvix.dev` viene **tolto** (nessuno lo usa ancora). Senza il token Cloudflare i record DNS li aggiungi tu;
la pipeline ti dice quali, li aspetta 20 minuti e, se non ci sono, si ferma con il record esatto in rosso: lo aggiungi
e rilanci. Fai i passi in quest'ordine, uno alla volta.

1. **Aggiorna lo stack `fenvix-bootstrap`** (dà al deploy il permesso di chiedere il certificato di `api.fenvix.dev`
   in eu-west-1). Scarica il file: <https://github.com/Mircoguidetti/fenvix-app/blob/claude/api-domain/infra/bootstrap/fenvix-bootstrap.json>
   → icona **Download raw file** (in alto a destra del file). Poi
   <https://eu-west-1.console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks> → clicca `fenvix-bootstrap`
   → **Update** (o **Update stack** → **Make a direct update**) → **Replace existing template** → **Upload a template
   file** → **Choose file** → il file scaricato → **Next** → **Next** (parametri invariati) → **Next** → in fondo spunta
   **"I acknowledge that AWS CloudFormation might create IAM resources with custom names."** → **Submit**. Aspetta
   **UPDATE_COMPLETE** (circa 1 minuto).
2. **Cloudflare: libera il nome `api`.** <https://dash.cloudflare.com> → `fenvix.dev` → **DNS** → **Records** → nella
   ricerca scrivi `api`. Se c'è un record il cui **Name** è esattamente `api` (di qualunque tipo: A, AAAA, CNAME, TXT…),
   aprilo con **Edit** → **Delete** → conferma. Se non c'è, vai avanti.
3. **Cloudflare: controlla i CAA.** Stessa pagina, nella ricerca scrivi `CAA`. Se **non** c'è nessun record di tipo
   `CAA`, vai avanti. Se ce n'è almeno uno: **Add record** → **Type** `CAA` → **Name** `@` → **Tag** `Only allow
   specific hostnames` → **CA domain name** `amazon.com` → **Save** (senza questo AWS non può emettere il certificato).
4. **Il coordinatore fa il merge** del pull request `claude/api-domain` (con il tuo OK). Parte da solo il workflow
   **Deploy**: <https://github.com/Mircoguidetti/fenvix-app/actions/workflows/deploy.yml> → apri l'esecuzione in alto.
5. **Record di convalida del certificato.** Quando il passo **7c. API certificate** è in corso, nel suo log (e in un
   avviso giallo nella pagina dell'esecuzione) compare una riga `Add in Cloudflare (fenvix.dev → DNS → Add record):
   CNAME, Name _….api, Target _….acm-validations.aws, Proxy status DNS only`. In Cloudflare → `fenvix.dev` → **DNS** →
   **Records** → **Add record** → **Type** `CNAME` → **Name** = quel `_….api` → **Target** = quel `_….acm-validations.aws`
   → **Proxy status**: clicca la nuvola finché è **grigia** (**DNS only**) → **Save**. Se il passo si ferma in rosso
   prima ("The certificate of api.fenvix.dev is PENDING_VALIDATION … Add it: …"), aggiungi lo stesso record e rilancia:
   pagina del workflow **Deploy** → **Run workflow** → branch `main` → **Run workflow**.
6. **Record `api`.** Quando il passo **9. DNS records** è in corso compare un'altra riga: `CNAME, Name api, Target
   d-….execute-api.eu-west-1.amazonaws.com`. In Cloudflare → **Add record** → **Type** `CNAME` → **Name** `api` →
   **Target** = quel `d-….execute-api.eu-west-1.amazonaws.com` (copialo esatto) → nuvola **grigia** (**DNS only**) →
   **Save**. Se il passo si è già fermato in rosso ("api.fenvix.dev is not a CNAME to … yet"), aggiungi il record e
   rilancia come al passo 5: la nuova esecuzione trova tutto pronto e finisce.
7. **Cloudflare: togli il vecchio nome.** In **DNS** → **Records**, ricerca `github`: cancella (**Edit** → **Delete**)
   il CNAME con Name `github` (Target `d-h3eqk8udlf.execute-api.eu-west-1.amazonaws.com`) e il CNAME il cui Name
   comincia con `_` e finisce con `.github` (Target `….acm-validations.aws`). Non toccare altri record.
8. **Vercel: il nuovo indirizzo dell'API.** <https://vercel.com/fenvix/fenvix-app> → **Settings** → **Environment
   Variables** → riga `VITE_API_URL` → **⋯** → **Edit** → **Value** `https://api.fenvix.dev/v1` (tutti gli ambienti)
   → **Save**. Poi **Deployments** → l'ultimo deploy di **Production** → **⋯** → **Redeploy** → **Redeploy**.
9. **Controllo.** Apri <https://api.fenvix.dev/healthz>: deve rispondere `{"ok":true,…}`. Apri
   <https://console.fenvix.dev>, accedi: devi arrivare alla dashboard senza "could not reach the server".
   <https://github.fenvix.dev/healthz> non risponde più: è giusto.

Il GitHub App non è ancora creato: quando lo crei (sezione C) usa già `https://api.fenvix.dev/...` (la tabella C2 è
aggiornata).

## C. Connecting the GitHub App (last; browser only)

Until this is done the API and the dashboard work; "Connect GitHub" in the dashboard says that GitHub is not connected
yet, and `api.fenvix.dev`'s GitHub routes answer 503 `github_not_configured`.

**C1.** Copy the webhook secret the pipeline generated: AWS console →
<https://eu-west-1.console.aws.amazon.com/systems-manager/parameters/?region=eu-west-1> → `/fenvix/prod/github-app/webhook-secret`
→ **Show decrypted value** (under "Value") → copy.

**C2.** Create the App: **github.com → Settings → Developer settings → GitHub Apps → New GitHub App** (for a
company-owned App, in the organization's settings):

| Field | Value |
|---|---|
| GitHub App name | `fenvix` (if taken: `fenvix-ci`) |
| Homepage URL | `https://console.fenvix.dev` |
| Callback URL | `https://api.fenvix.dev/github/setup` |
| Expire user authorization tokens | on |
| Request user authorization (OAuth) during installation | **on** |
| Enable Device Flow | off |
| Redirect on update | on |
| Webhook: Active | on |
| Webhook URL | `https://api.fenvix.dev/webhooks/github` |
| Webhook secret | the value from C1 |
| SSL verification | Enable |
| Repository permissions | Actions: **Read-only** · **Administration: Read and write** · Checks: **Read and write** · Contents: **Read and write** · Metadata: Read-only · Pull requests: **Read and write** · **Workflows: Read and write** |
| Organization / account permissions | none |
| Subscribe to events | **Pull request**, **Push**, **Workflow job**, **Repository** |
| Where can this GitHub App be installed? | Only on this account (for now) |

Click **Create GitHub App**. `docs/GITHUB-APP.md` explains the permissions. **Administration: Read and write** is the
permission GitHub requires to register a just-in-time runner on a repository (`POST .../actions/runners/generate-jitconfig`);
the App uses it for nothing else.

**C3.** On the App's General page: **Generate a new client secret** (copy it once), then **Private keys → Generate a
private key** (a `.pem` file downloads; open it with a text editor such as TextEdit or Notepad and copy all of it).

**C4.** AWS → Parameter Store → **Create parameter**
(<https://eu-west-1.console.aws.amazon.com/systems-manager/parameters/create?region=eu-west-1>), once per row, Tier
Standard, Data type text:

| Name | Type | Value |
|---|---|---|
| `/fenvix/prod/bootstrap/github-app-id` | String | the **App ID** (General page) |
| `/fenvix/prod/bootstrap/github-app-slug` | String | the App's URL name: the last part of `https://github.com/apps/<slug>` |
| `/fenvix/prod/bootstrap/github-app-client-id` | String | the **Client ID** (General page) |
| `/fenvix/prod/github-app/client-secret` | **SecureString** | the client secret from C3 |
| `/fenvix/prod/github-app/private-key` | **SecureString** | the whole `.pem` content from C3, from `-----BEGIN` to `-----END ... KEY-----` (the Value box keeps the line breaks) |

The two secret ones go straight where the App's functions read them (`/fenvix/prod/github-app/`), so nothing copies
them. Then delete the `.pem` file from Downloads.

**C5.** **Actions → Deploy → Run workflow** (branch `main`) **→ Run workflow** (or merge the next pull request). The summary says "GitHub App:
configured".

**C6.** GitHub → the App's settings → **Advanced → Recent Deliveries**: open the failed `ping`, click **Redeliver**.
The response must be `200 {"ok":true,"pong":true}`.

**C7.** In the dashboard (`https://console.fenvix.dev`): **Projects → Connect GitHub**, install the App on a repository,
come back, open the setup pull request. Each queued fenvix job then gets its own machine (EC2 → Instances shows
`fenvix-j<job id>`, terminated after the job).

## D. Optional settings

In Parameter Store (like section A, step 2):

| Name | Type | Effect |
|---|---|---|
| `/fenvix/prod/bootstrap/supabase-ca-cert` | String | Supabase's CA certificate (public): Supabase → Project Settings → Database → **SSL Configuration** → **Download certificate**, open the file in a text editor and paste all of it. The pipeline then verifies the pooler's certificate (like `sslmode=verify-full`) on its admin connection, which carries the database password. Without it the connection is encrypted but the certificate is not checked. If the deploy then stops with "did not verify against SUPABASE_CA_CERT", download it again or delete the parameter. |

As repository variables (GitHub → this repository → **Settings → Secrets and variables → Actions → Variables** tab →
**New repository variable**; available on GitHub Free; not secret):

| Variable | Effect |
|---|---|
| `FENVIX_ALARM_EMAIL` | an email for the dead-letter alarm (confirm the subscription email AWS sends) |
| `CLOUDFLARE_ZONE_ID` | the zone's id (Cloudflare → fenvix.dev → Overview, right column), if the token cannot read zones |
| `FENVIX_RUNNER_MODE` / `FENVIX_DEMO_REPOSITORY` | `demo` and `owner/name`: demo mode (section E) instead of per-job. Needs the GitHub App. |

There is no approval step before a deploy (it needs a GitHub environment, which GitHub Free does not offer for a
private repository): merging is the approval.

Other settings (instance types, limits, warm-ups, log retention) are in `infra/github-app/cdk.json` (`context`):
change them in a pull request.

## E. Demo mode (an option, off)

One fresh c6i.large per demo, registered as a runner on one repository of yours, terminated after the demo. Set the
repository variables (section D) `FENVIX_RUNNER_MODE` = `demo` and `FENVIX_DEMO_REPOSITORY` = `owner/name` (a private repository
of yours, with the App installed), run the workflow. Then, in the AWS console → Lambda →
`fenvix-prod-github-app-demo` → **Test**: event JSON `{"action":"up"}` before the demo, `{"action":"status"}` to see the
runner, `{"action":"down"}` after it. The reaper terminates a forgotten demo machine after 12 hours. Remove the two
variables and run the workflow to go back to per-job.

## When something fails

| What you see | Where to look | What to do |
|---|---|---|
| the run stops at **AWS credentials** (`Not authorized to perform sts:AssumeRoleWithWebIdentity`) | the step's log | step 1 not done (or not CREATE_COMPLETE, or created from an older file: update it, step 1 last paragraph); or the run was not on `main` |
| **Check the one-time setup** says `The SSM parameter /fenvix/prod/bootstrap/... is missing` or `SUPABASE_DB_URL ...` | the step's log (one sentence: what is wrong) | create or fix the parameter (section A, step 2: Parameter Store → the name → **Edit**); never the direct connection, always the Session pooler |
| **Check the one-time setup** says `Could not read the SSM parameter ... (AccessDeniedException)` | the step's log | the `fenvix-bootstrap` stack is older than this page: update it (section A, step 1, last paragraph) |
| **Check the one-time setup** says `SUPABASE_ANON_KEY holds ...` | the step's log (it never prints the key) | put the `anon` or publishable key of the same project in `/fenvix/prod/bootstrap/supabase-anon-key` (step 2); if it said service_role or secret key, also roll that key in Supabase (Project Settings → API Keys / JWT Keys) |
| **Database migrations** stops: "looks half-applied: its first objects exist but its last effects do not" | the step's log | a migration was run only partly by hand; nothing was changed: a person must finish it in the SQL editor |
| **Database roles** stops: "failed 4 times, never with wrong password" | the step's log | the password was not changed; run the workflow again later (the pooler was not answering) |
| **Database migrations** stops: "changed after it was applied" | the step's log | an applied migration file was edited: revert it and put the change in a new file |
| **Database migrations** stops: "looks half-applied" / "not a fenvix database" | the step's log | nothing was changed; the database differs from what the migrations describe: a person must look at it in the SQL editor |
| **Database migrations** stops: "... failed and was rolled back" | the step's log (the Postgres error) | fix the migration in a pull request; nothing of it was applied |
| **Database roles**: "logging in through the pooler still fails" | the step's log | run the workflow again (the pooler can take a moment to see a new password) |
| **GitHub App**: "half configured" | the step's log (it names what is missing) | add the missing parameters (section C4), or delete all five |
| **CDK deploy** stops: `... is not authorized to perform: <action>` | the step's log; CloudFormation → the stack → Events | add the action to the matching `infra/github-app/cfn-exec-policy-*.json` in a pull request; the policies are updated by updating the `fenvix-bootstrap` stack (section A, step 2, last paragraph) |
| **API certificate** stops: "The certificate of api.fenvix.dev is PENDING_VALIDATION" | the step's red line (it names the record) | without a Cloudflare token: add that CNAME in Cloudflare, DNS only, then **Run workflow**. With one: wait 10 minutes and run it again; if it repeats, the token lacks `Zone · DNS · Edit` on fenvix.dev |
| **API certificate** stops: "The deploy role may not request the certificate" | the step's log | the `fenvix-bootstrap` stack is older than this code: update it (section A, step 1, last paragraph), then **Run workflow** |
| **DNS records** stops: "api.fenvix.dev is not a CNAME to ... yet" | the step's red line (it names the record) | add or edit the `api` record in Cloudflare exactly as named (CNAME, DNS only), then **Run workflow** |
| **DNS records** stops: "... already exists at this name, and a CNAME cannot sit beside it" | the step's log | another record (TXT, MX, ...) holds that name in Cloudflare: delete it if nothing uses it, then **Run workflow** |
| the dashboard says "could not reach the server"; the browser console shows a CORS error | CloudWatch → Log groups → `/aws/lambda/fenvix-prod-github-app-api` | the dashboard's origin must be `https://console.fenvix.dev` (`dashboardUrl`) |
| every dashboard call answers **401** | the API log | `supabase-db-url` and `supabase-anon-key` must be of the same Supabase project (checked for an anon JWT; a publishable key carries no project, so it is not) |
| every dashboard call answers **500** / **503** | the API log (`password authentication failed`, `timeout`) | run the workflow: the role check sets a new password when the stored one is refused |
| a GitHub delivery shows **503** `github_not_configured` | | section C is not finished (C5) |
| a GitHub delivery shows **401** | the App's webhook secret vs `/fenvix/prod/github-app/webhook-secret` | make them equal (C1, C2), then redeliver |
| a fenvix job stays **Queued**; the worker logs `the installation is not linked` / `no runner image yet` / `limit 4` | `/aws/lambda/fenvix-prod-github-app-worker` | link the installation from the dashboard / wait for the image build (EC2 Image Builder → Images) / 4 machines busy (retried for about an hour) |
| the dead-letter alarm fires | `/aws/lambda/fenvix-prod-github-app-worker` | fix the cause, then SQS → `fenvix-prod-github-app-dead-letters` → **Start DLQ redrive** |

### Rotating a secret (AWS console → Systems Manager → Parameter Store)

Every function reloads its secrets every **5 minutes**, so a rotation needs no deploy unless said.

- **A database password** (`database-url`, `api-database-url`): **Delete** the parameter, then run the workflow. It sets
  a new password and stores the new connection string. Functions that are already running keep the old string until
  their next reload: their new connections fail for up to 5 minutes.
- **runner-token**: copy its value to a new SecureString `/fenvix/prod/github-app/runner-token-previous`, then delete
  `runner-token` and run the workflow (a new one is generated). Machines started before keep working. A day later,
  delete `runner-token-previous`.
- **webhook-secret**: delete it, run the workflow, copy the new value to the App's page (C1, C2). Deliveries in
  between fail with 401 and can be redelivered.
- **state-signing-key**: delete it and run the workflow. An install link made with the old key fails (ask for a new
  link).
- **The App's private key or client secret:** generate a new one on the App's page, then Parameter Store →
  `/fenvix/prod/github-app/private-key` (or `client-secret`) → **Edit** → paste → **Save changes**. The functions load
  it within 5 minutes; no deploy needed.
- **Cache signing key:** delete `/fenvix/prod/cache/signing-public-key` and run the workflow: a new pair is made, the
  cache machine is replaced and the shared cache starts empty.
- **Supabase's database password** (the one in `supabase-db-url`): reset it in Supabase, then Parameter Store →
  `/fenvix/prod/bootstrap/supabase-db-url` → **Edit** → the new connection string → **Save changes**.
- **Cloudflare token:** roll it in Cloudflare, then edit `/fenvix/prod/bootstrap/cloudflare-api-token` the same way.

### To remove everything (AWS console)

1. Wait until no job machine runs (EC2 → Instances, tag `fenvix:role`).
2. S3: **Empty** the overflow bucket (`fenvix-prod-github-app-overflow...`).
3. CloudFormation: **Delete** `fenvix-prod-dashboard`, then `fenvix-prod-github-app`. The dashboard bucket
   (`fenvix-prod-dashboard-865859654353`) is kept on purpose: empty it and delete it in S3.
4. EC2 → AMIs: deregister the runner images, then delete their snapshots.
5. CloudFormation: **Delete** `fenvix-bootstrap` last (it keeps its assets bucket `cdk-fenvix-assets-...`: empty and
   delete it in S3). The SSM parameters and the ACM certificates (the API's in eu-west-1, the dashboard's in us-east-1) stay; delete them by hand (including `/fenvix/prod/bootstrap/*`). Remove the four records in Cloudflare.

## The dashboard API

The dashboard talks only to this API, never to the database. The contract is `openapi/fenvix-api.yaml` (operations
tagged `dashboard`); the server is `github-app/src/api/`, its Lambda entry `github-app/src/lambda/api.ts`.

| | |
|---|---|
| Routes | API Gateway sends `ANY /v1/{proxy+}` to the api function, `ANY /v1/runner/{proxy+}` and everything else (`/webhooks/github`, `/github/setup`, `/healthz`) to the http function. The more specific route wins. |
| Sign-in | `Authorization: Bearer <Supabase access token>`, checked against the project's published keys (JWKS; ES256, RS256 or EdDSA only; issuer `<supabaseUrl>/auth/v1`, audience `authenticated`). No token or a bad one: 401. |
| Organization | `X-Fenvix-Workspace: <organization id>` on every organization operation. Not a member: 404, the same as an organization that does not exist. A member calling an owner-or-admin operation (`x-fenvix-role: admin` in the contract): 403. |
| Database | role `fenvix_api` through the transaction pooler (its password and connection string are set by the pipeline, section B step 5). In every transaction the API names the user and the organization (`set_config('app.user_id', …, true)`, `set_config('app.workspace_id', …, true)`); row level security shows a row only to a member of its organization and lets only owners and admins change settings, members, invitations and project settings (a second barrier behind the API's own checks). |
| CORS | answered by the function (API Gateway has no CORS setting): only `dashboardUrl`'s origin and `apiCorsOrigins`; headers `authorization`, `content-type`, `x-fenvix-workspace`, `if-none-match`; `etag`, `content-disposition` and `retry-after` readable. |
| Live run view | `GET /v1/runs/{id}` answers an `ETag` (from the run's `updated_at` and `progress_at`, and the project as shown) with `Cache-Control: private, no-cache`; the same `If-None-Match` answers 304 with no body. |
| Setup pull request | `POST /v1/github/repositories/{id}/setup-pull-request` queues `{ kind: "onboard", repositoryId }` on the work queue; the worker opens the pull request. |

Tests (the workflow's Tests job runs all of them; a developer can run them too): `cd github-app && npm test` runs the API's unit tests and, with the local Supabase running
(`bash scripts/local-supabase/up.sh`, Docker), its integration tests (real Supabase Auth tokens; every dashboard
operation; every 2xx answer validated against the contract). `TEST_DATABASE_URL=... npm run test:rls` (repository
root) runs the row level security tests (`supabase/tests/`).

## Per-job mode: why the shared cache is a small machine, not Lambda + S3

(Demo mode has no shared cache: each demo machine keeps its cache on its own disk, deleted with it.)

The cache service is the engine's own (`detpy.cache_service`, `docs/SHARED-CACHE.md` in fenvix-engine-cli). It is
deployed here unchanged, byte for byte, at the pinned commit, behind a small wrapper of ours
(`lib/cache/fenvix_cache_auth.py`) that replaces its token file with per-job signed tokens. Two of its properties rule out Lambda as it is written:

- It stores everything in **SQLite in WAL mode**. WAL does not work on a network file system (EFS), and Lambda has no
  other durable disk.
- Its client uploads batches of up to **16 MB** per request. API Gateway accepts 10 MB, and a synchronous Lambda call
  6 MB.

Lambda + S3 would mean rewriting the service's storage (for example S3 for documents and DynamoDB for the key log)
and its batching, in the engine repository. That is possible later.

Until then, the cheapest place where the service runs unchanged is one **t4g.nano** with an 8 GB disk:
**$3.36 + $0.70 a month**. It has no public address (no IPv4 charge) and no outbound route. Runners reach it inside
the VPC over HTTP; the client allows plain HTTP there through `FENVIX_CACHE_ALLOW_HTTP=1`. If the machine is
replaced, the cache starts empty, and the next runs record it again.

**One cache organization per customer installation.** The service scopes every entry, file fact and run to the
organization of the token. The worker signs one token per job (RSA, the key in SSM that only it reads) naming
`gh-<installation id>`, read or write, and an expiry; the cache machine checks it with the public key (setting
`cacheSigningPublicKey`). A job of one customer therefore never reads or writes another customer's cache, and a pull
request never writes. Nothing role-wide is on a job machine to steal.

## Time from a queued job to the first test (ESTIMATE, not measured)

No AWS account was available, so none of this was measured.

These estimates assume the machine runs at full speed, which is why the default is a c6i.large and not a T3 (a fresh
T3 in "standard" mode has no credits and runs at 20% of a vCPU).

**Demo mode.** The machine is started before the demo, and the demo function's `up` returns once it is started; the runner is online a minute or two later. A job then
starts within a few seconds of being queued, as on any self-hosted runner. The first test runs after the job's own
setup (checkout, `uv venv`, install: 10 to 60 s depending on the project). Starting the demo machine takes about 1 to
2 minutes, before the demo.

**Per-job mode** (a machine is started per job):

| Stage | Estimate |
|---|---|
| GitHub queues the job → webhook at API Gateway | about 1 s |
| HTTP Lambda → SQS → worker Lambda (warm; cold start adds 1–2 s) | under 1 s |
| worker: workflow run, `generate-jitconfig`, newest image, RunInstances | 1–2 s |
| EC2 pending → running | 10–20 s |
| Ubuntu boot → user data → runner connected and assigned the job | 30–50 s |
| **job starts (Set up job)** | **≈ 45–75 s after queued** |
| checkout, `uv venv`, project and engine install | 10–60 s, depending on the project; the first reads of the disk are slower, because a volume made from an image loads its blocks on first access |
| **first test runs** | **≈ 1–2.5 minutes after queued** |

A GitHub-hosted runner usually starts a job within seconds. The time lost here is the price of starting nothing when
no job runs. To cut it later: keep one warm, stopped machine to start, or turn on EBS fast snapshot restore (billed
per hour).

## Monthly cost

**Added by the pipeline (ESTIMATE; prices not re-read in this session):** the dashboard on S3 + CloudFront (a few MB
of files; CloudFront's always-free tier covers 1 TB and 10 million requests a month as last read, before this
session), the CDK assets bucket (the functions' zips, a few MB per deploy), the ACM certificates (free) and GitHub
Actions minutes (free for a public repository; on a private one they count against the plan's included minutes: a
deploy run takes about 15 to 25 minutes of tests and 10 to 15 of deploy, ESTIMATE). Expected well under $1 a month
at this size; not measured.

All prices are for eu-west-1, on demand, in USD, read on **2026-11-18**. Each price is marked **DECLARED**: it is
AWS's published price, read today, and not a measured bill.

The regional numbers come from AWS's official **Price List API**
(`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/current/eu-west-1/index.json`, with SKU and
publication date). The aws.amazon.com pricing pages load those same numbers in the browser from a data host that this
container's network refused, so the pages could not be read for them. The aws.amazon.com pages were read for the free
tiers, the metering units, the billing granularity and the flat prices.

| Item | Price (DECLARED) | Source (read 2026-11-18) |
|---|---|---|
| EC2 c6i.large, Linux (runner machines and the image build, default) | $0.0912 per hour; **billed per second, 60-second minimum** | Price List API AmazonEC2, SKU MY34M56N9KVPBWDG (as read by review R-012 on 2026-11-18; not re-read in this session, see below); aws.amazon.com/ec2/pricing/on-demand ("by the hour or second (minimum of 60 seconds)") |
| EC2 t3.medium, Linux (only if chosen; runs "unlimited") | $0.0456 per hour, plus $0.05 per vCPU-hour of surplus credits above the 20% baseline: ≈ $0.1256 per hour at full speed | Price List API AmazonEC2, SKU 47NTBKB4KMUU98P8; surplus credits SKU Z25C5STUBANBQC5Y (R-012) |
| EC2 t4g.nano, Linux | $0.0046 per hour | Price List API AmazonEC2, SKU 2WUM3HJN9JGXQ3A8 |
| EBS gp3 | $0.088 per GB-month; billed per second, 60-second minimum; 3,000 IOPS and 125 MB/s included | Price List API AmazonEC2, SKU TXACT7E3PV6ZX2NM; aws.amazon.com/ebs/pricing |
| EBS snapshot, Standard tier (the runner images) | $0.05 per GB-month of data stored (incremental) | Price List API AmazonEC2, SKU UZ7N3QU3DRSU25FK; aws.amazon.com/ebs/pricing |
| Public IPv4 address | $0.005 per hour | aws.amazon.com/vpc/pricing (and Price List API AmazonVPC) |
| EC2 Image Builder | no cost besides the resources it uses | aws.amazon.com/image-builder (its pricing page answered 404) |
| EC2 c7i.xlarge, Linux (customer-mode host) | $0.19152 per hour | Price List API AmazonEC2, SKU UGSWTF5QKT6FFUDJ |
| EC2 c7i.2xlarge, Linux (customer-mode host for 3 full-speed jobs) | $0.38304 per hour | Price List API AmazonEC2, SKU QC3ZMNBVRWVYJ3M2 |
| Nested virtualization on C7i (the KVM fallback) | no additional cost | docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html (re-read 2026-11-18: "There is no additional cost for using nested virtualization"; C7i listed) |
| EC2 c5n.metal, Linux (the cheapest x86 bare metal in eu-west-1, of 72; no longer the fallback) | $4.392 per hour | Price List API AmazonEC2, SKU 5WTB2K6WFG5VB34R |
| Nitro Enclaves / Nitro Sandboxes | no additional charge ("you pay the standard charges for the Amazon EC2 instance") | docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nitro-sandboxes.html; aws.amazon.com/ec2/nitro/nitro-enclaves/faqs |
| Lambda (x86) | $0.0000166667 per GB-second, $0.20 per 1M requests; free tier 400,000 GB-s and 1M requests per month | Price List API AWSLambda; aws.amazon.com/lambda/pricing |
| SQS standard | $0.40 per 1M requests (64 KB = 1 request); 1M per month free | Price List API AWSQueueService; aws.amazon.com/sqs/pricing |
| API Gateway HTTP API | $1.11 per 1M requests; 1M per month free for 12 months for accounts created before 2025-07-15 (newer accounts get Free Tier credits instead; not material at this volume) | Price List API AmazonApiGateway; aws.amazon.com/api-gateway/pricing |
| EventBridge Scheduler | 14M invocations per month free, then $1.00 per 1M | aws.amazon.com/eventbridge/pricing |
| SSM Parameter Store, standard | no additional charge | aws.amazon.com/systems-manager/pricing |
| CloudWatch Logs | $0.57 per GB ingested, $0.03 per GB-month; 5 GB per month free | Price List API AmazonCloudWatch; aws.amazon.com/cloudwatch/pricing |
| CloudWatch alarm | $0.10 per alarm-month; first 10 free | Price List API AmazonCloudWatch |
| ACM certificate for API Gateway | no cost | aws.amazon.com/certificate-manager/pricing |
| Data transfer out | 100 GB per month free | aws.amazon.com/ec2/pricing/on-demand |

### Option: demo mode

**Assumptions** (ESTIMATE, not measured): the runner image holds about 6 GB of data; 10 demos a month, each machine
up for 2 hours; the serverless part runs as in per-job mode at 0 jobs.

| | Monthly |
|---|---|
| Runner image snapshot (~6 GB × $0.05) | $0.30 |
| Demo machines: 20 hours × ($0.0912 c6i.large + $0.005 IPv4 + 30 GB gp3 at $0.088 ÷ 730 h) = 20 × $0.0998 | $2.00 |
| Lambda, SQS, logs, alarm (without free tier; free at this volume with it) | $0.43 |
| API Gateway, Scheduler, SSM, ACM, S3 | $0.00 |
| **Total without free tiers** | **≈ $2.73** |
| **Total with free tiers** | **≈ $2.30** |

Each extra demo hour costs about $0.10. Image builds add about $0.08 each (45 minutes of c6i.large, its IPv4 address
and disk). Between demos nothing runs, so the cost
is the image snapshot and the serverless part.

### Default: one machine per job

**Assumptions** (ESTIMATE, not measured):

- A job machine lives about **10 minutes** in all: about 1.5 minutes to boot, the job itself, and power-off.
- A runner image holds about **6 GB** of data (Ubuntu, build tools, Rust, Python, the engine build, the GitHub
  runner).
- Each job brings about 10 webhooks and runner requests.
- The sweep runs every minute (43,800 times a month) and the reaper every 10 minutes (4,380).
- The idle SQS trigger polls about 660,000 times a month.

**Per job:**

| Item | Calculation | Cost |
|---|---|---|
| c6i.large | $0.0912 × 1/6 h | $0.01520 |
| public IPv4 | $0.005 × 1/6 h | $0.00083 |
| 30 GB gp3 disk | 30 × $0.088 ÷ 730 h × 1/6 h | $0.00060 |
| **Total** | | **≈ $0.0166** |

**Monthly:**

| | 0 jobs | 100 jobs | 1,000 jobs |
|---|---|---|---|
| Cache machine t4g.nano (730 h) | $3.36 | $3.36 | $3.36 |
| Cache disk 8 GB gp3 | $0.70 | $0.70 | $0.70 |
| Runner image snapshot (~6 GB) | $0.30 | $0.30 | $0.30 |
| Job machines (≈ $0.0166 each) | $0.00 | $1.66 | $16.64 |
| Lambda (without free tier) | $0.06 | $0.07 | $0.25 |
| SQS (without free tier) | $0.26 | $0.26 | $0.28 |
| API Gateway (without free tier) | $0.00 | $0.00 | $0.01 |
| CloudWatch Logs and alarm (without free tier) | $0.11 | $0.11 | $0.12 |
| Scheduler, SSM, ACM, S3, data transfer | $0.00 | $0.00 | $0.00 |
| **Total without free tiers** | **≈ $4.79** | **≈ $6.46** | **≈ $21.66** |
| **Total with free tiers** (Lambda, SQS, logs, alarm free at this volume) | **≈ $4.36** | **≈ $6.02** | **≈ $21.01** |

Image builds add about $0.08 each: 45 minutes of c6i.large, its IPv4 address and disk.

A job that runs longer costs proportionally more. Each extra 10 minutes of job time adds $0.0166. At 1,000 jobs of
20 minutes, the job machines cost about $33.

Warm-up runs (ESTIMATE): one machine like a job's per warm-up, at most `warmupDailyCap` (6) per repository a day, and
none for a commit the customer's own push run covers. At 10 repositories with 6 warm-ups each every working day (22
days), that is 1,320 machines of about 10 minutes: about $22 a month, never billed to the customer. The warm-up
function runs every minute (43,800 invocations a month, within Lambda's free tier).

## Customer mode (design; spike in `infra/customer-mode/spike/`; not built)

**The plan.** Customer jobs run on **c7i** hosts, each job in its own **Firecracker microVM**, using Firecracker's
**Nitro Sandboxes** backend (v1.18.0, released with `PUT /enclave`). The microVM is destroyed after the job. More hosts
are added as customers grow. There is no Docker-per-job path.

**Why a c7i and not a T3 or a metal host.** Nitro Sandboxes run on the instance types that support Nitro Enclaves:
"not currently available on bare metal instances, burstable instance types (e.g. T3), and instances with only 1 CPU
core" (Nitro Enclaves FAQ, read 2026-11-18). C7i is supported except c7i.large and the metal sizes (EC2 User Guide,
Nitro Sandboxes). A sandbox needs no `/dev/kvm`: Firecracker drives `/dev/nitro_enclaves`.

**The real trust boundary is the parent, not only the Nitro Hypervisor.** The Nitro Hypervisor isolates a sandbox's
memory and vCPUs. In direct mode, though, "the trust model is equivalent to that of a nested virtual machine" (AWS):
what a hostile guest attacks is Firecracker's device emulation in the parent, the parent's TAP networking and
anything of the guest's the parent reads. One escape there must not reach other tenants or our credentials. So
(R-012 F17):

- **Firecracker runs under the jailer**, one per sandbox: its own uid, a chroot holding only that job's files, its own
  cgroup, Firecracker's seccomp filter. Never as root.
- **No credential of ours on the path a guest can reach.** The host agent that polls the queue holds only its queue
  role; each job's summary credential (signed by the worker for that job's runner name, repository and run, as in
  per-job mode) is handed over with the job. It is read by `fenvix-post`, a separate user that never reads guest
  bytes. The parent's metadata service has hop limit 1 and is unreachable from any TAP.
- **The host never mounts a disk a guest wrote** (F9). The guest writes its result to a raw 16 MiB disk as one
  length-prefixed record; an unprivileged user (`fenvix-parse`) reads it in userspace with a size cap
  (`read-result.py`). The repository, run, attempt and runner name of the summary come from the host's own job record,
  never from the guest. (vsock is the alternative; the raw disk needs no listener on the host.)
- **The firewall is keyed on the interface** (F10): every rule matches `-i fctap+`; `FORWARD` defaults to DROP; each
  TAP accepts only its own sandbox's source address, and `rp_filter` is strict; only the VPC's DNS
  (`169.254.169.253:53`) is reachable in `169.254.0.0/16`; a sandbox reaches no port of the parent and no other
  sandbox; IPv6 is off on every TAP and dropped by `ip6tables`. Each sandbox has a connection limit (4,096 tracked
  connections), a new-connection rate limit and Firecracker's own bandwidth and packet-rate limiters, so one sandbox
  cannot exhaust the connection-tracking table the others share.
- **The memory pool is mandatory** (F11): "With a memory pool, the parent instance has 4 slots. Without a pool, it has
  0" (EC2 User Guide, "Run Nitro Sandboxes with Firecracker", re-read 2026-11-18). `host-setup.sh` stops unless
  `nitro_enclaves.mempool=` is on the kernel command line (`grubby` and a reboot first) and then sets 12 slots
  (slots grow from 4 in steps of 8; each step uses 128 MiB of the pool).
- Direct mode leaves sandbox memory readable by the parent (us). Confidential mode, with a DMB-patched guest kernel,
  closes that if customers ask for it.

### How a job runs

```
GitHub ── workflow_job.queued ──▶ App (worker Lambda): linked installation? → generate-jitconfig (one job)
                                    → the job's summary credential and cache token (signed per job)
                                    └▶ SQS "jobs" queue (per host group)            [to build: SqsHostLauncher]
c7i host agent (polls the queue; holds no fleet secret):
   1. under /srv/jailer/firecracker/<id>/root, owned by the jail's uid: a copy of the guest disk (reflink), a
      read-only input disk with the jitconfig, an empty raw result disk
   2. TAP device fctap<N> owned by the jail's uid, IPv6 off, its source-address rule
   3. jailer → firecracker --config-file (2 vCPUs, 2 GiB, direct mode, rate limiters)
   4. guest: systemd → fenvix-guest-job → just-in-time runner takes exactly one job → result record onto the raw disk
      → poweroff → the sandbox is torn down (vCPUs and memory back to the pools)
   5. host: fenvix-parse reads the record; fenvix-post sends the summary with the job's credential and the host's ids;
      everything of the job is deleted (also on failure: trap)
```

- **Shared cache.** The same private cache machine as per-job mode, one organization per customer installation,
  per-job tokens; write only for trusted refs.
- **Capacity** (F16; ESTIMATE until measured). A c7i.xlarge has 4 vCPUs on **2 physical cores**. "The Nitro Enclaves
  driver keeps the first core of the parent instance for the parent, and the other cores form the CPU pool" (EC2
  User Guide). Without CPU overcommit, a c7i.xlarge therefore runs **one** 2-vCPU sandbox at full speed. With CPU
  overcommit (the spike's setting), three 2-vCPU, 2 GiB jobs fit by memory but time-share 2 cores with the parent,
  roughly 0.6 core each. For **3 jobs at full speed, plan a c7i.2xlarge** (8 vCPUs, 4 cores: 3 for the pool) at
  $0.38304 per hour, or a Graviton host (one thread per core) if jobs can be arm64. Measure it (test 6 below).
- **Hosts:** one to start; add a host when the queue waits. Scale-out by queue depth is a later step.

### Docker inside the job (`services:`, testcontainers, docker compose)

**Inside a Nitro Sandbox microVM:** expected to work, not yet run.

- Docker needs no hardware virtualization, only Linux kernel features in the guest, and the guest is a normal Linux
  VM.
- The spike's check (`guest-kernel-docker-check.sh`) on Firecracker's CI x86_64 6.18 guest kernel config plus its EFI
  fragment finds **every required option present**: namespaces, cgroups (memory, pids, cpu, devices, freezer, bpf),
  seccomp, keys, overlayfs, ext4, veth, bridge, bridge netfilter, iptables NAT and MASQUERADE, addrtype and conntrack
  matches. Only the optional IP_VS, MACVLAN and IPVLAN are absent; swarm and those network drivers are not needed for
  CI.
- The guest image installs `docker.io`, and the job user is in the `docker` group, inside its own VM.
- Each job starts with an empty image store, so every `docker pull` downloads again. A pull-through registry mirror on
  the host would help; this needs measuring.

**Inside a KVM Firecracker microVM on the fallback (nested virtualization on the same C7i):** same answer, the same
guest kernel and image. Docker runs in Firecracker KVM guests routinely.

### Must be tested on a real host before the first customer

1. **Start time per job.** Run `run-job.sh` 20 times and record each stage (preparing the disks; sandbox start →
   guest up; guest up → runner online → job assigned; the job's setup). Target: a job starts within about 30 s of
   being queued.
2. **The jailer with the Nitro Sandboxes backend.** Firecracker under the jailer with `/dev/nitro_enclaves` created
   in the chroot for the jail's uid, its seccomp filter, cgroup v2: the sandbox starts; as the jail's uid the VMM
   cannot read another sandbox's disk or any credential (F17). Not verified anywhere yet.
3. **From a guest, as root** (F10): spoof the source address (`ip addr add 10.42.0.99/32 dev eth0`,
   `curl --interface 10.42.0.99 169.254.169.254`); reach another sandbox's `172.16.N.2` with a spoofed source; reach
   the parent over IPv6 link-local (`ping6 fe80::...%eth0`, `nc -6`). All must fail. `169.254.169.254` (IMDSv1 and
   v2), `169.254.169.123` and the VPC resolver's other addresses fail; `169.254.169.253:53` answers; the cache machine
   answers only with the job's own customer's token.
4. **Conntrack exhaustion** from one guest (`hping3 --flood` to many ports): other sandboxes' jobs keep their network.
5. **The result disk** (F9): a guest writes a symlink, a corrupted record, a record of 2 GiB, another job's ids: the
   host neither follows, mounts nor accepts them, and the summary carries the host's ids.
6. **CPU** (F16): 1, 2 and 3 concurrent 2-vCPU jobs (`stress-ng --cpu 2` plus a real pytest suite), with and without
   CPU overcommit, on c7i.xlarge and c7i.2xlarge; the same on the fallback (nested virtualization).
7. **Memory pool sizing** (F11): `mempool` for 3 × (2048 + 2) MiB plus 256 MiB for 12 slots (7G); a fourth start fails
   cleanly.
8. **Host reboot mid-job:** no disk of a previous job remains under `/srv/jailer` or `/var/lib/fenvix-sandboxes`.
9. **Docker:** `docker run hello-world`; a job with `services: postgres`; testcontainers (Python and Java);
   `docker compose up`; image pull time with and without a registry mirror; overlay2 on the guest's ext4.
10. **The engine:** `strace -f` inside the guest; `fenvix-run` with the shared cache from the guest; a warm cache
    across two jobs (two microVMs).
11. **Failure handling:** a guest that hangs is killed by the host (killing Firecracker tears the sandbox down); a
    sandbox that never got its job.
12. **Limits of Nitro Sandboxes to live with:** no snapshots or pause, so no warm-start from a snapshot; no virtio
    device reset; memory is not overcommitted.

**Fallback if Nitro Sandboxes fails a must-have** (start time, Docker, isolation, the jailer): **KVM Firecracker with
nested virtualization on the same C7i type** ("There is no additional cost for using nested virtualization"; C7i is
supported; EC2 User Guide, re-read 2026-11-18). Same guest image and agent, same price per host, and KVM adds
snapshots (faster starts) and memory overcommit. Nested virtualization and Nitro Sandboxes are not on at the same time
on one instance, which suits a fallback. A bare-metal host (c5n.metal, $4.392 an hour) is no longer needed.

### Customer mode: monthly cost per host (DECLARED prices; usage ESTIMATED)

| | c7i.xlarge | c7i.2xlarge |
|---|---|---|
| instance, 730 h | $139.81 | $279.62 |
| host disk 50 GB gp3 | $4.40 | $4.40 |
| public IPv4 | $3.65 | $3.65 |
| **per host per month** | **≈ $147.86** | **≈ $287.67** |
| jobs at once (2 vCPU, 2 GiB) at full speed | 1 (3 time-sharing 2 cores) | 3 |

The same figures hold for the fallback (KVM with nested virtualization on the same type). A job costs nothing extra
on a host that is already running; the host is the cost. The serverless part and the cache machine are as in per-job
mode, about $4.80 a month.
