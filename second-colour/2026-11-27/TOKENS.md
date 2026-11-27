# The light blue: tokens and where they show

Source: `src/styles.css` at `origin/main` 50d7fd9. The light blue is the second colour next to the near-night dark blue.
Cobalt `#0d4fa3` (light `--nav-on`, `--chart`, `--focus`, `--stack-0`, the sign-in glow and dots) stays, as decided on
2026-11-26, and is not listed as something to replace.

## How the counts were made

```sh
# uses of each token (var(--x) anywhere in src/, CSS and TSX)
for t in nav-active nav-hover ink-2 ink-3 chart silver-1 silver-3 nav-label area-1 area-2; do
  printf "%s %s\n" $t "$(grep -rhoE "var\(--$t\)" src | wc -l)"; done
# the stack ramp is read by name from TSX
grep -rhoE 'var\(--stack-\$\{' src | wc -l
# hard-coded light-blue literals (each one is a definition line, listed below)
grep -rnoiE "#(e6eef9|6f9bd8|c9d8ef|3f72bd|7199d3|a3bfe5|cfdcf0|f3f6fb|e5edf8|d8e4f4|b6c6ed|4262ae|4560a1|819bda|8898bf|dae1f1|a6b7dd|728dca|4364b1|30477e|1f2e51)|rgba\(110, ?145, ?230[^)]*\)" src
```

Observed (27 Nov): nav-active 12, nav-hover 9, ink-2 11, ink-3 3, chart 23, silver-1 5, silver-3 5, nav-label 10,
area-1 1, area-2 1; `var(--stack-${i})` 1 (one helper in `StackedBars`, `src/components/charts.tsx:458`, used for
every segment, tooltip swatch and legend key). Every literal sits in `src/styles.css`; none in TSX.

## Light theme

| Token | Today | Defined | Uses | Where it shows |
|---|---|---|---|---|
| `--nav-active` | `#e6eef9` | `:33` | 12 (shared with dark) | selected rail icon, second-bar link, drawer link, search result (`:1328`, `:1359`, `:1380`, `:1403`); pressed segment and settings tab (`:1507`, `:1512`, `:1515`); select option, choice card (`:1528`, `:1532`); data explorer collection and document (`:1605`, `:1608`); old nav link (`:215`) |
| `--ink-2` | `#6f9bd8` | `:37` | 11 (shared) | dashed second chart line and its legend key and tooltip key (`:523`, `:532`, `:1467`, `:1472`, `:1544`, `:1545`; `charts.tsx:394`, `:653`); hover border of search and select (`:304`, `:309`); asleep state dot (`:843`) |
| `--ink-3` | `#c9d8ef` | `:38` | 3 (shared) | horizontal bar track (`:1547`, Overview and Skip with proof), fleet "asleep" blocks (`:868`, `:1548`) |
| `--stack-1..4` | `#3f72bd #7199d3 #a3bfe5 #cfdcf0` | `:536` | 1 helper | Usage, "Runs per day" stacked bars, legend and tooltip (`--stack-0` cobalt and `--stack-5` grey stay) |
| sign-in gradient | `#f3f6fb #e5edf8 #d8e4f4` | `:1569` (hard-coded) | 1 | the sign-in hero sky (`.signin-hero`); the sign-in page is light in both themes |

Not light blue in light theme (unchanged): `--nav-hover #f1f2f5` (grey), `--chart`/`--focus`/`--nav-on`/`--chart-fill`/`--area-*` (cobalt), `--silver-1/3` (greys).

## Dark theme

Each dark value is written twice, `:root[data-theme="dark"]` and the `prefers-color-scheme` block; a kit overrides both.

| Token | Today | Defined | Where it shows |
|---|---|---|---|
| `--chart` | `#b6c6ed` | `:101`, `:143` | every chart line, bar, dot, sparkline, meter, timeline, hbar fill, "kept" state dot (23 uses) |
| `--nav-hover` | `rgba(110,145,230,.1)` | `:92`, `:134` | hover on rail, second bar, crumbs, icon buttons, user button (9 uses) |
| `--nav-active` | `rgba(110,145,230,.2)` | `:93`, `:135` | as the light list above |
| `--ink-2` | `#4262ae` | `:99`, `:141` | as the light list above |
| `--silver-1` / `--silver-3` | `#4560a1` / `#819bda` | `:102/104`, `:144/146` | the fade under chart lines (`--area-1/2`, `:105`, `:147`, `.silver-stop-*` `:818-819`), the current-plan border on Billing (`:817`) |
| `--stack-0..4` | `#dae1f1 #a6b7dd #728dca #4364b1 #30477e` | `:537`, `:538` | Usage stacked bars (`--stack-5 #1f2e51` is near-night blue and stays) |
| `--nav-label` | `#8898bf` | `:91`, `:133` | small labels in the bars: workspace sub-line, org name, crumb kind, search icon and shortcut, drawer labels, preview title (10 uses) |

Left as they are (near-night blue family, not the light blue): `--ink-3 #23345c` (= `--border-strong`), `--silver-2 #1f2b47`, all surfaces and borders.
