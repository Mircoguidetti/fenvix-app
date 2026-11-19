# Every page against the real API (local)

Run 2026-11-19T01:38:56.190Z by scripts/e2e-real-api.mjs: local Supabase (Postgres + Supabase Auth in Docker), the API as fenvix_api, the dashboard built with VITE_API_URL, a real Supabase Auth session.

170 checks passed, 0 failed.

| Page | Check | Result |
| --- | --- | --- |
| overview | called the API (5 requests: GET /me, GET /settings, GET /activity, GET /overview, GET /projects) | ok |
| overview | every API answer 2xx/304 | ok |
| overview | signed in, real data (no sign-in page, no sample-data label) | ok |
| overview | shows "acme-279bc7da" | ok |
| overview | shows "trial" | ok |
| overview | no console errors | ok |
| overview | axe: no violations | ok |
| projects | called the API (3 requests: GET /me, GET /projects) | ok |
| projects | every API answer 2xx/304 | ok |
| projects | signed in, real data (no sign-in page, no sample-data label) | ok |
| projects | shows "acme-279bc7da/shop" | ok |
| projects | shows "acme-279bc7da/web" | ok |
| projects | shows "Cache warm since 4a7c2e9" | ok |
| projects | shows "Warming up b81f0d3" | ok |
| projects | shows "Cache cold: the first run fills it" | ok |
| projects | no console errors | ok |
| projects | axe: no violations | ok |
| project-runs | called the API (10 requests: GET /me, GET /projects/43e17b33-01b6-435c-846c-2e2dbbc44e23, GET /projects, GET /projects/43e17b33-01b6-435c-846c-2e2dbbc44e23/runs, GET /defects, GET /activity) | ok |
| project-runs | every API answer 2xx/304 | ok |
| project-runs | signed in, real data (no sign-in page, no sample-data label) | ok |
| project-runs | shows "Change number" | ok |
| project-runs | no console errors | ok |
| project-runs | axe: no violations | ok |
| project-defects | called the API (8 requests: GET /me, GET /projects/43e17b33-01b6-435c-846c-2e2dbbc44e23, GET /defect-families, GET /projects) | ok |
| project-defects | every API answer 2xx/304 | ok |
| project-defects | signed in, real data (no sign-in page, no sample-data label) | ok |
| project-defects | shows "test_count" | ok |
| project-defects | no console errors | ok |
| project-defects | axe: no violations | ok |
| project-skip-with-proof | called the API (9 requests: GET /me, GET /projects/43e17b33-01b6-435c-846c-2e2dbbc44e23, GET /projects/43e17b33-01b6-435c-846c-2e2dbbc44e23/skip-share, GET /projects/43e17b33-01b6-435c-846c-2e2dbbc44e23/runs, GET /projects/43e17b33-01b6-435c-846c-2e2dbbc44e23/audit, GET /projects) | ok |
| project-skip-with-proof | every API answer 2xx/304 | ok |
| project-skip-with-proof | signed in, real data (no sign-in page, no sample-data label) | ok |
| project-skip-with-proof | shows "rerun" | ok |
| project-skip-with-proof | no console errors | ok |
| project-skip-with-proof | axe: no violations | ok |
| project-nightly | called the API (9 requests: GET /me, GET /projects/43e17b33-01b6-435c-846c-2e2dbbc44e23, GET /projects/43e17b33-01b6-435c-846c-2e2dbbc44e23/explorations, GET /defects, GET /plans, GET /projects) | ok |
| project-nightly | every API answer 2xx/304 | ok |
| project-nightly | signed in, real data (no sign-in page, no sample-data label) | ok |
| project-nightly | shows "seed" | ok |
| project-nightly | no console errors | ok |
| project-nightly | axe: no violations | ok |
| project-time-to-green | called the API (7 requests: GET /me, GET /projects/43e17b33-01b6-435c-846c-2e2dbbc44e23, GET /projects/43e17b33-01b6-435c-846c-2e2dbbc44e23/runs, GET /projects) | ok |
| project-time-to-green | every API answer 2xx/304 | ok |
| project-time-to-green | signed in, real data (no sign-in page, no sample-data label) | ok |
| project-time-to-green | shows "green" | ok |
| project-time-to-green | no console errors | ok |
| project-time-to-green | axe: no violations | ok |
| project-settings | called the API (7 requests: GET /me, GET /projects/43e17b33-01b6-435c-846c-2e2dbbc44e23, GET /projects, GET /projects/43e17b33-01b6-435c-846c-2e2dbbc44e23/setup-change) | ok |
| project-settings | every API answer 2xx/304 | ok |
| project-settings | signed in, real data (no sign-in page, no sample-data label) | ok |
| project-settings | shows "Skip with proof" | ok |
| project-settings | no console errors | ok |
| project-settings | axe: no violations | ok |
| run | called the API (10 requests: GET /me, GET /runs/b696a9b8-74eb-4dc1-b640-da3856819b58, GET /runs/b696a9b8-74eb-4dc1-b640-da3856819b58/files, GET /projects/43e17b33-01b6-435c-846c-2e2dbbc44e23, GET /runs/b696a9b8-74eb-4dc1-b640-da3856819b58/tests, GET /projects) | ok |
| run | every API answer 2xx/304 | ok |
| run | signed in, real data (no sign-in page, no sample-data label) | ok |
| run | shows "test_total" | ok |
| run | shows "test_empty" | ok |
| run | no console errors | ok |
| run | axe: no violations | ok |
| run-failed | called the API (10 requests: GET /me, GET /runs/0baddcf8-eb33-4f4c-aa88-287f61b07fdd, GET /projects/43e17b33-01b6-435c-846c-2e2dbbc44e23, GET /runs/0baddcf8-eb33-4f4c-aa88-287f61b07fdd/files, GET /runs/0baddcf8-eb33-4f4c-aa88-287f61b07fdd/tests, GET /projects) | ok |
| run-failed | every API answer 2xx/304 | ok |
| run-failed | signed in, real data (no sign-in page, no sample-data label) | ok |
| run-failed | shows "failed" | ok |
| run-failed | no console errors | ok |
| run-failed | axe: no violations | ok |
| run-shadow | called the API (10 requests: GET /me, GET /runs/3831d07d-806e-4fbf-93ba-04b5fc136532/tests, GET /runs/3831d07d-806e-4fbf-93ba-04b5fc136532/files, GET /projects/43e17b33-01b6-435c-846c-2e2dbbc44e23, GET /runs/3831d07d-806e-4fbf-93ba-04b5fc136532, GET /projects) | ok |
| run-shadow | every API answer 2xx/304 | ok |
| run-shadow | signed in, real data (no sign-in page, no sample-data label) | ok |
| run-shadow | shows "hadow" | ok |
| run-shadow | no console errors | ok |
| run-shadow | axe: no violations | ok |
| defects | called the API (4 requests: GET /me, GET /defect-families, GET /projects) | ok |
| defects | every API answer 2xx/304 | ok |
| defects | signed in, real data (no sign-in page, no sample-data label) | ok |
| defects | shows "test_count" | ok |
| defects | no console errors | ok |
| defects | axe: no violations | ok |
| defect | called the API (3 requests: GET /me, GET /defects/254e715f-6a70-4c8b-a44c-0506cb50a00d, GET /projects) | ok |
| defect | every API answer 2xx/304 | ok |
| defect | signed in, real data (no sign-in page, no sample-data label) | ok |
| defect | shows "--det-seed=7" | ok |
| defect | shows ".fenvix/defects/" | ok |
| defect | no console errors | ok |
| defect | axe: no violations | ok |
| usage | called the API (4 requests: GET /me, GET /usage/months, GET /projects, GET /usage/2026-11) | ok |
| usage | every API answer 2xx/304 | ok |
| usage | signed in, real data (no sign-in page, no sample-data label) | ok |
| usage | shows "acme-279bc7da/shop" | ok |
| usage | shows "unit" | ok |
| usage | no console errors | ok |
| usage | axe: no violations | ok |
| billing | called the API (4 requests: GET /me, GET /plans, GET /projects, GET /billing) | ok |
| billing | every API answer 2xx/304 | ok |
| billing | signed in, real data (no sign-in page, no sample-data label) | ok |
| billing | shows "$129" | ok |
| billing | shows "$479" | ok |
| billing | shows "$1,350" | ok |
| billing | shows "$4,200" | ok |
| billing | shows "Nightly exploration" | ok |
| billing | no console errors | ok |
| billing | axe: no violations | ok |
| members | called the API (4 requests: GET /me, GET /organization/members, GET /organization/invitations, GET /projects) | ok |
| members | every API answer 2xx/304 | ok |
| members | signed in, real data (no sign-in page, no sample-data label) | ok |
| members | shows "Olive Owner" | ok |
| members | shows "Max Member" | ok |
| members | no console errors | ok |
| members | axe: no violations | ok |
| settings | called the API (3 requests: GET /me, GET /settings, GET /projects) | ok |
| settings | every API answer 2xx/304 | ok |
| settings | signed in, real data (no sign-in page, no sample-data label) | ok |
| settings | shows "Acme Robotics" | ok |
| settings | shows "Region" | ok |
| settings | no console errors | ok |
| settings | axe: no violations | ok |
| api-keys | called the API (2 requests: GET /me, GET /projects) | ok |
| api-keys | every API answer 2xx/304 | ok |
| api-keys | signed in, real data (no sign-in page, no sample-data label) | ok |
| api-keys | shows "oming soon" | ok |
| api-keys | no console errors | ok |
| api-keys | axe: no violations | ok |
| connect | called the API (4 requests: GET /me, GET /github, GET /github/repositories, GET /projects) | ok |
| connect | every API answer 2xx/304 | ok |
| connect | signed in, real data (no sign-in page, no sample-data label) | ok |
| connect | shows "acme-279bc7da" | ok |
| connect | shows "olive-279bc7da" | ok |
| connect | shows "uspended" | ok |
| connect | shows "Cache warm since 4a7c2e9" | ok |
| connect | shows "Warming up b81f0d3: running the test job" | ok |
| connect | shows "Warm-up not possible (ccccccc): the job needs the outputs of job build" | ok |
| connect | no console errors | ok |
| connect | axe: no violations | ok |
| run-live | polls with If-None-Match and gets 304 while nothing changes (200,200,304) | ok |
| run-live | a progress update appears within one poll (200 with a new ETag) | ok |
| run-live | polling stops once the run finished (0 requests in the 10 s after) | ok |
| run-live | shows the finished run | ok |
| connect-connected | called the API (4 requests: GET /me, GET /github, GET /github/repositories, GET /projects) | ok |
| connect-connected | every API answer 2xx/304 | ok |
| connect-connected | signed in, real data (no sign-in page, no sample-data label) | ok |
| connect-connected | shows "acme-279bc7da" | ok |
| connect-connected | no console errors | ok |
| connect-connected | axe: no violations | ok |
| connect-connected | says the App is installed on the account GitHub sent back | ok |
| connect | lists the repository in state pending | ok |
| connect | lists the repository in state pr_open | ok |
| connect | lists the repository in state merged | ok |
| connect | lists the repository in state closed | ok |
| connect | lists the repository in state no_workflow | ok |
| connect | lists the repository in state no_test_job | ok |
| connect | lists the repository in state already_fenvix | ok |
| connect | lists the repository in state unsupported | ok |
| connect | lists the repository in state failed | ok |
| connect-error | called the API (4 requests: GET /me, GET /github, GET /github/repositories, GET /projects) | ok |
| connect-error | every API answer 2xx/304 | ok |
| connect-error | signed in, real data (no sign-in page, no sample-data label) | ok |
| connect-error | no console errors | ok |
| connect-error | axe: no violations | ok |
| connect | install button goes to GitHub with a signed state (https://github.com/apps/fenvix-local/installations/new) | ok |
| connect-confirm | a code made for another person: refused in words, nothing connected | ok |
| connect-confirm | another person's code linked nothing | ok |
| connect-confirm | the code left the address bar | ok |
| connect-confirm | the person's own code: completed through the API, shown as connected | ok |
| connect-confirm | the installation is linked to the organization that asked | ok |
| connect-confirm | the code left the address bar | ok |
| connect-confirm | axe: no violations | ok |
| settings-region | the owner sets the region to EU (stored: eu) | ok |
| settings-region | a member sees the region (European Union) read only, with no control to change it | ok |
| invite | owner creates an invitation (201) | ok |
| invite | the invited person joins as member (member) | ok |
