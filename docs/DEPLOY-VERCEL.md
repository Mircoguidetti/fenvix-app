# Dashboard on Vercel (console.fenvix.dev)

**Why:** AWS does not let us create CloudFront until it verifies the account (support request opened on
2026-11-19). So the dashboard site (the part you see in the browser) goes on Vercel, for free. The API stays on AWS,
at `https://api.fenvix.dev` (until 2026-11-20 it was called `github.fenvix.dev`: if `VITE_API_URL` in Vercel still has
that name, change it as `docs/DEPLOY-AWS.md` says, section B2, step 8). It is like moving the shop window to another store: the warehouse (the API and the
database) stays where it is.

**What you do:** only clicks in the browser, once. You do not run anything on your computer. Estimated time: 20-30 minutes
(**ESTIMATED**), plus the wait for the HTTPS certificate (usually a few minutes, **DECLARED** by Vercel).

**What happens on its own afterwards:** every merge to `main` → Vercel rebuilds and publishes the dashboard on its own. The GitHub
pipeline (Deploy) updates only the API on AWS.

---

## Values you need

| Name | Value | Where you find it |
|---|---|---|
| `VITE_API_URL` | `https://api.fenvix.dev/v1` | it is this one, copy it as is |
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` | Supabase → the project → **Project Settings** → **Data API** (or **API**) → **Project URL** |
| `VITE_SUPABASE_ANON_KEY` | the `anon` `public` key | Supabase → **Project Settings** → **API Keys** → **Legacy API keys** tab → `anon` `public` → **Copy**. It is the same one you already put in AWS (Parameter Store `/fenvix/prod/bootstrap/supabase-anon-key`). |
| `VITE_DATA_BACKEND` | `mock` | **only** for previews (Preview), never for Production |

**Never** put the `service_role` key, the database password or other secrets in Vercel. The `anon` key is
public by design (it ends up in the browser of anyone who opens the site anyway), so it is fine.
**Do not** create `VITE_STYLEGUIDE`: it turns on an internal test page.

**Why `https://api.fenvix.dev/v1`:** it is the only address of the API (the internal AWS address is turned off,
`disableExecuteApiEndpoint` in `infra/github-app/lib/stack.ts`). There, `/v1/*` goes to the dashboard API function.
It is also the stack's `DashboardApiUrl` output and the same value the AWS pipeline used.

---

## Steps

> **The Vercel project already exists** (`fenvix-app`, in the Vercel team `fenvix`: it already builds the pull
> request previews). So **skip steps 1-3**: open <https://vercel.com/fenvix/fenvix-app> → **Settings** → **Environment
> Variables** and check that `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` are there (all
> environments) with the values in the table above. Add the missing ones, then continue from step 4 using the project
> `fenvix-app` wherever the steps below say `fenvix-console`. Also check **Settings** → **Build and Deployment**: the
> Build Command, Output Directory and Install Command fields must be empty or without **Override** (`vercel.json` decides).

1. **Create the Vercel account.** Go to <https://vercel.com/signup> → choose **Hobby** → **Continue with GitHub** → sign in
   with your GitHub account (Mircoguidetti) → **Authorize Vercel**. If you already have a Vercel account, just sign in.

2. **Give Vercel access to the `fenvix-app` repository only.** In the Vercel dashboard → **Add New…** (top right) →
   **Project** → under **Import Git Repository**, if `fenvix-app` does not appear: **Adjust GitHub App Permissions →** (or
   **Install**) → choose the **Mircoguidetti** account → **Only select repositories** → select `fenvix-app` →
   **Save** (or **Install**). You go back to Vercel and `fenvix-app` appears in the list.

3. **Import the project.** Next to `fenvix-app` → **Import**. On the **Configure Project** screen:
   - **Project Name:** `fenvix-console`
   - **Framework Preset:** `Vite` (it reads it from `vercel.json`; if it shows something else, choose `Vite`)
   - **Root Directory:** `./` (leave it as is)
   - **Build and Output Settings:** do not touch anything (the commands and the folder are already in `vercel.json`:
     `npm ci`, `npm run build`, `dist`)
   - **Environment Variables:** add these three, one at a time (**Key**, **Value**, then **Add**):
     `VITE_API_URL` = `https://api.fenvix.dev/v1`;
     `VITE_SUPABASE_URL` = the Project URL (table above);
     `VITE_SUPABASE_ANON_KEY` = the `anon` key (table above).
   - Click **Deploy**. After 1-3 minutes (**ESTIMATED**) you see **Congratulations!** and an address
     `https://fenvix-console-….vercel.app`. Sign-in does **not** work on that address yet (the API accepts only
     `console.fenvix.dev`): this is normal, step 6 fixes it.

4. **Previews with sample data.** Project `fenvix-console` → **Settings** → **Environment Variables** → **Add
   New** (or the form at the top):
   - **Key:** `VITE_DATA_BACKEND`  **Value:** `mock`
   - **Environments:** uncheck **Production** and **Development**, leave only **Preview**
   - **Save**.

   This way the branch previews (the `….vercel.app` addresses of the pull requests) show fake data with a fake
   sign-in, and they never call the real API. Production does not change.

5. **Add the domain.** Project `fenvix-console` → **Settings** → **Domains** → **Add Domain** → type
   `console.fenvix.dev` → **Add** (if it asks for the environment: **Production**; if it also offers the redirect from
   `www`/apex: **no**, only `console.fenvix.dev`). Vercel shows **Invalid Configuration** and a record to create:
   **Type** `CNAME`, **Name** `console`, **Value** an address that ends in `vercel-dns.com` (for example
   `cname.vercel-dns.com`, or a longer one like `…vercel-dns-0xx.com`). **Copy exactly the Value that
   Vercel shows.**

6. **DNS record in Cloudflare.** <https://dash.cloudflare.com> → the **fenvix.dev** domain → **DNS** → **Records**.
   - If a record with **Name** `console` already exists (not the ones that start with `_`, which are for the certificates):
     **Edit** and change the content as below. Otherwise **Add record**.
   - **Type:** `CNAME`
   - **Name:** `console`
   - **Target:** the Value you copied from Vercel in step 5
   - **Proxy status:** **DNS only** (**grey** cloud: click the orange cloud until it turns grey)
   - **TTL:** `Auto`
   - **Save**.

   Go back to Vercel → **Settings** → **Domains**: within a few minutes (**DECLARED** by Vercel; sometimes up to an hour)
   `console.fenvix.dev` becomes **Valid Configuration** and the HTTPS certificate is issued on its own.
   The AWS pipeline no longer touches this record (as long as the switch in step 9 is off).

7. **Sign-in URLs in Supabase.** <https://supabase.com/dashboard> → the project → **Authentication** → **URL
   Configuration**:
   - **Site URL:** `https://console.fenvix.dev` → **Save** (it is probably already there: you set it for AWS)
   - **Redirect URLs** → **Add URL** → `https://console.fenvix.dev/**` → **Save URLs** (if it is already there, nothing to do).
     This is enough: the site asks Supabase to return to `https://console.fenvix.dev/`, which falls under
     `https://console.fenvix.dev/**`.
   - **Do not** add `*.vercel.app` addresses: the previews use the fake sign-in (step 4) and do not go through Supabase.

8. **Rebuild production** (needed only if you changed variables after the first deploy). Project
   `fenvix-console` → **Deployments** → the latest **Production** deploy → **⋯** → **Redeploy** → **Redeploy**.

9. **Dashboard switch on AWS: leave it off.** In GitHub, the repository variable
   `FENVIX_DASHBOARD_ON_AWS` (Settings → Secrets and variables → Actions → **Variables**) **must not exist**, or
   it must be `false`. When it is off, the Deploy pipeline updates only the API on AWS and touches neither CloudFront nor
   `console.fenvix.dev`. When AWS verifies the account, the coordinator will tell you if and when to turn it back on
   (value `true`). First the domain must be removed from Vercel, otherwise the two services fight over `console.fenvix.dev`.

10. **Final check.** Open <https://console.fenvix.dev> → the FENVIX sign-in page must appear, with no
    messages like "This deployment is missing …". Sign in (GitHub, Google or email): you must reach the dashboard,
    with no "could not reach the server" error. Then open <https://api.fenvix.dev/healthz>: it must answer
    `{"ok":true,…}`.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| On the sign-in page: "This deployment is missing VITE_…" | Step 3: that variable is missing (or has an extra space). Fix it in **Settings → Environment Variables**, then step 8. |
| After sign-in: "could not reach the server" | You are using a `….vercel.app` address instead of `https://console.fenvix.dev` (the API accepts only that one), or `VITE_API_URL` is not exactly `https://api.fenvix.dev/v1`. |
| After sign-in, Supabase says the return address is not allowed | Step 7: check `https://console.fenvix.dev/**` in **Redirect URLs**. |
| Vercel stays on **Invalid Configuration** after an hour | Step 6: the cloud must be **grey** (DNS only) and the Target identical to the one in Vercel. If Vercel mentions **CAA**: in Cloudflare → DNS, if there are records of type `CAA` on `fenvix.dev`, add one with **Tag** `Only allow specific hostnames` and **CA domain name** `letsencrypt.org`. |
| The build on Vercel fails | Open the deploy → **Building** and send the log to the coordinator. Do not change the code. |

**Note on the Hobby plan:** Vercel declares the Hobby plan for personal, non-commercial use (**DECLARED**, Vercel's terms
of use). It is fine to get started. When there are paying customers, the coordinator will tell you whether to move to Pro or
go back to AWS.
