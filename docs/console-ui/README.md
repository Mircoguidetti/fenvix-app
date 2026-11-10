# Console UI: screenshots

The dashboard with the look of the console mockups (fenvix-brain `sessions/2026-11-10-console-ui/`): the landing's ink and
paper, Schibsted Grotesk and JetBrains Mono, a light and a dark theme with a button in the top bar, and the two-bar
navigation (area icons that widen on hover, then the pages of what is open). Only the look changed: every page, route,
call and rule is the one it was.

Every screen at 1440 and 390 pixels, light and dark: `<screen>-<width>-<theme>.png`. `menu-open-390-*.png` is the phone
menu. Taken from the mock backend (`VITE_DATA_BACKEND=mock`), so the names and numbers are the mock's.

Run it locally:

```bash
npm ci
VITE_DATA_BACKEND=mock npm run dev
```
