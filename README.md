# fenvix dashboard

Customer dashboard for fenvix: CI test runs made deterministic on `runs-on: fenvix`, tests skipped with proof, flaky
tests turned into reproducible defects. A static React app (Vite) that talks only to the fenvix API
(`openapi/fenvix-api.yaml`, served by `github-app/src/api/`), never to the database; Supabase Auth is used for sign-in
(GitHub, Google, email link) and the API checks the session token, the organization and the role on every call.

Pages: Overview (runs, minutes saved, time to green before and with fenvix, GitHub-hosted cost against the plan),
Projects, Connect a project (GitHub App install and the setup pull request), the project page (runs, skip share over
time, the `runs-on: fenvix` snippet, settings), the run page (every test's outcome, skip receipts), Defects (families,
cause, minimal order, seed, fingerprint, replay command), Usage (per project, CSV), Billing (plans by run units, the nightly
exploration add-on, the 30-day shadow trial), API keys, Members and Settings.

The records the dashboard shows are defined in `docs/data-contract.md` (runner → dashboard). The tables are
`supabase/migrations/0011_ci_runs.sql`. The earlier serverless database product was removed from the repository; what
went is listed in `docs/DELETED-old-database-product.md`.

## Run it

```bash
npm install
cp .env.example .env.local     # then fill in the values, see "Environment"
npm run dev                    # http://localhost:5173, talking to the fenvix API at VITE_API_URL
npm run build                  # checks the API types (api:check), type-checks, static output in dist/
npm run preview                # serve dist/ at http://localhost:4173
```

For local development without the API or a Supabase project, use the built-in mock (sample data, labelled "Sample
data" on every page, and a fake sign-in). Every real build talks to the API; the mock is never the default:

```bash
VITE_DATA_BACKEND=mock npm run dev
```

The mock covers every screen: a 30-day shadow trial (Harbor Analytics; `sessionStorage.setItem("fenvix-mock-trial",
"below")` in the browser console shows a trial under the 35% gate), audit reruns, three GitHub App installations
(active, suspended, uninstalled) with repositories in all nine onboarding states, a run that is still running and
advances while its page is open, and defects with the runner's replay command.

## Environment

The dashboard talks only to the fenvix API (`openapi/fenvix-api.yaml`); it never reaches the database. Supabase is
used for sign-in only (Supabase Auth): the API receives the session's access token as `Authorization: Bearer` and the
chosen organization as `X-Fenvix-Workspace`. Every value below is public by design:

| Variable | What it is |
| --- | --- |
| `VITE_API_URL` | The fenvix API, including `/v1`, for example `https://api.fenvix.dev/v1` (a bare host gets `/v1` added) |
| `VITE_SUPABASE_URL` | Supabase project URL, `https://<project-ref>.supabase.co` (Project settings → API), for sign-in only |
| `VITE_SUPABASE_ANON_KEY` | The `anon` `public` key (Project settings → API), for sign-in only |
| `VITE_DATA_BACKEND` | Optional. `mock` for local development and the checks; anything else (or nothing) uses the API |

Vite bakes these in when it builds, so change them and build again. If one of `VITE_API_URL`, `VITE_SUPABASE_URL` or
`VITE_SUPABASE_ANON_KEY` is missing, the sign-in page says which one instead of showing a blank page.

**Never put the `service_role` key, the database password or an OAuth client secret in this project.**
`.env*` files are git-ignored (only `.env.example` is committed).

## Set up Supabase

1. **The schema.** In production the deploy pipeline applies `supabase/migrations/` (step 2 of `.github/workflows/deploy.yml`,
   `node deploy/cli.mjs migrate`): every file once, in order, recorded as applied; a changed or out-of-order file stops
   the deploy (docs/DEPLOY-AWS.md). Never paste migrations into the production SQL editor. For a scratch or local
   project only, `bash scripts/local-supabase/up.sh` applies them the same way.
2. **Auth URLs.** Authentication → URL Configuration. Set *Site URL* to the production address and add
   every address the app is served from to *Redirect URLs*, each with a trailing slash: for example
   `https://console.fenvix.dev/` and `http://localhost:5173/`. Vercel previews build with `VITE_DATA_BACKEND=mock`
   and need no entry. The app asks the provider to return to the root of the site.
3. **Providers.** Authentication → Sign In / Providers:
   - **Google**: create an OAuth client (type *Web application*) in Google Cloud Console, add
     `https://<project-ref>.supabase.co/auth/v1/callback` as an authorised redirect URI, paste its
     client ID and secret into Supabase.
   - **GitHub**: create an OAuth App, set its *Authorization callback URL* to the same
     `https://<project-ref>.supabase.co/auth/v1/callback`, paste its client ID and secret into Supabase.
   - **Email**: enable it. The link is a magic link; for real use set up a custom SMTP server
     (Authentication → Emails → SMTP), because Supabase's built-in sender is limited to a few emails an hour.
   - Keep *Allow new users to sign up* on.
   The secrets go into the Supabase dashboard only, never into this repository.
4. **First sign-in.** Open the site and sign in once as `mircoguidetti1994@gmail.com`. The first sign-in
   creates a personal workspace for that account.
5. **Data.** The CI tables are written by the GitHub App service (`github-app/`). There is no
   Supabase seed for them: to see the dashboard with sample data, build with `VITE_DATA_BACKEND=mock`.

## Deploy on Vercel

The production dashboard (`https://console.fenvix.dev`) is hosted on Vercel; the API stays on AWS
(`https://api.fenvix.dev`). The founder's step-by-step setup is `docs/DEPLOY-VERCEL.md` (Italian). `vercel.json`
holds the whole build (`npm ci`, `npm run build`, output `dist`), the SPA rewrite (every path except `/assets/*` and
`/favicon.svg` is answered with `index.html`) and the security headers. Environment variables (Project → Settings →
Environment Variables):

| Name | Environments | Value |
| --- | --- | --- |
| `VITE_API_URL` | all | `https://api.fenvix.dev/v1` |
| `VITE_SUPABASE_URL` | all | the Project URL |
| `VITE_SUPABASE_ANON_KEY` | all | the anon (public) key |
| `VITE_DATA_BACKEND` | Preview only | `mock` (previews never call the API: its CORS accepts `https://console.fenvix.dev` only) |

Never set `VITE_DATA_BACKEND` or `VITE_STYLEGUIDE` for Production. Redeploy after changing a variable.

## How sign-in finishes

Supabase sends the browser back to the site root as `https://site/?code=…` (PKCE). `src/main.tsx` awaits
`completeAuthRedirect()` (`src/session/redirect.ts`) **before React renders**. It exchanges the code for a
session, then replaces the address with `/overview`, which removes the code from the address bar and from
history. The router then starts on a clean URL with the session already stored. A failed exchange (an expired
or replayed link, or a provider error) is shown on the sign-in page. The supabase-js option `detectSessionInUrl`
is turned off, so the library never tries to read the URL itself. Because the PKCE verifier is kept in the
browser, an emailed link must be opened in the same browser that asked for it.

After a provider or email sign-in the user lands on `/overview`, not on the page they first asked for.

## Tests

| Command | What it covers | Needs |
| --- | --- | --- |
| `npm run build` | `api:check` (`src/api/schema.d.ts` is what `openapi/fenvix-api.yaml` generates today), the TypeScript check of every screen against those types, the Vite build | Node 22 |
| `npm run test:unit` | The shared logic (`src/data/ci.ts`: run units, the shadow trial and its gate, audit reruns and the rule-of-three bound, usage rows that add up, billing, replay commands), row mapping, the API client over a stub fetch (paths, query names, headers, the live view's 304, error messages), the build's missing settings, organizations, colours | Node 22 |
| `npm run check` | Builds with the mock and serves it, then: behaviour checks on desktop and phone (`scripts/checks.mjs`: every page, the trial gate met and not met, the live run view and that its polling stops once the run finishes or the page is hidden, the Connect flow and each `?github=` return, audit reruns, units, billing, region for owners, API keys coming soon), organization checks (`scripts/orgs-checks.mjs`: members see the region and everything else read-only, invitations), status colours (`scripts/status-colors-checks.mjs`), and the screenshots with axe and layout checks (`scripts/screenshots.mjs`) | Playwright and Chromium |
| `npm run screenshots` | Every page at 1440 and 390 px, light and dark, into `docs/screenshots/` | a preview server on :4173 |
| `node scripts/ui-shots.mjs` | Every page at six widths: no sideways scroll, 44 px touch targets on a phone, axe | a preview server on :4173 |
| `npm run test:rls` | Applies the migrations to a scratch database (0001-0013 once, 0014 and later twice each: they must be safe to repeat) and runs the row level security tests in `supabase/tests/` | A scratch Postgres 15+ |

`npm run test:rls` takes `TEST_DATABASE_URL`, the address of an **empty, disposable** Postgres database, for example:

```bash
createdb fenvix_scratch
TEST_DATABASE_URL=postgresql://postgres@localhost:5432/fenvix_scratch npm run test:rls
```

What these cannot show: the real API's answers (another check runs every page against it locally) and that your
Google and GitHub apps, redirect URLs, SMTP and keys are set up correctly. That needs a real sign-in.

## Where things are

- `openapi/fenvix-api.yaml` describes the API; `npm run api:generate` writes `src/api/schema.d.ts` from it and
  `src/data/types.ts` re-exports its records. A field changed there breaks this build until the screens follow.
- `src/data/client.ts` is the interface the screens use, one method per API operation. `src/data/api.ts` implements
  it with `openapi-fetch` over the generated `paths` (and the organizations client); `src/data/api-browser.ts` wires
  it to `VITE_API_URL`, the Supabase session and the chosen organization; `src/data/api-errors.ts` turns errors into
  sentences. `src/data/mock.ts` and `src/data/orgs-mock.ts` are the sample data. `src/data/index.ts` and
  `src/data/orgs-client.ts` pick one.
- `src/data/ci.ts` and `src/data/ci-rows.ts` are shared with the API server: the mock builds its answers with the same
  functions, so the mock and the API agree.
- `src/lib/useLiveRun.ts` is the live run view (GET `/runs/{runId}` every 4 s with `If-None-Match` while the run is
  running and the page is visible).
- `src/session/` is sign-in (Supabase Auth, or the mock). `src/lib/env.ts` reads the environment.
- `src/pages/` are the screens, `src/components/` the shared parts, `src/styles.css` the one stylesheet;
  `docs/status-colors.md` the rules for status colours.
- `scripts/` holds the Playwright checks and the screenshots (`docs/screenshots/`).
