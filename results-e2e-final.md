# Risultati: control plane ↔ motore finale (branch `e2e-final`)

Branch `e2e-final` di `Mircoguidetti/olvix-app`, creato da `origin/orgs-invites` @ `a6b2be9`. Nessun merge, nessuna pull request, nessuna attività AWS, nessun Supabase reale, nessun segreto reale (token, password e chiavi dei test sono casuali e temporanei; MinIO locale con credenziali di prova). Non toccati: `main`, `infra/`, la landing, `.github/`, la migrazione 0006, gli screenshot (rigenerati da Playwright e poi ripristinati).

## 1. Binario

* `Mircoguidetti/test5`, branch `final-engine`, checkout del commit del motore `41ed169` (il branch finisce a `e038db7`: da `41ed169` a `e038db7` cambiano solo `tools/` e `results-final-engine*`).
* `cargo build --release --workspace` (cargo/rustc 1.97.0), 7 min 36 s, nessun errore.
* **SHA-256 di `mongo-server`: `086b756d77a2e145e6f185150ffe821f764aa3b6b97bb0de1b7dfd5d31d5418e`**. Il riferimento è `d39e4038be17d2a1e69706c06bd30173209858f94eda10c2e58528d61e925b9b`: **non coincidono** (compilazione su un'altra macchina/percorso; non ho verificato quale differenza produce l'hash diverso).
* Disco: 30 GB liberi all'inizio, mai sotto 26 GB; `target/` eliminato dopo la compilazione.
* Per i numeri "prima" ho compilato anche i vecchi binari: `fusion-ops` @ `e98ed24` (porta admin) e `compat-gaps` @ `5df2720` (auth/TLS).

## 2. Avvio come in produzione (senza AWS)

Profilo nuovo della suite: `ENGINE_E2E_PROFILE=production` (`tests/helpers/engine-proc.ts`, `tests/helpers/s3-local.ts`). Un solo processo:

```
AWS_ACCESS_KEY_ID=<utente MinIO di prova> AWS_SECRET_ACCESS_KEY=<password MinIO di prova>   # solo nell'ambiente del motore
mongo-server --listen 127.0.0.1:<dati> \
  --store s3 --bucket fenvix-e2e-<casuale> --region eu-central-1 --endpoint http://127.0.0.1:9000 \
  --holder e2e-<casuale> --lease-ttl-secs 10 --idle-secs 3 --log-commands \
  --admin-listen 127.0.0.2:<admin> --admin-token-file <tmp>/admin-token --pin-lease-ttl-secs 6 \
  --auth --tls-mode requireTLS --tls-certificate-key-file <tmp>/srv.pem
```

* TLS: CA e certificato usa-e-getta generati con `openssl` (SAN `localhost`, `127.0.0.1`).
* Porta admin su un indirizzo separato (`127.0.0.2`) con token; dati su `127.0.0.1`.
* MinIO compilato dai sorgenti (`go install github.com/minio/minio@latest`, moduli da proxy.golang.org, autorizzato da te), su `127.0.0.1:9000`, regione `eu-central-1`, un bucket nuovo per ogni motore creato dal test con firma SigV4, svuotato e cancellato alla fine.
* Leases attivi (niente `--no-leases`). Il motore riceve un ambiente pulito (`PATH` + le credenziali di MinIO): nessuna variabile `AWS_*` del sandbox arriva al motore; ogni comando è stato lanciato con le `AWS_*` tolte dall'ambiente.
* Postgres 16 locale usa-e-getta, migrazioni 0001-0005, 0007, 0008 applicate due volte. pymongo 4.19.0 in un venv (da PyPI, autorizzato da te).

## 3. Risultati per punto

### a. Suite engine-real, prima e dopo

| Esecuzione | Codice | Binari | Risultato |
| --- | --- | --- | --- |
| prima | base `a6b2be9` | vecchi: `fusion-ops` e98ed24 + `compat-gaps` 5df2720 (due processi, memory) | 54: **53 ok, 1 todo** (il todo è la lacuna `grantRole`: fallisce, come previsto) |
| base, motore nuovo | base `a6b2be9` | finale, un processo, memory | 54: 53 ok, 1 todo — **il todo ora passa** (il provisioner non crea più root) |
| dopo, profilo memory | `e2e-final` | finale | 66: **64 ok, 1 saltato, 1 todo** (il saltato è il controllo del log dei comandi, che richiede `--log-commands` del profilo production) |
| dopo, profilo production | `e2e-final` | finale, S3/MinIO, lease, admin separato | 66: **65 ok, 0 falliti, 1 todo** |

Il todo rimasto è una lacuna del motore nuova (punto h). Primo giro production: 1 fallito, `failures.test.ts` "engine restarted in the middle of a fork": con archivio durevole l'origine sopravvive al kill -9 e il retry **completa** il fork, invece di fallire come con `--store memory` (dove il motore ripartiva vuoto). Il test ora distingue i due profili (le asserzioni memory sono invariate; in production verifica fork pronto con i suoi utenti, poi erase pulito di fork e origine).

Altro eseguito sul binario finale: `tests/integration/explorer-real-engine.test.ts` (opzionale) contro il motore con `--auth`, requireTLS e S3/MinIO: **9/9**.

### b. Il control plane comanda il motore solo dalla porta admin

* **Ricerca nel codice** (test "b. source"): in `src/` non compare nessuno di `tenantAdmin`, `rotateCertificates`, `shutdown`, `fsync`, `closeAllDatabases`, `setParameter`, `logRotate`, `replSetInitiate`, `killAllSessions`, `dropAllUsersFromDatabase`, `dropAllRolesFromDatabase`; l'unico file che manda `.command(` alla porta dati è `src/engine/users.ts` (i comandi utenti del provisioner). Anche `grep -rn tenantAdmin` su tutto il repo: solo documenti.
* **Motore**: `tenantAdmin` sulla porta dati come root → **13** (rifiutato). Porta admin: senza token, con token sbagliato, con la password SCRAM del provisioner come token → **401**; con token → 200; sull'indirizzo dati alla porta admin non risponde nessuno.
* **A runtime** (test "b. at run time", profilo production): un ciclo completo (create, Data Explorer insert/find/listCollections/get/replace, utente creato/reset/eliminato, fork, keep-awake, erase di fork e origine) e poi il log dei comandi del motore (`--log-commands`, solo nome e database): sulla porta dati solo comandi della lista ammessa (handshake e autenticazione del driver, `createUser`/`updateUser`/`dropUser`/`usersInfo`, comandi dati); nessun comando del motore; create, fork, keep-awake ed erase compaiono nel log della porta admin.

### c. Utenti dei database con il motore vero

Tutto eseguito in un solo processo (prima erano due):

* creazione con ruolo `readWrite`/`read`, password mostrata una volta: ok (`db-users.test.ts`, 14 test, tutti ok);
* collegamento con il driver Node e con **pymongo 4.19** usando la stringa della risposta (TLS + SCRAM-SHA-256): ok; senza TLS rifiutato;
* isolamento: i 12 comandi ostili (find, insert, update, delete, drop, dropDatabase, listCollections, createUser su B e su A, grantRolesToUser, `$out` verso B, lettura di `admin.system.users`) → tutti **13**; con `authSource` di B → 18; B intatto;
* reset (vecchia password 18, nuova ok), eliminazione (connessione aperta 13, nuova 18): ok;
* erase: nessun utente resta; fork: solo gli utenti nuovi; restore: utenti invariati: ok.

### d. Regola grantRole

* **Il provisioner continua a funzionare**: crea `cp_<id>` (`readWrite`) e gli utenti dei clienti (`readWrite`, `read`) su `db_<id>`; create e fork passano (tutta la suite).
* **Provisioner compromesso** (test "d. a compromised provisioner"), rifiutati con 13: `root`, `__system`, `clusterAdmin`, `clusterManager`, `hostManager`, `readWriteAnyDatabase`, `readAnyDatabase`, `userAdminAnyDatabase`, `dbAdminAnyDatabase`, `backup`, `restore`; `grantRolesToUser` di root a sé stesso; `updateUser` di sé stesso con `readWriteAnyDatabase`; `createRole` (non è tra le sue azioni).
* **Ancora permessi dal motore** (fissati nel test, così un cambiamento si vede): qualsiasi ruolo **a livello di database** su qualsiasi database con nome — `dbOwner` su un database cliente, `readWrite` e `userAdmin` su `admin` — e un secondo utente con il ruolo stesso del provisioner. `readWrite` su `admin` non apre `admin.system.users` (13). Quindi chi ruba la password del provisioner non diventa root, ma può darsi accesso a qualunque database cliente. Il control plane non chiede mai questi ruoli (lista fissa, provata dai test ostili). Vedi decisioni.

### e. Nome con utenti residui

* Motore (porta admin): create e fork verso un nome con un utente residuo → **409 `users_exist`**; tolto l'utente il create funziona; erase con utenti → il motore li cancella; stesso nome di nuovo → creato.
* Control plane: erase → create con lo **stesso nome** (`again-01`) funziona: id nuovo, solo `app` e `cp_<nuovo>`, la stringa nuova si collega e scrive. Il control plane non incontra mai `users_exist` nei suoi flussi: il nome nel motore viene dall'id (nuovo a ogni create), il motore controlla `exists` prima di `users_exist` (quindi un retry dello stesso create/fork riceve ancora `409 exists`, accettato), e gli utenti si creano solo dopo il sì del motore.

### f. Fork di dati scritti da un'applicazione, stesso processo

Test "f. fork of data an application wrote": 50 documenti + un indice + una seconda collezione scritti con la stringa dell'utente `app`; fork via API; con l'utente `app` **del fork** (password nuova mostrata una volta): 50 documenti, il documento della seconda collezione, l'indice. Scritture indipendenti (insert/delete sul fork, insert/update sull'origine: nessuna si vede dall'altra parte; 51 contro 50). Utenti del fork: solo `app` e `cp_<fork>`; un utente extra dell'origine sul fork → 13; l'origine tiene i suoi tre utenti. In più "f. restore": dati scritti dall'app prima e dopo un istante, restore all'istante → resta solo il primo, utenti invariati.

### g. Data Explorer con --auth

Test "g.": legge i documenti scritti dall'applicazione; un solo client del driver per quel database, autenticato come `cp_<id>` (unico ruolo `readWrite` sul proprio database). Un **member** legge (200) e riceve **403** su insert, replace e delete; sul motore nulla cambia; `data_audit_log` ha 3 righe `denied` con il member come autore; l'insert dell'owner ha `attempted` + `ok`. Le letture non vanno nell'audit (scelta già documentata: sono nel log). Corretto il documento `data-explorer-security.md`, che diceva ancora che un member può scrivere.

### h. rotateCertificates

* Il control plane **non lo chiama mai** (codice), in nessun caso: quindi nemmeno con TLS disattivato.
* Con TLS attivo (processo senza `--auth`): cambiato il file, prima del comando il certificato servito resta il vecchio; dopo il comando le connessioni nuove ricevono il nuovo (fingerprint SHA-256), quella aperta continua; con un file non valido il comando fallisce e resta il precedente.
* Con TLS disattivato: risponde ok, niente cambia.
* **Lacuna nuova del motore**: con `--auth` nemmeno root può eseguire `rotateCertificates` (13): `authz.rs` non ha una voce per il comando (come `tenantAdmin`), quindi serve `anyAction` dell'utente interno. In produzione (`--auth` + requireTLS) il rinnovo del certificato richiede ancora un riavvio del motore. Test `todo` che diventa verde quando il motore lo corregge.

### i. Correzioni al control plane

Nessun difetto del control plane con il motore finale: nessuna correzione al codice è stata necessaria (nessun test ha fallito per colpa del control plane). Modifiche fatte:

* test: profilo production della suite; nuovo `final-engine.test.ts` (12 test); `security.test.ts`: il caso "il provisioner crea root" era un `todo` per una lacuna del motore, ora è un test normale (comportamento del motore cambiato di proposito); `failures.test.ts`: crash a metà fork con archivio durevole (spiegato in a);
* documenti: `engine-alignment.md` (sezione 0 sul motore finale, stato delle lacune), `data-explorer-security.md` (member solo in lettura), `README.md` (come avviare il profilo production);
* `operations.ts`: solo un commento (l'erase del motore ora cancella gli utenti da sé; il nostro `dropAll` dopo l'erase resta, innocuo).

## 4. Altri test

| Suite | Prima (base `a6b2be9`) | Dopo |
| --- | --- | --- |
| Control plane typecheck | ok | ok |
| Control plane unit | 119/119 | 119/119 |
| Control plane integrazione | 316: 314 ok, 1 fallito, 1 saltato | 316: 314 ok, 1 fallito, 1 saltato |
| Dashboard typecheck | — | ok |
| Dashboard unit | — | 28/28 |
| Dashboard Playwright (`npm run check`) | — | 48 + 10 controlli ok, screenshot ok (non committati) |

**Il fallito dell'integrazione non dipende da questo lavoro**: `usage.test.ts` "copies state, storage, hourly and daily usage" fallisce prima e dopo le modifiche, **quando l'ora UTC è prima delle 06:00** (le esecuzioni erano alle 04:3x-04:5x). Il test mette un'ora d'uso 30 ore fa, ma la sincronizzazione legge dall'inizio di ieri (UTC): prima delle 06:00 quell'ora cade fuori. Prova: lo stesso test con l'orologio del processo spostato di 7 ore (`--import` diagnostico, fuori dal repo) passa; senza, fallisce. Non l'ho modificato (difetto del test, non cambio di comportamento). Il saltato è il test dei 3.000 database (serve `SEEDED_DATABASE_URL`).

## 5. Decisioni che servono a te

1. **Provisioner**: con il motore finale non può creare root né ruoli di cluster, ma può ancora concedere qualunque ruolo di database su qualunque database (anche `dbOwner` o `userAdmin@admin`) e crearsi copie. Per chiudere servirebbe nel motore un elenco dei ruoli concedibili per utente o ruolo (per esempio "solo `readWrite`/`read` sul database dell'utente"). Da chiedere al motore, oppure accettare il rischio (chi ha il control plane ha comunque il token admin).
2. **rotateCertificates con --auth** (e `tenantAdmin`): una riga nel motore (`authz.rs`, azione di cluster `rotateCertificates`, che in mongod ha `hostManager`/root). Fino ad allora: rinnovo certificato = riavvio (già scritto per `infra/`).
3. **Il test che dipende dall'ora** (`usage.test.ts`): correggerlo (ora d'uso dentro la finestra a qualsiasi ora) è una riga; non l'ho fatto perché non è un cambio di comportamento. Dimmi se lo correggo.
4. Hash del binario diverso dal riferimento: se serve l'identità bit per bit, va compilato sulla stessa macchina o con build riproducibile.

## 6. Cosa NON ho potuto verificare

* **S3 vero (AWS)**: nessuna prova; solo MinIO locale. Quindi non provati: catena delle credenziali con ruolo dell'istanza, scritture condizionali su AWS, versioning, errori 409/503 reali.
* **Carico e latenza**: nessuna misura.
* **Più processi del motore** sullo stesso bucket e più istanze del control plane: non provati.
* **TLS sulla porta admin**: il motore non lo ha.
* La dashboard contro il control plane vero (solo mock, come prima); Supabase reale.

## 7. Commit su `origin/e2e-final`

Elencati nel messaggio di consegna (l'ultimo contiene questo file).
