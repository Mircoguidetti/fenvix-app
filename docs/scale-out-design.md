# FENVIX: crescere in orizzontale (progetto)

**Solo documento.** Nessun codice, nessuna risorsa AWS, nessuna spesa. Branch `scale-out-design`.

**Fonti:**
- lo stato reale di questo repository (`infra/`, `control-plane/`, `docs/`);
- in `Mircoguidetti/fenvix-engine`: `results-density.md`, `results-aws-test3.md` e `results-round3.md` (branch `round3`).

**Come leggere i numeri.** Ogni numero porta tra parentesi da dove viene:
- **(misurato, MinIO)**: misurato in locale contro MinIO, cioè uno storage compatibile con S3;
- **(misurato, S3)**: misurato su S3 vero da un runner di GitHub, che non è in eu-west-1;
- **(stima)**: un calcolo con le ipotesi scritte accanto.

## 0. In breve: la raccomandazione

1. **Un Network Load Balancer (NLB) in TCP puro davanti a N nodi uguali.** Il TLS resta sul motore e l'IP del client viene preservato.
   - Ogni nodo accetta qualunque connessione e legge il nome host dal TLS (SNI). Il nome host esiste già: uno per database, `<nome>-<workspace>.<region>.db.<dominio>`.
   - Se il database vive su un altro nodo, il nodo **inoltra il flusso TCP così com'è** al nodo proprietario, dentro la VPC, aggiungendo l'intestazione PROXY v2 con l'IP vero del client.
   - Nessun DNS per database, nessun router separato, nessuno stato nel load balancer.
2. **Il lease su S3 resta la verità** su chi possiede un database. Il registro in Postgres (`placements`) è solo un indirizzo veloce: se è sbagliato si fa un salto in più o un tentativo in più, ma non si rompe mai nulla.
3. **I driver vedono un replica set di un solo membro**, con nome host annunciato uguale a quello della connessione.
   - Così ottengono le scritture e letture ritentabili, che coprono lo spostamento di un database e il riavvio di un nodo.
   - Ottengono anche le transazioni e i change stream, oggi spenti in produzione (`--replica-set` vuoto).
4. **Capacità.**
   - Nodi non burstable, per esempio `c7g.large`.
   - Margine: CPU sotto il 60-70% a regime.
   - Immagine pre-costruita (AMI) e una riserva di nodi fermi già pronti (warm pool), così un nodo nuovo serve in circa 1 minuto.
   - Si scala prima dei picchi noti (a orario) e quando i segnali di saturazione salgono, non quando arrivano gli errori.
5. **Vicino rumoroso:** nessuna quota che rifiuti il traffico normale.
   - Coda equa tra database, solo quando il nodo è saturo.
   - Tetti di sicurezza altissimi, solo contro gli abusi.
   - Metriche per database, già presenti nel motore del branch `round3`.
   - Un database pesante si **sposta**, non si rallenta.
6. **Ordine di lavoro.**
   - (a) oggi: 1 nodo, nessun cambiamento;
   - (b) prima del primo cliente grosso: 2-3 nodi dietro NLB, con inoltro, registro, spostamento e i due test di carico;
   - (c) dopo: crescita automatica.
7. **Registro di scrittura condiviso tra database:** non ora. Risparmia richieste S3 solo con molti database piccoli attivi insieme. Rende più difficili lo spostamento, il ripristino di un solo database e la cancellazione di un cliente (sezione 8).

## 1. Stato di oggi (dal codice)

```
                Internet
                   │  27018 (Mongo, TLS)      443 (dashboard/API)
                   ▼                           ▼
        ┌──────────────── EC2 t3.medium (eu-west-1a, 1 EIP) ────────────────┐
        │  fenvix-engine (systemd)  ←admin 172.17.0.1:8443→  control plane  │
        │      │                                             (Docker+Caddy) │
        └──────┼────────────────────────────────────────────────────────────┘
               ▼
        S3 fenvix-<env>-data-<account>-<region>   (un prefisso per database)
```

Cosa c'è:
- **Un solo nodo per regione.** Un `ec2.Instance`, non un gruppo di autoscaling; immagine Amazon Linux 2023, installata da user data (`infra/lib/fenvix-stack.ts`).
- **Rete.**
  - Un solo IP elastico. DNS jolly `*.<region>.db.<dominio>` verso quell'IP.
  - Nessun load balancer, apposta, perché il motore veda l'IP del client.
- **Systemd:** il servizio ha `LimitNOFILE=65536`. Le opzioni del motore sono in `infra/lib/engine-command.ts`:
  - `--idle-secs 60`, `--retention-window-secs 604800`, `--wal-gc-mode bulk`;
  - modalità standalone, `--process-lease` spento.
- **Control plane.**
  - Parla a un solo indirizzo di amministrazione per regione (`ENGINE_ADMIN_ENDPOINTS`).
  - Tiene solo la colonna `databases.region`: **non c'è un registro dei nodi**.
- **Stringa di connessione:** `mongodb://u:p@<nome>-<ws>.<region>.db.<dominio>:27018/db_<hex>?tls=true&authSource=…`, senza `replicaSet` e senza `directConnection`. Oggi il nome host non decide nulla: tutti arrivano allo stesso nodo.
- **Piani.** Free, Managed e Dedicated esistono solo come etichette in `control-plane/config/plans.json`, con prezzi e limiti nulli.
- **Allarmi.** Esiste solo il recupero automatico di EC2. Nessuna metrica e nessun allarme di capacità.
- **Niente è ancora installato su AWS** (`infra/README.md`).

Quanto regge un nodo oggi (`results-density.md`; i numeri vengono da un t3.medium simulato con 2 CPU):
- **(misurato, MinIO):** 500 database a 1 richiesta/s con il 65% di un core; 2000 database aperti in 1,2 GB.
- **(stima):** 100-150 database attivi con traffico continuo per t3.medium, a causa della CPU alla base del t3 (che non è burstable all'infinito) e della memoria.
- **Branch `round3`:** la memoria ora ha un tetto (memtable, cache condivisa, log dei change stream) e il costo S3 di un database attivo è sceso (vedi `results-round3.md`).

## 2. Instradamento: come una connessione arriva al nodo giusto

Vincolo: **un database vive su un solo nodo alla volta.** Il nodo tiene il lease su S3 e ha il fencing; chi non lo tiene risponde con l'errore ritentabile 134.

### Opzione A: NLB e inoltro tra nodi (scelta)

```
 client ──TLS──► NLB :27018 (TCP, preserva IP client, cross-zone)
                  │ (un nodo qualunque)
                  ▼
            ┌─ nodo 2 ─┐   legge SNI dal ClientHello (senza decifrare)
            │ SNI = orders-1a2b3c4d.eu-west-1.db.fenvix… → db_…  │
            │ registro locale: db_… vive su nodo 5                │
            └────┬──────┘
                 │ TCP interno :27019 (PROXY v2 con IP client), byte per byte
                 ▼
            ┌─ nodo 5 ─┐  termina TLS, autentica, serve (possiede il lease)
            └──────────┘
```

- **Come funziona.**
  - Il nodo che riceve la connessione legge il primo messaggio TLS (ClientHello) fino all'estensione SNI, senza decifrare nulla.
  - Ricava il database dal nome host: la parte `<nome>-<workspace>` si traduce nel database tramite il registro.
  - Se il database è suo, termina il TLS. Altrimenti apre una connessione interna al proprietario e copia i byte nei due sensi.
  - Il proprietario termina il TLS, perché il certificato jolly è lo stesso su ogni nodo, e riceve l'IP vero del client dall'intestazione PROXY v2.
  - Così le liste di IP consentiti per database e i blocchi per IP continuano a funzionare.
- **Pro.**
  - Nessuno stato fuori dai nodi; un solo indirizzo pubblico (il NLB).
  - Uno spostamento non tocca il DNS: la connessione nuova arriva su un nodo qualunque e va al proprietario nuovo.
- **Contro.**
  - Con N nodi, (N-1)/N delle connessioni fa un salto in più dentro la stessa zona: frazioni di millisecondo e il doppio del traffico di rete interno **(stima)**. Il traffico di FENVIX è piccolo (documenti, non file).
  - Serve un lavoro nel motore: lettura dello SNI, inoltro, PROXY v2, porta interna.
- **Correttezza.** Se il registro è vecchio, il nodo "sbagliato" risponde subito "non sono io" (non tiene il lease), il mittente rilegge il registro e, al limite, l'oggetto del lease su S3 (`tenants/<db>/_lease`). Non è mai servito un dato sbagliato: decide il fencing.

### Opzione B: router per nome host (DNS per database, o un livello di proxy)

- **B1, un record DNS per database** verso l'IP del nodo proprietario.
  - Niente salto in più.
  - Ma ogni spostamento cambia il DNS. Resolver e driver tengono in cache (TTL, connessioni già aperte), quindi per un tempo da 30 s a qualche minuto i client nuovi vanno al nodo vecchio. Serve comunque l'inoltro come rete di sicurezza.
  - Serve un IP pubblico per nodo: niente NLB, niente zone multiple dietro un solo indirizzo.
  - Migliaia di record da tenere allineati.
- **B2, un livello di proxy che legge lo SNI** (per esempio HAProxy o Envoy) davanti ai nodi.
  - Funziona, ma è un altro pezzo da far scalare e tenere alto, con il suo registro.
  - Fa lo stesso salto della A, in un processo in più.

**Scelta: A.** È l'unica in cui uno spostamento non dipende da cache esterne, e non aggiunge pezzi. Il salto in più è il prezzo, piccolo e misurabile. Possibile ottimizzazione futura, non necessaria: un record DNS per database come *suggerimento*, con l'inoltro sempre presente.

### Come si comportano i driver MongoDB

| tema | standalone, come oggi | replica set di 1 membro, consigliato |
|---|---|---|
| topologia scoperta | `Single`/`Standalone` | `ReplicaSetWithPrimary`; un solo membro, il nome host della stringa |
| `directConnection` | non serve (seed unico) | non serve; se il cliente lo mette a `true` funziona come standalone |
| scritture ritentabili (`retryWrites`, attive di default) | **non usate sui server standalone**: un errore di rete durante uno spostamento arriva all'applicazione | **usate**: un errore di rete o un "not primary" viene ritentato una volta dopo la nuova selezione del server |
| letture ritentabili | sì | sì |
| transazioni, change stream | no | sì (il motore le ha; oggi spente) |
| durante uno spostamento | connessioni chiuse, il pool si riconnette al NLB; errori visibili sulle scritture in volo | connessioni chiuse; scrittura ritentata e riuscita sul nodo nuovo |

Il punto delicato del replica set: `hello.hosts` e `me` devono contenere **esattamente** il nome host usato dal client, altrimenti il driver scarta il server. Il motore oggi annuncia una stringa fissa (`--advertise`). Lavoro necessario: annunciare il nome SNI della connessione. È piccolo, ed è nel piano della fase (b).

La stringa di connessione diventa:

```
mongodb://u:p@<nome>-<ws>.<region>.db.<dominio>:27018/db_<hex>?tls=true&replicaSet=fenvix&authSource=…
```

Le stringhe già date continuano a funzionare in standalone, senza le scritture ritentabili.

## 3. Registro dei nodi e dei database

```
Postgres (control plane)
  nodes(id, private_ip, az, state[warming|active|draining|dead], heartbeat_at,
        plan_pool[managed|dedicated:<org>], capacity_hint)
  placements(database_id, node_id, epoch, state[active|moving], updated_at)
```

- **Chi lo scrive.**
  - Il control plane, per le assegnazioni e gli spostamenti.
  - Ogni nodo scrive il proprio heartbeat ogni 10 s attraverso un'API del control plane, mai direttamente nel database.
- **Chi lo legge.**
  - Ogni nodo tiene in memoria una copia di `placements`.
  - La copia si aggiorna con una lettura ogni 5 s delle sole righe cambiate (`updated_at > ultimo`), più un avviso immediato del control plane quando sposta un database.
- **Chi decide davvero:** il lease su S3, con il fencing di slatedb sotto. Il registro dice dove *dovrebbe* essere un database.
- **Se il registro è sbagliato:**
  - Il nodo indicato non tiene il lease e risponde "non sono io" sulla porta interna.
  - Il nodo che inoltra legge `tenants/<db>/_lease` su S3 (1 GET) e prova il `holder` scritto lì: il `holder` è l'id del nodo.
  - Se il database non è aperto da nessuno (si apre su richiesta), lo apre il nodo indicato dal registro. Se il registro non ne indica nessuno, lo apre il nodo meno carico che il control plane assegna.
  - Due nodi che provano ad aprirlo insieme: uno solo vince il lease, l'altro risponde 134 e inoltra al vincitore. È già provato su S3 vero (aws-test3) e in `ctl-tests/test_20_process_lease.py`.
- **Il registro non c'è (Postgres giù):** i nodi continuano con la loro copia. I database già assegnati funzionano; si fermano solo i nuovi assegnamenti e gli spostamenti.
- **Database che dorme.** Un database fermo non ha un nodo "acceso": `placements` dice dove aprirlo alla prossima richiesta. Per un database che non ha mai avuto assegnazione si usa una regola stabile (hash coerente dell'id sui nodi attivi), così tutti i nodi scelgono lo stesso anche senza registro aggiornato.

## 4. Spostare un database tra due nodi

Sequenza, guidata dal control plane, con il database D che va dal nodo S al nodo T:

```
1. control plane: placements(D) = {node S, state moving, target T}; avvisa S e T
2. T: si prepara (nessuna apertura ancora)
3. S: smette di avviare comandi nuovi per D (li tiene in coda, max ~5 s),
      aspetta la fine dei comandi in corso (max ~2 s, poi errore ritentabile)
4. S: chiude D: flush del WAL e della memtable, marcatore _clean, rilascio del lease
5. control plane: placements(D) = {node T, epoch+1, active}; avvisa tutti
6. S: chiude le connessioni dei client di D (ed eventuali inoltri), i comandi in coda
      ricevono un errore ritentabile (not primary / 134)
7. client: riconnessione al NLB → un nodo qualunque → inoltro a T
8. T: prima richiesta: lease + apertura (risveglio) → serve
```

**Durata attesa.**
- Il flush e la chiusura su S3 vero costano da 1 a 4 richieste in fila: 0,1-0,4 s **(stima)**.
- Il risveglio su S3 vero dal runner GitHub è stato misurato a 1,9-2,3 s, con circa 11-13 GET in fila **(misurato, S3; aws-test3)**. Dalla stessa regione dovrebbe scendere a 0,3-0,6 s **(stima: circa 30 ms per richiesta in eu-west-1)**.
- In tutto: **circa 1-2 s in cui le richieste di D aspettano**, dalla stessa regione **(stima)**.

**Cosa vede il cliente.**
- In replica set: una pausa di 1-2 s e nessun errore, perché scritture e letture vengono ritentate una volta.
- In standalone: le scritture in volo nel momento della chiusura possono tornare con un errore di rete, e l'applicazione deve ritentarle.
- Le transazioni aperte su D al momento dello spostamento vengono interrotte con `TransientTransactionError`, che il driver ritenta nel suo `withTransaction`.

**Errori possibili e cosa succede.**
- **S muore durante lo spostamento:** il lease scade dopo il suo ttl (30 s), T prende il database con la ripresa del WAL. Nessuna perdita delle scritture confermate (provato con SIGKILL).
- **Il flush di S non finisce** (L0 pieno): chiusura senza marcatore; T riprende il WAL. Già gestito nel motore.
- **Il control plane muore a metà:** lo stato `moving` resta. Un controllo periodico lo riprende guardando il lease su S3 (chi lo tiene, se qualcuno).
- **Prima apertura su T molto lenta:** il client aspetta. Il limite di risvegli in contemporanea del motore (`--max-concurrent-wakes`, 32 nel branch `round3`) evita che uno spostamento di massa intasi il nodo.

Lavoro nel motore: un comando di amministrazione "rilascia D" con le fasi 3, 4 e 6, e il "non sono io" sulla porta interna. Ordine di grandezza: 1-2 settimane con i test **(stima)**.

## 5. Capacità: quanto, quando e come scalare

### Unità di capacità

Un nodo non burstable con 2 vCPU.
- **`c7g.large`** (ARM): circa 0,0725 $/h in eu-west-1, cioè circa 53 $/mese **(stima dal listino; da verificare il giorno dell'ordine)**.
- **`c6i.large`** (x86) è l'alternativa.

Perché non `t3`:
- Un t3.medium dà in continuo solo il 20% per vCPU (0,4 vCPU), e il resto a crediti (`results-density.md`, sezione 7).
- Con traffico continuo i crediti finiscono e il nodo rallenta proprio quando serve.
- In modalità `unlimited` costa di più del `c7g` a pari CPU sostenuta.

Gestione dei crediti, se si resta su t3 nella fase (a):
- allarme su `CPUCreditBalance` sotto il 30%;
- passaggio a non burstable come primo passo della fase (b).

### Margine e segnali

**Obiettivo a regime:** CPU sotto il **60-70%** del nodo, così un picco del +40-50% entra senza code.

| segnale | da dove | soglia per aggiungere un nodo | perché |
|---|---|---|---|
| ritardo dello scheduler (`schedulingLagMs`, `GET /v1/metrics/databases`) | motore, nuovo | media 5 min > 5 ms, oppure > 10 ms per 1 min | misura direttamente la saturazione della CPU dei thread del motore; vedi sezione 6 e i numeri in `results-round3.md` |
| CPU del nodo | CloudWatch | > 65% per 10 min | semplice, ma con richieste che aspettano S3 la CPU sale tardi |
| p99 delle richieste | motore | > 2x il p99 normale del nodo per 5 min | è quello che vede il cliente, ma arriva tardi e dipende anche da S3 |
| attese nella coda equa (`queuedCommands`, `saturatedMs`) | motore, nuovo | > 0 in modo continuativo | se c'è coda il nodo è già saturo: è il segnale di allarme, non di pianificazione |
| memoria | CloudWatch agent | > 70% | con i tetti di `round3` la memoria è limitata per costruzione: segnale di sicurezza |
| database aperti | motore (`openReaders`+`openWriters`) | > un valore fissato per tipo di nodo, misurato in fase (b) | conta i file aperti e la CPU di fondo |

Il **segnale più affidabile per decidere**, misurato nel test 50 pesanti + 1 leggero (`results-round3.md`, sezione sul vicino rumoroso): vedi la sezione 6 qui sotto.

### Scalare PRIMA del picco

1. **Picchi a orario noto** (per esempio mezzanotte, fine mese): azione pianificata dell'autoscaling che porta il gruppo a N+k nodi 15 minuti prima. Il control plane sposta i database più attivi prima del picco.
2. **Picchi non previsti:** l'allarme sul ritardo dello scheduler fa partire un nodo dalla warm pool.
   - Avvio stimato di circa 1 minuto: istanza ferma che si riavvia, motore già installato nell'AMI, certificato dal Secrets Manager.
   - Poi il control plane sposta i database più pesanti, a 1-2 s di pausa ciascuno.
   - Il nodo nuovo riceve anche i database che si svegliano, con la regola di assegnazione al nodo meno carico.
3. **AMI pre-costruita** (oggi rifiutata: Packer escluso in `report-infra-align.md`). Da riconsiderare: con l'installazione da user data un nodo nuovo impiega 5-15 minuti, troppo per un picco.
4. **Warm pool** dell'Auto Scaling Group: 1-2 istanze ferme pagano solo il disco (circa 2 $/mese ciascuna con 20 GB gp3, **stima**).

### Costi per numero di nodi (stima, eu-west-1, solo calcolo)

| nodi `c7g.large` | EC2 | NLB (ora + LCU basse) | warm pool (2 ferme) | totale circa |
|---|---|---|---|---|
| 1 (fase a, t3.medium) | 33 $ | 0 | 0 | ~45 $ (con EIP, DNS, segreti) |
| 2 | 106 $ | ~20 $ | 4 $ | ~140 $ |
| 3 | 159 $ | ~20 $ | 4 $ | ~195 $ |
| 6 | 318 $ | ~25 $ | 4 $ | ~360 $ |
| 10 | 530 $ | ~30 $ | 4 $ | ~580 $ |

Le richieste S3 non dipendono dal numero di nodi: dipendono dai database e dal loro traffico (`results-round3.md`). Il traffico tra zone per l'inoltro si paga (circa 0,01 $/GB per direzione) ed è piccolo per FENVIX.

## 6. Picchi, letture distribuite, tetto di un database, vicino rumoroso

### Picco su molti database contro picco su un solo database

- **"100.000 richieste di colpo a mezzanotte" su molti database:** si assorbe distribuendo i database sui nodi.
  - Il costo per richiesta è piccolo (`results-density.md`: 1,3-1,6 ms di CPU per richiesta col 10% di scritture).
  - 100.000 richieste in 10 s sono 10.000/s: circa 15 core **(stima)**, cioè 8 nodi da 2 vCPU già accesi.
  - Con una pianificazione a orario si fa. Con un picco non previsto, i primi secondi si accodano in modo equo (nessun rifiuto); il resto lo assorbono i nodi della warm pool entro 1-2 minuti.
- **Molti database che si svegliano insieme** (dopo un riavvio, o a mezzanotte): il limite di risvegli in parallelo (32) li mette in fila. La coda equa dà la precedenza ai risvegli.
- **Un solo database molto caldo:** vive su un nodo solo, quindi il tetto è quello di un nodo. Misure del branch `round3` (`results-round3.md`, "tetto di un solo database"):
  - letture: limitate dalla CPU del nodo;
  - scritture durevoli: limitate dal flush su S3 e dal lock di scrittura del database. Le scritture concorrenti si raggruppano in un solo PUT, quindi il ritmo cresce con le connessioni parallele.
  - Oltre quel tetto servono due cose. Prima, un nodo più grande per *quel* database: è "verticale", ma solo per i clienti Dedicated che lo comprano. Poi lo sharding: un database diviso per intervalli di chiave su più nodi, con un router. È un lavoro grosso, di mesi, e cambia il motore (manifest per intervallo, transazioni tra shard). **Stima onesta:** non va fatto prima di avere un cliente che lo richiede con numeri veri.

### Letture distribuite con nodi di sola lettura

Cosa permette il motore attuale (dal codice, `results-round3.md`):
- **Il lettore slatedb esiste ed è già usato.** Un database si apre come `DbReader` in sola lettura (`FollowLatest`) e passa a scrittore alla prima scrittura.
- **Mancano tre cose.**
  - Oggi il motore chiede il lease anche per le letture, quindi un secondo processo viene rifiutato con l'errore 134.
  - Un lettore vede solo i dati già nelle SST o nel WAL che rilegge all'apertura. Senza un modo di seguire il WAL dello scrittore resta indietro fino al prossimo flush della memtable, che può arrivare dopo minuti o ore.
  - Mancano un'opzione "sola lettura senza lease" e l'instradamento delle letture `secondaryPreferred` verso quei nodi.
- **Quindi:** letture distribuite con dati vecchi di qualche secondo sono fattibili con un lavoro medio. Serve un lettore senza lease che ricarichi il manifest e segua il WAL ogni N secondi; con i replica set, i driver mandano già le letture `secondary` ai membri annunciati come secondari.
- Letture fresche quanto quelle del nodo proprietario: no, non senza un canale di replica dallo scrittore.

### Vicino rumoroso (implementato nel motore del branch `round3`)

1. **Nessuna quota che rifiuti o rallenti il traffico normale.**
2. **Coda equa, solo a nodo saturo.**
   - Il motore misura ogni 10 ms il ritardo con cui esegue un timer (ritardo dello scheduler). Sotto la soglia (10 ms) ogni comando parte subito.
   - Sopra la soglia, un comando nuovo aspetta nella coda del suo database e parte quando un altro finisce, a turno tra i database, con i risvegli per primi.
   - Un database con 64 connessioni ha gli stessi turni di uno con 1.
3. **Tetti di sicurezza altissimi** per database: 10.000 comandi in corso e 100.000 al secondo, configurabili.
   - Sono molto sopra quello che un database può ricevere davvero (vedi il tetto misurato), quindi scattano solo con un ciclo infinito o un abuso.
   - Quando scattano, l'errore MongoDB è il 462 `IngressRequestRateLimitExceeded` con un messaggio chiaro, e cresce la metrica `safetyRejections`.
4. **Metriche per database** sulla porta di amministrazione (`GET /v1/metrics/databases`):
   - comandi e comandi/s (ultimi 10 s e 60 s);
   - tempo CPU;
   - attese in coda;
   - rifiuti di sicurezza;
   - byte scritti dall'apertura;
   - stato.
   - A livello del server: ritardo dello scheduler e tempo passato in saturazione.
5. **Con queste metriche il control plane sposta i database pesanti** su un nodo con margine, oppure ne aggiunge uno. Il pesante non viene rallentato: viene spostato.

Risultato del test "50 database pesanti + 1 leggero": **[da completare con i numeri di `results-round3.md`, sezione "Vicino rumoroso"]**.

## 7. Piano Dedicated e rapporto con il Managed

- **Managed:** pool condiviso di nodi, database di più clienti sullo stesso nodo. Coda equa, spostamenti automatici, prezzo per database e consumo.
- **Dedicated:** un pool di nodi con `plan_pool = dedicated:<org>`, dove gira solo quel cliente, minimo 2 nodi in 2 zone.
  - Stesso motore, stesso registro, stesso NLB, oppure un NLB suo se vuole IP fissi propri.
  - Il control plane sposta i suoi database su quel pool e non vi mette nessun altro.
  - Il cliente può scegliere un tipo di nodo più grande. È qui che il "verticale" ha senso: solo per lui, solo se paga.
  - Prezzo: nodi a prezzo pieno più margine, richieste S3 come nel Managed.
- **Passaggio da Managed a Dedicated:** spostamento database per database, ciascuno con 1-2 s di pausa e senza cambio di stringa di connessione (il nome host resta lo stesso, decide l'inoltro).

## 8. Tensione con un registro di scrittura condiviso tra database

Idea (calcolo in `results-round3.md`, "Registro di scrittura condiviso"): le scritture di tutti i database di un nodo vanno in un unico oggetto S3 per finestra (50 ms-1 s) e sono confermate dopo quel PUT.
- **Risparmio:** grande con molti database piccoli scritti insieme. Con 100 database a 1 scrittura/s, una finestra di 250 ms dà circa 4-6 PUT/s per il nodo, contro circa 100 della modalità immediata **(calcolo)**.
- **Con pochi database molto attivi** il risparmio rispetto alla modalità rilassata o al log locale per database è nullo o negativo.

Cosa diventa più difficile:

| tema | oggi (un prefisso S3 per database) | con registro condiviso |
|---|---|---|
| spostamento | chiudi, rilascia, apri altrove: 1-2 s | prima si deve "materializzare" la parte del registro di quel database nel suo prefisso; finché il registro è del nodo, il database non può aprirsi altrove senza leggere i registri del nodo vecchio |
| ripristino di un solo database | punti di ripristino e WAL del suo prefisso | il WAL di un database è sparso in oggetti condivisi: per ripristinare un istante bisogna leggere e filtrare i registri di tutti i database del nodo in quel periodo |
| esportazione | legge il suo prefisso | uguale, ma solo dopo la materializzazione |
| cancellazione di un cliente | cancelli il suo prefisso, verificabile | i suoi dati restano negli oggetti condivisi finché scadono o vengono riscritti senza di lui: "cancellato" non è più immediato né verificabile per prefisso (problema per GDPR e contratti) |
| isolamento tra clienti | un errore di un database tocca il suo prefisso | un oggetto condiviso corrotto o un bug di filtro tocca tutti i database del nodo; le chiavi di cifratura per cliente diventano difficili |
| vicino rumoroso | ogni database paga i suoi PUT | un database che scrive tanto ingrossa ogni PUT condiviso e ne allunga la latenza per tutti |
| failover | il lease è per database | il registro è per nodo: la sua ripresa diventa il passo critico di ogni database del nodo |

**Conclusione:** non ora. Le modalità per database del branch `round3` (raggruppamento adattivo, durabilità rilassata per database, log locale come prototipo) danno gran parte del risparmio senza perdere nessuna delle proprietà della tabella. Se un giorno servirà, va fatto solo dentro un pool Dedicated di un solo cliente, dove l'isolamento non è in gioco.

## 9. Fasi

### (a) Oggi: 1 nodo

- **Cosa:** niente di nuovo nell'architettura. Prima del primo cliente:
  - passare a un nodo non burstable (`c7g.large`), oppure allarme sui crediti;
  - usare il motore del branch `round3` (costo S3 e memoria);
  - allarmi su CPU, `schedulingLagMs` e memoria.
- **Lavoro:** 2-3 giorni **(stima)**.
- **Test:** quelli esistenti, più un carico di 200 database per 24 ore.
- **Costo:** circa 45-60 $/mese più S3.

### (b) Prima del primo cliente grosso: 2-3 nodi

**In ordine:**
1. AMI pre-costruita e Auto Scaling Group con launch template (min 2, max 6, 2 zone); warm pool di 1-2 nodi.
2. NLB TCP 27018, preservazione dell'IP del client, cross-zone. Health check su TCP; poi su una porta `/health` del motore che risponde "pronto" solo con lease di processo valido.
3. Motore:
   - lettura dello SNI e inoltro con PROXY v2 su una porta interna;
   - "non sono io";
   - comando "rilascia D" per lo spostamento;
   - annuncio del nome host SNI in `hello` (replica set di 1 membro);
   - `--holder` = id dell'istanza (c'è già).
4. Control plane:
   - tabelle `nodes` e `placements`, heartbeat e avvisi;
   - assegnazione al nodo meno carico, con l'hash coerente come ripiego;
   - spostamento guidato;
   - indirizzo di amministrazione per nodo, invece che per regione;
   - lettura di `GET /v1/metrics/databases`.
5. Stringa di connessione con `replicaSet=fenvix` per i database nuovi.

**Lavoro:** 4-6 settimane per una persona **(stima)**.

**Test obbligatori:**
1. **Picco improvviso.**
   - 2000 database, 200 attivi.
   - A un istante, 10.000 richieste/s per 60 s su 500 database diversi, metà a freddo.
   - Criteri: zero errori, p99 sotto 1 s nei primi 10 s e sotto 100 ms dopo.
2. **Spostamento sotto carico.**
   - Un database a 200 richieste/s (50% scritture, replica set, `retryWrites`) spostato 20 volte di fila tra due nodi.
   - Criteri: zero errori visti dal client, zero scritture confermate perse, pausa massima e p99 durante lo spostamento sotto 3 s.
   - Poi lo stesso test con SIGKILL del nodo sorgente a metà spostamento.
3. **Registro sbagliato.** Righe di `placements` corrotte a mano: il traffico deve continuare (un salto in più), senza dati sbagliati.
4. **Vicino rumoroso** su 2 nodi: lo stesso test del motore, con lo spostamento automatico del database pesante.

**Costo:** circa 140-200 $/mese **(stima)**.

### (c) Crescita automatica

- **Cosa:**
  - autoscaling sul ritardo dello scheduler e sulla CPU;
  - azioni pianificate per i picchi noti;
  - ribilanciamento automatico, cioè spostamenti a basso ritmo e mai di notte durante i picchi;
  - pool Dedicated;
  - più regioni con un registro per regione.
- **Lavoro:** 4-8 settimane **(stima)**.
- **Test:**
  - 24 ore con crescita e calo automatico del gruppo;
  - un nodo ucciso ogni ora;
  - picchi pianificati.
- **Costo:** cresce con i clienti: circa 53 $/mese per ogni nodo da 2 vCPU in più.

## 10. Rischi e punti aperti

| rischio o punto aperto | stato |
|---|---|
| Latenza di un risveglio dalla stessa regione (0,3-0,6 s) | **stima**: su S3 vero è misurata solo da un runner GitHub fuori regione (1,9-2,3 s) |
| Salto in più dell'inoltro: latenza e banda | **stima**; da misurare in fase (b) |
| Annuncio del nome SNI in `hello`: driver diversi (Java, Node, Python, Go) con replica set di 1 membro dietro NLB | **da provare**: possibile incompatibilità con chi usa `directConnection=false` e indirizzi IP |
| Clienti con stringhe vecchie (standalone): niente scritture ritentabili durante uno spostamento | **noto**: errori visibili per 1-2 s per spostamento; da comunicare o da migrare |
| Capacità di un nodo `c7g.large` con il motore `round3` (database per nodo) | **da misurare** in fase (b); i numeri di `results-density.md` vengono da 2 CPU x86 simulate |
| Tetto di un solo database | **misurato su MinIO** (`results-round3.md`); su S3 vero il flush costa decine di ms, quindi le scritture durevoli per connessione scendono |
| Postgres come registro: se è giù, niente spostamenti né nuove assegnazioni | **accettato**: i database già assegnati continuano |
| Picchi da 100.000 richieste non previsti oltre la warm pool | **limite**: si accodano in modo equo; se durano più di qualche minuto servono più nodi accesi (costo) |
| Sharding di un singolo database | **non progettato**: mesi di lavoro, solo su richiesta |
| Lettori di sola lettura | **fattibile** con lavoro medio; dati in ritardo di qualche secondo |
| Il budget AWS ferma l'istanza al 100% (oggi) | **da rivedere**: con clienti veri un arresto automatico è peggio di una fattura alta (meglio allarmi e decisione umana) |
