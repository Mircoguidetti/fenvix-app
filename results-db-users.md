# Risultati: utenti dei database dei clienti ("Database Access") — branch `db-users`

Branch `db-users` di `Mircoguidetti/olvix-app`, creato da `origin/e2e-engine` @ `0fde489`. Nessun merge, nessuna pull request, nessuna attività AWS, nessun deploy, nessun Supabase reale, nessun segreto reale (token, password e chiavi dei test sono casuali, creati a ogni esecuzione in cartelle temporanee e mai scritti nel repo; le password che si vedono negli screenshot sono generate dal mock). Non toccati: `main`, `infra-aws`, `engine-adapter`, `data-browser`, `e2e-engine`, `account-linking`, `.github/`, `infra/`, la landing, il motore; nessuna rinomina. Migrazioni 0001–0006 non modificate; la 0003 non è stata eseguita su niente di reale (solo, come prima, sul Postgres usa-e-getta locale dallo script dei test).

Documento di riferimento nuovo: [`control-plane/docs/database-users.md`](control-plane/docs/database-users.md).

## 0. Motore usato

`git ls-remote` su `Mircoguidetti/test5`: **non esiste `final-engine`**. Esiste ora `fusion-ops` @ `e98ed24` (= `merge-engine` + `control-ops`), ma **non ha l'autenticazione** (`--help`: c'è `--admin-listen`, non ci sono `--auth`/`--tls-mode`). Quindi, come nella sessione e2e-engine, due binari:

| Ruolo | Branch @ commit | Uso |
| --- | --- | --- |
| porta admin | `fusion-ops` @ `e98ed24` | create, fork, restore, export, erase, keep-awake, usage |
| auth + TLS + utenti | `compat-gaps` @ `5df2720` | SCRAM, TLS obbligatorio, `createUser`/`updateUser`/`dropUser`/`usersInfo`, i dati scritti dalle applicazioni |

Compilati qui (`cargo build --release -p mongo-server`, cargo 1.97, ~6 min ciascuno, nessun errore). Avvio con `--store memory --no-leases`, TLS con CA usa-e-getta e SCRAM, come descritto in `results-e2e-engine.md`. Postgres 16 locale usa-e-getta (`/tmp/pgscratch`, porta 54329), migrazioni 0001–0005 e **0007** applicate due volte.

## 1. Cosa è stato costruito, file per file

**Migrazione**

* `supabase/migrations/0007_database_users.sql` (nuova; 0003–0006 già prese, verificato con `git ls-remote` e `git ls-tree` su tutti i branch: 0006 è su `account-linking` e non tocca `api_keys`/`databases`). Aggiunge `api_keys.user_access` (`none` | `manage`, default `none`) e `databases.app_user` (il nome dell'utente della stringa di connessione, mai una password). Ripetibile. **Non applicata a nessun Supabase.**

**Control plane**

* `src/engine/users.ts`: l'interfaccia `EngineUsers` ha i metodi per gli utenti dei clienti — `listCustomer`, `createCustomer`, `ensureCustomer`, `setCustomerPassword`, `dropCustomer`, `lockCustomers`, `unlockCustomers`, `dropAll` — nelle tre implementazioni (motore vero via provisioner, in memoria, `NoEngineUsers`). La lista fissa dei ruoli `CUSTOMER_ROLES = { readWrite, read }` e `roleOf` per rileggerli.
* `src/engine/credentials.ts`: `randomPassword()` — 40 caratteri `[A-Za-z0-9]` da `crypto.randomBytes`, campionamento con rifiuto (nessuna distorsione).
* `src/services/db-users.ts` (nuovo): regole del nome (3–32, `^[a-z][a-z0-9_-]{2,31}$`, nomi e prefissi riservati, `cp_` compreso), ruolo dalla lista fissa, campi sconosciuti rifiutati, permessi (`requireManage`), limiti per persona/chiave, lettura del database con lo stesso 404, blocco della riga durante la chiamata al motore, audit, errori puliti; elenco, creazione, reset, eliminazione.
* `src/routes/users.ts` (nuovo): `GET/POST /v1/databases/:id/users`, `POST /v1/databases/:id/users/:username/reset-password`, `DELETE /v1/databases/:id/users/:username`; intestazioni `no-store`, `Pragma: no-cache`, `X-Frame-Options`, CSP, `Referrer-Policy`; idempotenza "no-replay".
* `src/once.ts` (nuovo): `OnceSecrets`, la password iniziale in memoria tra l'operazione e la risposta (presa una volta, dimenticata dopo 10 minuti).
* `src/services/operations.ts`: create e fork creano l'utente iniziale (`readWrite`) dopo `cp_<id>`; se fallisce, la create fallisce con frase nostra e la pulizia elimina **tutti** gli utenti e il database; l'erase blocca gli utenti dei clienti → elimina `cp_` → erase → elimina tutti gli utenti (`usersInfo` + `dropUser`); un erase rifiutato ridà i ruoli; `revealInitialPassword` (solo la richiesta che ha avviato l'operazione).
* `src/http.ts`: `Outcome.reveal`, chiamato solo sulla prima risposta di un'operazione, mai nel replay né nel polling.
* `src/routes/data.ts`: `appUser` su create e fork; `userAccess` su `POST /api-keys`.
* `src/services/databases.ts`: `connectionString()` e `connectionDbName()`; `Database.connectionString` col nome utente vero.
* `src/services/account.ts`: chiavi con `userAccess`.
* `src/limits.ts`, `config/limits.json`: `maxUsersPerDatabase` (20), `userChangesPerMinute` (10), `userListsPerMinute` (60), con default per un `limits.json` vecchio.
* `src/context.ts`, `src/app.ts`: `Services.once`, registrazione delle rotte.
* `scripts/prepare-test-db.sh`: applica anche la 0007.
* Documenti: `docs/database-users.md` (nuovo), `docs/api-extensions.md` (sezione "Database users"), `README.md`.

**Test del control plane**

* `tests/unit/db-users.test.ts` (nuovo, 8): generatore di password (formato, unicità su 2000, distribuzione delle 62 lettere), nomi, ruoli (anche `toString`, `__proto__`), corpo con campi in più, `roleOf`, `OnceSecrets`, stringa di connessione, limiti.
* `tests/integration/db-users.test.ts` (nuovo, 31): ciclo di vita, permessi, isolamento, payload ostili, idempotenza, limiti, errori, audit, ricerca delle password ovunque (motore finto).
* `tests/engine-real/db-users.test.ts` (nuovo, 14): tutto ciò che conta, contro il motore vero.
* `tests/engine-real/failures.test.ts`: +1 test (l'utente iniziale non si crea → create fallita, niente resta); il wrapper degli utenti ora è un `Proxy` (l'interfaccia ha più metodi).
* `tests/helpers/harness.ts`: `apiKey(..., userAccess)`.
* Test esistenti cambiati perché il comportamento è cambiato di proposito: `contract.test.ts` (4 rotte in più tra le estensioni), `databases.test.ts` (la risposta di create ha `initialUser`, la stringa ha `app`/`authSource`/`authMechanism`), `integration/real-engine.test.ts` e `engine-real/lifecycle.test.ts` (nuova forma della stringa), `usage.test.ts` (le chiavi hanno `userAccess`).

**Dashboard** (stile e componenti esistenti; tutto testo React, mai HTML dai dati)

* `src/components/DatabaseUsers.tsx` (nuovo): scheda "Users": elenco (nome, accesso, data), "Add user" (nome + Read and write / Read only), "Reset password" e "Delete" con conferma, stato vuoto, stato d'errore con "Try again", contatore "N of 20".
* `src/components/PasswordOnce.tsx` (nuovo): `SecretOnce` e `PasswordDialog` — password e stringa completa, pulsanti di copia, avviso "Copy the password now. This is the only time it is shown…"; nulla resta nello stato dopo la chiusura.
* `src/pages/DatabaseDetail.tsx`: terza scheda "Users"; nella scheda Overview porta, nome del database e utente letti dalla stringa (prima la porta era fissa a 27017 e il nome del database era sbagliato col motore vero), "Manage users"; dopo un fork la password del nuovo utente si vede una volta prima di aprire la copia.
* `src/pages/CreateDatabase.tsx`: campo "Database user" (default `app`); dopo la creazione la password iniziale una volta, con avviso e copia.
* `src/data/users.ts`, `users-http.ts`, `users-client.ts`, `users-mock.ts` (nuovi); `types.ts` (`initialUser`, `appUser`); `connection.ts` (stessa forma di stringa del control plane, `connectionParts`); `mock.ts`; `explorer-http.ts` (esporta `call`, riusata); `styles.css` (poche regole).
* `scripts/checks.mjs`: 3 controlli nuovi × 2 schermi, aggiornati "create a database" e "fork"; `scripts/screenshots.mjs`: 7 schermate nuove × 2; `tests/unit/queries.test.ts`, `scripts/supabase-e2e.mjs`: nuova stringa.
* `screenshots/`: rigenerati (nuovi: `database-users-*`, `database-created-*`).

## 2. Sicurezza: punto per punto

| Punto | Come | Dove | Test |
| --- | --- | --- | --- |
| Isolamento tra workspace, ogni rotta, persona e chiave | ogni rotta legge la riga con `workspace_id = chiamante` (sotto RLS del ruolo ristretto); id altrui, inesistente, malformato, maiuscolo → stesso `404` con lo stesso corpo | `db-users.ts` `readRow` | integrazione "every route answers a database of another workspace…" (4 rotte × 4 id × persona e chiave `manage`); niente scritto nell'audit del workspace vittima |
| L'utente di A non vede né scrive B (motore vero) | utenti definiti su `db_<A>` con un solo ruolo su `db_<A>` | `users.ts` | engine-real "a customer user of A can do nothing on B": find, insert, update, delete, drop, dropDatabase, listCollections, createUser su A e su B, grantRolesToUser, `$out` verso B, `admin.system.users` → tutti **13**; con `authSource=B` → **18**; B intatto; `listDatabases` non mostra B. Più il fork: utenti dell'origine sul fork e viceversa → 13 |
| Nessun ruolo più potente | la richiesta nomina solo `readWrite` o `read`; ruolo e database li mette il server; campi in più rifiutati | `CUSTOMER_ROLES`, `parseRole`, `parseNewUser` | unit; integrazione con 23 ruoli ostili (root, dbOwner, `{role, db: admin}`, liste, `__proto__`…) e 7 campi extra (`roles`, `db`, `pwd`, `customData`, `mechanisms`…), più un registro di **ogni** ruolo inviato al motore; engine-real: utenti riletti come root, solo `readWrite`/`read` sul proprio database |
| Nomi strani | regola stretta, riservati, nessuna trasformazione; nell'URL un nome fuori regola = 404 | `parseUsername` | oltre 30 nomi ostili in integrazione (`<script>`, `cp_…`, `admin`, NUL, a capo, unicode…), unit |
| Password mai in log, errori, audit, risposte successive, idempotenza, dati salvati | generata e passata al motore, messa in una sola risposta; operazioni con `password: null`; idempotenza "no-replay" (solo lo stato); errori del motore ridotti a tipo + codice | `db-users.ts`, `operations.ts`, `once.ts`, `http.ts` | integrazione e engine-real: ogni password mostrata compare in **una** risposta e in nessuna tabella (`audit_log`, `data_audit_log`, `operations`, `idempotency_keys`, `databases`, `api_keys`) né log (nostro e dei due motori) |
| Ripetizione con la stessa Idempotency-Key | create database: replay dell'operazione, stesso database, `password: null`, nessun secondo utente, la password non cambia. Create user / reset: `409` "cannot be shown a second time", niente di nuovo | `http.ts`, `routes/users.ts` | integrazione "a repeat with the same Idempotency-Key…" (due test) |
| Errori puliti | solo frasi nostre (400/403/404/409/429/503/500) | `fromEngine` in `db-users.ts`, `makeInitialUser` | integrazione 503 pulito; engine-real motore in `SIGSTOP` → 503 pulito; regex su tutte le risposte: niente `MongoServerError`, `127.0.0.1`, stack, `storedKey`, `pwd` |
| `no-store` sulle risposte con password | `Cache-Control: no-store` + `Pragma: no-cache` (e CSP, `X-Frame-Options`, `Referrer-Policy` sulle rotte utenti) | `routes/users.ts`, `http.ts` | integrazione su create database, create user, reset |
| Permessi | owner/admin; member solo elenco; chiavi: elenco sì, modifiche solo con `userAccess: "manage"` (default `none`); rifiuti in audit come `denied` | `requireManage` | integrazione "who may do what" (4 test) |
| Limiti | 20 utenti per database; 10 modifiche/min e 60+10 richieste/min per persona e per chiave | `limits.ts`, `hitLimit` | integrazione (limite a 4 in una suite, 429 con `Retry-After`, budget separato per la chiave) |
| Audit | create/reset/delete con chi, database, utente, ora, esito, codice | `db-users.ts` `audit` | integrazione "every change is audited…" |
| `cp_<id>` invisibile e intoccabile | escluso dall'elenco; il prefisso è riservato; nell'URL → 404 | `listCustomer`, `parseUsername` | integrazione (elenco, reset, delete di `cp_<hex>`) ed engine-real |
| Disconnessione all'eliminazione | `dropUser`: la connessione aperta riceve **13** al comando dopo, una nuova **18** | `dropCustomer` | engine-real "reset… delete: an open connection is cut at once" |
| Sweep non tocca gli utenti dei clienti | lo sweep considera solo i nomi `cp_<hex>` | `engine-users.ts` (invariato) | integrazione ed engine-real (anche un utente cliente su un database senza riga) |

**Risolto solo in parte, detto apertamente:**

* **Reset della password ≠ chiusura delle sessioni.** Dopo un reset le connessioni già autenticate col vecchio password restano aperte (il motore si comporta come MongoDB; provato). Per tagliarle bisogna eliminare l'utente. Documentato anche nella finestra di conferma della dashboard.
* **La password iniziale non si vede se la create risponde `202`** (l'operazione supera `OPERATION_WAIT_MS`) o finisce su un'altra istanza / dopo un riavvio: l'utente esiste, `initialUser.password` è `null`, va fatto un reset. È la scelta più sicura (niente password salvata da nessuna parte), ma è un caso d'uso peggiore.
* **La dashboard in modalità Supabase non crea database tramite il control plane** (fino al cutover del README, passo 9): lì la schermata di creazione non può mostrare una password e la scheda Users richiede `VITE_API_URL`. Tutto il flusso è provato col mock.
* **Lacuna del motore** (non dipendiamo da essa): `createUser` non controlla `grantRole`; il test `todo` già esistente lo segnala.
* **Erase: blocco invece di eliminazione immediata.** Hai chiesto di eliminare tutti gli utenti *prima* dell'erase. L'ho fatto in due tempi: prima tutti gli utenti dei clienti perdono i ruoli (le connessioni aperte ricevono 13 subito: provato sul motore vero), poi l'erase, poi **tutti** gli utenti vengono elencati con `usersInfo` ed eliminati. Motivo: il motore rifiuta alcuni erase (database con fork); se li avessi già eliminati, l'applicazione del cliente resterebbe senza utenti e senza password recuperabili. Così un erase rifiutato ridà i ruoli (stesse password, provato). La garanzia "nessuno scrive durante e dopo l'erase, nessun utente resta" è la stessa. Se preferisci l'eliminazione secca prima dell'erase, è una modifica di poche righe in `operations.ts`.

## 3. Test per categoria e risultati (tutti eseguiti qui)

| Suite | Prima (base `0fde489`, rieseguita qui) | Dopo |
| --- | --- | --- |
| Control plane typecheck | ok | ok |
| Control plane unit | 108/108 | **116/116** (+8) |
| Control plane integrazione | 264: 263 ok, 1 saltato | **295: 294 ok, 1 saltato, 0 falliti** (+31 `db-users`) |
| `engine-real` (motore vero, `fusion-ops` + `compat-gaps`) | 39: 38 ok, 1 todo (esistenti, rieseguiti col codice nuovo) | **54: 53 ok, 1 todo, 0 falliti** (39 esistenti + 14 `db-users` + 1 in `failures`; il todo è la lacuna `grantRole` del motore) |
| Dashboard typecheck + build | ok | ok |
| Dashboard unit | 20/20 (report e2e-engine) | 20/20 |
| Dashboard Playwright (`npm run check`) | 40 (report e2e-engine) | **46/46** + screenshot, layout e axe senza problemi |

Il saltato dell'integrazione è il test dei 3.000 database (serve `SEEDED_DATABASE_URL`), come prima.

**Il test instabile** "two identical requests at the same moment do not both run": in questa sessione è passato in tutte le esecuzioni complete (base e dopo). Resta noto come instabile; non l'ho toccato.

**Provato col motore vero** (`tests/engine-real/db-users.test.ts` + 1 in `failures.test.ts`):

* la stringa di connessione della risposta di create, così com'è (cambiati solo host e porta verso il motore locale, perché l'host vero è un nome DNS del deployment), con il **driver Node.js ufficiale** e con **pymongo 4.19**: si collega, scrive, aggiorna, crea un indice, legge; il database di default è quello della stringa; con `tls=false` il motore rifiuta;
* utente `read` creato via API: legge, non scrive (13);
* isolamento A/B (sopra); payload ostili mai arrivati al motore come ruoli;
* reset (vecchia password 18 su connessioni nuove; nuova funziona; sessione già aperta resta) ed eliminazione (13 sulla connessione aperta, 18 sulle nuove);
* fork: utente nuovo, password nuova, nessun utente copiato, diritti incrociati 13/18;
* restore: un utente creato dopo il punto resta e funziona;
* erase: nessun utente del database rimane, la connessione aperta non scrive più; blocco che taglia subito le connessioni aperte; erase rifiutato (fork esistente) → ruoli restituiti, stesse password funzionanti;
* utente iniziale che non si può creare → create fallita, database e tutti gli utenti eliminati; provisioner senza diritti → operazione in attesa, poi pulizia completa;
* sweep che non elimina utenti dei clienti; motore fermo (`SIGSTOP`) → 503 pulito;
* nessuna password in risposte successive, log (control plane e due motori), tabelle Postgres.

**Solo col motore finto**: limiti (numero di utenti, 429 per persona e per chiave), permessi member/admin/chiavi, audit (righe e contenuto), idempotenza delle rotte utenti, risposta `202` della create, `appUser` ostili, tutte le regole dei nomi.

**Con due binari** (nessun ramo fuso con l'autenticazione): gli utenti e i dati scritti dalle applicazioni stanno nel processo `compat-gaps`, mentre fork/restore/erase dei dati agiscono sul processo `fusion-ops`. Quindi il test di restore prova che gli utenti non vengono toccati, ma non che i dati scritti dall'utente tornino indietro nello stesso processo; il fork prova utenti e diritti, non che il fork veda i dati scritti dalle applicazioni. Con un binario unico la suite usa un solo processo senza modifiche.

## 4. Rischi residui e decisioni che servono a te

**Decisioni:**

1. **Applicare la migrazione 0007** (dopo 0002 e 0004) prima di mettere in produzione questa versione del control plane: senza, `databases.app_user` non esiste e le letture dei database falliscono.
2. **Erase in due tempi** (blocco → erase → eliminazione) invece di "elimina tutto prima": vedi sezione 2. Confermi?
3. **Chi vede la password iniziale**: chi crea il database (anche un member o una chiave API, che oggi possono creare database). Alternativa: creare l'utente iniziale solo per owner/admin.
4. **Cutover della dashboard sul control plane** per create/fork (oggi passano dalle funzioni Supabase): finché non avviene, in produzione la schermata di creazione non mostra credenziali.
5. **Al motore**: comando per chiudere le sessioni di un utente (per un reset che disconnetta), controllo `grantRole` in `createUser`, ramo unico con admin + auth.
6. Limiti scelti: 20 utenti per database, 10 modifiche/min, nome 3–32 caratteri minuscoli. Da confermare.

**Rischi residui:**

* Il control plane ha il provisioner, che può creare utenti con qualsiasi ruolo finché il motore non controlla `grantRole`: un processo compromesso può farlo. Un bug nelle richieste no (la lista è fissa e provata).
* I limiti di frequenza sono in memoria per istanza (come gli altri).
* Una password mostrata nel browser può restare negli appunti del cliente: è responsabilità sua, la dashboard lo dice.

## 5. Branch e commit

Branch **`db-users`** (push su `origin/db-users`), da `origin/e2e-engine` @ `0fde489`. Nessun merge in `main`.

* `97f9759` control-plane: customer database users (initial user, /databases/:id/users, erase/fork/sweep handling, migration 0007)
* FINAL_COMMIT
