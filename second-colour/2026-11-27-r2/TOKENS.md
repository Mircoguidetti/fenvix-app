# The accent: tokens and where they show (round 2)

Source: `src/styles.css` at `origin/main` 50d7fd9. Round 1's inventory of the light blue is `../2026-11-27/TOKENS.md`;
this round adds cobalt itself.

## Commands and counts (27 Nov)

```sh
for t in nav-on chart chart-fill focus nav-active nav-hover ink-2 ink-3 silver-1 silver-3 area-1 area-2; do
  printf "%s %s\n" $t "$(grep -rhoE "var\(--$t\)" src | wc -l)"; done
grep -rnoE "0d4fa3|13, ?79, ?163" src | cut -d: -f1,2 | sort -u
```

Observed: nav-on 7, chart 23, chart-fill 3, focus 2, nav-active 12, nav-hover 9, ink-2 11, ink-3 3, silver-1 5,
silver-3 5, area-1 1, area-2 1; `var(--stack-${i})` 1 helper (`src/components/charts.tsx:458`). Cobalt literals:
`src/styles.css` lines 34, 39, 40, 41, 44, 519, 521, 536, 1569, 1570. None in TSX.

## What each kit overrides

| Theme | Token / literal | Today | Where |
|---|---|---|---|
| light | `--nav-on` | `#0d4fa3` `:34` | selected rail icon and second-bar link text, search result, seg focus ring, focused field border, data explorer marker |
| light | `--chart`, `--stack-0`, `--area-1/2` | `#0d4fa3` `:39`, `:41`, `:536` | every chart line, bar, dot, sparkline, meter, timeline, hbar, the fade under lines |
| light | `--chart-fill` | `rgba(13,79,163,.06)` `:40` | area under sparklines and charts, legend fill key |
| light | `--focus` | `rgba(13,79,163,.18)` `:44` | focus ring of fields and selects |
| light | `.spark-area`, `.chart-area` literals | `rgba(13,79,163,.07/.08)` `:519`, `:521` | fallbacks; the kit points them at `--chart-fill` |
| light | sign-in glow and dots | `rgba(13,79,163,…)` `:1569`, `:1570` | the sign-in hero |
| light | `--nav-active`, `--ink-2`, `--ink-3`, `--stack-1..4`, sky stops | see round 1 | selected tint, second line, bar track, stacked bars, sign-in sky |
| dark | `--chart`, `--nav-active/hover`, `--ink-2`, `--silver-1/3`, `--stack-0..4` | see round 1 | charts, menu tints, plan border |
| both | `--danger`, `--warning` (and `-on-dark`) | `#d6140a`/`#ff6a5c`, `#9c5900`/`#ffb020` | only in kits whose accent is too close (STATUS.md) |

Not overridden, on purpose:
- Links, including "Watch it live", are ink (`a { color: inherit }`, `.row-link` uses `--text`), not cobalt.
  Making them accent-coloured would be a new design decision, not a colour swap.
- Dark `--nav-on` and `--focus` are white, not cobalt.
- Dark `--nav-label #8898bf` is a blue-grey text colour in the grey family.
- Dark `--silver-2 #1f2b47` and `--ink-3 #23345c` are near-night blues.
- The green success colour.
