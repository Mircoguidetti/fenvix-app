DONE

# Sign-in page: background only, no test drawing

- Branch: `claude/signin-clean`, from `origin/main` at `0d27ca8c7e871acf667edd338fb485973d728642` (recorded after `git fetch origin main` on 2026-11-27).
- PR: https://github.com/Mircoguidetti/fenvix-app/pull/28 (open, not merged).
- Commits: `95adfc7` (remove the drawing) and `f9a46a9` (fix the dark-theme comment, from the review), then this report.
- Identity: `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT` both printed `Mirco Guidetti <mircoguidetti1994@gmail.com> ...` before the first commit. `git config user.*` was not run. No commit has a Co-Authored-By line.

## Changes

1. `src/pages/SignIn.tsx`: removed `import { PairHero } ...` and `<PairHero />`. The logo, title, lead text and form are unchanged.
2. `src/components/PairHero.tsx`: removed with `git rm`. Before the change, `grep -rn PairHero src scripts tests` found it imported only by `src/pages/SignIn.tsx:8`.
3. `src/styles.css`: removed `.signin-pair`, `.pair-dot`, `.pair-link`, `.pair-node*`, `.pair-name` and `.pair-note`, their `prefers-reduced-motion` block, and `@keyframes pair-twinkle`, `pair-draw` and `pair-pulse`. The `.signin-hero` background and the static dot band in `.signin-hero::before` are unchanged. Two comments changed:
   - The comment above `.signin-hero` no longer mentions squares lighting up.
   - The dark-theme comment now reads "The dark theme keeps its dark code boxes." The old text claimed a black hero with the moving drawing, but the `.signin-hero` rule has no theme scope, so the light hero shows in both themes (found by /review).
4. Scripts: none referenced `PairHero`, `signin-pair` or `pair-`, so no script changed.

## Checks

The commands below ran on `f9a46a9`, which has the same source as this report's commit.

1. `grep -rn -E "PairHero|signin-pair|pair-(dot|link|node|name|note|twinkle|draw|pulse)" src scripts tests` printed nothing (exit 1).
2. Each command and its result:
   - `npm ci` exit 0
   - `npm run typecheck` exit 0
   - `npm run test:unit` exit 0: 88 tests, 88 pass, 0 fail
   - `npm run build` exit 0
   - `npm run check` exit 0: "checks: all 72 passed", "organization checks: all 10 passed", "status colour checks: all 18 passed", "screenshots: all checks passed, 170 pictures in docs/screenshots/". No failures, so nothing needed comparing with main.
3. Shots in `shots/` (`signin-<before|after>-<1440|390>-<light|dark>.png`):
   - Setup: `deviceScaleFactor: 2`, mock builds (`VITE_DATA_BACKEND=mock npx vite build`), served with `vite preview`. Before came from a `git worktree add <scratch> origin/main` build, taken first; after came from `95adfc7`. The later commit only changes a CSS comment.
   - Tool: the pre-installed Playwright, from a script outside the repo.
   - Console errors: 0 in all 8 shots.
   - `.signin-pair, .pair-dot` element count: 591 before, 0 after.
   - 1440 light: the drawing is gone and the gradient and static dot band remain (hashes differ: before `b04394c4cc8f`, after `fe3b01e9bc58`).
   - 1440 dark: this one does change. The sign-in page forces the light theme (`data-theme="light"` was observed with `colorScheme: dark`), so the dark shot shows the same light hero with the drawing. The after dark shot is byte-identical to the after light shot (`cmp`).
   - 390 light and dark: the hero is hidden below 900 px, so before and after are byte-identical (sha256 `04556ac5675d` for all four).
4. `git diff --stat origin/main...claude/signin-clean` lists `src/components/PairHero.tsx` (deleted), `src/pages/SignIn.tsx`, `src/styles.css`, and `signin-clean/2026-11-27/` (this report and 8 PNGs).

## Review (gstack /review, non-interactive)

- Dispatched Testing, Maintainability, Performance and Design specialists, plus the Claude adversarial pass. Codex is not installed. Cross-project learnings: set to `false`. The gstack upgrade prompt was skipped (no AskUserQuestion).
- Testing, Performance and Design: NO FINDINGS.
- Auto-fixed: the stale "black hero" comment in `src/styles.css`, flagged by Maintainability and Adversarial.
- Adversarial notes resolved by choosing the option that changes nothing outside the scoped files:
  - The screenshots are 4.2 MB of PNGs. They are kept, because the spec asks for them in `signin-clean/`.
  - A check that the drawing stays gone would change `scripts/`. Skipped.
  - Whether the headline "Two tests. One cause." still fits without the drawing: copy is out of scope. Noted for the founder.
- Result: 0 unresolved issues. Gate edits: none detected (0 listed).

## Founder note and follow-ups

- The founder also said "anche da signup page". The app has no separate sign-up page: sign-in, with the magic link and OAuth, is the only signed-out screen, and it now has no blinking squares. The landing hero is in a different repository and was out of scope.
- Follow-up: `src/components/HeroVisual.tsx` is imported nowhere (dead code), and so are its `.hero-visual` rules in `src/styles.css`. Both are left in place as the spec says.
