DONE

# Accent colour, round 2: six red-orange directions (27 Nov 2026)

Board (new private artifact): https://claude.ai/artifact/KFcn1DSkjqjuw5u7JJcfF3
Branch `claude/second-colour`. Round 1 (`../2026-11-27/`) is unchanged. Nothing in `src/` changed: `shots.mjs`
injects each kit's CSS.

## The six directions (light accent / light chart / dark chart)

| | Name | Accent | Chart | Dark chart | Status in this kit |
|---|---|---|---|---|---|
| A | Vermilion | `#d91202` | `#ea2513` | `#fb5e4a` | danger → `#b1014f` / `#e34e83` |
| B | Coral | `#9c5250` | `#c77775` | `#e49e9a` | danger → `#ae0360` / `#df4f94`; warning → `#7d6505` / `#eac52c` |
| C | Burnt orange | `#954c00` | `#954c00` | `#d4874e` | danger → `#b20446` / `#e54d7a`; warning → `#7d6505` / `#eac52c` |
| D | Amber orange | `#996003` | `#c57e07` | `#f8b054` | warning → `#746805` / `#d8cb34` (danger unchanged) |
| E | Rust | `#8a3e27` | `#8a3e27` | `#b9735e` | danger → `#b20446` / `#e54d7a`; warning → `#7d6505` / `#eac52c` |
| F | Tangerine on sand | `#b44e05` | `#e86604` | `#fd833e` | danger → `#b20446` / `#e54d7a`; warning → `#7d6505` / `#eac52c` |

All values per token are in `kits/*.css` and `contrast.json`. The intent sentences are on the board.

## Checks (command, observed result)

- `node second-colour/2026-11-27-r2/palette.mjs` reports "Directions failing a bar: none" (`CONTRAST.md`). That covers
  text ≥ 4.5:1 and non-text ≥ 3:1 in both themes, including the moved status colours used as text.
- `node second-colour/2026-11-27-r2/shots.mjs` reports "147 shots, 0 console error(s)". That is today plus A–F × 7
  pages (Overview, project Runs, a failed run `prj_docs/runs/run_docs_2016`, Parallel with proof, Usage, Settings,
  sign-in) × 1440×900 light, 1440×900 dark and 390×844 light, at `deviceScaleFactor: 2`.
- Status collision: the OKLCH hue, lightness and ΔE of each direction to danger and warning are in `STATUS.md` and
  on the board. Five of six directions were too close to danger, warning or both, so those kits move the status
  colour. The failed-run shots show the result. Two pairings are still close after the move: C's accent vs the
  moved warning (ΔE 0.075) and D's accent vs the moved warning (ΔE 0.067 light, 0.092 dark). There the warning icon
  and label carry the meaning, as they already do everywhere.
- Look-alike check: I put the seven Runs thumbnails side by side. A/B and C/F looked alike in the first pass, so I
  changed them: A became more vivid on near-white tints, B became pastel with a stronger tint, C became darker
  copper, and F's tints became beige-grey sand. The closest pairs now are D/F (golden vs tangerine) and C/E
  (copper vs brick). They differ in tint and lightness.
- `git diff --stat origin/main...claude/second-colour` shows only files under `second-colour/`.

## Notes

- Links, including "Watch it live", are ink today, not cobalt, so the kits leave them alone (see `TOKENS.md`).
  If the founder wants accent-coloured links, that is a separate decision.
- The moved danger is a deeper crimson that leans slightly pink (hue ≈ 0–10°). It is a real change to how failure
  looks, so it would need sign-off along with the accent.
- Board pictures are JPEG copies made by `board/thumbs.py` and are not committed. The PNGs in `shots/` are the source.

## My ranking (for the coordinator, not on the board)

1. **F, Tangerine on sand.** Clearly orange, clearly not failure (ΔE 0.13 to the moved danger), and the sand
   neutrals make the whole console feel warmer. It is the biggest visible change for the founder.
2. **C, Burnt orange.** Calm, technical and confident: the mood the founder pointed at. Far from danger, but it
   needs the warning moved, and that pairing stays fairly close.
3. **E, Rust.** Serious and quiet. It is so dark that it reads close to ink, so the accent does less work.
4. **D, Amber orange.** The only one that keeps today's danger red. But it lands on the warning colour, and moving
   warning only half solves it.
5. **B, Coral.** Friendly but soft. It needs both status colours moved, and the selected tint reads pink.
6. **A, Vermilion.** It is today's danger red (ΔE 0.006 to `#d6140a`). In a product that shows failed tests, the
   accent would read as failure everywhere, even with danger moved.
