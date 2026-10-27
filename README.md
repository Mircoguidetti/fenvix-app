# FENVIX dashboard (olvix-app)

Customer dashboard for FENVIX. Static React app (Vite): no server runtime, no database, no auth provider. All data is mock data under a "Sample data" label. Documentation lives in the olvix-landing repository.

```bash
npm install
npm run dev                      # local dev server
npm run build                    # static output in dist/
npm run preview                  # serve dist/ at http://localhost:4173
npm run screenshots              # needs the preview server running; writes screenshots/
```

Data access goes through `src/data/client.ts`; the mock lives in `src/data/mock.ts`. To go live, implement `DataClient` and export it from `src/data/index.ts`.
