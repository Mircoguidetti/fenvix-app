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
| `--success` | `#067a3a` | ready, awake, active, paid, done, confirmed |
| `--danger` | `#d6140a` | errors, blocked addresses, failures, actions that cannot be undone |
| `--warning` | `#a15c00` | starting, in progress, needs attention |
| `--success-on-dark` | `#3ddc84` | the same on a dark surface (toasts) |
| `--danger-on-dark` | `#ff6a5c` | the same on a dark surface (toasts) |
| `--warning-on-dark` | `#ffb020` | the same on a dark surface (defined, not used yet: no amber toast exists) |
| `--silver-1` | `#c4c8ce` | silver, light grey |
| `--silver-2` | `#f4f5f7` | silver, near white |
| `--silver-3` | `#7c828b` | silver, mid grey |
| `--silver` | `linear-gradient(90deg, silver-1, silver-2 50%, silver-3)` | the silver line |

The status colours are flat: a single hex value each, no gradient, no tint behind text.

### Contrast

Contrast ratios (WCAG 2), computed by `tests/unit/status-colors.test.ts`:

| Colour | on `--bg` #ffffff | on `--page` #fafafa | on `--surface` #f6f6f7 | on `--surface-2` #efeff1 |
| --- | --- | --- | --- | --- |
| `--success` | 5.45 | 5.22 | 5.05 | 4.75 |
| `--danger` | 5.30 | 5.08 | 4.91 | 4.61 |
| `--warning` | 5.19 | 4.97 | 4.81 | 4.52 |

| Colour | on `--nav-bg` #0a0a0b (also the toast) | on `--nav-hover` #17171a | on `--nav-active` #202024 |
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
   depends on telling colours apart: "Awake", "Active", "Paid", "Open", "Error: …", "Blocked until …", "Unsaved
   changes", a warning triangle, a tick in a circle, an alert circle, a "blocked" sign.
3. No blue and no other hue. Links stay underlined. The selected menu item stays filled (dark grey on the dark
   navigation) with a silver underline. Charts are black and grey; none of today's series means success or error,
   so none is green or red.
4. Silver only on: the thin line under the selected tab (database tabs, settings tabs) and under the selected menu
   item; the border of the highlighted card (the current plan); the light fill under chart lines (area charts and
   sparklines). Never on text, never behind text, no chrome or bevel. The logo does not use silver and is unchanged.
5. Primary buttons stay black, except the confirm button of a destructive dialog: that one is filled red
   (`--danger`, white text, 5.30:1). Dialogs have no border and no coloured line. The button that opens a destructive dialog
   is red (red text and border, filled red on hover), except "Restore to a point in time", which stays neutral.
6. No new dependency: the icons come from `lucide-react`, which was already used.

## Where it is applied

| Place | State | Colour | Word or icon | Class |
| --- | --- | --- | --- | --- |
| Database state badge (list, detail header, status card) | awake | green dot and border | "Awake" | `.state-awake` |
| API key status | active | green dot and border | "Active" | `.state-ok` (`KeyStatus`) |
| Invoice status (Billing) | paid | green dot and border | "Paid" | `.state-ok` (`InvoiceStatus`) |
| Invoice status (Billing) | open, waiting for payment | amber ring and border | "Open" | `.state-warn` (`InvoiceStatus`) |
| New API key created | confirmation | green border | "Key … created." | `.callout-success` |
| Sign-in link sent | confirmation | green border | "Check your inbox." | `.callout-success` |
| Copy buttons, after copying | done | green tick | "Copied" | `.copy-done` |
| Toasts after an action that worked | success | green icon (dark-surface shade) | tick in a circle, the message | `.toast-success` |
| Toasts after an action that failed | error | red icon and a red edge (dark-surface shade) | alert circle, the message | `.toast-error` |
| Data tab: waking a sleeping database | in progress | amber border and icon | "Waking the database…", spinning icon | `.waking` |
| Network: Data Explorer not trusted by the server | warning | amber border and icon | warning triangle, the explanation | `.once-warning` |
| Network: the engine checks a list different from the saved one | warning | amber border and icon | warning triangle, "different list" | `.callout-warning` |
| Network: the engine's list could not be checked | warning | amber icon | warning triangle, the explanation | `.message-warning` |
| Network: the server does not check sign-ins yet | warning | amber icon | warning triangle, the explanation | `.message-warning` |
| Network: unsaved changes to the list | needs attention | amber border | "Unsaved changes" | `.tag-warning` |
| Network: save dialog, "FENVIX cannot see your address" | warning | amber border and icon | warning triangle | `.once-warning` |
| Database user: "Copy the password now" | warning | amber border and icon | warning triangle | `.once-warning` |
| Reset password dialog: "Applications using the old password will stop working." | warning | amber border and icon | warning triangle | `.once-warning` (the dialog is not destructive; its confirm stays black) |
| Network: blocked addresses | blocked | red text and icon | "Blocked until …", blocked sign | `.blocked-until` |
| Form and dialog errors everywhere | error | red text | "Error: " written before the message | `.error` |
| A field with an error | error | red border | the error below it | `input[aria-invalid="true"]` |
| Load failures (lists, pages, charts, the engine not answering, 403, network errors) | error | red text and icon | alert circle, the message | `.message-error` (`Message role="alert"`) |
| Erase (database page and bulk bar), Delete user, Delete document, Revoke key, Remove member, Revoke invitation, Clear list | destructive | red text and border; red fill on hover | the word on the button | `.btn-danger` |
| The dialogs of those actions, Leave organization, and Restore to a point in time | destructive | the confirm button filled red with white text (the dialog itself has no border or line) | the title and text say what is lost; the button says the action | `.dialog-danger` (`ConfirmDialog danger`) |
| Selected database tab | — | silver line under it | the tab is also filled black | `::after` |
| Selected settings tab | — | none (the black fill is enough) | the tab is filled black | — |
| Selected menu item (sidebar and drawer) | — | silver line under it | the item is also filled and bold | `.nav-link.active::after` |
| Current plan card (Billing) | — | silver border | "Current plan" | `.plan-current` |
| Area charts and sparklines | — | silver fill under the line | — | `.silver-stop-*` |

## Where there is no colour, and why

| Place | Why it stays black, white or grey |
| --- | --- |
| Asleep databases | Sleeping is normal and costs less; it is not a problem and not in progress. Hollow grey dot and "Asleep". |
| Revoked API keys | A past action, not a current problem. Hollow grey dot and "Revoked". |
| "Kept awake" | A setting, not a state. |
| Counts (databases, awake, asleep, kept awake) and the Overview numbers | Quantities, not states. |
| The awake/asleep timeline and the "Awake databases" chart | Awake time is a quantity (it drives the bill), not a health signal; rule 3 keeps charts black and grey. |
| Requests, storage and cost charts | No series means success or error. |
| Primary buttons, including the confirm button of the Reset password dialog | Rule 5: primary buttons stay black; only the confirm of a destructive dialog is red. |
| The "Restore to a point in time" and "Reset password" buttons | Neutral by choice: Restore opens a red dialog that says what is lost; Reset password opens a plain dialog with an amber warning. |
| "Remove" next to an entry of the IP allowlist | It only changes the draft; nothing happens until "Save list", and "Discard changes" undoes it. |
| Fork, Export, Unblock, Apply again | Recoverable or constructive actions. |
| Save dialog of the IP allowlist | Saving is not destructive; its warning paragraph is amber. |
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
  dialog (Restore included) has a red, white-text confirm button and every other dialog has not; that no dialog has
  a border or a coloured line;
  that Restore and Reset password open from neutral buttons and that the Reset password dialog has its amber warning
  with an icon; and that every toast is marked success or error.
- `scripts/status-colors-checks.mjs` (in `npm run check`, desktop 1440 px and phone 390 px): opens the pages in
  Chromium and reads the colours the browser actually draws for each state, opens the dialogs and reads the colour of their confirm buttons (red with white text in Erase, Restore, Revoke
  and Delete user; black in Fork and Reset password, where it also checks the amber warning), saves an allowlist to
  see the green toast, wakes a sleeping database to see the amber notice, scans every visible element for any
  saturated colour that is not a status colour or that has no word or icon next to it, and checks that nothing leaves
  the screen or overlaps.
- The existing screenshot checks (`scripts/screenshots.mjs`) run axe, including its colour-contrast rule, on every
  screen and dialog they capture.

The mock backend gained one state for these checks: in `src/data/network-mock.ts`, `db_0004`'s server does not trust
the Data Explorer, so the amber warning can be seen and tested.
