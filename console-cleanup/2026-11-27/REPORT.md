DONE

# Console cleanup: report (spec rev 2, area design)

- Repository: Mircoguidetti/fenvix-app. Branch `claude/console-cleanup` from `origin/main` 50d7fd9 (head after `git fetch origin` on 2026-11-27).
- PR: https://github.com/Mircoguidetti/fenvix-app/pull/30 (open, not merged).
- Inventory: `INVENTORY.md` (commit 62cfe9f) was sent to the coordinator. The reply approved the R rows with one change: keep the `NightlyPage` code, unrouted. It also approved hiding the nightly switch and removing run units from Overview and Usage. Remove and coming-soon changes were made only after that reply.
- Commit identity: `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT` printed `Mirco Guidetti <mircoguidetti1994@gmail.com> …` before the first commit. No `Co-Authored-By` line was written. An environment stop hook asked to rewrite the commits to a different identity with `git config user.*` and amend/rebase. I did not do it, because Rules 1 and 5 of the spec forbid it. The commits are therefore unsigned and GitHub may show them as "Unverified".

## Changes to tests, check scripts, CI, timeouts, thresholds (Rule 4)

- `scripts/run.mjs`: also runs the new `scripts/cleanup-checks.mjs` (16 checks). Reason: the checks required by the spec.
- `scripts/checks.mjs` "sign in and out": `toast(page, "Signed out")` x2 is replaced by an assert that no toast is shown. Reason: sign-out toast removed (B1).
- `scripts/checks.mjs` "overview": the `$479` plan price and "run units used…" asserts are replaced by an assert that the cost card has no plan or run units, plus "On GitHub-hosted runners". Reason: W3, approved.
- `scripts/checks.mjs` "projects, a project…": no longer toggles the nightly switch. It now asserts the switch is absent and the saved nightly value is unchanged. Reason: W8 (switch hidden), approved.
- `scripts/checks.mjs` "skip with proof…": the nightly part now expects the coming-soon page (no nights, no add-on note). Adds the "Cache with proof" heading. Reason: C1, C3.
- `scripts/checks.mjs` "the shadow trial…" (renamed "…(on the hidden billing page only)…"): trial asserts moved from Overview to `/billing`. The nightly add-on note assert is removed (page is coming soon). The below-gate check reloads `/billing`. Adds an assert that Overview shows no trial. Reason: W1, C3.
- `scripts/checks.mjs` "connect a project…": asserts that the connected block is collapsed, that its count equals its rows, and that connected repositories are not in the steps. Then it opens the block. The installations helper and count use `.steps .install`. Reason: B5.
- `scripts/checks.mjs` "usage…" (renamed "usage: per project, the rows add up, CSV export"): run-units card asserts are replaced by asserts that neither the card nor the column exists. The runs total comes from the table footer. `toast(page, "CSV ready")` is replaced by an assert that no toast is shown. Reason: W10, B1.
- `scripts/orgs-checks.mjs`: `toast(page, "Switched to Harbor Analytics")` is replaced by an assert that no toast is shown. The member read-only switch check now uses "Skip tests with proof" instead of the hidden nightly switch. Reason: B1, W8.
- `scripts/status-colors-checks.mjs`: the connect check opens the collapsed block before reading pill colours. The trial-gate colour is read on `/billing` instead of Overview. Reason: B5, W1.
- `scripts/e2e-real-api.mjs` (not run here: it needs the real API): page markers updated. Overview uses "Proven identical"; "trial" moved to the billing row; nightly uses "Coming soon"; project settings uses "Cache with proof"; usage uses "GitHub-hosted". Reason: the wording changes. The testing specialist found this in review.
- `src/session/mock.ts`, `src/data/mock.ts`: the mock delay can be raised by `window.__fenvixMockDelayMs`, which only the checks set. Reason: the "API mock delayed 3 s" loading check.
- No timeout or threshold of an existing check was changed. No CI step was changed.

## Check 1: commands

| Command | origin/main (worktree at 50d7fd9) | claude/console-cleanup (24a4744) |
|---|---|---|
| `npm ci` | (node_modules copied from the branch's `npm ci`; same lockfile) | exit 0 |
| `npm run typecheck` | exit 0 | exit 0 |
| `npm run test:unit` | exit 0, 88 tests, 88 pass | exit 0, 91 tests, 91 pass |
| `npm run build` | exit 0 | exit 0 |
| `npm run check` | exit 0: checks 72 passed, organization 10, status colours 18, screenshots 170 pictures | exit 0: checks 72 passed, organization 10, status colours 18, cleanup 16, screenshots 170 pictures |

`npm run check` regenerates `docs/screenshots/`. That directory is not tracked by git (no change shown by `git status`), so it is not in this PR.

## Check 2: tests and their cards

1. **Unit `tests/unit/next.test.ts`** (3 tests): the `next` guard.
   - protects: the return after sign-in stays on this site.
   - fails_when: `safeNext` keeps `//x`, `/\x`, `https://x`, `javascript:`, control characters, or a path that normalises to `//host` (`/..//evil.com`). Before the review fix, `node … safeNext("/..//evil.com")` returned `//evil.com`; the test now fails on that code.
   - no_claim: browser behaviour of `navigate()`; the real Supabase redirect.
2. **UI "toasts: none after sign-in, sign-out, org switch or navigation"** (desktop, mobile).
   - protects: no toast for actions that need no answer, including a double click on the Settings "Sign out".
   - fails_when: any `.toast` appears from sign-in to sign-out. On the origin/main build the same check saw "Switched to Harbor Analytics | Signed out | Signed out".
   - no_claim: toasts of other actions.
3. **UI "toasts: one, top right, after Project settings saved"** (desktop, mobile).
   - protects: exactly one toast at 16 px top/right (16 px left below 600 px); a second save while it is shown does not add another; after dismissal the next save shows it again.
   - fails_when: zero or two toasts, a wrong position, or no toast after dismissal.
   - no_claim: other toast texts.
4. **UI "usage table at 400, 1280 and 1920 px…"** (desktop, mobile).
   - protects: no cell text over 2 lines, no cell's right edge past the card's right edge, the project's full name in `title`, no sideways page scroll.
   - fails_when: any of those at any of the three widths.
   - no_claim: other tables.
5. **UI "billing: no link to it anywhere in the navigation; /billing still renders"**.
   - protects: no `a[href="/billing"]` on Usage, Overview, Settings or project settings (drawer included on mobile); no "Usage and billing"; the palette offers no Billing (desktop); `/billing` shows its heading.
   - fails_when: any link or label comes back, or the route breaks.
   - no_claim: the billing page's own content.
6. **UI "signed out: /projects/x goes to /welcome?next=…, and back there after sign-in"**.
   - protects: `/projects/x` goes to `/welcome?next=%2Fprojects%2Fx` and returns to `/projects/x` after mock sign-in. The same holds for a deep path with a query. A signed-in `/welcome` goes to `/`.
   - fails_when: wrong URL before or after sign-in.
   - no_claim: the OAuth provider in api mode.
7. **UI "welcome: after a provider round-trip (back on /)…"** (added in review).
   - protects: a stored `next` is followed once after landing on `/`, then cleared; a hostile stored value is not followed.
   - fails_when: no redirect, a redirect off-site, or the value is not cleared.
   - no_claim: Supabase itself.
8. **UI "welcome: a next to another site goes to /"**.
   - protects: `//evil`, `/\evil`, `/..//evil`, `https://evil`, `javascript:` keep the browser on this origin.
   - fails_when: the browser leaves the origin.
   - no_claim: none beyond these inputs.
9. **UI "loading screen: in the built index.html, visible at once with a slow start, never an empty #root"**.
   - protects: `dist/index.html` has the screen inside `#root`. With scripts held 3 s and the API mock delayed 3 s, the screen is drawn within 300 ms of navigation start (page clock), and no animation frame or mutation sees an empty `#root` until the sign-in page.
   - fails_when: any of those.
   - no_claim: real network cold starts.
10. **UI "loading screen: after 8 s still loading…"**.
    - protects: "Waking up the service..." is hidden at 2 s and visible by 10 s.
    - fails_when: it shows early or never.
    - no_claim: the exact timing in a real cold start.
11. **UI "coming soon: every live-list item has a nav entry that opens its page"** (desktop, mobile).
    - protects: Detailed proof, Compatibility, Is this red real?, Database copies, Nightly exploration and Python each open from the nav, with their title and the "Coming soon" block; "Cache with proof" is the renamed page.
    - fails_when: a nav entry or page is missing.
    - no_claim: the future features themselves.
- Invitation links: the existing `orgs-checks.mjs` invitation tests passed (10/10) with the redirect in place: signed-out `/invite#token` → welcome → join screen.

## Check 3: shots

`shots/`: 28 pictures before (origin/main build, worktree at 50d7fd9) and 28 after (build of 6d54049). Mock backend, pre-installed Playwright, `deviceScaleFactor: 2`, light and dark, 1440x900 and 390x844. Pages: Connect, Usage, Settings, sign-in/welcome, loading screen, a coming-soon page (nightly), a toast. Command: `BASE_URL=… PREFIX=before|after node scripts/cleanup-shots.mjs`. Output: "28 pictures … console errors: 0" for both. The after shots predate the review fixes (24a4744), which change no layout: they add a failure note to the static loading screen and fix the `next` guard. The sign-in page stays light only, by design, so its light and dark shots are identical.

## Check 4: files

`git diff --stat origin/main...claude/console-cleanup` lists only `console-cleanup/`, `index.html`, `scripts/` (checks.mjs, cleanup-checks.mjs, cleanup-shots.mjs, e2e-real-api.mjs, orgs-checks.mjs, run.mjs, status-colors-checks.mjs), `src/` (App.tsx, main.tsx, components/AccountMenu.tsx, ComingSoon.tsx, LoadingScreen.tsx, Shell.tsx, Toast.tsx, data/mock.ts, lib/next.ts, pages/Connect.tsx, Defects.tsx, Overview.tsx, Project.tsx, ProjectSections.tsx, Run.tsx, Settings.tsx, SignIn.tsx, Usage.tsx, session/mock.ts, session/redirect.ts, styles.css) and `tests/unit/next.test.ts`. Nothing is under `github-app/`, `supabase/`, `openapi/` or `deploy/`. No colour token changed.

## Findings asked for by the spec

- **Why "Signed out" showed twice**: the Settings account card's "Sign out" button stayed enabled while `session.signOut()` waited on Supabase, and each click awaited and then toasted. Reproduced on the origin/main build: the cleanup check double-clicked it and saw "Signed out" twice. Now no toast is shown, the button is disabled while signing out, and the provider dedupes the same text.
- **Email link in a new tab**: the API-mode email link opens in a new tab with empty sessionStorage, so it loses `next` and lands on `/`. Accepted by the spec.
- **Accepted, not changed**: a `next` stored at sign-out can outlive it in a shared tab. It is always a same-site path, and the server authorises every request.
- **Open for the coordinator**: the sign-in hero title "Two tests. One cause." was not in the approved wording rows and is unchanged. It reads as the old flaky-test promise next to the new lead line.
- `/review` (gstack): specialists Testing, Security and Maintainability, plus the adversarial pass. 0 critical open, 7 fixed in one cycle, 2 accepted (above). Gate edits: 4 listed, 3 read, 0 findings (product-code try/catch blocks, no relaxed tests).
