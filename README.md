# FENVIX dashboard (olvix-app)

Customer dashboard for FENVIX. Static React app (Vite): no server runtime, no database, no auth provider. Data comes from a mock behind `DataClient`, sign-in from a mock behind `SessionClient`. Documentation lives in the olvix-landing repository.

Pages: Overview (fleet at a glance), Databases (list, tags, grouping, bulk actions), the database page (connection string, tags, activity, fork, restore, export, erase, keep awake), Usage (per database or per tag, CSV export), Billing (month to date, invoices, payment method, plans), API keys and Settings.

```bash
npm install
npm run dev                      # local dev server
npm run build                    # static output in dist/
npm run preview                  # serve dist/ at http://localhost:4173
npm run check                    # build, serve, run the behaviour checks and regenerate screenshots/
npm run checks                   # behaviour checks only (needs the preview server running)
npm run screenshots              # screenshots and layout/accessibility checks only (needs the preview server)
```

`ONLY=billing npm run checks` runs a single behaviour check while working on it.

## Going live

- Data: the screens only talk to `DataClient` (`src/data/client.ts`). The mock is `src/data/mock.ts`. Write an HTTP implementation and export it from `src/data/index.ts`.
- Sign-in: the same for `SessionClient` (`src/session/client.ts`, mock in `src/session/mock.ts`, picked in `src/session/index.ts`).
- Every method maps to one endpoint in [`docs/control-plane-api.md`](docs/control-plane-api.md).

The mock keeps the session in this browser's localStorage; its data lives in memory and resets on reload.

## Look

One fixed theme: a near-black navigation column beside white content, blacks, whites and greys only, Schibsted Grotesk and JetBrains Mono, and the black-to-grey gradient of the logo mark. Nothing animates. Tables become stacked rows on phones and the navigation becomes a drawer.
