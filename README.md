# fenvix dashboard

Customer dashboard for fenvix: CI test runs made deterministic on `runs-on: fenvix`, tests skipped with proof, flaky
tests turned into reproducible defects. A static React app (Vite) that talks to Supabase: Supabase Auth for sign-in
(GitHub, Google, email link) and Postgres, behind row level security, for the data.

Pages: Overview (runs, minutes saved, time to green before and with fenvix, GitHub-hosted cost against the plan),
Projects, Connect a project (GitHub App install and the setup pull request), the project page (runs, skip share over
time, the `runs-on: fenvix` snippet, settings), the run page (every test's outcome, skip receipts), Defects (families,
cause, minimal order, seed, fingerprint, replay command), Usage (per project, CSV), Billing (plans by runs, no prices
set yet), API keys, Members and Settings.

The records the dashboard shows are defined in `docs/data-contract.md` (runner → dashboard). The tables are
`supabase/migrations/0011_ci_runs.sql`. The earlier serverless database product was removed from the repository; what
went is listed in `docs/DELETED-old-database-product.md`.

## Run it

```bash
npm install
cp .env.example .env.local     # then fill in the two values, see "Environment"
npm run dev                    # http://localhost:5173
npm run build                  # static output in dist/
npm run preview                # serve dist/ at http://localhost:4173
```

To run it with no Supabase project at all, use the built-in mock (fake data, fake sign-in):

```bash
VITE_DATA_BACKEND=mock npm run dev
```

## Environment

Only two values reach the browser, and both are public by design (every table is protected by row
level security, so the anon key alone can read nothing):

| Variable | What it is |
| --- | --- |
| `VITE_SUPABASE_URL` | Project URL, `https://<project-ref>.supabase.co` (Project settings → API) |
| `VITE_SUPABASE_ANON_KEY` | The `anon` `public` key (Project settings → API) |
| `VITE_DATA_BACKEND` | Optional. `supabase` (default) or `mock` |

Vite bakes these in when it builds, so change them and build again.

**Never put the `service_role` key, the database password or an OAuth client secret in this project.**
`.env*` files are git-ignored (only `.env.example` is committed). If a value is missing the sign-in
page says which one, instead of showing a blank page.

## Set up Supabase

1. **Create the schema.** Supabase dashboard → SQL editor → New query. Run every file in `supabase/migrations/` in
   order, `0001` to `0014`. 0011 holds the CI dashboard's tables and plans; 0014 removes the earlier product's tables
   and must run after all the others.
2. **Auth URLs.** Authentication → URL Configuration. Set *Site URL* to the production address and add
   every address the app is served from to *Redirect URLs*, each with a trailing slash: for example
   `https://app.fenvix.dev/`, `http://localhost:5173/`, and for Vercel previews a wildcard such as
   `https://*-<your-team>.vercel.app/`. The app asks the provider to return to the root of the site.
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

Project → Settings → Environment Variables, for Production and Preview (and Development if you use
`vercel dev`):

| Name | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | the Project URL |
| `VITE_SUPABASE_ANON_KEY` | the anon key |

Do not set `VITE_DATA_BACKEND` (or set it to `supabase`). Redeploy after changing a variable. The app uses
real URLs (`/overview`, `/projects/…`), so every path must be answered with `index.html`. `vercel.json` does
that; on another host add the equivalent rewrite.

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
| `npm run check` | Behaviour checks on desktop and phone (onboarding, runs, receipts, defects, usage CSV, billing, organizations), status colours, accessibility and layout checks, screenshots, all with the mock backend | Playwright browsers |
| `npm run test:unit` | Overview, usage, billing and defect logic (`src/data/ci.ts`), row mapping, error messages, CSV, API-key hashing, colours | Node 22 |
| `npm run test:rls` | Runs the migrations twice each, `supabase/tests/rls.sql`, `functions.sql`, `orgs-rls.sql`, `ci-rls.sql` (the CI tables: members read, nobody reads another organization, only owners and admins change project settings) | A scratch Postgres 15+ |

`npm run test:rls` takes `TEST_DATABASE_URL`, the address of an **empty, disposable** Postgres database, for example:

```bash
createdb fenvix_scratch
TEST_DATABASE_URL=postgresql://postgres@localhost:5432/fenvix_scratch npm run test:rls
```

It refuses addresses that look like a hosted Supabase project, because it creates roles and a stand-in
`auth` schema. `supabase/tests/rls.sql` and `functions.sql` are also safe to paste into the Supabase SQL editor:
each runs in one transaction and rolls back.

What these cannot show: that your Google and GitHub apps, redirect URLs, SMTP and keys are set up correctly,
and how the real GoTrue and PostgREST behave. That needs a real sign-in.

## Where things are

- `src/data/client.ts` is the interface the screens use. `src/data/supabase.ts` implements it on Supabase,
  `src/data/mock.ts` is the sample data (from fenvix's measured shapes, labelled "Sample data" on every page).
  `src/data/index.ts` picks one. `src/data/ci.ts` turns rows into what the screens show, for both.
- `src/session/` is the same for sign-in. `src/lib/env.ts` reads the environment.
