# Status colours and silver

The dashboard is black, white and grey. Colour appears only where it means something, the way Uber does it:
green, red and amber are status colours, never decoration. Silver is one small detail on top of that.

The dashboard is this repository's root app (`src/`), so this file lives in `docs/`. It has one fixed theme:
white content with a near-black navigation column. There is no dark mode. The "dark" values below are for the dark
surfaces in that theme: the navigation, the drawer and the toasts.

## Tokens

All of them are defined once, in the `:root` block at the top of `src/styles.css`. Every rule that uses them is in
the "status colours and silver" section at the end of that file.

| Token | Value | Meaning |
| --- | --- | --- |
| `--success` | `#067a3a` | passed, active, paid, done, confirmed |
| `--danger` | `#d6140a` | errors, blocked addresses, failures, actions that cannot be undone |
| `--warning` | `#9c5900` | starting, in progress, needs attention |
| `--success-on-dark` | `#3ddc84` | the same on a dark surface (toasts) |
| `--danger-on-dark` | `#ff6a5c` | the same on a dark surface (toasts) |
| `--warning-on-dark` | `#ffb020` | the same on a dark surface (defined, not used yet: no amber toast exists) |
| `--silver-1` | `#c4c8ce` | silver, light grey |
| `--silver-2` | `#f4f5f7` | silver, near white |
| `--silver-3` | `#7c828b` | silver, mid grey |
| `--silver` | `linear-gradient(90deg, silver-1, silver-2 50%, silver-3)` | the silver gradient |

The status colours are flat: a single hex value each, no gradient, no tint behind text.

### Contrast

Contrast ratios (WCAG 2), computed by `tests/unit/status-colors.test.ts`:

| Colour | on `--bg` #ffffff | on `--page` #fafafa | on `--surface` #f6f6f7 | on `--surface-2` #efeff1 |
| --- | --- | --- | --- | --- |
| `--success` | 5.45 | 5.22 | 5.05 | 4.75 |
| `--danger` | 5.30 | 5.08 | 4.91 | 4.61 |
| `--warning` | 5.19 | 4.97 | 4.81 | 4.52 |

| Colour | on `--nav-bg` #000000, `--black` (also the toast) | on `--nav-hover` #17171a | on `--nav-active` #202024 |
| --- | --- | --- | --- |
| `--success-on-dark` | 11.09 | 10.03 | 9.10 |
| `--danger-on-dark` | 7.04 | 6.36 | 5.77 |
| `--warning-on-dark` | 10.82 | 9.78 | 8.88 |

So every status colour passes 4.5:1 as text on every surface it can sit on, and therefore also 3:1 as a shape (dot,
border, icon). White text on `--danger` (a red button on hover) is 5.30:1.

Silver is a detail, not a carrier of meaning, but it is still checked to stay visible: its darkest stop is 3.87:1 on
white and its light stop 11.78:1 on the navigation and on a black (selected) tab. Its light stops stay under 2:1 on
white, so on the white content it reads as a sheen rather than a stripe.

## Rules

1. Black, white and grey for everything. A place with no real state stays black, white or grey.
2. Green, red and amber only for a state. Each of them always comes with a word or an icon too, so the meaning never
   depends on telling colours apart: "Passed", "Failed", "Active", "Paid", "Open", "Error: …", a warning triangle, a
   tick in a circle, an alert circle.
3. No blue and no other hue. Nothing is underlined: links are bold, and the selected menu item and tab are filled
   (dark grey on the dark navigation, black on the content) and bold, with no line under them. Charts are black and grey; none of today's series means success or error,
   so none is green or red.
4. Silver only on: the border of the highlighted card (the current plan); the light fill under chart lines (area charts and
   sparklines). Never on text, never behind text, no chrome or bevel. The logo does not use silver and is unchanged.
5. Notices (confirmations, warnings, one-time secrets, read-only notes) have no border and no
   coloured edge: a light grey fill sets them apart, and only their icon is coloured.
6. Primary buttons stay black, except the confirm button of a destructive dialog: that one is filled red
   (`--danger`, white text, 5.30:1). Dialogs have no border and no coloured line. The button that opens a destructive dialog
   is red (red text and border, filled red on hover).
7. No new dependency: the icons come from `lucide-react`, which was already used.

## Where it is applied

| Place | State | Colour | Word or icon | Class |
| --- | --- | --- | --- | --- |
| Run status (project runs, run page, projects list) | passed / failed / running | green, red, amber dot and border | "Passed", "Failed", "Running" ("Cancelled" stays grey) | `.state-ok`, `.state-danger`, `.state-warn` (`RunStatusPill`) |
| Test outcome (run page) | failed | red dot and border | "Failed" or "Failed: flaky defect" ("Skipped with proof" stays grey) | `.state-danger` (`OutcomePill`) |
| Failed count in the runs table | failed | red number | the number, and "(n flaky)" | `.fail-count` |
| Project setup | on fenvix / waiting | green / amber | "On fenvix", "Pull request open", "Waiting for setup" | `.state-ok`, `.state-warn` (`SetupStatePill`) |
| Defect replay | reproduced / unstable | green / amber | "Replays 10/10" / "Replays 10/10, fingerprints differ" | `.state-ok`, `.state-warn` (`ReplayStatus`) |
| Defect state | open / fixed | red / green | "Open" / "Fixed" | `.state-danger`, `.state-ok` |
| Onboarding step done | done | green circle | a tick and "(done)" for screen readers | `.step[data-done] .step-n` |
| The setup pull request's diff (on a dark box) | removed / added line | red / green, dark-surface shades | "-" and "+" before each line | `.diff-del`, `.diff-add` |
| API key status | active | green dot and border | "Active" | `.state-ok` (`KeyStatus`) |
| Invoice status (Billing) | paid | green dot and border | "Paid" | `.state-ok` (`InvoiceStatus`) |
| Invoice status (Billing) | open, waiting for payment | amber ring and border | "Open" | `.state-warn` (`InvoiceStatus`) |
| New API key created | confirmation | green icon | tick in a circle, "Key … created." | `.callout-success` |
| Sign-in link sent | confirmation | green icon | tick in a circle, "Check your inbox." | `.callout-success` |
| Copy buttons, after copying | done | green tick | "Copied" | `.copy-done` |
| Toasts after an action that worked | success | green icon (dark-surface shade) | tick in a circle, the message | `.toast-success` |
| Toasts after an action that failed | error | red icon and a red edge (dark-surface shade) | alert circle, the message | `.toast-error` |
| Form and dialog errors everywhere | error | red text | "Error: " written before the message | `.error` |
| A field with an error | error | red border | the error below it | `input[aria-invalid="true"]` |
| Load failures (lists, pages, charts, 403, network errors) | error | red text and icon | alert circle, the message | `.message-error` (`Message role="alert"`) |
| Revoke key, Remove member, Revoke invitation | destructive | red text and border; red fill on hover | the word on the button | `.btn-danger` |
| The dialogs of those actions, and Leave organization | destructive | the confirm button filled red with white text, a darker red on hover (the dialog itself has no border or line) | the title and text say what is lost; the button says the action | `.dialog-danger` (`ConfirmDialog danger`) |
| Selected settings tab | — | none (the black fill is enough) | the tab is filled black | — |
| Selected menu item (sidebar and drawer) | — | — | filled dark grey, bold; no line under it | `.nav-link.active` |
| Current plan card (Billing) | — | silver border | "Current plan" | `.plan-current` |
| Area charts and sparklines | — | silver fill under the line | — | `.silver-stop-*` |

## Where there is no colour, and why

| Place | Why it stays black, white or grey |
| --- | --- |
| Revoked API keys | A past action, not a current problem. Hollow grey dot and "Revoked". |
| Counts and the Overview numbers | Quantities, not states. |
| Charts (runs, minutes, cost) | No series means success or error; rule 3 keeps charts black and grey. |
| Primary buttons | Rule 6: primary buttons stay black; only the confirm of a destructive dialog is red. |
| The view-only note ("You have view-only access…", "Only an owner or admin…") | Information about the role, not a state of anything. |
| Role tags (Owner, Admin, Member), tag chips, "Current plan" tag | Labels, not states. |
| Plan feature ticks, "What happens next" bullets | Decoration of a list; a green tick would claim success where there is none. |
| Workspace avatar, logo | Brand; the logo already had its own grey fade and does not use silver. |
| The Google "G" on the sign-in page | Google's own mark, in Google's colours (the one exception to "no other hue"). |
| Focus rings | Black (white on the dark navigation), as before; they show focus, not a state. |

## How it is checked

- `tests/unit/status-colors.test.ts` (in `npm run test:unit`): reads the tokens from `src/styles.css`; checks each
  token's contrast on every surface it can sit on; that the status colours are flat, saturated and green, red and
  amber; that silver is a cool grey gradient that stays visible but quiet; that no other hue appears in the stylesheet
  or the components; that silver is used only on the allowed selectors and never as a text colour; that each state in
  the table above uses its token and no other; that every coloured state has a word or icon; that every destructive
  dialog has a red, white-text confirm button and every other dialog has not; that no dialog has a border or a
  coloured line; and that every toast is marked success or error.
- `scripts/status-colors-checks.mjs` (in `npm run check`, desktop 1440 px and phone 390 px): opens the pages in
  Chromium and reads the colours the browser actually draws for each state, opens the dialogs and reads the colour
  of their confirm buttons, scans every visible element for any saturated colour that is not a status colour or that
  has no word or icon next to it, and checks that nothing leaves the screen or overlaps.
- The existing screenshot checks (`scripts/screenshots.mjs`) run axe, including its colour-contrast rule, on every
  screen and dialog they capture.
