# FENVIX dashboard (olvix-app)

Customer dashboard for FENVIX. Static React app (Vite): no server runtime, no database, no auth provider. All data is mock data under a "Sample data" label. Documentation lives in the olvix-landing repository.

What it does: a fleet of databases (the mock has about 3,000 over 200 customers) with tags, tag filters, grouping by a tag key, bulk actions, per-database actions (fork, restore, export, erase, keep awake), usage per database and per tag with CSV export, billing, API keys, settings and a sign-in page.

```bash
npm install
npm run dev                      # local dev server
npm run build                    # static output in dist/
npm run preview                  # serve dist/ at http://localhost:4173
npm run check                    # build, serve, run the behaviour checks and regenerate screenshots/
npm run checks                   # behaviour checks only (needs the preview server running)
npm run screenshots              # screenshots and layout/accessibility checks only (needs the preview server)
```

## Going live

- Data: the screens only talk to `DataClient` (`src/data/client.ts`). The mock is `src/data/mock.ts`. Implement `DataClient` over HTTP and export it from `src/data/index.ts`.
- Sign-in: the same for `SessionClient` (`src/session/client.ts`, mock in `src/session/mock.ts`, picked in `src/session/index.ts`). No real auth provider is included.
- The API each method needs is described in [`docs/control-plane-api.md`](docs/control-plane-api.md).

The mock sign-in keeps its session in this browser's localStorage; mock data lives in memory and resets on reload.
