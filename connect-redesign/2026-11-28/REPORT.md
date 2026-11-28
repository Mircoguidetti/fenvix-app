DONE

# Connect a project, real redesign (rev 1) and the founder's follow-ups of 28 Nov

Branch `claude/connect-redesign` from `origin/main` 3fc67ec. PR to main, not merged: https://github.com/Mircoguidetti/fenvix-app/pull/32. Board: https://claude.ai/artifact/59TpMBcX9yCALY1S3v8QtV (private artifact "Connect: before / after").

Commit identity: `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT` both printed `Mirco Guidetti <mircoguidetti1994@gmail.com> …` before the first commit.

## What changed

- **Connect, v2 (coordinator message, 12:34, replaces layout B of the spec).** Founder: "if I connect a repo it must have its own project with the steps; here it stays global and nothing is clear". `/projects/connect` has: (a) "Install the fenvix GitHub App" when there is no installation; (b) "Pick a repository to connect", listing the repositories not on fenvix (not merged/already_fenvix/side_by_side, no open setup pull request, not removed, not on an uninstalled installation), each with a state pill when not ready and one "Set up" link to `/projects/connect/:repositoryId`; (c) one line per GitHub account (Choose more / Add another account, suspended or uninstalled as a short warning); (d) the collapsed Removed list (Add again). It has no numbered steps, no mode toggle and no global list of setup pull requests. It keeps "See your projects" and the collapsed "What fenvix does with access".
- **New page `/projects/connect/:repositoryId`** (`src/pages/ConnectSetup.tsx`; its title is the repository's full name). It has four steps for this repository only:
  1. How fenvix runs it: the existing Move / Side by side toggle, with the line "This choice applies to your organization". There is no API change: the setting is per organization.
  2. Open the setup pull request: the button and the diff, or, when nothing was detected, the App's detail, what to do, and "Check again".
  3. Merge it on GitHub: a link to the pull request, with its state read again every 5 s while it is open.
  4. First run: waiting, or "Open project".

  A repository that already has its project when the page opens redirects to `/projects/:projectId`. An unknown repository says "Repository not found".
- **"Setting up".** The sidebar's "Your projects" and the Projects page list the repositories in setup: setup pull request open, or merged with no project yet. Each links to its setup page.
- **Python removed (coordinator message, 12:26, item 1).** Gone from the Projects sidebar, the mobile drawer (same component), the command palette and the `/python` route.
- **Four project tabs removed (12:34).** Detailed proof, Compatibility, Is this red real? and Database copies are gone: their `PROJECT_SOON` entries, nav entries and routes. Their old URLs give the 404 page. Runs, Parallel with proof, Defects, Cache with proof, Time to green, Nightly exploration (coming soon) and Settings are unchanged.
- **Projects, one "Connect a project" button (12:26, item 2).** With no project, the empty state's button only; with projects, the header's only.
- **Gate screens (12:27).** NameOrgScreen, NoOrgScreen and InviteScreen get their own frame (`.gate-page`, `.gate-mark`, `.gate-card`, `.gate-foot`): logo on top, one centred card, the signed-in line right under it. The sign-in page's classes are no longer shared, so `/welcome` is unchanged.
- **Kept, unchanged:** the install link, the OAuth completion fragment, the `?github=` messages (connected, requested, error, updated), polling after opening a setup pull request (now on the setup page), side-by-side persistence, and toasts only after create/update/delete.

Files: `src/pages/Connect.tsx`, `src/pages/ConnectSetup.tsx` (new), `src/pages/Projects.tsx`, `src/components/Shell.tsx`, `src/components/ComingSoon.tsx`, `src/components/OrgScreens.tsx`, `src/App.tsx`, `src/styles.css`, the check scripts below, `connect-redesign/`. No API, github-app or mock change.

## Checks (each command and its observed result)

- `npm ci`: completed.
- `npm run typecheck`: exit 0.
- `npm run test:unit`: exit 0, 91 tests, 91 pass, 0 fail.
- `npm run build`: exit 0.
- `npm run check`: exit 0. checks 72 passed, organization 10, remove/delete 8, status colours 18, cleanup 18, connect 20, screenshots "all checks passed, 170 pictures" (axe and layout included).
- `scripts/e2e-real-api.mjs`: **not run**. It needs a local Supabase stack, which this session does not have. Its Connect expectations were updated (below) but are unverified.

### Changed checks, one per line with the reason

- `scripts/checks.mjs` sign-up test: "No installation yet: install the app first." became the "Install the fenvix GitHub App" heading, because the install card replaces step 2's line.
- `scripts/checks.mjs` "connect a project: installations, every onboarding state, …": steps and installation blocks became GitHub lines, the pick list and the setup page (Set up → Open setup pull request → toast → Merge link), because the page was rebuilt.
- `scripts/checks.mjs` "connect: the side-by-side choice is saved": runs on a repository's setup page, because the toggle moved there.
- `scripts/checks.mjs` "connect a project always offers more repositories …": "Add another GitHub account" became "Add another account", the label the GitHub line uses.
- `scripts/status-colors-checks.mjs` Connect test: the done-step paint, the green/amber pills of connected or open repositories and the installation pills were dropped, and the diff is read on the setup page. The checklist, those rows and those pills are no longer on Connect. Installation warnings are now checked as an amber icon with words.
- `scripts/cleanup-checks.mjs` `?github=updated`: `.steps .repo-row` became `.connect-pick .repo-row`, because there are no steps.
- `scripts/cleanup-checks.mjs` coming soon: only Nightly exploration is left, because the four tabs and Python were removed (their 404 is checked in connect-checks).
- `scripts/orgs-checks.mjs`: "Add another account", and the member's disabled "Open setup pull request" is checked on the setup page, because the button moved there.
- `scripts/remove-delete-checks.mjs` Add again: the Removed list is opened first (it is collapsed), and a removed repository offers no "Set up".
- `scripts/screenshots.mjs`: the one-background check looks for `.gate-page` as well as `.signin-page`, because the gate screens have their own frame.
- `scripts/e2e-real-api.mjs`: dropped the warm-cache markers on Connect, because connected repositories are no longer listed there. The pick-list states are read in `<main>`, since the sidebar lists projects and repositories in setup. The install button is matched by "Install the GitHub App" or "Add another account". The marker "Warm-up not possible (ccccccc)…" is not checked anywhere now (not run, see above).
- `scripts/run.mjs`: runs the new `scripts/connect-checks.mjs`.

### UI tests (`scripts/connect-checks.mjs`, mock backend, desktop 1440x900 and mobile 390x844; 20 of 20 passed)

Each test carries protects / fails_when / no_claim in the source.
- state A: no installation shows the install card, no steps and no repository list.
- state B: the pick list leaves out connected, open and removed repositories; Set up goes to the setup page; no steps, no mode toggle, no "Waiting for your merge"; the Removed list is collapsed; "See your projects" goes to /projects.
- setup page, not detected: why, what to do, Check again, no pull request offered.
- setup page, ready: Open setup pull request, exactly one toast, then "Merge it on GitHub" with the new pull request, and listed as "Setting up" on /projects.
- setup page, pull request open: reached from "Setting up" (Projects, and the sidebar on desktop); the merge link goes to pull request #812.
- setup page, merged without a project: waits for the first run. Active: redirects to `/projects/prj_homehub`. An unknown id: "Repository not found".
- removed: Python and the four tabs are not in the navigation (sidebar, drawer, command palette), and their old URLs give "Page not found"; the kept tabs are still there.
- Projects with no project: one "Connect a project" button (the empty state's). With projects: one (the header's).
- Gate screens (Name your organization, No organization, Join an organization): the card is horizontally centred (|left gap − right gap| ≤ 2 px) and wholly inside the viewport, the logo is above it, and the signed-in line sits right under it.

## Shots and board

`node connect-redesign/2026-11-28/shots.mjs` (Connect, states A and B) and `node connect-redesign/2026-11-28/extras-shots.mjs` (setup page, Projects, navigation, tabs, gate screens) ran against the origin/main build (before) and this branch's build (after). Mock backend, `deviceScaleFactor: 2`, 1440x900 light and dark, 390x844 light. Observed: "console errors in total: 0" for every run.

Gate cards, measured by the shot script:
- Before: x=107, right gap 953 at 1440 (cut to the viewport height); x=0, right gap 10 at 390.
- After: left 510 / right 510 at 1440; 16 / 16 at 390.

Board (57 images): https://claude.ai/artifact/59TpMBcX9yCALY1S3v8QtV

## gstack /review (on the first commit, 27eb5e8; non-interactive, every ASK took the option that changes nothing outside scope)

- Specialists: testing, maintainability, security (no findings), performance (no findings), design, simplification; Claude adversarial pass (Codex not installed).
- Fixed:
  - step titles nested under the card heading (h3, with margin 0);
  - "Add another account" padding on phones;
  - dead CSS from the old page;
  - a `pr_open` repository with no pull request number shown nowhere;
  - a second Connect during polling dropped (functional queue update);
  - a false empty-state sentence;
  - install clickable while an install is completing;
  - step text that assumed move mode.
- Resolved by v2: Step's `done` branch is used again on the setup page (done ticks).
- Skipped:
  - Carried over unchanged from main (the spec keeps that behaviour): polling/refresh/restore timing, the toast tone on an undetected result, and the account name in the `?github=connected` banner.
  - Outside the files I may touch: `InstallationStatusPill` is now unused (src/components/StateBadge.tsx), and `docs/status-colors.md` rows 85 and 87–89 still describe the old Connect page.
- Gate edits: 1 listed, 1 read, 0 findings. The one tagged hunk (RH-16) is an empty `catch` in the shot script's wait for the preview server.
- The coordinator's v2 changes came after this review and were not reviewed by gstack again. Their verification is the checks above.

## Not done or not verified

- `scripts/e2e-real-api.mjs` was not run (no local Supabase here).
- The setup page's live state (polling every 5 s while the pull request is open) is checked only through the mock, where a pull request never merges on its own.
