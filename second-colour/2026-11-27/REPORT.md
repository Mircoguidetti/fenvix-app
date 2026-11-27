DONE

# Second colour board, 27 Nov 2026

Board (private artifact): https://claude.ai/artifact/14eStBNDmRtHFbhxNeGLH3
Branch `claude/second-colour` from `origin/main` 50d7fd9. Nothing in `src/` changed: the kits are injected by the shot
script, so there is no loader.

## What is here

| File | What |
|---|---|
| `TOKENS.md` | every light-blue token, both themes, with use counts and the grep commands that produced them |
| `palette.mjs` | builds the five kits from a hue and chroma each (OKLCH), then measures every pairing; writes `kits/`, `contrast.json`, `CONTRAST.md` |
| `kits/a-slate.css` … `kits/e-graphite.css` | token overrides only (light, dark, `prefers-color-scheme` dark, sign-in sky) |
| `CONTRAST.md` | the ratio table, today plus A–E |
| `shots.mjs`, `shots/<kit>/` | 108 PNGs: reference + A–E × Overview, project Runs, Parallel with proof, Usage, Settings, sign-in × 1440×900 light, 1440×900 dark, 390×844 light; `deviceScaleFactor: 2`, mock backend |
| `board/` | `template.html` + `build.mjs` → `index.html` (the published page); `thumbs.py` makes `board/img/` (not committed) |

## Checks (command, observed result)

- `node second-colour/2026-11-27/palette.mjs` → "Directions failing a bar: none." Every text pairing ≥ 4.5:1 and every
  non-text pairing ≥ 3:1 in A–E, both themes. Today's colours fail six non-text pairings: light `--ink-2` 2.85 on card and
  2.64 on page, light `--stack-2/3/4` 2.92 / 1.88 / 1.39, dark `--stack-4` 2.06.
- `node second-colour/2026-11-27/shots.mjs` (preview built with `VITE_DATA_BACKEND=mock VITE_STYLEGUIDE=1 npx vite build`,
  served by `npx vite preview --port 4173`) → "108 shots, 0 console error(s)". It also confirms the kit `<style>` was
  injected into each page.
- Board page loaded in Playwright from a local server: 0 console errors.
- `git diff --stat origin/main...claude/second-colour`: only files under `second-colour/`.

## Notes

- The sign-in page is light in both themes today (the dark-theme sign-in shot matches the light one). Its cobalt glow
  and dot band stay cobalt in every direction, because the spec keeps cobalt; only the three sky stops change.
- To reach 3:1, the light stacked-bar ramp in A–E spans 5.6:1 to 3.05:1. Adjacent segments are closer in tone than
  today's (which go down to 1.39:1). The legend and tooltip still name every series.
- Left unchanged on purpose: dark `--ink-3 #23345c` and `--silver-2 #1f2b47`. Both are in the near-night family.
- Glacier's hue moved from 218 to 232 after a first look: at 218 its dark ramp read as teal, too close to the green
  status colour.

## My ranking (for the coordinator, not on the board)

1. **A, Slate.** It keeps the blue family the founder kept on 23 and 26 Nov and takes out the periwinkle. It is the
   calmest and most technical, and the cobalt stays the one clear blue.
2. **E, Graphite.** The most disciplined: cobalt is the only accent. The cost is that the selected tint is almost the
   same grey as hover, so "you are here" depends on the cobalt text alone.
3. **D, Stone.** The most distinctive of the quiet options, with a printed-page warmth. In dark charts the warm greys
   next to the near-night blues can look muddy.
4. **B, Glacier.** Cleaner than today's blue, but it is still a second blue beside cobalt, and its ramps lean
   towards teal.
5. **C, Iris.** The clearest second colour, but violet next to cobalt reads as a blue-to-purple pairing that competes
   with the brand blue.
