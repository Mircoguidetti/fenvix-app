# Console inventory, 2026-11-27 (Phase A of the console-cleanup spec, rev 2)

Base: fenvix-app `origin/main` 50d7fd9. Read statically (`src/App.tsx:95-116`, `src/components/Shell.tsx:33-69`,
`:601-611`). Sold product: parallel with proof (`PRODUCT.md`). Old-product wording looked for: "deterministic" as the
product, flaky tests as the main promise, plans by run units, the 30-day shadow trial.
"Data today": **mock** = the sample backend (`src/data/mock.ts`); **API** = the route in `openapi/fenvix-api.yaml` and
`src/data/api.ts`. Whether production tables hold rows is not checked here (no customer yet; UNKNOWN).

Verdicts: `keep`, `keep, reword` (old -> new), `coming soon`, `hide` (route kept, no nav), `remove`.
Rows marked **R** are recommendations waiting for the coordinator's reply; nothing `remove` or `coming soon` is
changed before it.

## Routes (`src/App.tsx:95-116`)

| # | Route | Shows today | Data today | Verdict |
|---|---|---|---|---|
| 1 | `/` (`Home`) | Redirects to the last or first project, else `/overview`; blank while loading | API `/projects` | keep (loading screen replaces `null`, B7) |
| 2 | `/overview` | KPIs (runs, proven identical, minutes saved, skipped with proof, time to green, GitHub cost, open defects), **"Shadow trial" card** with "Plans" link to `/billing`, "Cost compared" vs **"Your plan … run units"**, projects, latest defects, activity | mock + API `/overview` | keep, reword (see W1-W5) |
| 3 | `/projects` | Connected repositories, this month | mock + API | keep |
| 4 | `/projects/connect` | Installations and connected repositories first, then steps | mock + API | keep, restructure (B5) |
| 5 | `/projects/:id` | Runs of a project, KPIs, minutes, snippet/status | mock + API | keep, reword W6 (shadow tooltip stays: describes real past runs) |
| 6 | `/projects/:id/parallel-with-proof` | Proven-identical trend, not-proven causes, speed, runs with tests not proven | mock + API (runs `proof`) | keep |
| 7 | `/projects/:id/defects` | Defects of the project | mock + API | keep, reword W7 |
| 8 | `/projects/:id/skip-with-proof` | Skip share trend, why tests ran, audit reruns, lowest-skip runs | mock + API `/skip-share`, `/audit` | **R** keep, reword: nav label and title "Skip with proof" -> "Cache with proof" (PRODUCT.md name; same feature). Route path kept |
| 9 | `/projects/:id/nightly` | Nights of exploration, flaky per night, seeds | mock + API `/explorations` | **R** coming soon (live order step 5, not built; page text sells "a paid add-on … run units"). `NightlyPage` code: remove (dead after the switch) |
| 10 | `/projects/:id/time-to-green` | Time to green per commit vs before | mock + API (runs) | keep |
| 11 | `/projects/:id/settings` | Project settings switches, setup snippet | mock + API | keep, reword W8 (nightly switch) |
| 12 | `/projects/:projectId/runs/:runId` | One run: proof card, tests, receipts; "Shadow (trial): every test runs" | mock + API | keep, reword W9 |
| 13 | `/defects` | All defects; header "Flaky tests turned into reproducible defects…" | mock + API | keep, reword W7 |
| 14 | `/defects/:id` | One defect, replay | mock + API | keep |
| 15 | `/usage` | **Run units meter vs plan**, "Plans and billing" link, totals, runs per day, per-project table with a "Run units" column | mock + API `/usage` | keep, reword W10 + table fix (B2) |
| 16 | `/billing` | Plans by run units, shadow trial, add-ons, payment | mock + API | hide (B3; route and file kept) |
| 17 | `/api-keys` | Already a "Coming soon" block (public API) | none | keep (not a live-list item; may adopt the shared `ComingSoon` component) |
| 18 | `/settings` | Organization name, region, notifications ("run units nearing what the plan includes"), account card | mock + API | keep, reword W11 + account card (B4) |
| 19 | `/settings/members` | Members, invitations | mock + API | keep |
| 20 | `/styleguide` | Dev-only style guide (`STYLEGUIDE_ON`) | none | keep (not in production nav) |
| 21 | `/invite` | Redirect to `/overview` | — | keep |
| 22 | `*` | 404 | — | keep |
| 23 | (new) `/welcome` | — | — | new (B6) |

## Navigation (`Shell.tsx:33-69`) and command palette (`Shell.tsx:601-611`)

| # | Entry | Verdict |
|---|---|---|
| N1 | Area "Overview" | keep |
| N2 | Area "Projects" | keep |
| N3 | Area "Usage and billing" (`:37`, `:240-243`, `:390-391`) | keep, reword: "Usage and billing" -> "Usage" |
| N4 | Area "Organization" | keep |
| N5 | Usage sub: "Usage" | keep |
| N6 | Usage sub: "Plans and billing" (`:44`) | hide |
| N7 | Settings sub: General, Members, API keys | keep |
| N8 | Projects sub: All projects, All defects, Connect a project | keep |
| N9 | Section "Runs" | keep |
| N10 | Section "Parallel with proof" | keep |
| N11 | Section "Defects" | keep |
| N12 | Section "Skip with proof" | **R** keep, reword -> "Cache with proof" |
| N13 | Section "Nightly exploration" | **R** keep entry, opens the coming-soon page |
| N14 | Section "Time to green" | keep |
| N15 | Section "Settings" | keep |
| N16 | Palette: Overview, Projects, Connect a project, Defects, Usage, Organization settings, Members, API keys | keep |
| N17 | Palette: "Billing" (`:607`) | hide |
| N18 | Account menu: workspace sub-label `PLAN = "Managed"` (`AccountMenu.tsx:16`, shown only without the organizations API) | keep (not a price plan; mock/no-orgs fallback) |

## Live-list items not built yet (`ceo-plans/2026-11-27-live-scope.md`)

| # | Item | Existing page that partly covers it | Real data today | Verdict and proposed place |
|---|---|---|---|---|
| C1 | Cache with proof | `SkipWithProofPage` (`ProjectSections.tsx:73`): skip share, receipts, audit reruns | mock + API (`/skip-share`, `/audit`) | **R** no separate coming-soon page: the existing page is the feature; rename to "Cache with proof" (row 8). Alternative if you prefer: coming-soon section in the page header saying the cache is being fixed before live |
| C2 | "Is this red real?" | none (Defects lists flaky defects, not "red on base") | none | **R** coming soon: project section "Is this red real?", `/projects/:id/is-this-red-real`. Sentence: "For each failed run, whether the same tests were already red on the base branch, so you know which reds are yours." |
| C3 | Nightly exploration | `NightlyPage` (`ProjectSections.tsx:295`) | mock + API `/explorations` (no production writer verified) | **R** coming soon on the existing route `/projects/:id/nightly`. Sentence: "Your suite run at night in many orders and seeds on fenvix machines, and the hidden order and timing bugs it found." Nightly switch in project settings: hidden until then (W8) |
| C4 | Database copies per lane | none | none | **R** coming soon: project section "Database copies", `/projects/:id/database`. Sentence: "Each parallel lane gets its own copy of your test database, with no change to your code; this page will show the copies each run used." |
| C5 | Python | none (Connect and runs are language-agnostic in text) | none | **R** coming soon: Projects area sub-page "Python", `/python`. Sentence: "pytest suites in parallel with proof, like Vitest, Jest and node:test today." |
| C6 | Onboarding with compatibility % | `SideBySide` (`src/pages/SideBySide.tsx`, inside Connect/project): one week side by side | mock + API (`/side-by-side`) | **R** coming soon: project section "Compatibility", `/projects/:id/compatibility`. Sentence: "How much of your suite can run in parallel with proof, predicted at connect and then measured, with what blocks the rest, whose it is, and the change that frees it." Side-by-side stays where it is |
| C7 | Detailed proof | `ParallelWithProofPage` (`ProjectSections.tsx:545`) and the run's proof card (`Run.tsx:178`): proven / not proven counts and causes | mock + API (runs `proof`) | **R** coming soon: project section "Detailed proof", `/projects/:id/proof`. Sentence: "For each run, test by test, the parallel result next to the serial one and the evidence that they are identical." |

Project-level coming-soon sections need an open project; C5 (Python) is org-level so it is reachable with no project.
Every coming-soon entry also goes in the command palette when it is org-level (C5).

## Wording rows (`keep, reword`)

| # | Where | Old | New |
|---|---|---|---|
| W1 | `Overview.tsx:53-66` trial card | "Shadow trial: N days left" + `TRIAL_DESCRIPTION` ("For 30 days every test runs as usual, in shadow mode … The trial is not billed.") + "Plans" link | card removed. **R** `Trial.tsx` then has one user left (`Billing.tsx`, hidden) -> kept, not removed |
| W2 | `Overview.tsx:42` description | "…how many, how much test time was skipped with proof, and how fast pull requests turn green." | "Your test runs on fenvix this month: how many, how many were proven identical to the serial run, and how fast pull requests turn green." |
| W3 | `Overview.tsx:122` cost card | "…priced as GitHub-hosted runner minutes and as your plan, which counts run units (1 unit = 10 baseline minutes)." + "Your plan" column with run units | "…priced as GitHub-hosted runner minutes." The "Your plan" column removed (price decided 22 Dec) |
| W4 | `Overview.tsx` KPI "Open defects" | sub "flaky, now reproducible" | sub "each with a replay command" |
| W5 | `Overview.tsx:189` latest defects | "Flaky tests turned into reproducible defects." | "Order and timing bugs fenvix found, each reproducible." |
| W6 | `Project.tsx` | no change (shadow tooltip describes existing runs) | — |
| W7 | `Defects.tsx:58` | "Flaky tests turned into reproducible defects: the cause named, …" | "Order and timing bugs fenvix found in your suite: the cause named, …" (rest unchanged) |
| W8 | `Project.tsx:349` nightly switch | help "…A paid add-on; not counted in your run units." | switch hidden while nightly is coming soon (setting kept in data); if you prefer keeping it: drop the last sentence |
| W9 | `Run.tsx:480` | "Shadow (trial): every test runs" | "Shadow: every test runs" |
| W10 | `Usage.tsx:76`, "Run units" card, "Run units" column | "Run units used against your plan, the test minutes fenvix skipped with proof, …" | "The test minutes your runs used on fenvix, the minutes skipped with proof, and what the same runs would cost on GitHub-hosted runners. Per project, for any month." Run-units card and column removed (price unit decided 22 Dec); CSV unchanged |
| W11 | `Settings.tsx:204` | "Email me about new defects, run units nearing what the plan includes, and account notices" | "Email me about new defects and account notices" |
| W12 | `SignIn.tsx:79` hero | "Sign in to see the test that breaks another, found in a suite of thousands, with the order that replays it." | "Sign in to see your tests run in parallel, each result proven identical to the serial run." |

No "deterministic" sold as the product was found in `src/` (grep `determinis`: 0 hits in pages and components).

## Questions for the coordinator
1. Approve the **R** rows: C1 rename instead of a page, C2-C7 coming soon with the routes above, nightly code removed.
2. W8: hide the nightly switch (recommended) or keep it with the shorter help?
3. W3/W10: removing run units from Overview and Usage goes slightly beyond "hide billing"; approve or keep them.
