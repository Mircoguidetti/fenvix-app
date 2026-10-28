# Risultati: control plane ↔ motore FENVIX vero, end-to-end in locale (branch `e2e-engine`)

Branch `e2e-engine` di `Mircoguidetti/olvix-app`, creato da `origin/data-browser` @ `359099b`. Nessun merge, nessuna pull request, nessuna attività AWS, nessun deploy, nessun Supabase reale, nessun segreto reale (token, password e chiavi dei test sono casuali, creati a ogni esecuzione in una cartella temporanea e mai scritti nel repo). Non toccati: `main`, `control-plane` (branch), `infra-aws`, `engine-adapter`, `data-browser`, `.github/`, `infra/`, la landing, le migrazioni 0001-0004; nessuna rinomina. Il repo `Mircoguidetti/test5` è stato solo letto e compilato.

Documenti nuovi o aggiornati: [`control-plane/docs/engine-alignment.md`](control-plane/docs/engine-alignment.md) (nuovo), [`control-plane/docs/data-explorer-security.md`](control-plane/docs/data-explorer-security.md) (sezione 6 riscritta), [`control-plane/docs/engine-adapter.md`](control-plane/docs/engine-adapter.md), `control-plane/README.md`, `control-plane/.env.example`.

## 1. Motore usato, compilazione, avvio

**Ramo fuso: non c'era.** `git ls-remote` su `Mircoguidetti/test5` all'inizio e alla fine del lavoro: nessun `fusion-ops` (né altro ramo "fusion"/"fused"). Quindi due binari:

| Ruolo | Branch @ commit | Cosa ha |
| --- | --- | --- |
| porta admin (ctl) | **`control-ops` @ `1f473f9`** | `mongo-server/src/ctl/*` (create/list/get, fork, restore, export, erase, keep awake, usage), niente auth/TLS |
| auth + TLS + utenti | **`compat-gaps` @ `2742441`** | `auth.rs`, `authz.rs`, `tls.rs`, `scram.rs`, utenti e ruoli; niente `ctl/` |

**Attenzione, diverso da quanto indicato:** `merge-engine` @ `e4a560c` **non ha** la porta admin (in `mongo-server/src/` non esiste `ctl/`; `--help` non ha `--admin-listen`). La porta admin esiste solo su `control-ops`, che quindi ho usato. `compat-gaps` è avanzato durante il lavoro a `5df2720`: ho verificato che `mongo-server/`, `src/`, `Cargo.toml` e `Cargo.lock` sono **identici** tra `2742441` e `5df2720` (cambiano solo test e documenti del motore), quindi i risultati valgono anche per `5df2720`.

**Compilazione** (cargo 1.97.0, cloni in scratchpad, worktree per branch): `cargo build --release -p mongo-server`, circa 5 minuti per binario, nessun errore (solo warning del motore).

**Avvio**: lo fa la suite stessa (`control-plane/tests/helpers/engine-proc.ts`), su porte libere di `127.0.0.1`:

```
# processo "admin" (control-ops)
mongo-server --listen 127.0.0.1:<dati> --store memory --no-leases --idle-secs 3 \
  --admin-listen 127.0.0.1:<admin> --admin-token-file <tmp>/admin-token --pin-lease-ttl-secs 6
# processo "auth" (compat-gaps): TLS obbligatorio + SCRAM
mongo-server --listen 127.0.0.1:<dati2> --store memory --no-leases --idle-secs 3 \
  --auth --tls-mode requireTLS --tls-certificate-key-file <tmp>/srv.pem
```

CA e certificato usa-e-getta generati con `openssl` (SAN `localhost`, `127.0.0.1`). Bootstrap degli utenti con l'eccezione localhost del motore: un root "break-glass", il ruolo `fenvix_provisioner` (solo `createUser dropUser viewUser changePassword changeCustomData grantRole revokeRole`) e l'utente provisioner. Se un binario ha sia `--admin-listen` sia `--auth` (ramo fuso), la suite avvia **un solo processo** con tutti i flag: nessuna modifica ai test.

**`--store memory`, non `--store local`:** con `--store local` le operazioni di controllo falliscono tutte (create, fork, keep-awake, erase → `500 internal: put_opts with mode PutMode::Update not yet implemented by LocalFileSystem`), anche con `--no-leases`, oltre al limite già noto del risveglio. Verificato. Conseguenza: un riavvio del motore lo riporta **vuoto**; i test di riavvio verificano la coerenza Postgres/motore, non la durabilità.

Per rifare tutto:

```
cd control-plane && npm ci
TEST_DATABASE_URL=postgresql://postgres@localhost:54329/cp_test?host=/tmp/pgscratch bash scripts/prepare-test-db.sh
ENGINE_E2E_BIN=<test5 control-ops>/target/release/mongo-server \
ENGINE_E2E_AUTH_BIN=<test5 compat-gaps>/target/release/mongo-server \
TEST_DATABASE_URL=... npm run test:engine-real
```

Postgres: 16 locale, cluster usa-e-getta in `/tmp/pgscratch` (porta 54329), migrazioni 0001-0005 applicate due volte dallo script.

## 2. Divergenze tra adattatore e motore, e come le ho risolte

| # | Divergenza (trovata sul motore vero) | Risolta dove |
| --- | --- | --- |
| 1 | Restore prima del primo punto: il motore risponde `400` con la sua frase (`… is before the earliest restorable time …`) e l'adattatore la passava **così com'era** al cliente | adattatore (`real.ts`): frase nostra, con l'istante preso da `GET /restore-points`: "That time is before the earliest restorable point of this database (<ora>). Choose a later time."; nel futuro "Choose a time in the past." Test aggiornati |
| 2 | La porta admin non gestisce utenti; gli utenti esistono solo sulla porta dati (`createUser`/`dropUser`/`updateUser`/`usersInfo`) | nuovo `src/engine/users.ts` (provisioner sulla porta dati), separato da `admin-http.ts` |
| 3 | L'erase del motore non tocca gli utenti (`admin.system.users`) | il control plane elimina l'utente **prima** dell'erase |
| 4 | Un database nuovo nasce `awake` (l'interfaccia diceva "asleep") | documentato; Postgres registra ciò che dice il motore |
| 5 | Un erase fallito lascia `409 operation_in_progress` finché il motore non si riavvia | già ritentato come "busy"; poi l'operazione fallisce e il database torna `ready` con il suo utente ricreato |
| 6 | I `500` del motore contengono testo grezzo (percorsi di file) | già mai inoltrati; ora verificato da test (nessuna frase del motore nelle risposte) |
| 7 | Gli errori `Unauthorized` del motore ripetono **l'intero comando, `pwd` compreso** | mai inoltrati (solo tipo + codice numerico); test che provoca il rifiuto e cerca la password derivata in risposte, log e record delle operazioni |
| 8 | `createUser` controlla solo l'azione `createUser`, non `grantRole` sui ruoli concessi: il provisioner può creare un utente `root` | non risolvibile qui: lacuna del motore, test `todo` che diventa verde quando il motore la chiude |
| 9 | `rotateCertificates` risponde ok ma non ricarica niente | documentato (rinnovo certificato = riavvio del motore) |
| 10 | Il motore si configura solo con flag; nessuna variabile `FENVIX_*` è letta; l'unica variabile è `MONGO_ADMIN_TOKEN` | `engine-alignment.md` (modifiche a `infra/`) |
| 11 | S3: regione fissa `us-east-1`, credenziali fisse `minioadmin`, HTTP ammesso | `engine-alignment.md` (modifica al motore) |
| 12 | Porta admin senza TLS | `ENGINE_ADMIN_ALLOW_PLAIN_HTTP=true` + rete privata, documentato |
| 13 | `merge-engine` non ha la porta admin (vedi sezione 1) | usato `control-ops` |

**Confermato uguale a quanto l'adattatore assumeva:** percorsi e metodi delle 13 rotte; nomi dei campi (`state`, `storage_bytes`, `last_active_at`, `keep_awake`, `forked_from.database`, `earliest_restorable`, `days[].requests.commands`, `wakes.events[]`, `files[].path`); codici di errore (`exists`, `not_found`, `has_forks`, `bad_request`, `unauthorized`); date RFC 3339 con millisecondi; `Authorization: Bearer` (token ≥ 16 caratteri); una richiesta per connessione; nome `db_<32 hex>` accettato dal motore; `409 exists` a una ripetizione di create/fork (accettato dopo verifica), `404` a una ripetizione di erase; `Range: bytes=N-` → `206` sui file di export; nomi file con l'escape di mongodump (provati spazi, `%`, `?`, `#`, `.`, caratteri non ASCII). Hostname: il motore non lo usa per instradare (vedi sezione 7).

## 3. Operazioni provate contro il motore vero (`tests/engine-real/lifecycle.test.ts`, 13/13)

Tutte via HTTP del control plane con `ENGINE_DRIVER=real`, Postgres locale col ruolo ristretto `fenvix_control_plane`.

| Operazione | Esito |
| --- | --- |
| create | ✔ `db_<id>` sul motore, retention impostata, utente `cp_<id>` su `db_<id>` con il solo ruolo `readWrite` su `db_<id>`; host `orders-prod-<ws>.eu-central-1.db.example.test`; stringa di connessione con `db_<id>` |
| lista, dettaglio | ✔ |
| tag (PUT, add, remove, `/tags`) | ✔ |
| Data Explorer, 6 rotte (collezioni, find con `$regex` e sort, get, insert, replace con versione + 409 su versione vecchia, delete) | ✔ client del driver autenticato come `cp_<id>`, mai come provisioner; documenti scritti in `db_<id>` |
| fork | ✔ il fork contiene i dati dell'origine; ha un **utente nuovo**; l'utente dell'origine è rifiutato (13) sul fork e viceversa |
| restore | ✔ i documenti scritti dopo il punto spariscono; l'utente resta |
| restore troppo indietro | ✔ `400` pulito con frase nostra |
| export + download | ✔ ZIP dietro link firmato con i dump dei due database; nessun utente, hash o `SCRAM` dentro |
| keep awake on/off | ✔ sul motore e in Postgres |
| usage (sync + rotta) | ✔ `{ databases: 2, failed: 0 }` |
| erase con un fork esistente | ✔ rifiutato pulito ("Other databases are forks of this one…"), database `ready`, utente funzionante di nuovo |
| erase fork poi origine, poi ripetuto | ✔ database e utenti spariti; la ripetizione dà `affected: 0`; nessun utente rimasto sul motore |
| rotte admin usate | ✔ solo quelle permesse; mai `GET /v1/databases` (dal log admin del motore) |
| segreti nei log | ✔ nessun token, password, chiave nei log del control plane e dei due motori |

Con due binari i documenti del Data Explorer stanno nel processo `compat-gaps`, mentre fork/restore/export agiscono sul processo `control-ops` (la storia per fork/restore la scrivo lì direttamente). Con il ramo fuso è un solo processo e gli stessi test valgono senza modifiche.

## 4. Casi di guasto e coerenza Postgres/motore (`tests/engine-real/failures.test.ts`, 16/16)

| Caso (eseguito davvero) | Esito |
| --- | --- |
| Postgres rifiuta la scrittura dopo il sì del motore (`revoke update` sul ruolo) | ✔ operazione in coda (non fallita), riga nascosta; ripristinato il permesso, il retry trova `409 exists`, lo accetta: **un** database, **un** utente |
| Postgres continua a rifiutare fino all'ultimo tentativo | ✔ l'operazione rinuncia: database **e** utente cancellati dal motore, riga rimossa, errore pulito |
| Il motore crea ma l'utente non si può creare | ✔ create fallisce pulita, database cancellato dal motore |
| …e il motore non è raggiungibile per la pulizia | ✔ l'operazione **non** viene segnata fallita: torna in coda con il fallimento salvato (`pendingFailure`), riga nascosta; al giro dopo pulisce e solo allora fallisce |
| Risposta lenta (motore in `SIGSTOP`) + database già esistente | ✔ `202` entro il timeout, risposta pulita; il motore poi esegue la richiesta trattenuta; il retry riceve `409 exists` e la accetta |
| Lentezza sul Data Explorer (porta dati in `SIGSTOP`) | ✔ `503` pulito entro il limite, poi tutto torna normale |
| Erase di un database sveglio, con keep-awake e un client connesso | ✔ cancellato; utente sparito; la connessione già aperta perde i diritti subito (13); nuova connessione → 18 |
| Restore su un database in scrittura continua | ✔ esito pulito, stato `ready` |
| Database sparito dal motore (cancellato alle nostre spalle) | ✔ fork `404` pulito senza riga orfana; restore `404`; keep-awake `500` pulito e Postgres invariato; export `404`; erase riallinea (`affected: 1`) |
| Motore spento | ✔ create → `202` pulito, non elencato; motore riavviato → il retry completa |
| Riavvio a metà erase (`CTL_FAILPOINT=erase.after_intent`, poi `kill -9`) | ✔ l'utente era già eliminato; il retry chiude, niente resta |
| Riavvio a metà fork (`CTL_FAILPOINT=fork.after_intent`, poi `kill -9`) | ✔ fork fallito pulito, nessuna riga, database o utente del fork |
| Token admin sbagliato | ✔ niente creato sul motore (`401` nel suo log), operazione in attesa, il token non appare in risposte né log |
| Sweep degli utenti | ✔ un utente orfano creato a mano viene eliminato, un utente mancante ricreato; secondo giro: zero modifiche |
| Coerenza finale | ✔ ogni riga `ready` (creata dopo l'ultimo riavvio) ha database e utente; nessun utente orfano |
| Pulizia delle risposte | ✔ nessun segreto, stack, indirizzo, frase del motore o del driver in nessuna risposta né nel log |

**Strategia di coerenza** (`src/services/operations.ts`):

* **Ordine fisso.** Create/fork: riga Postgres (`provisioning`, invisibile) → database sul motore → utente → riga `ready`. Erase: riga `erasing` → utente eliminato → database eliminato → riga eliminata. Ogni passo è ripetibile (nome derivato dall'id, `409 exists` verificato, `404` = già fatto, utente creato o aggiornato, `UserNotFound` = già fatto).
* **Guasti temporanei** (motore irraggiungibile, timeout, Postgres che rifiuta): l'operazione torna in coda con backoff (8 tentativi) e il retry riparte dall'inizio; grazie alla ripetibilità il risultato è uno solo.
* **Fallimento definitivo**: prima si rimette a posto il motore (`finishFailed` → `cleanupEngine`): ciò che create/fork hanno creato viene cancellato insieme all'utente; agli erase rifiutati viene ridato l'utente. Solo dopo Postgres segna `failed`. Se il motore non risponde nemmeno per la pulizia, l'operazione resta in coda con il fallimento salvato e si ritenta solo la pulizia: **Postgres non dice mai "fallito" mentre il motore tiene ancora qualcosa**.
* **Rete di sicurezza**: lo sweep degli utenti (ogni `ENGINE_USER_SWEEP_SECONDS`, default 3600) elimina gli utenti senza riga e crea quelli mancanti; legge prima gli utenti e poi le righe, quindi non tocca operazioni in corso.
* Limite: database orfani **sul motore** (senza riga) non si possono cercare con uno sweep, perché elencare tutti i database del motore è proprio la rotta che il control plane si vieta; li evita l'ordine sopra più `finishFailed`.

## 5. Un utente per database

**Come funziona.** Ogni database `db_<hex>` ha l'utente `cp_<hex>`, definito su `db_<hex>`, con il solo ruolo integrato `readWrite` su `db_<hex>`. Scelta del meccanismo: i comandi MongoDB `createUser`/`updateUser`/`dropUser`/`usersInfo` sulla porta dati, con una credenziale amministrativa dedicata (il "provisioner"), perché è l'unico modo che il motore supporta (la porta admin non ha rotte utenti). Il Data Explorer apre un client del driver per database e si autentica come quell'utente; nome del database e credenziale vengono dallo stesso `DataTarget`.

* **Password**: 40 caratteri `[A-Za-z0-9]` derivati con HMAC-SHA256 da `ENGINE_USER_KEY` (`v<N>:<segreto ≥ 32>`) e dal nome `db_<hex>`; mai salvate in Postgres, nei log, nell'audit. La versione della chiave è nel `customData` dell'utente sul motore (non è un segreto).
* **Parameter Store**: `/fenvix/<env>/control-plane/engine-user-key` (e `…/engine-user-key-previous` solo durante una rotazione), `/fenvix/<env>/control-plane/engine-provisioner-password`, `/fenvix/<env>/control-plane/engine-admin-token`.
* **Tre credenziali separate**: token admin (`ENGINE_ADMIN_TOKEN`, solo `admin-http.ts`), provisioner (`ENGINE_PROVISIONER_*`, solo `users.ts`, nessun dato), chiave principale (l'unica cosa che riceve il Data Explorer). All'avvio il servizio rifiuta: chiave assente con motore vero e Data Explorer attivo; `DATA_ENGINE_USERNAME` insieme alla chiave; credenziale condivisa in produzione; due segreti uguali tra chiave, provisioner e token admin.
* **Ciclo di vita**: nasce con create e con fork (il fork ne ha uno nuovo), si elimina con erase (prima del database), si riverifica dopo restore (best effort), export non lo tocca (gli utenti non sono nel dump), se non si può creare il create fallisce e si pulisce tutto, lo sweep elimina orfani.
* **Rotazione senza fermo**: nuova chiave `v2` + precedente `v1` su tutte le istanze (entrambe valide: il Data Explorer prova l'una e poi l'altra su `AuthenticationFailed`); poi lo sweep porta tutti gli utenti a `v2` (solo in avanti, mai indietro); poi si toglie la precedente. Procedura in `data-explorer-security.md`.

**Test obbligatori, contro il motore vero (`tests/engine-real/security.test.ts`, 9 ok + 1 todo):**

| Test | Esito |
| --- | --- |
| (a) con l'utente di A su B: find, count, listCollections, insert, update, delete, upsert, create, drop, createIndexes, dropDatabase, `$merge` e `$out` da A verso B, renameCollection A→B, createUser, grantRolesToUser, lettura di `admin.system.users` | ✔ tutti rifiutati dal motore (13); `listDatabases` mostra solo A; B identico byte per byte; A funziona |
| (b) bug simulato: il driver forzato a usare B mentre serviamo A (lettura, scrittura, elenco collezioni) | ✔ il motore rifiuta (codice 13 nel log), `503` al cliente, nessun dato di B in risposta, audit `attempted` + `failed`, B identico |
| (c) dopo erase | ✔ nuova connessione → 18; connessione già aperta → 13 subito; client in cache del Data Explorer → errore; rotta → 404 |
| (d1) TLS richiesto | ✔ connessione in chiaro rifiutata dal motore; `DATA_ENGINE_TLS=false` rifiutato dalla configurazione |
| (d2) password sbagliata | ✔ `503` pulito, nessuna password o chiave in risposta o log; `ensure` ripara |
| (d3) CA sbagliata | ✔ Data Explorer non disponibile, create in attesa, nessun indirizzo o segreto |
| (d4) provisioner con password sbagliata e provisioner senza diritti (il motore ripete il comando con `pwd` nel suo errore) | ✔ create in attesa; la password derivata non è in risposta, log, record dell'operazione |
| rotazione v1→v2 | ✔ v2+v1 insieme funzionano; lo sweep porta tutti a v2; v2 da sola funziona; un'istanza rimasta a v1 riceve `503` pulito |
| (e) log, audit dati, audit, operazioni, chiavi di idempotenza, risposte, log dei due motori | ✔ nessuna password né token; nessun testo `pwd` |
| lacuna del motore: il provisioner crea un utente `root` | `todo` (fallisce di proposito finché il motore non controlla `grantRole`) |

## 6. Cosa NON è stato provato

* **Il ramo fuso**: non esisteva. Da rifare quando c'è: `ENGINE_E2E_BIN=<binario fuso>` (senza `ENGINE_E2E_AUTH_BIN`) e `npm run test:engine-real`; la suite usa un solo processo e verifica in più che i dati del Data Explorer e quelli di fork/restore/export siano gli stessi.
* S3 vero, MinIO, AWS (il motore usa credenziali MinIO fisse: non può girare su AWS senza modifica).
* Durabilità attraverso un riavvio (con `--store memory` il motore riparte vuoto) e il recupero delle operazioni interrotte del motore stesso.
* Più istanze del control plane in parallelo e più processi del motore con lease (sempre `--no-leases`); la rotazione su più istanze è simulata con istanze in sequenza.
* TLS sulla porta admin (il motore non lo ha), certificati veri (ACM), DNS.
* La dashboard contro il control plane vero (solo col mock, come prima).
* Supabase reale: la migrazione `0005` è applicata solo al Postgres locale.

## 7. `engine-alignment.md` in sintesi: cosa cambiare in `infra/`

Su `main`/`infra-aws` (@ `0c4a32c`); dettagli e righe nel documento.

1. Porte: dati **27018** (oggi 27017), admin **8443** (oggi 27018); `mongoPort` in `config.ts`/`cdk.json`, regola del security group, `FENVIX_LISTEN`. (Nota: su questo branch `infra/` ha già queste porte nel codice, ereditate da `646b694` di engine-adapter, ma il README dice ancora 27017/27018.)
2. `ExecStart` del motore con i **flag** (`--listen`, `--admin-listen`, `--admin-token-file`, `--auth`, `--tls-mode requireTLS`, `--tls-certificate-key-file`, `--store s3 --bucket`): oggi parte senza flag e le variabili `FENVIX_*` non sono lette.
3. Token admin: da `/fenvix/<env>/engine/admin-token` a un file 0600 passato con `--admin-token-file` (il motore legge `MONGO_ADMIN_TOKEN`, non `FENVIX_ADMIN_TOKEN`).
4. TLS: niente `FENVIX_TLS_MODE=self-signed` (non esiste); esportare il certificato ACM in un PEM all'avvio; rinnovo = riavvio.
5. Certificato e DNS per regione `*.<region>.db.<domain>` (oggi `*.db.<domain>` non copre `<name>-<ws>.<region>.db.<domain>`).
6. Parametri SSM del control plane: `engine-admin-token`, `engine-user-key`, `engine-provisioner-password`, `download-signing-key`, `control-plane-database-url` (richiesti), `engine-user-key-previous` (facoltativo); `session-secret` non serve.
7. Ambiente del container: `ENGINE_DRIVER=real`, `REGIONS`, `ENGINE_ADMIN_ENDPOINTS`, `ENGINE_ADMIN_ALLOW_PLAIN_HTTP=true`, `DATA_ENGINE_ENDPOINTS`, `DATA_ENGINE_TLS_SERVER_NAME`, `ENGINE_PROVISIONER_USERNAME`, `CONNECTION_PORT=27018`, `CONNECTION_DB_NAME=engine`, `HOST_TEMPLATE=<name>-<workspace>.<region>.db.<BASE_DOMAIN>`, `API_PUBLIC_URL`, `DASHBOARD_ORIGINS`, `SUPABASE_*`, `NODE_ENV=production`, `TRUST_PROXY`; `--add-host=host.docker.internal:host-gateway`.
8. Hop limit dei metadati a 1; README; test.

Lato motore: credenziali S3 dall'ambiente e regione configurabile; un binario con admin + auth; controllo `grantRole` in `createUser`; niente `pwd` nei messaggi d'errore; TLS sulla porta admin; `rotateCertificates` reale.

## 8. Rischi residui e decisioni che servono a te

**Decisioni:**

1. **Credenziali del cliente.** La stringa di connessione dice `app_user:<password>`, ma `app_user` non esiste sul motore. L'utente `cp_<hex>` di questo lavoro è del control plane (la sua password non viene mai mostrata e cambia con la rotazione). Serve decidere come il cliente ottiene le sue credenziali (un secondo utente per database per l'applicazione, password mostrata una volta, reset).
2. **Ruolo dell'utente per database**: ho scelto `readWrite` (documenti, collezioni, indici), non `dbOwner`/`dbAdmin` (che permetterebbero `dropDatabase` e gestione utenti). Confermi?
3. **Correzioni nel motore** da chiedere: `grantRole` in `createUser` (oggi chi ha la password del provisioner è di fatto root), niente password nei messaggi `Unauthorized`, credenziali S3, ramo fuso, TLS admin.
4. **Applicare la migrazione `0005`** (dopo la `0002`) quando si accende: aggiunge solo la funzione `fenvix_cp_engine_databases()` (id, regione, stato) per lo sweep.

**Scelte fatte per sicurezza, senza chiederti:**

* La credenziale condivisa del Data Explorer (`DATA_ENGINE_USERNAME`) ora è **rifiutata in produzione** e incompatibile con le chiavi per database.
* Con `ENGINE_DRIVER=real` e Data Explorer attivo, `ENGINE_USER_KEY` è obbligatoria.
* L'erase elimina prima l'utente e poi i dati (meglio un cliente bloccato durante l'erase che dati riscritti dopo).
* Un'operazione la cui pulizia sul motore non riesce resta in coda indefinitamente (backoff fino a 5 min) invece di dichiararsi fallita; nel frattempo quel nome di database resta occupato.
* Lo sweep della rotazione va solo in avanti di versione.
* Timeout regex del Data Explorer: `DATA_REGEX_TIMEOUT_MS`, default **2000 ms**, mai sopra il timeout dei comandi.

**Rischi residui:**

* Il control plane tiene la chiave principale e il provisioner: un processo compromesso raggiunge tutti i database (come già può cancellarli col token admin). Ciò che è cambiato: un **bug** non attraversa più i database (lo rifiuta il motore) e non esiste più una credenziale che legge tutto nel Data Explorer, in Postgres o nei log.
* Il provisioner vede i nomi di tutti i database (`listDatabases`), non i contenuti.
* Fino a `DATA_ENGINE_MAX_CLIENTS` (100) client × `DATA_ENGINE_POOL_MAX` (5) connessioni verso il motore.
* Durante la rotazione, un'istanza non ancora riavviata con la nuova chiave riceve `503` per i database già passati a v2 (procedura e ordine documentati).

**Test esistenti modificati (comportamento cambiato di proposito):** `tests/unit/explorer-config.test.ts` (2 test: la credenziale condivisa in produzione ora è rifiutata, il messaggio cita ancora `DATA_ENGINE_USERNAME`), `tests/unit/real-engine.test.ts` e `tests/integration/real-engine.test.ts` (restore troppo indietro: frase nostra invece di quella del motore). `tests/helpers/harness.ts`: opzione `usersFactory`.

**Il test instabile** "two identical requests at the same moment do not both run": in questa sessione è **passato** in tutte e tre le esecuzioni dell'integrazione (base prima delle modifiche e due dopo); resta noto come instabile, non l'ho toccato.

**Numeri (tutti eseguiti qui):**

| Suite | Prima (base `359099b`) | Dopo |
| --- | --- | --- |
| Control plane typecheck | ok | ok |
| Control plane unit | 100/100 | **108/108** (+8 nuovi: derivazione, nomi, config, client, regex, rotazione in avanti) |
| Control plane integrazione | 256: 255 ok, 1 saltato | **264: 263 ok, 1 saltato, 0 falliti** (+8 nuovi: ciclo di vita utenti, pulizia, sweep, regex) |
| `engine-real` (nuova, motore vero) | — | **39: 38 ok, 1 todo** (13 ciclo completo, 16 guasti, 10 sicurezza) |
| `explorer-real-engine` (esistente, opzionale) contro `compat-gaps` TLS+SCRAM | — | 9/9 |
| Dashboard typecheck + build | — | ok |
| Dashboard unit | — | 20/20 |
| Dashboard Playwright (`npm run check`) | — | 40/40 + screenshot (screenshot rigenerati e poi ripristinati: la dashboard non è cambiata) |

Il saltato dell'integrazione è il test dei 3.000 database (richiede `SEEDED_DATABASE_URL`), come prima.

## 9. Branch e commit

Branch **`e2e-engine`** (push su `origin/e2e-engine`), da `origin/data-browser` @ `359099b`. Nessun merge in `main`.

* `33bcf61` control-plane: one engine user per database, real-engine fixes, engine-real suite
* il commit successivo (l'ultimo del branch): sweep solo in avanti, documentazione (`engine-alignment.md`, `data-explorer-security.md`, `engine-adapter.md`, README, `.env.example`) e questo report
