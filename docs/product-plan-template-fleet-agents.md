# Piano di prodotto: database da template, migrazioni sulla flotta, utente per agente

**Solo documento.** Nessun codice cambiato, nessuna risorsa AWS/Vercel/DNS, nessun segreto, nessun deploy.
Letto: il repository `Mircoguidetti/fenvix-app`, branch `main` @ `2a07060`. Non letto: il repository del motore
(`fenvix-engine`, branch `journal3z`, PR #1 `round3`): tutto ciò che riguarda il motore è preso da questo repository
(codice dell'adattatore, documenti e file `results-*.md`) e va confermato lì.

**Come leggere i riferimenti.** `percorso:riga` indica il file e la riga di questo repository. I percorsi senza
cartella iniziale sono dentro `control-plane/`. "Non trovato" vuol dire che l'ho cercato e non c'è.

**Due parole usate spesso.**
- *Control plane*: il servizio in TypeScript che riceve le richieste della dashboard e dell'API pubblica, tiene i
  registri in Postgres e dà ordini al motore. È il servizio di questo repository.
- *Motore*: il programma in Rust che contiene i dati dei clienti e parla il protocollo MongoDB. Ha due porte: una
  "dati" (dove si collegano le applicazioni, protocollo MongoDB) e una "admin" (comandi di gestione: crea, fork,
  cancella, ecc., via HTTP).

---

## a) In breve

1. **Si può costruire subito, solo nel control plane:** la macchina delle "migrazioni sulla flotta" limitata a creare
   indici, e un template "a ricetta" (un elenco di raccolte, indici e documenti iniziali applicato a un database nuovo
   e vuoto). Il control plane sa già creare database e parlare MongoDB con ognuno di essi.
2. **Ordine consigliato:** (0) il giro di prova control plane ↔ motore attuale; (1) migrazioni sulla flotta per gli
   indici; (2) database da template a ricetta, costruito sugli stessi pezzi; (3) agenti: chiave per agente limitata a
   certi database, poi utente database per agente; (4) ciò che richiede il motore.
3. **Il fork così com'è non basta come template**, salvo casi semplici: funziona solo dentro la stessa organizzazione
   e la stessa regione, copia anche le etichette della sorgente, e in modalità `clone` impedisce di cancellare il
   template finché esiste anche un solo database creato da lui.
4. **Validatori, registro delle azioni sui dati per agente, consumi per agente e "annulla per agente" dipendono dal
   motore.** Nel codice di oggi il motore conta i consumi per database e per giorno, non per utente, e il control
   plane non vede le azioni fatte dalle applicazioni sulla porta dati.
5. **Il rischio più grande:** una migrazione che rovina centinaia di database insieme. Si previene con: prova a
   secco, poche decine di database prima di tutti gli altri, arresto automatico al primo fallimento oltre una soglia,
   solo operazioni che si possono ripetere senza danni.
6. **Secondo rischio:** il collegamento al motore vero del repo `fenvix-engine` non risulta provato da questo
   repository (vedi sezione d). Va fatto per primo.
7. **Stima complessiva (solo control plane, fasi 0-3, senza i pezzi che aspettano il motore):** circa 23-39 giornate
   di sessione (2-3 + 6-10 + 9-16 + 6-10). Le ipotesi sono nella
   sezione b; la parte nel motore non è stimata perché non ho letto il suo codice.

---

## Cosa c'è oggi nel codice (fatti, con riga)

### Creazione di un database e operazioni lunghe

- Le operazioni lunghe sono righe della tabella `public.operations`; i tipi ammessi sono solo `create`, `fork`,
  `restore`, `export`, `erase` (`supabase/migrations/0002_control_plane.sql:55`, `src/services/operations.ts:12`).
- **C'è già una coda di lavori in background, con riprese:** un "runner" prende le operazioni in coda o abbandonate
  (`src/services/operations.ts:340-348`, funzione SQL `fenvix_cp_due_operations` in
  `supabase/migrations/0002_control_plane.sql:187-196`, al massimo 200 per giro), le "prenota" con un affitto di 120
  secondi (`src/services/operations.ts:49`, `:368-378`), ritenta fino a 8 volte con attesa crescente fino a 300 secondi
  (`:50-51`, `:396-402`) e, se fallisce per sempre, rimette a posto prima il motore e poi Postgres (`:416-437`).
  Il giro parte ogni 15 secondi per impostazione (`src/config.ts:389`, `OPERATION_SWEEP_SECONDS`).
- Doppioni: mentre un'operazione è in corso, una seconda identica ritrova la prima (`dedupe_key`,
  `src/services/operations.ts:131-169`, indice unico in `supabase/migrations/0002_control_plane.sql:74-75`). In più
  l'intestazione `Idempotency-Key` ripete la prima risposta per 24 ore (`src/idempotency.ts:79-97`,
  `config/limits.json` `idempotencyTtlHours: 24`).
- Creazione: riga in Postgres invisibile (`provisioning`) → database nel motore → utente interno `cp_<id>` → utente
  iniziale del cliente → riga `ready` (`src/services/operations.ts:187-202`, `:519-525`).
- Quote: l'unico limite per piano è `maxDatabases` (`src/services/operations.ts:171-177`), ed è `null` (nessun
  limite) in tutti i piani (`config/plans.json`). Nomi unici per organizzazione (`:179-182`).
- Audit: ogni operazione scrive `database.<tipo>.requested`, `.completed`, `.failed` in `public.audit_log`
  (`src/services/operations.ts:145`, `:391`, `:435`).

### Fork

- Il control plane accetta un fork solo se la sorgente è **della stessa organizzazione** del chiamante e in stato
  `ready` (`src/services/operations.ts:206-211`). Non esiste un modo per fare un fork da un'altra organizzazione.
- Il fork nasce **nella stessa regione** della sorgente (`src/engine/types.ts:93-94`; `src/engine/real.ts:205`).
- Il fork **copia le etichette** della sorgente (`src/services/operations.ts:220-223`) e la sua dimensione in Postgres
  (`:217`); riceve utenti suoi, nessun utente della sorgente viene copiato (`:527-533`).
- `ENGINE_FORK_MODE` è `clone` (predefinito) o `copy` (`src/config.ts:206-207`). Il control plane la passa al motore
  così com'è (`src/engine/real.ts:209`). Secondo il README del control plane: `clone` è istantaneo ma la sorgente non
  si può cancellare finché esiste il fork; `copy` è indipendente ma copia ogni oggetto (`control-plane/README.md:75`).
  La modalità vale per tutto il servizio, non per singola richiesta.
- Il motore rifiuta di cancellare un database che ha fork (`has_forks`, `src/engine/real.ts:109`) e rifiuta un `copy`
  da un fork `clone` non ancora indipendente (`source_is_shallow_fork`, `:110`). Non esiste un'operazione per
  "staccare" un fork (`control-plane/docs/engine-adapter.md`, domanda aperta 6).
- Il motore finto usato nei test non simula `has_forks`: cancella sempre (`src/engine/fake.ts:153-159`). I test che
  girano senza motore vero non coprono questo caso.
- Tempi del fork misurati: **non trovati** nel repository.
- L'API pubblica (chiavi `fvx_`) **non espone il fork**: solo elenco, creazione, lettura e cancellazione dei database
  (`src/routes/public/index.ts:71-93`). Il fork è solo sulla API della dashboard (`src/routes/data.ts:63-69`).

### Come il control plane parla col motore

- **Porta admin (HTTP):** solo le 18 rotte elencate in `src/engine/admin-http.ts:36-57`. Nessuna rotta per indici,
  validatori o dati. Il motore ha un solo token che apre tutto; il filtro è nel control plane
  (`src/engine/admin-http.ts:11-18`).
- **Porta dati (MongoDB):** due usi.
  - Il "provisioner" crea e cancella gli utenti dei database (`src/engine/users.ts`), con un pool di 2 connessioni
    per regione (`src/engine/users.ts:131`).
  - Il Data Explorer legge e scrive documenti come utente `cp_<id>` del singolo database, con ruolo `readWrite`
    (`src/engine/users.ts:90`, `:196-207`; `src/engine/data-mongo.ts:41-147`). Un client per database, al massimo
    100 aperti insieme (`src/config.ts:290`), 5 connessioni per client, comando con limite di 10 secondi
    (`src/config.ts:286`), collegamento entro 5 secondi (`:296`).
- L'interfaccia della porta dati offre solo: elenco raccolte, conteggio stimato, ricerca, inserisci, sostituisci,
  cancella un documento (`src/engine/data.ts:74-92`). **Non c'è** creare indici, impostare validatori, aggiornare molti
  documenti.
- Un database addormentato si sveglia quando riceve un comando che lo nomina (`src/engine/data-mongo.ts:34-36`). Il
  tempo di risveglio non è nel codice; il motore lo riporta solo come dato di consumo (`firstRequestMs`,
  `src/engine/types.ts:43`).
- Ogni client nuovo verso un database fa un accesso (SCRAM). Il control plane si ferma da solo dopo 3 accessi falliti
  per database o 8 per regione al minuto (`src/engine/auth-guard.ts:23`), per non farsi bloccare dal motore (che
  blocca a 5 e 10, `:20`). Un lavoro che apre migliaia di client deve rispettare questo freno.
- I ruoli che un utente può ricevere nel motore di produzione sono solo `read` e `readWrite`
  (`infra/lib/engine-command.ts:65`). Con `readWrite` si creano indici (provato sul motore vero:
  `tests/engine-real/db-users.test.ts:84`). Impostare un validatore in MongoDB richiede `collMod`, che di solito non
  fa parte di `readWrite`; **se il motore supporti i validatori: non trovato**.

### Utenti dei database, chiavi, audit, consumi

- Utente database = utente SCRAM-SHA-256 nel motore, definito sul singolo database, con **un solo ruolo** scelto tra
  `read` e `readWrite` (`src/engine/users.ts:67`, `:237-244`). Permessi per raccolta: **non esistono** (un ruolo
  diverso viene mostrato come `other`, `:79-85`). Massimo 20 utenti per database (`config/limits.json`
  `maxUsersPerDatabase`, controllato in `src/services/db-users.ts:192`). Il control plane non tiene un elenco degli
  utenti: stanno solo nel motore (`src/services/db-users.ts:20-22`).
- Chiavi pubbliche `fvx_`: ruolo `admin` o `read_only` (`src/services/apikeys.ts:16-17`), valide per **tutta
  l'organizzazione**, nessun limite a singoli database (`src/auth/apikeys.ts:27`, `:75`). Massimo 100 chiavi attive per
  organizzazione (`src/services/apikeys.ts:97`). Chi l'ha creata è salvato in `created_by_type`/`created_by` (persona o
  chiave, `supabase/migrations/0010_public_api_keys.sql:38-39`); una chiave creata da una chiave non può essere `admin`
  e scade non dopo la creatrice (`src/services/apikeys.ts:105-112`); revocare una chiave revoca quelle create da lei
  (`supabase/migrations/0010_public_api_keys.sql:18-19`).
- Audit delle azioni di gestione: `public.audit_log`, una riga per cambiamento, nella stessa transazione del cambiamento
  (`src/audit.ts:26-37`), segreti tolti (`:13`). Tipo di attore: `user`, `api_key` o `system`
  (`supabase/migrations/0002_control_plane.sql:100`). Le chiavi `fnx_` della dashboard e `fvx_` dell'API pubblica
  finiscono entrambe come `api_key`: dal solo registro non si distingue quale tabella guardare.
- Audit delle azioni sui dati: **solo** quelle fatte dal Data Explorer (inserisci, sostituisci, cancella), in
  `public.data_audit_log` (`supabase/migrations/0004_data_explorer.sql:18-32`, scritte da
  `src/services/explorer.ts:77-85`). Le azioni che un'applicazione o un agente fa collegandosi alla porta dati con un
  utente database **non sono registrate dal control plane**. Il motore ha un'opzione `--log-commands` (nome del comando
  e database, usata nei test: `results-e2e-final.md`, sezione b); se registri anche l'utente: non trovato.
- Consumi: il motore conta i comandi **per database e per giorno UTC** (`src/engine/real.ts:361-391`), più spazio
  occupato e risvegli. La copia in Postgres è spenta per impostazione (`USAGE_SYNC_SECONDS=0`, `src/config.ts:390`).
  Consumi per utente o per agente: non trovati. CSV mensile per database o per etichetta: `src/services/usage.ts:320`,
  esposto anche all'API pubblica (`src/routes/public/index.ts:139-146`).

### Cose scritte nel codice o nei documenti che frenano

- Il README del control plane dice che l'adattatore "non ha mai parlato col motore vero" (`control-plane/README.md:5`).
  I file `results-e2e-engine.md`, `results-e2e-final.md` e `results-cp-engine-round2.md` raccontano però prove in
  locale contro binari del motore compilati da `Mircoguidetti/test5` (con MinIO al posto di S3). Quindi: provato in
  locale con versioni del motore di `test5`; **mai** contro il repo `fenvix-engine` né contro un motore in AWS.
- Il README e `docs/engine-adapter.md` chiamano il motore `test5`; `docs/scale-out-design.md` cita `fenvix-engine`.
  Quale sia la fonte attuale del motore non è scritto nel codice.
- Nessun `TODO`/`FIXME` in `control-plane/src` (cercato). Le lacune note sono nei documenti:
  `control-plane/docs/engine-adapter.md` (domande aperte 1-15), `control-plane/docs/database-users.md` sezione 11.
- Il limitatore di frequenza è in memoria per singola istanza (`control-plane/README.md:168`).
- `listDatabases` per organizzazione non esiste nel motore (`src/engine/real.ts:198-202`): l'elenco della flotta deve
  venire da Postgres.

---

## b) Le tre funzioni

Le stime sono in **giornate di sessione** (una giornata di lavoro di una sessione di sviluppo come questa). Sono un
mio giudizio, non un dato del codice. Ipotesi comuni: il codice esistente si riusa come descritto; i test si scrivono
con lo stesso stile dei test di oggi; il motore si comporta come nei file `results-*.md`. Non so quanto tempo
richiedano revisione e domande al fondatore: non incluso.

### 1. Database da template

**Per il cliente.** Una piattaforma di agenti prepara un database "modello" (raccolte, indici, magari dati di
esempio). Ogni nuovo utente della piattaforma riceve un database già pronto, senza che la piattaforma debba
rieseguire i suoi script di preparazione.

**Esempio.** `POST /v1/public/databases { "name": "cliente-4821", "region": "eu-central-1", "template": "crm-v3" }`
→ il database nasce con le raccolte `contatti` e `note`, l'indice su `email`, e tre documenti di benvenuto.

**Due modi possibili (decisione del fondatore, vedi f):**

| | A. Ricetta | B. Fork del database modello |
|---|---|---|
| Cos'è | Un elenco salvato in Postgres: raccolte, indici, documenti iniziali. Applicato a un database nuovo e vuoto. | Il fork di oggi, da un database marcato "template". |
| Motore | Solo porta dati, comandi già provati (creare indici e documenti). | Fork del motore; in `clone` il template non si può più cancellare (`src/engine/real.ts:109`). |
| Tra organizzazioni | Possibile (la ricetta è un testo). | Oggi no (`src/services/operations.ts:206-207`). |
| Regioni | Qualsiasi. | Solo la regione del template (`src/engine/real.ts:205`). |
| Dati iniziali grandi | Lento (si inseriscono uno a uno). | Veloce con `clone`; `copy` copia tutto (`control-plane/README.md:75`). |
| Cambiare il template | Nuova versione della ricetta. | Cambiare il database modello; i fork già fatti non cambiano (da confermare nel motore). |

**Raccomandazione:** A per partire (non dipende dal motore, funziona tra regioni), B come opzione per template con
molti dati, dopo aver risolto il problema della cancellazione.

**Pezzi, in ordine (modo A):**
1. Tabella `database_templates` (organizzazione, nome, versione, ricetta JSON, limiti di dimensione) e regole di
   validazione della ricetta (nomi di raccolta con le regole di `src/explorer/rules.ts`, indici solo di forme ammesse,
   documenti con il limite di `DATA_MAX_DOCUMENT_BYTES`). *Prova:* test unitari sul validatore. 1-2 giornate.
2. Un "client di manutenzione" separato dal Data Explorer, con solo i comandi necessari: `create` raccolta,
   `createIndexes`, `insertMany`. Stesso modo di scegliere il database (`targetDbName`, `src/engine/data.ts:30-33`) e
   stesso utente `cp_<id>`. *Prova:* motore finto + un test sul motore vero (`tests/engine-real`). 2-3 giornate.
   Questo pezzo serve anche alla funzione 2.
3. La creazione accetta `template`: dopo il passo "utente" e prima di `ready` applica la ricetta
   (`src/services/operations.ts:519-525`). Ogni passo ripetibile (indice già esistente = ok; documenti con `_id` fisso
   → duplicato = ok). Se fallisce per sempre, il database viene cancellato come oggi (`:446-456`). *Prova:* test
   d'integrazione con guasti simulati a metà. 2-3 giornate.
4. Esporre nell'API pubblica e nell'OpenAPI (`src/routes/public/index.ts`, `src/routes/public/openapi.ts`), audit
   `database.template.applied`. *Prova:* test del contratto OpenAPI già presenti. 1-2 giornate.

**Totale A:** 6-10 giornate. Ipotesi: dati iniziali piccoli (non so il limite giusto: decisione del fondatore).

**Modo B (dopo):** permettere fork da un database "template" anche via API pubblica; non copiare le etichette;
eventuale modalità per richiesta (`clone`/`copy`) — oggi è unica per servizio (`src/config.ts:206`). Dipende dal motore
per un'operazione "stacca il fork" o per un fork che non blocchi la cancellazione. Non stimato: dipende dalla risposta
del motore.

**Domande aperte:** limite di dimensione dei dati iniziali; template pubblici tra organizzazioni sì/no; aggiornare i
database già creati quando il template cambia (è la funzione 2).

### 2. Migrazioni sulla flotta

**Per il cliente.** Una piattaforma con 5.000 database (uno per suo utente) aggiunge un indice: oggi deve scrivere uno
script che si collega a 5.000 database, gestisce gli errori e ricorda dove è arrivato. Con FENVIX lancia un lavoro e
legge un rapporto.

**Esempio.** `POST /v1/public/migrations { "selector": { "tag": "app=crm" }, "operation": { "createIndex": {
"collection": "contatti", "keys": { "email": 1 }, "unique": true } }, "dryRun": false }` → risposta: id del lavoro.
`GET /v1/public/migrations/{id}` → `{ total: 5000, succeeded: 4990, failed: 3, skipped: 7, items: [...] }`, ogni voce
con database, esito e motivo (per esempio "documenti duplicati su email", "database in cancellazione").

**Disegno minimo su questo codice:**
- Due tabelle nuove: `fleet_jobs` (organizzazione, operazione, selettore, stato, soglia di arresto, chi l'ha lanciato)
  e `fleet_job_items` (una riga per database: stato `pending/running/succeeded/failed/skipped`, motivo, tentativi,
  `retry_at`, `locked_until`). Non riuso `operations` perché il suo vincolo sui tipi
  (`supabase/migrations/0002_control_plane.sql:55`) e il suo modello "una operazione, un database" non reggono migliaia
  di voci; riuso invece lo **stesso schema di prenotazione e ripresa** (`src/services/operations.ts:368-408`).
- L'elenco dei database viene da Postgres, fissato al lancio (il motore non sa elencare per organizzazione,
  `src/engine/real.ts:198-202`). Database in `restoring`/`erasing`/`provisioning` → `skipped` con motivo.
- Ogni voce: blocco della riga del database come fa `src/services/db-users.ts:163-171` (così un erase o un restore non
  parte a metà), poi il comando via il client di manutenzione (pezzo 2 della funzione 1).
- Concorrenza bassa e configurabile (per esempio N database alla volta per regione), sotto il tetto di 100 client
  (`src/config.ts:290`) e il freno degli accessi (`src/engine/auth-guard.ts:23`). Il valore giusto di N: non trovato,
  va misurato.
- Database addormentati: il comando li sveglia. Alternativa: applicare al prossimo risveglio (richiede il motore o un
  segnale di risveglio; non esiste nel codice). Decisione del fondatore.
- Sicurezza: prova a secco (controlla e conta, non cambia nulla); "canarino" (prime K voci, poi pausa o prosegui);
  arresto automatico se i falliti superano una soglia; operazioni ammesse solo da una lista; ogni operazione deve essere
  ripetibile senza danni.
- Audit: `fleet.job.created/paused/finished` in `audit_log`, più l'esito di ogni voce nella tabella delle voci.
- Timeout: il limite di 10 secondi dei comandi (`src/config.ts:286`) è troppo basso per un indice su una raccolta
  grande; serve un limite separato per la manutenzione.

**Operazioni, in ordine di rischio:**
1. `createIndex` — possibile oggi con `readWrite` (`tests/engine-real/db-users.test.ts:84`). Ripetibile: un indice
   identico già presente non è un errore in MongoDB; **nel motore: da verificare**.
2. Validatore — serve `collMod` e un ruolo che oggi non è concedibile (`infra/lib/engine-command.ts:65`); supporto dei
   validatori nel motore: non trovato. **Aspetta il motore.**
3. Backfill (aggiornare molti documenti) — ripetibile solo se scritto bene (per esempio "imposta il campo solo dove
   manca"). Va limitato a forme sicure e a lotti piccoli. Rischio più alto: ultimo.

**Pezzi, in ordine:**
1. Tabelle + migrazione SQL + lettura del rapporto (senza esecuzione). *Prova:* test d'integrazione, isolamento tra
   organizzazioni come `tests/integration/isolation.test.ts`. 2-3 giornate.
2. Runner delle voci con prenotazione, ripresa, concorrenza, arresto a soglia, pausa/riprendi. *Prova:* motore finto
   con guasti iniettati (`failNext` come in `src/engine/users.ts:371`), processo ucciso a metà, due runner insieme.
   3-5 giornate.
3. Operazione `createIndex` + prova a secco + canarino. *Prova:* test sul motore vero con 50-200 database, alcuni
   addormentati, uno con dati che violano un indice unico. 2-4 giornate.
4. API pubblica, OpenAPI, dashboard minima (tabella del rapporto, CSV). 2-4 giornate.
5. Backfill limitato. 2-4 giornate, dopo una decisione sulle forme ammesse.

**Totale (1-4):** 9-16 giornate; con backfill 11-20. Ipotesi: nessuna modifica al motore per gli indici; il motore
regge N database svegliati insieme (non misurato in questo repository).

**Domande aperte:** quanti database svegliare insieme senza disturbare gli altri clienti; costo del risveglio di
migliaia di database (S3, non trovato); comportamento del motore con `createIndex` identico ripetuto e con indice
unico su dati duplicati.

### 3. Utente per agente, audit e consumi

**Per il cliente.** Una piattaforma fa lavorare 30 agenti sullo stesso database del suo cliente. Vuole sapere quale
agente ha cancellato cosa, togliere l'accesso a un solo agente, e fatturare ogni agente per quello che consuma.

**Esempio.** `POST /v1/public/databases/{id}/agents { "name": "agente-fatture", "access": "read" }` → nome utente,
password (una sola volta) e stringa di connessione. Più tardi: `GET .../agents/agente-fatture/activity` e
`GET .../agents/agente-fatture/usage`.

**Come mappare "agente" su ciò che esiste:**
- *Agente = utente database* (consigliato per l'accesso ai dati): esiste già (`src/services/db-users.ts`), è isolato
  dal motore (provato: `results-db-users.md`, l'utente di A non vede B), si revoca subito
  (`src/services/db-users.ts:231-240`). Limiti: un database per utente, solo `read`/`readWrite`, massimo 20 per database.
- *Agente = chiave `fvx_`* (per la gestione: creare database, leggere consumi): esiste, ma una chiave vede tutta
  l'organizzazione. Per un agente bisogna poterla limitare a un elenco di database o a un'etichetta. Nuovo.
- Il registro delle azioni sui dati e i consumi per agente si possono fare solo se il motore sa a quale utente
  attribuire ogni comando.

**Cosa c'è già:** creazione/reset/cancellazione utenti con audit (`database.user.*`, `src/services/db-users.ts:82-90`),
chiavi con scadenza e revoca a cascata, audit delle azioni di gestione per chiave.

**Cosa è nuovo, in ordine:**
1. Una tabella `agents` in Postgres (organizzazione, nome, database, utente motore, stato, creato da). Oggi il control
   plane non tiene l'elenco degli utenti (`src/services/db-users.ts:20-22`): per un agente serve un registro nostro,
   riallineato col motore come fa lo sweep degli utenti interni (`src/services/engine-users.ts`). *Prova:* test con
   motore finto e vero, compreso utente cancellato "alle spalle". 3-4 giornate.
2. Chiavi `fvx_` limitate a database/etichette, e distinzione `fnx_`/`fvx_` nel registro. *Prova:* test di isolamento
   come `tests/integration/public-isolation.test.ts`. 3-5 giornate.
3. Alzare o rendere per piano i limiti 20 utenti per database e 100 chiavi per organizzazione, se il fondatore lo
   decide (`config/limits.json`, `src/services/apikeys.ts:97`). Meno di 1 giornata ciascuno, più una prova sul motore
   vero con molti utenti (comportamento oltre 20 utenti: non trovato).
4. **Motore:** registro dei comandi con utente, database, raccolta, esito (senza contenuti), e un modo per il control
   plane di leggerlo; contatori per utente. Non stimato.
5. Pagine "attività" e "consumi" per agente, dopo il punto 4. 3-5 giornate.
6. Permessi per raccolta e "annulla per agente": **motore**. Il "copia-rivedi-applica" si può avvicinare oggi con il
   fork (copia), ma "applica le differenze" non esiste. Non stimato.

**Totale control plane (1-3, 5):** 9-15 giornate, di cui 3-5 dopo il motore.

---

## c) Dipendenze dal motore

Non ho letto `fenvix-engine` (`journal3z`, PR #1 `round3`): non so cosa offra già.

| Cosa | Può partire adesso nel solo control plane? | Cosa serve dal motore |
|---|---|---|
| Giro di prova (sezione d) | Sì, è il primo passo | Un binario attuale |
| Template a ricetta | Sì | Niente di nuovo (comandi già provati), salvo conferma su `createIndexes` ripetuto |
| Template con fork | Parzialmente | Fork che non blocca la cancellazione del modello, o "stacca fork"; fork tra regioni |
| Migrazioni: indici | Sì | Conferma comportamento indice ripetuto / unico su duplicati; capacità di risvegli in parallelo |
| Migrazioni: validatori | No | Supporto dei validatori + un ruolo concedibile adatto |
| Migrazioni: backfill | Sì, con limiti | Niente, se a lotti piccoli |
| Agenti: registro e chiavi limitate | Sì | Niente |
| Agenti: audit delle azioni sui dati | No | Log per utente esportabile |
| Agenti: consumi | No | Contatori per utente |
| Annulla per agente / applica differenze | No | Probabilmente il journal; da chiedere |

---

## d) Il giro control plane ↔ motore vero

**Dove:** passo 0, prima di qualsiasi funzione che tocchi il motore. Tutto il resto (fasi 1-3) presuppone che create,
fork, utenti e porta dati funzionino col motore che andrà in produzione.

**Cosa:** il "Round trip" già scritto in `control-plane/docs/engine-adapter.md` (sezione omonima) più la suite
`npm run test:engine-real` col profilo `production` (`control-plane/README.md:44-48`), con il binario costruito dal
repo e dal branch che andranno in produzione, in locale con MinIO, senza AWS. Aggiungere tre prove nuove che servono
a queste funzioni: fork in `clone` poi tentativo di cancellare la sorgente; `createIndex` ripetuto e unico su dati
duplicati con l'utente `cp_<id>`; 100 database addormentati svegliati da un ciclo.

**Stima:** 2-3 giornate se il binario si compila come nei report precedenti (5-8 minuti, `results-e2e-final.md`),
di più se le rotte admin sono cambiate.

---

## e) Sicurezza

| Cosa può andare storto | Come lo si previene |
|---|---|
| Un agente vede i dati di un altro cliente | Agente = utente database definito su un solo database (isolamento nel motore, provato); il database si sceglie solo dalla riga Postgres dell'organizzazione (`src/engine/data.ts:25-33`); test di isolamento per ogni rotta nuova. |
| Un agente vede altri database della stessa organizzazione via chiave `fvx_` | Chiavi limitate a database/etichette (nuovo); finché non esiste, non dare chiavi `fvx_` agli agenti. |
| Chiavi o utenti non revocati | Scadenza obbligatoria per le chiavi degli agenti (decisione); revoca a cascata già esistente; registro `agents` riallineato col motore da uno sweep; cancellare un agente = `dropUser` (le connessioni aperte vengono rifiutate, `src/services/db-users.ts:235`). Nota: un reset di password non chiude le sessioni aperte (`control-plane/docs/database-users.md`, sezione 11). |
| Una migrazione rovina molti database | Solo operazioni di una lista; prova a secco; canarino; soglia di arresto; ogni voce ripetibile; niente cancellazioni di raccolte o indici nella prima versione; restore disponibile solo se la finestra di ripristino è attiva (`ENGINE_RETENTION_WINDOW_SECS`, `control-plane/README.md:76`). |
| Template che porta dati di un altro cliente | Ricette per organizzazione; template pubblici solo se il fondatore lo decide e con revisione. |
| Il control plane si fa bloccare dal motore durante una migrazione | Freno degli accessi esistente (`src/engine/auth-guard.ts`); concorrenza bassa. |
| Il token admin unico può tutto (`control-plane/docs/engine-adapter.md`, domanda 12) | Le funzioni nuove usano la porta dati e il filtro delle rotte; non aggiungere rotte admin larghe. |

---

## f) Le 10 decisioni del fondatore

1. **Template: ricetta o fork?** La ricetta non dipende dal motore e funziona tra regioni; il fork è veloce con molti
   dati ma blocca la cancellazione del modello. *Raccomando:* ricetta per partire.
2. **Template condivisi tra organizzazioni (un "negozio")?** Utile alle piattaforme, ma aumenta il rischio di dati
   altrui. *Raccomando:* no nella prima versione.
3. **Quanto possono essere grandi i dati iniziali di un template?** Decide tempi e costi della creazione.
   *Raccomando:* un limite basso all'inizio, deciso dopo il giro di prova.
4. **Quali operazioni nelle migrazioni?** Indici, poi backfill limitato; validatori solo col motore. *Raccomando:* solo
   `createIndex` nella prima versione.
5. **Politica di arresto:** quanti fallimenti fermano tutto, e quanti database nel canarino. *Raccomando:* fermarsi
   presto e chiedere conferma dopo il canarino.
6. **Database addormentati:** svegliarli per migrarli o applicare al prossimo risveglio? Il primo costa risvegli, il
   secondo richiede il motore. *Raccomando:* svegliarli, con concorrenza bassa.
7. **Cos'è un agente?** Un utente database (accesso ai dati), una chiave limitata (gestione), o entrambi.
   *Raccomando:* entrambi, collegati nello stesso registro.
8. **Servono permessi per raccolta?** Oggi solo per database; è lavoro nel motore. *Raccomando:* chiedere a 3-5
   clienti prima di farlo.
9. **Registro delle azioni sui dati:** cosa registrare (solo scritture o anche letture), per quanto, chi paga lo
   spazio. *Raccomando:* solo scritture, senza contenuti.
10. **Limiti e prezzi per agente:** alzare 20 utenti per database e 100 chiavi per organizzazione? Fatturare per
    agente? (Oggi i piani non hanno né prezzi né limiti, `config/plans.json`.) *Raccomando:* decidere dopo i primi
    clienti, ma alzare subito i limiti se il motore regge.

---

## g) Domande aperte e fatti non verificati

**Domande aperte**
- Quale repository e branch del motore andrà in produzione (`test5` nel codice, `fenvix-engine` nella richiesta)?
- Cosa contiene il journal a 3 zone (`journal3z`) e la PR #1 `round3`, e se rende possibile "annulla per agente".
- Il motore supporta validatori (`collMod`, `$jsonSchema`)?
- `createIndexes` identico ripetuto: ok o errore nel motore? Indice unico su dati duplicati: quale errore?
- Quanti database possono essere svegliati insieme, e quanto costa un risveglio?
- Dopo un fork `clone`, una modifica alla sorgente compare nel fork? (Il motore finto condivide gli stessi documenti
  tra sorgente e fork, `src/engine/fake.ts:119`; il comportamento vero va verificato.)
- Il motore regge più di 20 utenti per database, e migliaia di utenti per regione?
- Il motore può registrare l'utente di ogni comando ed esportarlo?

**Fatti non verificati da me**
- Nessun test eseguito: è un lavoro di sola lettura.
- Il codice del motore non letto; i comportamenti del motore vengono dai documenti e dai report di questo repository.
- Tempi di fork, di risveglio e costi S3: non trovati nel repository.
- Lo stato reale di produzione (cosa è deployato, quale `ENGINE_DRIVER` è attivo): non verificato.
- Il README dice "mai provato col motore vero" ma i report descrivono prove locali: non ho rieseguito quelle prove.
