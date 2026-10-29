# Risultati: candidato per main (branch `release-candidate`)

Branch `release-candidate` di `Mircoguidetti/olvix-app`, creato da `origin/cp-engine-round2` e unito con `origin/infra-grants` (merge, non rebase). Nessun merge in `main`, nessun force-push, nessuna attività AWS (ogni comando di test senza variabili `AWS_*`; `cdk synth` con `env -i` e proxy verso `127.0.0.1:9`), nessun segreto nei file, nessuno screenshot aggiunto da questo lavoro. Altri branch non toccati; `account-linking` fuori da questo lavoro. Pushato solo `release-candidate`.

## 1. Commit esatti

| cosa | commit | come verificato |
|---|---|---|
| `origin/main` | `34b2e41` | `git rev-parse --short origin/main` dopo `git fetch origin` |
| `origin/cp-engine-round2` | `9db58b1` (33 commit sopra main, 0 indietro) | `git rev-list --left-right --count origin/main...origin/cp-engine-round2` → `0 33` |
| `origin/infra-grants` | `8fa0287` (20 commit sopra main, 0 indietro) | stesso comando → `0 20` |
| punto di incontro | `0fde489` | `git merge-base origin/cp-engine-round2 origin/infra-grants` |
| merge in `release-candidate` | `bfba994` "Merge infra-grants (8fa0287) into release-candidate" (genitori `9db58b1`, `8fa0287`) | `git log -1` |
| questo report | il commit successivo a `bfba994` su `release-candidate` | `git log` |
| motore (test5) | `3bcd7e5` (branch `engine-round2`, punta `561f05d`) | `git checkout 3bcd7e5` nel clone di test5, `git log -1` |

## 2. Merge e conflitti

**Nessun conflitto.** `git merge --no-ff origin/infra-grants` è terminato senza conflitti.

Come verificato:
* File cambiati dal punto di incontro `0fde489`: 27 commit e 191 file di `cp-engine-round2`, 14 commit e 34 file di `infra-grants` (`git diff --name-only 0fde489 <branch>`). **Intersezione vuota** (`comm -12` dei due elenchi ordinati).
* I 34 file di `infra-grants` sono tutti in `infra/`, più `.github/workflows/release-control-plane.yml` e `docs/deploy-checklist.md` (`git diff --stat 0fde489 origin/infra-grants`).
* Dopo il merge: `git diff --name-only origin/cp-engine-round2 HEAD` = esattamente i 34 file di `infra-grants`; `git diff --name-only origin/infra-grants HEAD` = esattamente i file di `cp-engine-round2`. Quindi `control-plane/`, `src/`, `supabase/`, `tests/`, `scripts/` sono identici byte per byte a `cp-engine-round2`, e `infra/`, il workflow e la checklist sono identici a `infra-grants`. Nessuna risoluzione è stata necessaria, quindi nessuna scelta tra le due parti.

**Migrazioni** (`git ls-tree --name-only HEAD supabase/migrations/`):
`0001_init`, `0002_control_plane`, `0003_close_dashboard_write_path`, `0004_data_explorer`, `0005_engine_users`, `0007_database_users`, `0008_organizations`, `0009_ip_allowlist`. In ordine, nessun doppione (`ls | cut -c1-4 | uniq -d` vuoto), `0006` assente come previsto. `infra-grants` ha solo 0001–0005, identiche a quelle di `cp-engine-round2` (nessun file di `supabase/` nel diff dal punto di incontro).

## 3. Workflow di rilascio del control plane

`.github/workflows/release-control-plane.yml` è presente ed è identico a quello di `infra-grants` (`git diff origin/infra-grants HEAD -- .github` vuoto). È l'unico workflow del repository. Coerenza con `infra/`, controllata leggendo i file:

| punto | workflow | infra | esito |
|---|---|---|---|
| nome dell'immagine | `IMAGE_REPO: fenvix-control-plane` | `CONTROL_PLANE_IMAGE_REPO = 'fenvix-control-plane'` (`lib/artifacts.ts:34`) | uguale |
| chiave S3 | `control-plane/$version/$ARCH/control-plane.tar.gz` | `controlPlaneKey` (`lib/artifacts.ts:30`) e `fetch "control-plane/$ver/$ARCH/control-plane.tar.gz"` (riga 128) | uguale |
| architetture | `x86_64`, `aarch64` | `type Arch = 'x86_64' \| 'aarch64'` (`lib/artifacts.ts:19`) | uguale |
| formato | `docker save \| gzip`, SHA-256 dell'archivio | `docker load` dopo il controllo di `controlPlaneSha256` (`lib/artifacts.ts`) | coerente |
| segreti GitHub | `AWS_PUBLISH_ROLE_ARN`, `ARTIFACTS_BUCKET` | output `PublishControlPlaneRole…` e `ArtifactsBucketName` (`lib/fenvix-stack.ts:226, 287`) | coerente |
| fiducia OIDC | ruolo assunto con il token del workflow | `repo:Mircoguidetti/olvix-app:ref:refs/heads/main` (unico valore, letto nel template sintetizzato) da `controlPlaneRepoBranches: "main"` in `cdk.json` | solo `main` |
| regione | `AWS_REGION: eu-west-1` | `"regions": "eu-west-1"` in `cdk.json` | uguale |
| `actions/checkout` | SHA `3d3c42e5…` commentato `v7.0.1` | — | `git ls-remote https://github.com/actions/checkout refs/tags/v7.0.1` → stesso SHA |
| sintassi | — | — | YAML valido (`yaml.safe_load`) |

## 4. Migrazioni 0001→0009 da zero

Postgres 16.15 locale (`psql --version`), database vuoti appena creati.
* **Script di preparazione dei test** (`control-plane/scripts/prepare-test-db.sh`, `TEST_DATABASE_URL=postgresql://postgres@localhost:5432/cp_scratch`): esito 0, "0001 to 0005, 0007, 0008 and 0009 applied twice". L'elenco dei file nello script coincide con la cartella (`diff` dei due elenchi vuoto).
* Lo script nasconde l'output delle migrazioni, quindi le ho riapplicate **una per una** su un secondo database vuoto (`cp_mig`, dopo `supabase/tests/local-stub.sql`) con `ON_ERROR_STOP=1`: primo passaggio, tutte e 8 esito 0 e nessuna riga `ERROR`; secondo passaggio (ripetibilità), tutte e 8 esito 0. Risultato: 16 tabelle in `public`.
* Test di integrazione sul database `cp_scratch`: vedi sezione 5 (353: 352 ok, 0 falliti).

## 5. Test: prima e dopo

"Prima" = numeri dei report (`results-cp-engine-round2.md` sezioni 4 e 8, `infra/report-infra-align.md` sezione 12.6); per la dashboard, l'ultimo numero registrato (`control-plane/docs/network-allowlist.md`, branch network-tab). "Dopo" = eseguito ora su `release-candidate` (`bfba994`).

| suite | prima | dopo | differenza |
|---|---|---|---|
| control plane `tsc --noEmit` | ok | **ok** (esito 0) | nessuna |
| control plane unit (`node --test`, non jest) | 140/140 | **140/140** | nessuna |
| control plane integrazione (Postgres 16 locale) | 353: 352 ok, 1 saltato | **353: 352 ok, 0 falliti, 1 saltato** | nessuna |
| engine-real, profilo memory, `--grantable-roles=read,readWrite` | 89: 88 ok, 1 saltato | **89: 88 ok, 0 falliti, 1 saltato** | nessuna |
| engine-real, profilo production (MinIO, lease, `--log-commands`) | 89: 89 ok | **89: 89 ok, 0 saltati** | nessuna |
| infra `tsc --noEmit` | ok | **ok** | nessuna |
| infra jest | 176 ok + 1 saltato (177, 13 suite) | **176 ok + 1 saltato (177, 13 suite)** | nessuna |
| infra user data (`USER DATA SIZE`) | 15.712 byte (dominio lungo 15.792) | **15.712 (15.792)** | nessuna |
| infra `cdk synth --quiet`, senza e con versioni | esito 0, 2 W3010 | **esito 0, 2 W3010** in entrambi | nessuna |
| dashboard `tsc --noEmit` | — | **ok** | — |
| dashboard unit | 32/32 (network-tab) | **48/48** | +16 = `tests/unit/status-colors.test.ts` di ui-status (16 ok, eseguito da solo) |
| dashboard build (`npm run build`) | — | **ok** (solo l'avviso Vite sui chunk > 500 kB) | — |
| dashboard Playwright (`npm run check`, backend mock) | 48 + 10 + 12 | **48 + 10 + 12 + 24 = 94 ok, 0 falliti** | +24 = `scripts/status-colors-checks.mjs` di ui-status |

Dettagli e come verificato:
* Il saltato dell'integrazione: la riga di sintesi di `node --test` dice `skipped 1`; nel log compaiono 3 righe `﹣` (il test dei 3.000 database, `SEEDED_DATABASE_URL`, e due test di `explorer-real-engine.test.ts` che chiedono `DATA_ENGINE_TEST_ENDPOINT`). È lo stesso conteggio del report precedente; non ho indagato perché la sintesi ne conti uno.
* engine-real memory: il saltato è "b. at run time" (esiste solo nel profilo production); il test pymongo passa (`✔ the same connection string works with pymongo`). In production passano entrambi.
* `cdk synth`: CLI vera, `env -i`, proxy verso `127.0.0.1:9`, impostazioni obbligatorie con valori di esempio (`budgetEmail=ops@example.com`, `baseDomain=fenvix.dev`, `acmeEmail=acme@example.com`, `dashboardOrigins=https://console.fenvix.dev`; con versioni anche versioni e SHA-256 finti). Boot script decodificato dal template (base85 + gzip): `--grantable-roles=read,readWrite` esattamente una volta, nessun `dbAdmin`; nel boot script e nel template nessun `AKIA…`, `-----BEGIN`, `PRIVATE KEY`, `password=`, `MONGO_ADMIN_TOKEN=`, token GitHub. I valori `-c` esatti del round precedente non erano scritti nel report: questi sono miei.
* Dashboard: i file della dashboard sono identici a `cp-engine-round2` (`git diff --quiet origin/cp-engine-round2 HEAD -- src scripts tests public index.html package.json package-lock.json vite.config.ts tsconfig.json supabase`). `npm run check` rigenera gli screenshot tracciati: li ho ripristinati con `git checkout -- screenshots` e cancellato i 4 nuovi non tracciati; `git status` vuoto prima del commit.

**Motore.** test5 `main-candidate` (`f306ba5`) **non è finito**: nessun `results-main-candidate.md` (c'è solo `results-main-candidate/imds_outage.txt`), ultimo commit di oggi. Ho usato **`engine-round2`**, commit del motore `3bcd7e5`, come nel round precedente. Il codice del motore è comunque identico: `git diff --stat 3bcd7e5 origin/main-candidate` escludendo `results*`, `tools`, `ctl-tests`, `.github` è vuoto. Compilazione `cargo build --release --workspace` (cargo 1.97.0): 10 min 48 s, esito 0. `--help` del binario: `--grantable-roles` presente, `--auth-fail-max` default 100, `--auth-fail-max-per-db` 5.
* **SHA-256 di `mongo-server`: `253233d0c59af22f57a223b13075754fc17ce9fde58ee1fa662008d0ed237032`**, diverso da quello del round precedente (`48b82572…`, stesso commit e stesso comando). Il report precedente aveva già trovato hash diversi tra macchine/percorsi (decisione 5 di quel report); la build non è riproducibile bit per bit tra ambienti.

**Dipendenze esterne, fuori dal repo** (in `/home/user/deps`): MinIO compilato da sorgenti (`go install github.com/minio/minio@latest`, go 1.24.7), pymongo 4.19.0 in un venv, gitleaks 8.30.1 (`go install`). Credenziali MinIO casuali in un file `0600` fuori dal repo, passate solo alla suite; dopo la suite: nessuno dei due valori in nessun file del checkout (`grep -rF`, `node_modules` esclusa) né nei log; nessun bucket rimasto; MinIO fermato e file delle credenziali cancellato.

## 6. Diff completo rispetto a main

`git diff --name-status origin/main HEAD`: 261 file (154 aggiunti, 107 modificati).

* **Immagini: TROVATE.** 46 PNG in `screenshots/` (18 aggiunti, 28 modificati), tutti binari. Non vengono dal merge né da questo lavoro: vengono da due commit della catena della dashboard, `f0131a1` (db-users, 28 PNG) e `29351aa` (navbar-fix, 38 PNG, compresi `screenshots/sidebar/before|after/`) (`git log origin/main..HEAD -- screenshots`). Non li ho toccati: **decisione 1** sotto. Nessun'altra immagine (ricerca per estensione: png/jpg/gif/webp/svg/ico/pdf/zip/pem/key/…).
* **Segreti: nessuno.** Stessa scansione dei round precedenti:
  * gitleaks 8.30.1 sulla storia `origin/main..HEAD` (48 commit, 47 senza il merge; gitleaks ne riporta 46 analizzati, non ho indagato quale salta) e, separatamente, sui 215 file nuovi o modificati (contenuto attuale, PNG esclusi): 6 segnalazioni `generic-api-key`, **tutte falsi positivi** letti riga per riga: `authSource: "db_0123abcd…"` (nome di database finto, `engine-users.test.ts` righe 48 e 97), l'id di zona inventato `Z0123456789ABC` (`infra/test/user-data.test.ts`, già noto dal report infra), `secretValue: "IDEMPOTENT-SECRET-123"` (marcatore di test, `explorer.test.ts:221`).
  * regex: chiavi AWS (`AKIA|ASIA…`), secret AWS, chiavi private PEM, token GitHub/Slack/Google, JWT, `sk_live_`: 0. URL con password: 4, tutti segnaposto (`postgresql://u:p@`, `https://u:p@`, `mongodb://app:Secret123@` in test, `change-me-local-only` in `control-plane/.env.example`). Valori delle credenziali MinIO: 0.
  * L'id dell'account AWS (`865859654353`) compare in 14 file di `infra/`; era già in main (`cdk.json`, `deploy-policy.json`, `README.md`, test) ed è stato accettato nel round infra (sezione 11). Nuovi file che lo contengono: 5 test e il report infra.
* **File estranei: nessuno.** Le aggiunte fuori dalle cartelle di codice sono: il workflow, `control-plane/.env.example`, `docs/deploy-checklist.md`, `docs/status-colors.md`, `infra/report-infra-align.md`, `infra/scripts/gen-acme-requirements.py` e i 6 report `results-*.md`. Nessun log, `node_modules`, `cdk.out`, `dist`, `.env`, `.orig`/`.rej`, `__pycache__` (ricerca sui nomi del diff e su `git ls-files`).

## 7. Dipendenze da branch diversi da main

* `control-plane/Dockerfile`: **nessun riferimento a branch** (letto per intero: `node:22-slim`, `npm ci --omit=dev`, copia di `config` e `src`, `CMD node src/server.ts`). Il codice di `control-plane/src` non importa file fuori dalla cartella (ricerca di `../../`: nessun risultato), quindi il contesto `control-plane` basta.
* Workflow: l'unico workflow (`release-control-plane.yml`) ha solo `workflow_dispatch`, nessun `push`/`pull_request`/`branches`; `ref` è un input libero (commit, tag o branch). La fiducia AWS è solo per `refs/heads/main` (`cdk.json` → template, sezione 3). Nessun nome di branch del lavoro (`cp-engine*`, `infra-*`, `release-candidate`, `engine-round2`, `main-candidate`) nel Dockerfile o nel workflow (`grep`).
* In `infra/cdk.json`: `engineRepoBranches: "main"` e `controlPlaneRepoBranches: "main"`.

## 8. Cosa NON ho potuto verificare

* **Build dell'immagine Docker del control plane.** Ho avviato `dockerd` (Docker 29.9.2). Docker Hub ha risposto `429 Too Many Requests` per `node:22-slim` (due tentativi); ho preso la stessa immagine da `mirror.gcr.io/library/node:22-slim` (Node 22.23.4, amd64). La build si è poi fermata a `RUN npm ci --omit=dev`: dal container di build npm non raggiunge il registro (`npm error Exit handler never called!` dopo 70 s): il proxy del sandbox ha un certificato che il container non ha, e disattivare la verifica TLS non è accettabile. **Verifica sostitutiva** (non è la build): copia del contesto come nel Dockerfile (`package.json`, `package-lock.json`, `config`, `src`) in una cartella fuori dal repo, `npm ci --omit=dev` (77 pacchetti, esito 0, Node 22.22.0), avvio con lo stesso comando del `CMD` con `NODE_ENV=production`, driver fake e il Postgres di prova; il comando del `HEALTHCHECK` → `healthz 200`. Non verificati: l'immagine vera, l'architettura `aarch64`, il comando `docker save | gzip` e la dimensione dell'archivio.
* Il workflow su GitHub Actions (non eseguito: richiede di lanciarlo da GitHub, e con `publish=true` anche AWS).
* AWS, S3 vero (solo MinIO locale), IPv6 da un client vero, carico: come nei round precedenti.
* Identità bit per bit del binario del motore con quello del report del motore (vedi sezione 5).

## 9. Decisioni che servono a te

1. **Screenshot nel diff verso main.** Il candidato porta 46 PNG in `screenshots/` (commit `f0131a1` e `29351aa` della catena; main traccia già 41 PNG in `screenshots/`). La regola "nessuna immagine nel diff" oggi **non è rispettata**. Opzioni: (a) li lasci (aggiornano schermate che main ha già); (b) aggiungo su `release-candidate` un commit che riporta `screenshots/` allo stato di main (28 modificati tornano come in main, 18 nuovi tolti), così il diff non ha immagini ma le schermate in main restano vecchie; (c) tolgo `screenshots/` dal repository e la metto in `.gitignore` (si rigenerano con `npm run screenshots`). Non ho scelto io perché cambia cosa finisce in main. Io farei (c).
2. **Motore.** Ho usato `engine-round2` (`3bcd7e5`) perché `main-candidate` non ha il report finale. Il codice del motore è identico; se vuoi la conferma formale su `main-candidate` quando è chiuso, si rifà solo la suite engine-real (qui la sola compilazione ha richiesto 10 min 48 s).
3. **Immagine del control plane.** Non verificata qui (sezione 8). Primo controllo consigliato dopo il merge: lanciare `release-control-plane` con `publish = off` (build e SHA-256, nessun upload). La fiducia AWS accetta solo `main`: per pubblicare va lanciato da `main`.

## 10. Comandi principali (per ripetere)

```bash
git fetch origin && git checkout -b release-candidate origin/cp-engine-round2 && git merge --no-ff origin/infra-grants
cd control-plane && TEST_DATABASE_URL=postgresql://postgres@localhost:5432/cp_scratch bash scripts/prepare-test-db.sh
npx tsc --noEmit && npm run test:unit && TEST_DATABASE_URL=... npm run test:integration
ENGINE_E2E_BIN=<test5 3bcd7e5>/mongo-server ENGINE_E2E_GRANTABLE_ROLES=read,readWrite ENGINE_E2E_PYTHON=<venv>/bin/python TEST_DATABASE_URL=... npm run test:engine-real
# production: in più ENGINE_E2E_PROFILE=production ENGINE_E2E_S3_ENDPOINT=http://127.0.0.1:9000 ENGINE_E2E_S3_ACCESS_KEY/SECRET_KEY (MinIO locale) ENGINE_E2E_S3_REGION=eu-central-1
cd ../infra && npx tsc --noEmit && npx jest && env -i PATH="$PATH" HOME="$HOME" HTTPS_PROXY=http://127.0.0.1:9 npx cdk synth --quiet -c ...
cd .. && npm run typecheck && npm run test:unit && npm run build && npm run check && git checkout -- screenshots
```
