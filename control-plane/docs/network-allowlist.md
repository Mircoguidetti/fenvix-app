# Lista di IP ammessi e limiti di rete (branch `network-tab`)

Branch `network-tab` di `Mircoguidetti/olvix-app`, creato da `origin/e2e-final` @ `bfcee0e` (punta controllata). Una sola
eccezione fuori dal branch: la modifica a `infra/`, come commit su `origin/infra-align` (punta controllata: `7036589`).
Nessun merge, nessuna pull request; `main` e le altre branch non toccate. Nessuna attività AWS, nessun Supabase reale,
nessun segreto reale: le variabili `AWS_*` dell'ambiente sono state tolte da ogni comando (valori mai letti); token,
password e chiavi dei test sono casuali e temporanei; MinIO locale con credenziali di prova generate sul momento.
Screenshot rigenerati da Playwright e poi ripristinati: nessuno screenshot nei commit.

Fonte del motore: `Mircoguidetti/test5`, branch `network-limits`, commit del motore `1c9fee7`, report
`results-network-limits.md` (commit `628273b`), letto per intero prima di scrivere codice; letti anche
`mongo-server/src/ctl/allowlist.rs` e `mongo-server/src/netguard.rs` (regole esatte delle voci e forma delle risposte).

## 1. Hash del binario e flag

* Compilato con `cargo build --release --workspace` (cargo/rustc 1.97.0) dal checkout di `1c9fee7`, 8 min 50 s, nessun
  errore. **SHA-256 di `target/release/mongo-server`: `ffca6a3c9dc78a5cd66500a2cad8ae64dbe9e83be807b6892cfe9ee6087d52d5`.**
* Riferimento: `8b3d7b71e63326d4a6a1913a96ace4fb1e0c3f6efd8ee26161ab48be677632f4`. **Non coincidono.** Il report del motore
  dice che il suo binario è stato fatto con `cargo build --release -p mongo-server`: ho compilato anche così, stessa
  macchina, e ho ottenuto un terzo hash, `90e1883e818f079faf6d99b3caf05cfbea00ecb8305908c482552b92a2864db2` (con
  `--workspace` le feature delle dipendenze si unificano diversamente). Nessuno dei due coincide con il riferimento (altra
  macchina/percorso; la build non è riproducibile bit per bit). Tutte le prove sono state fatte con il binario
  `--workspace` (`ffca6a3c…`). Il motore non è stato modificato.
* Flag usati nelle prove (oltre a quelli già usati dalla suite: `--auth`, `--tls-mode requireTLS`, porta admin con token,
  `--store memory --no-leases` oppure, nel profilo production, `--store s3` su MinIO locale, lease, porta admin su
  `127.0.0.2`): **`--trusted-networks=127.0.0.1/32`** (motore "T": il control plane è fidato) e **`--trusted-networks=`**
  (vuoto, motore "U": nessuna rete fidata). Limiti lasciati ai valori predefiniti del motore (10 errori per indirizzo,
  5 per indirizzo e database, finestra 60 s, blocco 300 s che raddoppia fino a 3600 s).

## 2. Cosa ho costruito

### 2.1 Migrazione `supabase/migrations/0009_ip_allowlist.sql` (non applicata a Supabase reale)
Provata solo su Postgres 16 locale usa-e-getta, applicata due volte (`scripts/prepare-test-db.sh`).
* Tabella `public.database_ip_allowlists`: `database_id` (chiave), `workspace_id`, `entries text[]`, `updated_at`,
  `updated_by_type` (`user`/`api_key`/`system`), `updated_by`. Chiave esterna su **(database, workspace)** verso
  `databases (id, workspace_id)` (nuovo indice unico, banale perché `id` è già chiave) con `on delete cascade`: una lista
  può stare solo nel workspace del suo database e sparisce con lui. Vincoli: al massimo 100 voci; solo i caratteri e la
  forma che il motore accetta (`[0-9a-f.:]/prefisso`).
* RLS e permessi come 0004: RLS attiva, niente per `anon`/`authenticated`, il ruolo `fenvix_control_plane` con la policy
  "workspace = quello della transazione". Provato: con un altro workspace la riga non si vede e l'inserimento è rifiutato
  (anche se la riga viene intestata al proprio workspace).

### 2.2 Endpoint (dettaglio in `api-extensions.md`, sezione "IP allowlist")
| Rotta | Chi | Cosa |
|---|---|---|
| `GET /v1/databases/{id}/ip-allowlist` | tutti i ruoli, chiavi API | lista salvata, `allowAll`, `maxEntries`, data e autore (con nome) dell'ultima modifica, stato del motore (`in_sync` / `different` con la lista del motore / `unavailable`), `enforced`, `dataExplorer.trusted` |
| `PUT /v1/databases/{id}/ip-allowlist` `{entries}` | owner, admin, chiavi API; member **403** | imposta (lista vuota = svuota) |
| `POST /v1/databases/{id}/ip-allowlist/reapply` | owner, admin, chiavi API | rimanda al motore la lista salvata |
| `GET /v1/databases/{id}/network/blocks` | owner, admin, chiavi API; member **403** | indirizzi bloccati **su questo database**: solo `ip`, `until`, `remainingSecs` |
| `POST /v1/databases/{id}/network/unblock` `{ip}` | owner, admin, chiavi API; member **403** | sblocca un indirizzo della lista precedente (altrimenti 404), con audit |

* **Validazione = quella del motore** (`src/engine/netlist.ts`, traduzione di `Net::parse`/`validate_entries`): CIDR
  IPv4 e IPv6 severi (niente spazi, zone, segni, zeri iniziali, bit dopo il prefisso: `10.0.0.1/8` è rifiutato e il
  messaggio dice "la rete è 10.0.0.0/8"), indirizzo singolo → `/32` o `/128`, IPv4-mappato → IPv4, IPv6 minuscolo con la
  sequenza di zeri più lunga come `::`, nessun duplicato dopo la normalizzazione, massimo 100, solo il campo `entries`.
  Il messaggio nomina la voce (`Entry 3 ("1.2.3.4/32/32") ...`) e il campo è `entries[2]`, così la dashboard può
  indicarla. **Prova**: 130 voci e 7 liste mandate sia al motore vero sia al control plane: stessa risposta per ognuna
  (accettata/rifiutata e forma normalizzata).
* **Ordine**: chi (http.ts) → voci → riga del database bloccata (`for update`) → **motore** → salvataggio e audit nella
  stessa transazione. Motore che rifiuta → 400 "The database engine refused the list. Nothing was changed."; motore che
  non risponde → 503 "The database engine did not answer. Nothing was changed."; in entrambi i casi nulla salvato e
  tentativo nell'audit con `outcome: failed`. Database in restore o erase → 409.
* **Divergenza** (decisione mia): se il motore accetta ma Postgres fallisce, il control plane rimette subito nel motore
  la lista precedente; se anche questo fallisce, o se la lista nel motore cambia per altre vie, ogni lettura confronta le
  due liste (ordine ignorato) e restituisce `engine.status: "different"` con la lista del motore; la dashboard lo mostra e
  offre **"Apply again"** (`reapply`, con audit `before` = lista del motore, `after` = lista salvata). La lista salvata è
  quella che la pagina mostra. Non c'è una riconciliazione periodica automatica (vedi decisioni).
* **Audit**: `database.ip_allowlist.set` / `.reapply` con `before` e `after` (fino a 100 voci: il limite degli array
  nell'audit è passato da 50 a 100), `database.network.unblock` con l'indirizzo; chi e quando come per il resto.
* **Fork / erase / restore / create**: il fork non eredita (nessuna riga nel control plane, nessuna lista nel motore);
  l'erase cancella la riga (cascade) e il motore cancella il record; il restore non tocca nulla; un database ricreato con
  lo stesso nome parte senza lista. Provato con il driver fake (integrazione) e con il **motore vero** (engine-real).
* **Driver fake**: `FakeEngine` simula la stessa interfaccia (liste, blocchi, sblocco, reti fidate, errori iniettabili),
  con le stesse regole di validazione.
* **Blocchi**: il control plane legge `GET /v1/network` del motore e tiene **solo** i blocchi del database chiesto, e di
  ognuno solo indirizzo e scadenza (mai nomi utente né password: il motore non li registra; nemmeno contatori,
  connessioni o altri database). Lo sblocco chiama `DELETE /v1/network/blocks/{ip}` (per un blocco IPv6 mostrato come
  `/64` manda l'indirizzo di rete).

### 2.3 Dashboard: scheda "Network" (`src/components/DatabaseNetwork.tsx`)
* "IP allowlist" con il testo "Only these addresses can connect to the database. The dashboard's Data Explorer is not
  affected by the list."; riepilogo **"All IP addresses are allowed."** per la lista vuota, altrimenti "N addresses and
  networks can connect. Every other address is refused.".
* Add / Remove su una bozza, **Import** (molte voci, una per riga o separate da virgole o spazi, `#` per i commenti, ogni
  riga sbagliata indicata con il suo numero), **Save list** solo dopo una conferma esplicita: il dialogo dice che FENVIX
  non può vedere l'indirizzo delle applicazioni del cliente, che se non è nella lista smettono di funzionare e che dopo
  qualche tentativo quell'indirizzo viene bloccato; il pulsante resta disattivato finché non si spunta "I have checked that
  the addresses of my applications are in the list". **Clear list** con conferma. Errori sull'input con il motivo
  ("has address bits set after the prefix length. The network is 10.0.0.0/8: use that, or a longer prefix.").
* Lista diversa nel motore: avviso con la lista del motore e **Apply again**. Motore che non risponde: errore e
  "Try again".
* "Blocked addresses": indirizzo e scadenza, **Unblock**, **Refresh**. Un member vede la lista in sola lettura e non
  vede i blocchi.
* Telefono: le voci IPv6 lunghe vanno a capo, i pulsanti si allargano; un controllo Playwright verifica che nessun
  pulsante, campo o voce esca dallo schermo (anche nei dialoghi) e che la pagina non scorra in orizzontale, a 390 px e a
  1440 px. Testi in inglese, "IP allowlist" ovunque; un controllo verifica che la scheda non dica "private network",
  "VPN" o "whitelist".

## 3. Punto 3: Data Explorer e provisioner con la lista attiva

**Come ho simulato la rete.** Tutto sul loopback del sandbox: il control plane (Data Explorer, provisioner, chiamate
admin) si collega dal **127.0.0.1**, che rappresenta la rete Docker del container sul server; "l'applicazione del
cliente" si collega dal **127.0.0.2** (driver Node con `localAddress`), un indirizzo esterno. Motore **T** con
`--trusted-networks=127.0.0.1/32` (il deploy con il flag di `infra/`), motore **U** con `--trusted-networks=` (il deploy
senza il flag, o con una rete Docker che il flag non copre). Test: `tests/engine-real/network.test.ts`.

| caso | risultato sul motore vero |
|---|---|
| (a) lista `203.0.113.0/24` (esclude 127.0.0.2), applicazione con la password **giusta** | rifiutata con **code 18 AuthenticationFailed**, lo stesso codice di una password sbagliata (provato anche quello); con `127.0.0.2/32` nella lista funziona |
| (b) stessa lista (esclude anche il control plane), motore T | Data Explorer: insert 201 e lettura 200; provisioner: creazione utente 201 e reset 200; fork 200; nessun errore del control plane contato dal motore (`failing` vuoto per 127.0.0.1) |
| (c) motore U, stessa lista | la scheda lo sa: `dataExplorer.trusted: false` (il control plane confronta l'indirizzo da cui si collega con le reti fidate del motore); il Data Explorer risponde **503** e il motore **conta** il suo errore su quel database; il provisioner continua finché non è bloccato (si autentica su `admin`, che non ha lista) |

Cosa si rompe senza `--trusted-networks` sul bridge (motore U, misurato):
* la lista di un cliente vale anche per il Data Explorer (non vede più i dati);
* gli errori del control plane vengono contati e portano a blocchi: **senza protezione**, una password del provisioner
  sbagliata (cambiata in SSM e non nel motore) dà 5 errori su `admin` e il motore blocca `127.0.0.1` su `admin` (300 s):
  il provisioner non funziona più per nessun cliente, e anche dopo aver corretto la password nessun database si può
  creare finché il blocco non scade. Con le liste di 3 clienti che escludono il control plane e il Data Explorer usato su
  di esse, al decimo errore il motore blocca `127.0.0.1` **su tutti i database**. Output registrato:
  `{"blocks":[{"ip":"127.0.0.1","database":"admin",...,"strike":1}]}` e `{"blocks":[{"ip":"127.0.0.1","database":null,...}]}`.

Nota sul deploy: in `infra/` il container del control plane non è sul bridge predefinito ma sulla rete Docker `fenvix`,
quindi il motore lo vede con un indirizzo di quella rete, non `172.17.0.x`: per questo in `infra/` ho fissato anche quella
subnet e l'ho messa tra le reti fidate (sezione 6).

## 4. Punto 4: il control plane non deve mai bloccarsi da solo

**Quali collegamenti possono incrementare i contatori.** Solo quelli che si autenticano sulla porta dati: il Data
Explorer (`cp_<id>` su `db_<id>`, `src/engine/data-mongo.ts`) e il provisioner (`fenvix_provisioner` su `admin`,
`src/engine/users.ts`). Le chiamate alla porta admin no (non autenticano con SCRAM e non sono soggette a lista e blocchi).
La misura di fiducia (`sourceAddress`) apre una connessione TCP e la chiude senza mandare nulla: non conta. Con il control
plane fidato (motore T) **nulla viene contato**: provato con 12 creazioni fallite per password del provisioner sbagliata,
`failing` e `blocked` vuoti per 127.0.0.1.

**Se il control plane non è fidato, sì, un database (o un errore del control plane) poteva bloccare il provisioner**,
dimostrato dai test "WITHOUT the guard" (sopra): password del provisioner ruotata da una parte sola; liste dei clienti che
escludono il control plane; e, per i database già esistenti, la rotazione della chiave master (`ENGINE_USER_KEY`): prima
il Data Explorer provava la chiave nuova su ogni database non ancora visto, un errore per database.

**Come l'ho risolto, solo dal lato control plane** (`src/engine/auth-guard.ts`, test prima del codice):
* il control plane conta i propri errori di autenticazione come il motore (finestra di 60 s, per motore/regione e per
  database) e smette di autenticarsi **prima** dei limiti del motore: al massimo **3 per database** (motore: 5) e
  **8 in tutto** (motore: 10), di cui il Data Explorer può usarne 6 e **2 restano sempre al provisioner**. Quando si ferma
  risponde "non disponibile, riprova" (503 al Data Explorer, operazione riprovata più tardi per il provisioner): mai un
  blocco del motore;
* un client che non si è ancora autenticato fa un solo tentativo alla volta (gli altri aspettano l'esito), e i tentativi
  in corso occupano il loro posto nel conteggio: un'ondata di richieste non può superare il limite;
* durante una rotazione della chiave master, un database non ancora visto viene provato prima con la versione della
  chiave che ha funzionato per ultima: **una** rotazione costa circa un errore, non uno per database (misurato: 8
  database letti, 1 errore);
* un errore su un client già autenticato (password o lista cambiata sotto di lui) viene contato lo stesso.

Prova (motore U, stesse prove "WITH the guard"): password del provisioner sbagliata → 3 errori su `admin`, nessun blocco,
e appena corretta la password il primo create funziona; liste che escludono il control plane → 6 errori in tutto (2 per
database), nessun blocco; rotazione → 1 errore, nessun blocco.

**Correzione durante il lavoro.** Con i primi limiti (2 per database, 6 in tutto) la suite engine-real completa ha
trovato un caso legittimo bloccato dalla protezione stessa: nella prova di rotazione di `security.test.ts`, lo stesso
database fallisce una volta con la chiave nuova (prima dello sweep) e una volta con la vecchia (dopo lo sweep, su una
connessione nuova), e il terzo tentativo, quello giusto, veniva rifiutato. Ho portato i limiti a 3 e 8 (2 riservati):
restano sotto 5 e 10 anche contando i tentativi in corso, e la prova casuale lo conferma. Ho adattato un mio test
unitario che dava per scontato il limite 2. Una prova casuale (200 sequenze da 400 passi,
`tests/unit/auth-guard.test.ts`) verifica che in nessuna finestra di 60 s si arrivi a 5 per database o 10 in tutto.
Limite: il conteggio è per processo; con N istanze del control plane dietro lo stesso indirizzo i limiti si sommano
(oggi `infra/` ne ha una per regione).

## 5. Test: numeri prima e dopo

"Prima" = codice di `bfcee0e` (e, per il motore, lo stesso binario nuovo `ffca6a3c…`); "dopo" = `network-tab`.

| Suite | Prima | Dopo |
|---|---|---|
| Control plane typecheck | ok | ok |
| Control plane unit | 119/119 | **138/138** (+8 regole delle voci e copia della dashboard, +6 protezione, +5 adapter) |
| Control plane integrazione | 316: 315 ok, 1 saltato (eseguito alle 09:15 UTC; con l'orologio alle 03:10 UTC `usage.test.ts` falliva: 2 righe invece di 3) | **352: 351 ok, 1 saltato** (+36 `ip-allowlist.test.ts`) — vedi sotto per l'ora |
| engine-real, profilo memory | 66: 64 ok, 1 saltato, 1 todo | **79: 77 ok, 1 saltato, 1 todo, 0 falliti** (+13 `network.test.ts`) |
| engine-real, profilo production (MinIO, lease, admin separato) | 66: 65 ok, 1 todo | **79: 78 ok, 1 todo, 0 falliti** |
| Dashboard typecheck | ok | ok |
| Dashboard unit | 28/28 | **32/32** |
| Dashboard Playwright (`npm run check`) | 48 + 10 controlli, screenshot ok | **48 + 10 + 12** controlli (i 12 nuovi falliscono tutti sulla dashboard di `bfcee0e`), screenshot ok (2 schermate nuove, axe compreso) |
| infra | tsc ok; jest 141 ok, 1 saltato | tsc ok; jest **146 ok, 1 saltato**; `cdk synth` ok |

* Il saltato dell'integrazione è il test dei 3.000 database (serve `SEEDED_DATABASE_URL`); il todo di engine-real è la
  lacuna del motore su `rotateCertificates` con `--auth` (invariata); il saltato del profilo memory richiede
  `--log-commands` del profilo production.
* **Ordine dei test**: `ip-allowlist.test.ts` (36 falliti su 36 prima del codice), `tests/unit/ip-allowlist.test.ts`
  (modulo assente), `network.test.ts` (prima del collegamento della protezione: i test "WITH the guard" fallivano con
  `blocks: [{"ip":"127.0.0.1","database":"admin"}]`), `infra/test/trusted-networks.test.ts`, i controlli Playwright (12
  su 12 falliti sulla dashboard di base). `tests/unit/auth-guard.test.ts` l'ho eseguito per la prima volta insieme al
  modulo: la prova "prima" del punto 4 è quella engine-real.
* **Test modificati di proposito** (comportamento cambiato): `contract.test.ts` (le 5 rotte nuove sono estensioni
  documentate); `real-engine.test.ts` (rotte ammesse nuove nella lista e nel giro completo); `infra/test/engine-command.test.ts`
  (l'elenco esatto dei flag ora ha `--trusted-networks`). Aggiunti, non cambiati: `sim-engine.ts` (le rotte nuove del
  motore), `engine-proc.ts` (flag in più per il motore), `common.ts` (una protezione per ogni "mondo" di test), una
  verifica in `orgs-checks.mjs` (member sulla scheda Network). Nessun test esistente è stato allentato.
* **`usage.test.ts`** (commit separato `7ceaabe`): la sincronizzazione ora usa le 12:30 UTC di oggi invece dell'ora
  attuale, così l'ora d'uso di 30 ore prima è sempre nella finestra. Verificato con l'orologio del processo spostato alle
  03:10 e alle 23:50 UTC e con l'orologio vero: 34/34 in tutti e tre i casi (prima: fallito alle 03:10).
* **Scansione dei segreti** su tutti i file nuovi e modificati (`olvix-app` e `infra/`): chiavi AWS, chiavi private,
  token GitHub/Slack/Google/API, JWT, URL con password, e i valori delle credenziali MinIO di questa sessione:
  **nessun risultato** (43 file in `olvix-app`, 6 in `infra/`).

## 6. Modifiche a `infra/` (commit `61e1378` su `origin/infra-align`, sopra `7036589`)
* `--trusted-networks=127.0.0.0/8,::1/128,172.17.0.0/16,172.18.0.0/24` all'avvio del motore (`TRUSTED_NETWORKS` in
  `lib/engine-command.ts`).
* La subnet del bridge predefinito era già fissata (`bip` `172.17.0.1/16` → `172.17.0.0/16`; `172.17.0.1` è dentro,
  verificato da un test). **Trovato**: il control plane non è su quel bridge ma sulla rete `fenvix` (serve a Caddy per
  raggiungerlo per nome), la cui subnet **non era fissata**; il motore vede il control plane con l'indirizzo di quella
  rete. Fissata a `172.18.0.0/24` nello stesso file del bridge, creata con `--subnet` in entrambe le unità, con un
  controllo all'avvio (`fenvix-check-network`) che ferma control plane e Caddy se la rete esiste con un'altra subnet.
* Test nuovo `test/trusted-networks.test.ts`; README (sezione "Trusted networks", verifiche nello Step 9); report
  `infra/report-infra-align.md` sezione 10.
* User data: da 14.206 a **14.457 byte** (dominio lungo 14.522; limite 16.384): ci stiamo, nessun controllo tolto.
* `tsc --noEmit` ok, jest 146 ok + 1 saltato, `cdk synth` locale con `env -i` e proxy morto: esito 0, template 40,3 KB.
* Attenzione al rilascio: un motore più vecchio di `network-limits` non conosce il flag e non parte.

## 7. Decisioni che servono a te
1. **Blocchi "su tutti i database"** (10 errori da un indirizzo su più database): non li mostro al cliente, perché
   riguardano anche i database di altri clienti; mostro e lascio sbloccare solo i blocchi del suo database. Però lo
   sblocco del motore toglie **tutti** i blocchi e contatori di quell'indirizzo, anche quello globale: un cliente che
   sblocca un indirizzo bloccato sul suo database lo sblocca anche altrove. Alternative: nessuno sblocco self-service
   (solo supporto), oppure chiedere al motore uno sblocco per (indirizzo, database).
2. **Riconciliazione**: oggi la divergenza si vede a ogni lettura e si ripara con "Apply again" (più il ripristino
   immediato se Postgres fallisce dopo il motore). Vuoi anche un passaggio periodico automatico (come quello degli utenti
   del motore) che rimetta la lista salvata?
3. **Chiavi API**: possono leggere e cambiare la lista e sbloccare, come le altre operazioni sui database. Se preferisci
   che la lista si cambi solo dalla dashboard, è una riga per rotta (`apiKey: false`).
4. **Member**: vede la lista (quindi gli indirizzi degli uffici o dei server del cliente). Era la richiesta; se sono
   dati da nascondere ai member, va cambiato.
5. **Audit con gli indirizzi**: `before`/`after` contengono indirizzi IP del cliente, conservati come il resto
   dell'audit (nessuna scadenza oggi).
6. **Protezione del control plane**: limiti 3 per database e 8 in tutto (2 riservati al provisioner) per processo. Con più istanze del control plane
   sullo stesso indirizzo vanno abbassati (o le reti fidate devono essere giuste, come in `infra/`).
7. **Caddy nella rete fidata**: è nella stessa rete Docker del control plane, quindi anche lui salterebbe liste e blocchi
   se si collegasse alla porta dati (oggi non lo fa e non ha password). Separarlo richiede una seconda rete Docker.
8. **Lista vuota = tutti ammessi** e nessuna lista "nessuno ammesso": come il motore (D7 del report del motore: per
   ammettere tutti si può anche usare `0.0.0.0/0` e `::/0`).

## 8. Cosa NON ho potuto verificare
* **S3 vero**: solo MinIO locale (la lista sta nel record dei metadati del database come gli altri campi).
* **IPv6 da un client vero**: il kernel del sandbox non ha IPv6; IPv6 coperto da regole, confronto con il motore sulle
  voci e test unitari, non da una connessione.
* **Rete vera e Docker**: client "esterni" simulati con 127.0.0.2; nessun Docker nel sandbox, quindi il percorso dei
  pacchetti dal container `fenvix` al motore (indirizzo 172.18.0.x) è ragionato, non misurato: dopo il deploy la scheda
  Network lo mostra (`dataExplorer.trusted`) e il README dice come controllarlo.
* **Dietro un NAT**: non provato. Tutti i client dietro lo stesso NAT condividono contatori e blocchi (un'applicazione con
  la password sbagliata blocca per 5 minuti tutti gli altri dello stesso ufficio su quel database).
* **Carico**: nessuna misura (molti tentativi al secondo, molte voci, molti database).
* **Più processi**: del motore (contatori per processo) e del control plane (protezione per processo).
* **Supabase reale**: la migrazione 0009 non è stata applicata a nessun progetto.

## 9. Commit
* `origin/network-tab` (sopra `bfcee0e`): `7ceaabe` (usage.test.ts, separato), `79332fd` (control plane, migrazione, test), `1b83c69` (dashboard), `d5384f1` (limiti della protezione), e il commit che aggiunge questo documento.
* `origin/infra-align`: `61e1378` (sopra `7036589`).
