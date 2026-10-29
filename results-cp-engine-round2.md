# Risultati: control plane ↔ motore `engine-round2` (branch `cp-engine-round2`)

Branch `cp-engine-round2` di `Mircoguidetti/olvix-app`, creato da `ui-status` @ `3281c90` (punta controllata con `git log -1`). Per la Parte 3 il branch `infra-grants`, creato da `origin/infra-align` @ `8ca5194` (report: `infra/report-infra-align.md`, sezione 12 su quel branch). Nessun merge, nessuna pull request, nessun force-push, nessuna attività AWS, nessun segreto nei file (token, password e chiavi dei test sono casuali e temporanei, generati dalla suite), nessuno screenshot. Altri branch non toccati. Ogni comando di test è stato lanciato con le variabili `AWS_*` tolte dall'ambiente.

## 1. Motore

* Sorgente: `Mircoguidetti/test5`, branch `engine-round2` (punta `561f05d`), checkout del **commit del motore `3bcd7e5`**. Verificato con `git diff --stat 3bcd7e5 HEAD`: dopo `3bcd7e5` cambiano solo `results-engine-round2*` e `tools/round2/` (nessun file di `mongo-server/`, `Cargo.toml`, `Cargo.lock`).
* `cargo build --release --workspace` (cargo/rustc 1.97.0, come negli altri test reali): 6 min 27 s, esito 0. **SHA-256 di `mongo-server`: `48b825721b41cc702fb23f4688eb230d324e9861c62658cd7002d3a6394cedc1`**. Tutte le prove sono state fatte con questo binario.
* Per confronto ho compilato anche con `cargo build --release -p mongo-server` (il comando del report del motore): `ec1d1ef5f37e022fdc5b89fc23ac1b3c5bab026f9971c435598a62b7b40ea38e`. Il riferimento del report del motore è `615c631a…ba398fcc6`: **nessuno dei due coincide** (altra macchina/percorso; non ho indagato quale differenza produce l'hash).
* Avvio: quello della suite (`tests/helpers/engine-proc.ts`, profilo `memory`): `--store memory --no-leases`, porta admin con token, **`--auth`**, `--tls-mode requireTLS`, più **`--grantable-roles=read,readWrite,dbAdmin`** (nuova variabile `ENGINE_E2E_GRANTABLE_ROLES`, passata a ogni motore della suite). Verificato da `--help` del binario: `--grantable-roles` esiste, `--auth-fail-max` ha default 100, `--auth-fail-max-per-db` 5.
* Provisioner: `fenvix_provisioner` su `admin`, ruolo personalizzato `fenvix_provisioner` con `createUser, dropUser, viewUser, changePassword, changeCustomData, grantRole, revokeRole` (`PROVISIONER_ACTIONS` in `engine-proc.ts`; le stesse 7 azioni dello Step 10 di `infra/`, letto in `infra/lib/user-data.ts` riga 118).

## 2. Parte 1 — sblocco per singolo database

**Cosa è cambiato** (commit `52f2195`):
* `src/engine/real.ts` `unblockAddress`: chiama `DELETE /v1/network/blocks/{ip}?database=db_<hex>` (nome del database nel motore). Se la risposta non contiene `database` uguale al nome chiesto (un motore precedente a `engine-round2` ignora il parametro e sblocca tutto) l'adattatore risponde "non disponibile": nessun audit `ok`, il cliente riceve 503.
* `src/engine/admin-http.ts`: una rotta ammessa può fissare la sua query. Lo sblocco esce **solo** con esattamente `database=db_<32 hex>`; senza parametro, `?`, `database=`, `database=admin`, `database=orders`, nome con un carattere in più, parametro ripetuto, parametri in più, frammento → rifiutati prima della rete (aggiunti ai casi rifiutati del test "permission boundary"). Le altre rotte non cambiano.
* `src/engine/fake.ts`: toglie solo i blocchi con `database` uguale al database chiesto; i blocchi di altri database e quelli globali (`database: null`) restano. Il motore simulato dei test unitari (`tests/helpers/sim-engine.ts`) segue `?database=` come `ctl/allowlist.rs` del motore (letto: `unblock(ip, database)`, risposta `{ip, database, unblocked}`), e può fingersi un motore vecchio.
* `src/services/network.ts` **non modificato**: controlla ancora che l'indirizzo sia bloccato su QUEL database prima di chiedere lo sblocco (404 altrimenti). Verificato dal test di integrazione (sblocco ripetuto → 404 anche se lo stesso indirizzo è ancora bloccato su un altro database).
* Documenti: `control-plane/docs/network-allowlist.md` (nuova sezione 2.4, riga sullo sblocco, decisione 1 della sezione 7 segnata come risolta), `api-extensions.md`, `engine-adapter.md`.

**Test** (scritti prima del codice: stash delle modifiche, test eseguiti sul codice di `3281c90`, poi codice ripristinato):

| test | sul codice di 3281c90 | dopo |
|---|---|---|
| `tests/unit/real-engine.test.ts` (2 nuovi + 9 rotte rifiutate nuove) | 4 falliti (rotte senza `?database=` accettate; sblocco di tutte le coppie; motore vecchio non riconosciuto) | tutti ok |
| `tests/integration/ip-allowlist.test.ts` (1 nuovo: stesso IP su due database e globale) | 1 fallito | 37/37 |
| `tests/engine-real/network.test.ts` "unblock on one database" (motore vero) | — (sul codice vecchio l'adattatore manda lo sblocco su tutti i database) | ok |

Il test sul motore vero: stesso indirizzo (127.0.0.2, "l'applicazione") con 5 password sbagliate su A e 5 su B → il motore ha due blocchi, A e B (10 errori, sotto la soglia globale di 100: nessun blocco globale). Sblocco dal control plane su A → nel motore resta solo il blocco di B; su A la password giusta funziona, su B è ancora rifiutata (18); `audit_log` ha una riga `database.network.unblock` per A con `{ip}` e nessuna per B.

**Mutazione** (verifica che il test engine-real serva): tolto `?database=` da `real.ts`, tolto il controllo della risposta e la query obbligatoria in `admin-http.ts`, eseguito `network.test.ts` sul motore vero → **1 fallito**, proprio il nuovo test ("in the engine only B's block is left": anche B era sbloccato). Sorgenti ripristinati (`git diff --stat` identico a prima della mutazione).

Un dettaglio: il test "every call the adapter makes in a full run is on the list" controllava solo il percorso (`sim.seen`); ora controlla percorso **e query** come inviati (`sim.seenQueries`), altrimenti la query obbligatoria non sarebbe stata verificata.

## 3. Parte 2 — flussi utente con `--auth` e `--grantable-roles`

### 3.1 Suite engine-real, prima e dopo

| esecuzione | codice | motore | risultato |
|---|---|---|---|
| prima | `3281c90` | `3bcd7e5` con `--auth --grantable-roles=read,readWrite,dbAdmin` (wrapper nello scratchpad, perché la suite di base non ha la variabile) | 79: **74 ok, 2 falliti, 2 saltati, 1 todo** (il todo ora passa) |
| dopo | `cp-engine-round2` | stesso, flag via `ENGINE_E2E_GRANTABLE_ROLES` | 89: **87 ok, 0 falliti, 2 saltati** |
| dopo, senza flag (compatibilità) | `cp-engine-round2` | stesso, senza `--grantable-roles` | 80: **78 ok, 0 falliti, 2 saltati** |

I 2 saltati in entrambe: il test con pymongo (serve `ENGINE_E2E_PYTHON`) e "b. at run time" (serve il profilo production con `--log-commands`). Vedi sezione 6.

**I 2 falliti "prima" e il todo sono cambiamenti voluti del motore, non difetti del control plane:**
1. `final-engine.test.ts` "d. a compromised provisioner…": il test fissava ciò che il motore **ancora permetteva** al provisioner (`dbOwner` su un database cliente, `userAdmin@admin`, `readWrite@admin`, una copia del provisioner). Con il flag ora sono rifiutati (13): esito `13 !== 0` su "dbOwner on a customer database". Test aggiornato: con il flag si aspetta 13 per tutti e quattro, più "nessun utente su admin" e "password di root" (13); senza flag fissa ancora il vecchio comportamento.
2. `network.test.ts` "(point 4) WITHOUT the guard, customers' allowlists…": il test si aspettava che 18 errori del Data Explorer su 3 database bloccassero il provisioner su tutti i database (soglia globale 10). Con la soglia 100 il motore blocca il control plane **solo su quei 3 database** (output registrato: 3 blocchi `db_…`, 15 errori nella finestra globale, nessun blocco su `admin` né globale) e il provisioner continua a creare database. Test aggiornato per questo scenario (blocchi solo sui 3 database, poi un create riesce). L'altro scenario (password del provisioner sbagliata → 5 errori su `admin` → blocco su `admin`) resta invariato e passa: la protezione `auth-guard.ts` serve ancora.
3. Todo "h. rotateCertificates" (lacuna del motore): ora root lo esegue (0). Trasformato in test normale; aggiunto che il provisioner riceve 13.

### 3.2 Voce per voce (nuovo `tests/engine-real/grantable-roles.test.ts`, 9 test, tutti ok)

Ogni voce usa il codice del control plane (`MongoEngineUsers` di `src/engine/users.ts`, autenticato come `fenvix_provisioner`) o le sue API; i controlli leggono il motore come root.

| # | voce | esito | come verificato |
|---|---|---|---|
| 0 | il flag è attivo | ok | il provisioner riceve 13 per `dbOwner`, `userAdmin`, `readWrite@admin`, il proprio ruolo, un utente su `admin`. **Controllo**: lo stesso file con il motore avviato senza il flag (wrapper che lo toglie) → solo questo test fallisce (`0 !== 13`), gli altri 8 passano |
| 1 | ensure di `cp_<id>`: `createUser` e `updateUser`, ruolo `USER_ROLE` (`readWrite`) su `db_<hex>` | ok | create via API → `usersInfo`: un solo ruolo `{readWrite, db_<hex>}`; `ensure` di nuovo (51003 → `updateUser`) ok; ruolo cambiato a mano in `read` → `ensure` lo ripara con `updateUser`; `cp_<id>` scrive |
| 2 | utenti cliente `readWrite` e `read` | ok | `createCustomer` con i due ruoli; `read` legge e non scrive (13); `ensureCustomer` su nome esistente (`updateUser` con ruoli e password) read→readWrite; `setCustomerPassword`; `listCustomer`; `dropCustomer`; creazione via API con `read` (201) |
| 3 | `lockCustomers` / `unlockCustomers` | ok | dopo il lock `roles: []` per `app` e per l'utente `read`, ruoli salvati in `customData.fenvix.lockedRoles`, `cp_<id>` non toccato, connessione aperta rifiutata (13); dopo l'unlock ruoli originali, `lockedRoles` tolto, la stessa connessione legge |
| 4 | `usersInfo { forAllDBs: true }` su `admin` | ok | `list()` (lo sweep) restituisce il `cp_<id>` del database appena creato |
| 5 | drop di tutti gli utenti prima della cancellazione | ok | `dropAll` → 3 (app, utente cliente, `cp_<id>`), `usersInfo` vuoto; ripetuto → 0; erase via API: `{affected: 1}`, database e utenti spariti |
| 6 | fork | ok | il fork ha solo `app` (`readWrite`) e il suo `cp_<id>` (`readWrite`) sul proprio database; `app` del fork legge i dati dell'origine |
| 7 | restore | ok | restore a un istante tra due scritture → resta solo il primo documento; utenti e ruoli identici prima e dopo |
| 8 | contatori | ok | `tenantStats`: root 0; provisioner, `cp_<id>`, utente cliente → 13. La lettura dell'uso dell'adattatore (`GET /v1/databases/{db}/usage` sulla porta admin) funziona |

**Nessun rifiuto del motore nei flussi del control plane**: non c'è nulla da correggere lato control plane per `--grantable-roles`. Coincide con la decisione D1 del report del motore (`cp_<id>` deve essere definito sul database cliente: lo è, `credentials.ts` usa `authSource = db_<hex>`).

### 3.3 Contatori d'uso: chi li legge, con quale comando, con quale utente (nessuna modifica)

* **Comando**: HTTP `GET /v1/databases/{db}/usage?from=<giorno>&to=<giorno>&storage=false` e `GET /v1/databases/{db}` (stato, byte) sulla **porta admin** del motore. Codice: `src/engine/real.ts`, metodo `usage` (righe ~365-395 del branch); chiamato da `syncAllUsage` in `src/services/usage.ts` (riga ~319, `s.engine.usage(...)`), avviato dal timer di `src/app.ts` (righe ~197-204, ogni `usageSyncSeconds`).
* **Utente**: nessun utente MongoDB. È il **token bearer** della porta admin (`ENGINE_ADMIN_TOKEN_FILE`), passato da `AdminHttp`; la rotta è nella lista ammessa (`"usage"` in `admin-http.ts`).
* **Ruolo**: nessuno (la porta admin non usa ruoli SCRAM).
* **`tenantStats`**: non compare in nessun file del repository (`git grep -i "tenantStats\|dbStats\|collStats\|serverStatus"` su `cp-engine-round2`, codice escluso `.md`: nessun risultato; `git grep -i tenantStats origin/infra-align`: nessun risultato). L'unico comando "di conteggio" sulla porta dati è `estimatedDocumentCount` del Data Explorer (come `cp_<id>`, `readWrite` sul suo database), che conta documenti, non uso.
* Letto nel motore (`cmd.rs` `tenant_stats`, README di `engine-round2`): `tenantStats` dà contatori **di tutto il processo** (lettori, scrittori, lease, TTL, richieste S3), non per database; quelli per database (comandi, risvegli, byte) sono in `ctl/usage.rs`, cioè la rotta `/usage` che il control plane usa già.
* **Conflitto: nessuno oggi.** Il control plane non ha bisogno di root. Ci sarebbe un conflitto solo se un giorno volessi i contatori di processo di `tenantStats` nel control plane: richiederebbero root sulla porta dati, e la password di root non è sul server. In quel caso la strada giusta è chiedere al motore una rotta sulla porta admin, non dare root al control plane. Confermato anche dal test 8 sopra (provisioner e `cp_<id>` → 13).

### 3.4 Compatibilità senza il flag
Suite completa sul branch con lo stesso motore **senza** `--grantable-roles`: **80: 78 ok, 0 falliti, 2 saltati** (gli stessi due), e `grantable-roles.test.ts` saltato per intero (non conta come test: nessuna variabile). Il test "d." in questo caso verifica ancora che, senza il flag, il motore permetta i ruoli fissati prima: il control plane funziona con il motore `engine-round2` con o senza il flag.

## 4. Altri test

| suite | prima (`3281c90`) | dopo |
|---|---|---|
| typecheck control plane | ok | ok |
| unit control plane | 138/138 | **140/140** |
| integrazione control plane (Postgres 16 locale, migrazioni applicate due volte) | 352: 351 ok, 1 saltato | **353: 352 ok, 1 saltato** |
| engine-real (motore con il flag) | 79: 74 ok, 2 falliti, 2 saltati, 1 todo | **89: 87 ok, 2 saltati** |

Il saltato dell'integrazione è il test dei 3.000 database (serve `SEEDED_DATABASE_URL`). Dashboard: non modificata (nessun testo da cambiare: `DatabaseNetwork.tsx` dice solo "Unblock", letto), quindi non ho rieseguito typecheck/Playwright della dashboard.

**Test modificati di proposito** (comportamento del motore cambiato, nessuno allentato): `final-engine.test.ts` (d. con il flag; h. non più todo), `network.test.ts` (scenario "liste dei clienti" con soglia 100), `real-engine.test.ts` ("full run" controlla anche la query; rotte di sblocco con `?database=`). Aggiunti: `engine-proc.ts` (`ENGINE_E2E_GRANTABLE_ROLES`), `sim-engine.ts` (`seenQueries`, `?database=`, motore vecchio), `grantable-roles.test.ts`, un test in `ip-allowlist.test.ts`, uno in `network.test.ts`. README del control plane: come avviare la suite con il flag.

## 4b. Parte 3 (riassunto; dettagli nella sezione 12 di `infra/report-infra-align.md` sul branch `infra-grants`)
* `GRANTABLE_ROLES = ['read', 'readWrite', 'dbAdmin']` in `infra/lib/engine-command.ts`, accanto a `TRUSTED_NETWORKS`; `--grantable-roles=read,readWrite,dbAdmin` ultimo flag di `engineArgs`. README (sezione "Grantable roles", soglie 100/5) e test.
* `tsc --noEmit` ok; jest **172 + 1 saltato → 176 + 1 saltato** (nuovo `test/grantable-roles.test.ts`, 4 test, falliva prima del codice; `engine-command.test.ts` aggiornato con il flag); `cdk synth --quiet` con `env -i` e proxy morto: esito 0 con e senza versioni, solo i 2 W3010 noti, flag presente una volta nel boot script decodificato dal template.
* **User data**: 15.693 → **15.718 byte** (+25), **margine 666 byte** su 16.384 (dominio lungo 15.798, margine 586; nel template sintetizzato con 90 byte per ciascuno dei 3 id CloudFormation 15.853, margine 531). Misure dal `USER DATA SIZE` stampato da `test/user-data.test.ts` e dal template, "prima" rifatte su `8ca5194` con gli stessi valori.

## 5. Decisioni che servono a te

1. **[Deciso: prima il motore, scritto nella checklist di deploy, sezione 8]** **Ordine di rilascio**: aggiornare **prima il motore** (`engine-round2`), poi il control plane. Con un motore vecchio lo sblocco del nuovo control plane risponde 503, ma il motore vecchio ha già tolto tutti i blocchi dell'indirizzo (ignora il parametro): il controllo fa vedere l'errore, non lo evita.
2. **[Deciso: solo a mano con il token admin, procedura nella checklist, sezione 8]** **Blocco globale (100 errori)**: il cliente non lo vede e non può toglierlo (giusto: riguarda anche altri clienti); il control plane ora non può più nemmeno mandare lo sblocco globale (rotta rifiutata). Resta solo il supporto, con il token admin a mano. Va bene così, o vuoi una procedura/rotta interna di supporto?
3. **[Deciso: tolto, flag `read,readWrite`, sezione 8]** **`dbAdmin` nella lista**: il control plane concede solo `read` e `readWrite`. `dbAdmin` include `dropDatabase` sul database; nessun nostro flusso lo usa. Ti consiglio `read,readWrite` (anche il motore lo propone, D8). Ho messo `read,readWrite,dbAdmin` come chiesto.
4. **Protezione del control plane** (`auth-guard.ts`: 3 per database, 8 in tutto): era tarata sulla soglia globale 10. Con 100 è più prudente del necessario; non l'ho cambiata (funziona, e una password del provisioner sbagliata blocca ancora `admin` a 5). Si può alzare il totale se serve, ma non lo consiglio senza motivo.
5. **Hash del binario** diverso dal riferimento (vedi 1): se serve identità bit per bit, va compilato sulla stessa macchina/percorso del report del motore.
6. **[Autorizzato ed eseguito, sezione 8]** **Profilo production** (MinIO, lease, `--log-commands`) e **pymongo**: non eseguiti, perché richiedono di scaricare MinIO (sorgenti Go) e pymongo (PyPI), che in questa sessione non mi hai autorizzato. Se vuoi, li eseguo.

## 6. Cosa NON ho potuto verificare
* ~~Profilo production e test pymongo~~: eseguiti nella seconda revisione (sezione 8).
* S3 vero, AWS, IPv6 da un client vero, più processi del motore o del control plane, carico: nessuna prova.
* Lo sblocco per database su un motore vecchio: provato solo con il motore simulato (`unblockIgnoresDatabase`), non con un binario vecchio vero.

## 7. Commit
* `origin/cp-engine-round2` (da `3281c90`): `52f2195` (Parte 1: codice, documenti, test), `2810895` (Parte 2: test con `--grantable-roles`), e il commit che aggiunge questo report e la riga del README.
* `origin/infra-grants` (da `8ca5194`): `4509c9b` (Parte 3: costante, flag, test, README, sezione 12 del report).

## 8. Seconda revisione (tue decisioni)

**Cosa ho fatto**
* **Lista dei ruoli concedibili `read,readWrite`** (senza `dbAdmin`): in `infra/` su `infra-grants` (sezione 12.6 di `infra/report-infra-align.md`). Qui: la suite usa ora `ENGINE_E2E_GRANTABLE_ROLES=read,readWrite` (README del control plane ed esempi aggiornati); il test "0" di `grantable-roles.test.ts` verifica anche che, quando `dbAdmin` non è nella lista, il provisioner riceva **13** per `createUser` con `dbAdmin` sul database cliente.
* **Checklist di deploy** (`docs/deploy-checklist.md`, che esiste sul branch `infra-grants`, non su `cp-engine-round2`): regola "prima il motore, poi il control plane" (ritorno indietro nell'ordine inverso) e procedura di supporto per togliere un blocco globale a mano, con il token admin letto dal file e passato a `curl` dallo standard input, senza password. La procedura è stata provata su un motore locale con i comandi copiati dalla checklist (cambiati solo percorso del token, indirizzo, senza `sudo`): blocco globale visto (`"database": null`), `{"ip":"127.0.0.1","unblocked":true}`, poi nessun blocco; il token non compare nel log del motore.
* **MinIO e pymongo** scaricati fuori dal repository, in `/home/user/deps`: pymongo 4.19.0 da PyPI in un venv; MinIO compilato da sorgenti con `go install github.com/minio/minio@latest` (modulo `v0.0.0-20260212201848-7aac2a2c5b7c`, go 1.24.7). MinIO su `127.0.0.1:9000`, regione `eu-central-1`, credenziali di prova casuali in un file `0600` fuori dal repository, passate solo alla suite e al motore. Nessuna variabile `AWS_*` del sandbox usata. Dopo le prove: nessuna delle due credenziali in nessun file dei due checkout (ricerca con `grep -r` dei due valori) né nell'output della suite; nessun bucket rimasto in MinIO (la suite li cancella).

**Numeri** (motore `3bcd7e5`, binario `48b82572…`, `--auth --grantable-roles=read,readWrite`):

| suite engine-real | prima revisione (`read,readWrite,dbAdmin`) | ora (`read,readWrite`) |
|---|---|---|
| profilo memory | 89: 87 ok, 2 saltati | **89: 88 ok, 1 saltato, 0 falliti** (pymongo ora eseguito e ok; saltato solo "b. at run time", che esiste solo nel profilo production) |
| profilo production (MinIO, lease, porta admin su 127.0.0.2, `--log-commands`, requireTLS) | non eseguito | **89: 89 ok, 0 saltati, 0 falliti** |

Nel profilo production passano anche il test pymongo e "b. at run time" (sulla porta dati arrivano solo i comandi ammessi durante un ciclo completo). Unit (140/140) e integrazione (353: 352 ok, 1 saltato) non cambiano: la seconda revisione tocca solo test engine-real, `engine-proc.ts` (commento) e README.

**infra** (dettagli in 12.6): `tsc` ok; jest 176 ok + 1 saltato; `cdk synth` esito 0 con e senza versioni; user data **15.712 byte, margine 672** (dominio lungo 15.792; template con i 3 id a 90 byte 15.846, margine 538).

**Cosa ancora NON ho verificato**
* AWS e S3 vero (solo MinIO locale), IPv6 da un client vero, più processi del motore o del control plane, carico.
* La procedura di sblocco globale sul server vero: provata in locale, non con Session Manager, `sudo`, l'indirizzo `172.17.0.1` e `/run/fenvix/admin-token` reali.
* Lo sblocco per database con un binario vecchio vero (solo con il motore simulato).
* L'ordine "prima il motore" è scritto, non automatizzato: `fenvix-artifact` non impedisce di aggiornare prima il control plane.

**Commit della seconda revisione**: su `cp-engine-round2` il commit che aggiunge questa sezione (test, README); su `infra-grants` `8fa0287`.
