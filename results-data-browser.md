# Risultati: Data Explorer di FENVIX (branch `data-browser`)

Branch `data-browser` di `Mircoguidetti/olvix-app`, creato da `origin/engine-adapter` @ `646b694`. Nessun merge, nessuna pull request, nessuna attività AWS, nessun deploy, nessun segreto reale. Non toccati: `main`, `control-plane` (branch), `infra-aws`, `engine-adapter`, `.github/`, `infra/`, la landing; nessuna rinomina.

Il modello di sicurezza completo è in [`control-plane/docs/data-explorer-security.md`](control-plane/docs/data-explorer-security.md). Qui: cosa c'è, come è stato verificato, cosa resta aperto.

## 1. Cosa è stato costruito, file per file

### Control plane (`control-plane/`)

| File | Cosa |
| --- | --- |
| `src/engine/data.ts` (nuovo) | Interfaccia `DataClient` (listCollections, estimatedCount, find, findOne, insertOne, replaceOne, deleteOne), `DataError` (solo tipo + codice numerico, mai il messaggio del motore), `DataTarget` (oggetto congelato con simbolo privato, creabile solo da `dataTarget()`), `targetDbName()`: l'unica funzione che sceglie il nome del database (`db_<id>`). |
| `src/engine/data-mongo.ts` (nuovo) | `MongoDataClient` con il driver ufficiale `mongodb` 6.21: un client per regione, pool ≤ 5, connessioni chiuse dopo 30 s inattive, client intero chiuso dopo 60 s senza richieste, TLS + SCRAM da env (credenziali in `auth`, mai nell'URL), `maxTimeMS` + scadenza lato client, `mapError()` che riduce ogni errore a tipo + codice. |
| `src/engine/data-fake.ts` (nuovo) | `FakeDataClient` in memoria, stessa interfaccia: documenti come BSON, matcher degli operatori ammessi, iniezione di ritardi/guasti, simulazione del risveglio, registro dei database toccati (per i test di isolamento). |
| `src/explorer/rules.ts` (nuovo) | Le whitelist: nomi di collezione, filtri (operatori ammessi, profondità, chiavi, dimensione, regex), sort, proiezione, documenti, `_id` nell'URL, conversione Extended JSON involucro per involucro. |
| `src/services/explorer.ts` (nuovo) | Logica: `resolveTarget` (unico punto in cui nasce un `DataTarget`, dal record Postgres del workspace), `requireWrite` (ruoli e chiavi), audit, log, scadenze, mappatura errori, versione dei documenti, filtro di concorrenza. |
| `src/routes/explorer.ts` (nuovo) | Le 6 rotte sotto `/v1/databases/:id/data/collections`, intestazioni di sicurezza in un plugin proprio, limiti al minuto per persona e per chiave. |
| `src/config.ts` | `DataSettings` + `dataSettings()`: tutte le variabili `DATA_*`, valori sicuri di default, rifiuto di partire con `DATA_ENGINE_INSECURE_LOCAL=true` in produzione, tetti non superabili (100 per pagina, 200 KiB per documento). |
| `src/errors.ts` | Nuovo codice `unavailable` (503 con `Retry-After`). |
| `src/http.ts` | L'helper `write` accetta anche `DELETE`. |
| `src/app.ts` | Collega il `DataClient`, registra le rotte, `logPath()`: nei log niente dopo `/data/`. |
| `src/context.ts` | `Services.data`. |
| `src/routes/data.ts`, `src/services/account.ts` | `POST /api-keys` accetta `dataAccess: "read" | "readWrite"` (default `read`); le chiavi mostrano `dataAccess`. |
| `scripts/prepare-test-db.sh` | Applica anche la `0004` al Postgres di test locale. |
| `package.json` | Dipendenze `mongodb` ^6.21.0 e `bson` 6.10.4. |
| `README.md`, `docs/api-extensions.md`, `docs/data-explorer-security.md` (nuovo), `.env.example` (nuovo, valori finti), `.gitignore` (solo l'eccezione `!.env.example`) | Documentazione e configurazione. |
| `tests/unit/explorer-rules.test.ts`, `tests/unit/explorer-config.test.ts`, `tests/integration/explorer.test.ts`, `explorer-isolation.test.ts`, `explorer-hostile.test.ts`, `explorer-real-engine.test.ts` (nuovi); `tests/helpers/harness.ts`, `tests/integration/contract.test.ts`, `tests/integration/usage.test.ts` (adattati) | Test (sezione 3). Le due modifiche a test esistenti: l'elenco delle rotte di estensione (contract) e la nuova chiave `dataAccess` nella forma di una API key (usage). |

### Database

| File | Cosa |
| --- | --- |
| `supabase/migrations/0004_data_explorer.sql` (nuovo) | `public.data_audit_log` (RLS, solo il ruolo del control plane può inserire/leggere il proprio workspace, niente update/delete, nessun accesso per `anon`/`authenticated`) e `api_keys.data_access` (`read` default, `read_write`). Ripetibile. **Non applicata a nessun Supabase**: solo al Postgres 16 locale di test. La `0003` non è stata eseguita da nessuna parte se non sul Postgres locale di test, come già faceva lo script esistente. |

### Dashboard (`src/`)

| File | Cosa |
| --- | --- |
| `src/components/DataExplorer.tsx` (nuovo) | La scheda "Data": collezioni a sinistra (select su telefono), documenti con vista JSON espandibile, filtro/sort/campi con errori chiari, paginazione, inserisci/modifica (editor Extended JSON) / cancella con conferma, conflitti di versione con "Load the latest version", stato "Waking the database", stati vuoti ed errori. Solo testo React, nessun HTML dai dati. |
| `src/lib/ejson.ts` (nuovo) | Descrizione testuale dei tipi (`ObjectId(...)`, `ISODate(...)`, int32/int64/decimal…), riassunti, controllo del JSON digitato. |
| `src/data/explorer.ts`, `explorer-http.ts`, `explorer-mock.ts`, `explorer-client.ts` (nuovi) | Tipi e client: HTTP verso il control plane (`VITE_API_URL`, token Supabase come Bearer, `credentials: "omit"`, `cache: "no-store"`), mock in memoria per i check (con un documento ostile `<script>`/`<img onerror>`). |
| `src/pages/DatabaseDetail.tsx` | Selettore "Overview / Data" (`?tab=data`); il contenuto esistente è invariato sotto "Overview". |
| `src/lib/env.ts`, `.env.example` | `VITE_API_URL`. |
| `src/styles.css` | Solo regole nuove in coda, con i token del design esistente. Nessuna altra pagina modificata. |
| `scripts/checks.mjs`, `tests/unit/explorer.test.ts` | 4 nuovi check Playwright (×2 viewport) e 4 unit test. |

## 2. I punti di sicurezza 1-11

| # | Come | Dove | Test | Stato |
| --- | --- | --- | --- | --- |
| 1 Isolamento | `resolveTarget` legge il record con `workspace_id` del chiamante (in transazione con RLS); stesso 404 per "di un altro workspace", "non esiste", "malformato"; il nome `db_<id>` viene solo dal record; `DataTarget` non falsificabile | `services/explorer.ts`, `engine/data.ts` | `explorer-isolation.test.ts`: 7 rotte × (persona, chiave read-write) contro il DB di B (stesso nome in A e B), risposta identica a un id casuale, dati di B identici byte per byte, motore mai interpellato col nome di B, audit pulito; id maiuscoli/malformati/nomi motore; RLS dell'audit. Motore vero: "two workspaces" | **Risolto** (vincolo nel codice; vedi rischio 1) |
| 2 Nomi collezione | Whitelist: 1-120 caratteri `A-Za-z0-9_-.`, no `system.`, no `$`, no NUL, no `..`, no punto iniziale/finale | `explorer/rules.ts` | unit (25 nomi rifiutati), hostile (12 nomi nell'URL, motore mai chiamato) | **Risolto** |
| 3 Iniezione di operatori | Whitelist di operatori ($eq $ne $gt $gte $lt $lte $in $nin $and $or $not $exists $regex+$options i/m/s); tutto il resto rifiutato ovunque compaia; involucri EJSON verificati uno per uno; profondità 8, 100 chiavi, 8 KiB, regex ≤ 256, `$in` ≤ 100; stesso approccio per sort, proiezione, documenti, `_id`; `__proto__` rifiutato | `explorer/rules.ts` | unit (25 operatori vietati in 4 posizioni ciascuno, limiti), hostile (18 filtri ostili + sort/proiezione/documenti/id via HTTP, contatori del motore invariati, prototype pollution) | **Risolto** (rischio 3: costo regex) |
| 4 Limiti | Corpo 256 KiB; documento 192 KiB (tetto 200 KiB); pagina 25/100; skip ≤ 10.000; lettura a lotti ≤ 25 con budget 4 MiB e cursore chiuso; `maxTimeMS` + scadenza client; 120 req/min e 30 scritture/min per persona e per chiave, oltre al limite di workspace esistente | `config.ts`, `routes/explorer.ts`, `services/explorer.ts`, `data-mongo.ts` | `explorer.test.ts` "limits" e "timeouts"; hostile "body over the limit" | **Risolto** (rischio 6: dimensione JSON) |
| 5 Ruoli | Lettura: tutti nel workspace. Scrittura: owner/admin/member e solo chiavi `read_write`; rifiuti 403 auditati. Modifica minima: colonna `api_keys.data_access` (default `read`) | `services/explorer.ts`, `0004`, `account.ts` | `explorer.test.ts` "roles and API keys" (6 test) | **Risolto**, con decisioni da confermare (sezione 5) |
| 6 Credenziali verso il motore | SCRAM + TLS da env con default sicuri; flag locale rifiutato in produzione; password solo in `auth`, mai in log/risposte/errori; un'unica funzione sceglie il database | `config.ts`, `data-mongo.ts` | `explorer-config.test.ts`; motore vero `compat-gaps` con TLS obbligatorio + SCRAM-SHA-256, password sbagliata → 503 pulito senza password né indirizzo | **In parte**: utente per database **non** implementato (possibile su `compat-gaps`, verificato); oggi un'unica credenziale. Decisione e rischio scritti nel doc |
| 7 Dati sensibili | Log solo chi/database/operazione/esito/durata/numero documenti; path redatto dopo `/data/`; `data_audit_log` per insert/replace/delete (attempted + esito, denied), mai il contenuto; idempotenza senza contenuto | `services/explorer.ts`, `app.ts`, `0004` | `explorer.test.ts` "logs" (marcatori in documenti, filtri, `_id`, collezioni), "audit log" (3 test), idempotenza | **Risolto** (rischio 9: `_id` nell'audit) |
| 8 Risposte ed errori | Errori mappati a codici puliti; 503 con `Retry-After`; `no-store`, `Pragma`, `nosniff`, `X-Frame-Options: DENY`, CSP `default-src 'none'`, `Referrer-Policy` su tutte le risposte dati, errori inclusi; CORS e cookie invariati | `services/explorer.ts`, `routes/explorer.ts` | `explorer.test.ts` intestazioni e "clean codes" | **Risolto** |
| 9 Dashboard | Solo testo React; nessun `innerHTML` & co. in `src/`; conferma prima di cancellare; versione + filtro `$eq` lato motore contro sovrascritture | `DataExplorer.tsx`, `ejson.ts` | check Playwright "shown as text, never as markup" (desktop + telefono: `<script>` e `<img onerror>` restano testo, nessun elemento, nessun dialog, nessun effetto); unit "no source file renders HTML"; check "insert, edit, delete and someone else's change" | **Risolto** |
| 10 Tipi MongoDB | Extended JSON v2 **canonico** in entrambe le direzioni (scelto perché non perde tipi); il driver non converte i valori in lettura | `explorer/rules.ts`, `data-mongo.ts` | unit (round trip di ogni involucro), motore vero (documento con 14 campi di tipi diversi riletto identico) | **Risolto** |
| 11 Database dormiente | 503 + `Retry-After` e messaggio "waking"; la dashboard mostra "Waking the database" e riprova fino a 5 volte (insert con `_id` scelto prima, quindi niente doppioni); pool con limiti e chiusura per inattività; nessun polling | `services/explorer.ts`, `data-mongo.ts`, `DataExplorer.tsx` | `explorer.test.ts` "sleeping database"; check "a sleeping database is woken"; motore vero: risveglio dopo `--idle-secs 5`, client chiuso mentre inattivo; verifica manuale: connessione aperta con heartbeat ogni 500 ms e il motore chiude comunque il database dopo 5 s | **Risolto** |

## 3. Test: numeri ed esito (tutto eseguito qui, su questa macchina)

Ambiente: Node 22.22, Postgres 16 locale di prova (migrazioni 0001-0004 applicate due volte dallo script), Chromium di Playwright.

**Prima del lavoro (base `646b694`):** control plane unit 73/73; integrazione 162 test: 160 passati, 1 fallito, 1 saltato. Dashboard: unit 16/16, check 32/32.

**Dopo:**

| Suite | Test | Passati | Falliti | Saltati |
| --- | --- | --- | --- | --- |
| Control plane typecheck | | ok | | |
| Control plane unit | 100 (73 esistenti + 27 nuovi) | 100 | 0 | 0 |
| — di cui validatore filtri/nomi/documenti/limiti (`explorer-rules`) | 17 | 17 | 0 | 0 |
| — di cui configurazione, client Mongo, errori, log (`explorer-config`) | 10 | 10 | 0 | 0 |
| Control plane integrazione | 256 (162 esistenti + 94 nuovi) | 254 | 1 | 1 |
| — rotte, ruoli, 403/404, limiti, timeout, risveglio, audit, log (`explorer`) | 37 | 37 | 0 | 0 |
| — isolamento tra due workspace su ogni rotta (`explorer-isolation`) | 18 | 18 | 0 | 0 |
| — payload ostili (`explorer-hostile`) | 39 | 39 | 0 | 0 |
| Motore vero `merge-engine` e4a560c (`explorer-real-engine`, opzionale) | 8 | 7 | 0 | 1 |
| Motore vero `compat-gaps` 7f4ca5c, TLS + SCRAM (stesso file) | 9 | 9 | 0 | 0 |
| Dashboard typecheck + build di produzione | | ok | | |
| Dashboard unit (`npm run test:unit`) | 20 (16 + 4 nuovi) | 20 | 0 | 0 |
| Dashboard check Playwright (`npm run check`) | 40 (32 + 8 nuovi: 4 scenari × desktop/telefono, incluso XSS) | 40 | 0 | 0 |
| Dashboard screenshot + axe | | ok | | |

Il fallito e i saltati, spiegati:

* **Fallito:** `two identical requests at the same moment do not both run` (`operations.test.ts`, test esistente, non toccato). Fallisce identico (`got 201,500`) anche sulla base `646b694` prima di ogni modifica; era già segnalato come instabile in `results-engine-adapter.md`. Causa non indagata qui.
* **Saltato (integrazione):** il test esistente dei 3.000 database, richiede `SEEDED_DATABASE_URL`. I test sul motore vero si saltano da soli senza `DATA_ENGINE_TEST_ENDPOINT` e sono stati eseguiti a parte (righe sopra).
* **Saltato su `merge-engine`:** il controllo "connessione con TLS e SCRAM" e il caso "password sbagliata": quel branch non ha né TLS né autenticazione. Eseguiti e passati su `compat-gaps`.

## 4. Motore vero e motore finto

**Provato contro il motore vero** (`Mircoguidetti/test5`, compilato qui in release):

* `merge-engine` @ `e4a560c`, `--store memory --idle-secs 5`, senza TLS né auth (`DATA_ENGINE_INSECURE_LOCAL=true`, solo sviluppo): due workspace e due database; insert di un documento con ObjectId, int32, int64 oltre 2^53, double, Decimal128, Date, Binary, UUID, Timestamp, bool, null, stringa con `<script>`/`<img onerror>`, array, sotto-documento, riletto identico; 30 documenti per filtri (`$gte/$lt`, `$date`, `$regex` con `i`, `$in`, `$exists`, `$not`, `$or`), sort, proiezione, paginazione; collezioni con conteggio stimato (`count` sui metadati); replace con versione (il motore valuta il filtro `$eq` su tutti i tipi), versione vecchia → 409, `_id` duplicato → 409, delete; B non vede e non scrive A (404), e nel motore i dati stanno in `db_<id>` distinti; `$where` rifiutato prima del motore; risveglio dopo il sonno con il client già chiuso per inattività (prima richiesta dopo il sonno: 16-46 ms con lo store in memoria).
* `compat-gaps` @ `7f4ca5c`, `--auth --tls-mode requireTLS`, certificato e CA usa-e-getta generati nello scratchpad (non nel repo), utenti creati con l'eccezione localhost e password casuali in file nello scratchpad: gli stessi test con **TLS obbligatorio e SCRAM-SHA-256** passano; password sbagliata → 503 pulito; una connessione senza TLS viene chiusa dal motore; un utente con `readWrite` solo su `db_a…` viene rifiutato (`Unauthorized`) su `db_b…` e `listDatabases` gli mostra solo `db_a…` (prova manuale con il driver, non un test del repo).

**Trovato grazie al motore vero e corretto:** con `promoteValues:false` sul client intero anche le risposte del motore arrivano come `Int32` (codice 11000, `matchedCount`, `deletedCount`): un duplicato diventava 400 e un replace che non trovava nulla poteva sembrare riuscito. Ora quelle opzioni valgono solo per la lettura dei documenti, i contatori passano da `Number()`, e un test copre il codice in forma `Int32`. Mappati anche gli errori interni del motore (codice 1) su 503 invece di 400.

**Limite del motore trovato (non nostro):** con `--store local` (filesystem) il risveglio di un database addormentato fallisce: `put_opts with mode PutMode::Update not yet implemented by LocalFileSystem` (i lease richiedono scritture condizionali). Per questo le prove sono con `--store memory`. **MinIO non è stato provato.**

**Solo contro il motore finto:** limiti di byte per pagina, scadenze e risveglio lento oltre il timeout, guasti iniettati (unavailable/timeout/refused), conflitto tra il controllo di versione e la scrittura, limiti al minuto, stati `restoring`/`erasing`/`provisioning`, audit di `failed`/`conflict`/`denied`, log, intestazioni, tutta la suite ostile e di isolamento tra workspace (sul motore vero c'è solo il sottoinsieme "two workspaces").

**Non provato:** AWS, un motore pubblicato come release, un motore dietro TLS con un vero certificato, MinIO, più istanze del control plane, la dashboard contro il control plane reale (la dashboard è provata col mock; il client HTTP è coperto dal typecheck e dalla build, non da un test end-to-end).

## 5. Rischi residui e decisioni per te

1. **Credenziale unica verso il motore.** L'isolamento per database è nel codice (una sola funzione sceglie il database, dal record del server), non nel motore. Su `compat-gaps` gli utenti per database funzionano (verificato): propongo un utente per database creato a create/fork ed eliminato a erase, con password per database in un vault. **Serve una tua decisione** (è un lavoro a parte: ciclo di vita utenti e dove tenere le password).
2. **`merge-engine` non può essere usato in produzione per il Data Explorer**: non ha TLS né auth, e il control plane rifiuta di partire senza (in produzione). Serve `compat-gaps` (o equivalente) nella release del motore.
3. **Tutte le API key esistenti diventano in sola lettura per i documenti** (default `read`). Una chiave read-write si crea solo via API (`dataAccess: "readWrite"`): la pagina API keys della dashboard non è stata cambiata per rispettare "non cambiare altre pagine". Vuoi l'opzione anche nella dashboard?
4. **I `member` possono scrivere documenti** (come oggi possono creare, forkare, ripristinare). Se vuoi un ruolo di sola lettura per le persone, serve un ruolo nuovo in `workspace_members`.
5. **Costo delle regex**: lunghezza e opzioni limitate e `maxTimeMS` su tutto, ma un pattern cattivo può occupare CPU del motore fino a 10 s. Vuoi un timeout più basso o il rifiuto dei costrutti con backtracking?
6. **Finestra di concorrenza**: un campo *aggiunto* da altri tra controllo di versione e replace (millisecondi) andrebbe perso. Documenti con nomi di campo con `.` o `$` sono protetti solo dalla versione.
7. **Scritture andate in timeout** possono essere state applicate (auditate come `failed`). La dashboard lo gestisce (sceglie l'`_id`, versione sulle modifiche); un client API che inserisce senza `_id` e riprova può duplicare.
8. **Dimensione delle risposte**: il budget di 4 MiB è in BSON; in Extended JSON canonico una risposta può arrivare a circa 10 MiB.
9. **L'`_id` finisce nell'audit e nei record di idempotenza** (richiesto per identificare il documento): se un cliente usa dati personali come `_id`, quei dati sono nell'audit.
10. **Rate limit in memoria per istanza** (come il resto del servizio).
11. **Da fare per accenderlo:** applicare `0004` (dopo `0002`; indipendente da `0003`), impostare `DATA_ENGINE_*` con credenziali e CA, `VITE_API_URL` nella dashboard e l'origine della dashboard in `DASHBOARD_ORIGINS`; il progetto Supabase deve firmare con chiavi asimmetriche (passo 1 del README del control plane), perché la dashboard manda il token Supabase come Bearer.
12. Scelte prese per sicurezza senza chiederti: niente header `If-Match` (avrebbe allargato il CORS: la versione va nel corpo o nella query); idempotenza `no-replay` per le scritture (mai documenti in `idempotency_keys`); le collezioni `system.*` non vengono nemmeno elencate; `$code`, DBRef e nomi di campo con `$`/`.` rifiutati in scrittura (documenti che li contengono si vedono ma non si salvano).

## 6. Commit e branch

Branch: **`data-browser`** (push su `origin/data-browser`), da `646b694`. Nessun merge in `main`.

* `88af519` control plane: API del Data Explorer, client dati, migrazione 0004, test
* `6d06c40` dashboard: scheda "Data", client, check
* il commit successivo (l'ultimo del branch): documentazione (`control-plane/docs/data-explorer-security.md`, README, `api-extensions.md`, `.env.example`) e questo report
