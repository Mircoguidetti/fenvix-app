# Report: allineamento di `infra/` al motore reale e al control plane (branch `infra-align`)

Branch `infra-align` creato da `origin/e2e-engine` @ `0fde489`. Modificata solo la cartella `infra/`. Nessuna attività AWS: niente deploy, niente bootstrap, nessuna chiamata ad AWS; solo codice, `npm test` e `cdk synth` locale.

Fonti lette: `control-plane/docs/engine-alignment.md`, `engine-adapter.md`, `data-explorer-security.md` (modello di sicurezza, credenziali, "Making the provisioner"), `control-plane/.env.example`, `control-plane/src/config.ts`, `control-plane/README.md`, `control-plane/Dockerfile`, `results-e2e-engine.md`; il motore `Mircoguidetti/test5` (clonato in una cartella a parte, solo lettura): `mongo-server/src/main.rs`, `ctl/mod.rs`, `ctl/http.rs`, `ctl/usage.rs`, `auth.rs`, `tls.rs` sui branch `fusion-ops` @ `e98ed24`, `control-ops` @ `1f473f9`, `compat-gaps` @ `5df2720`. Il branch `final-engine` non esisteva quando ho clonato test5 (nella stessa sessione); un secondo controllo a fine lavoro non è stato possibile (il `git fetch` di test5 è stato negato dal sistema di permessi della sessione).

## 1. Differenze trovate e come le ho risolte

### Cosa c'era già su `e2e-engine` (commit `646b694`)
`git diff origin/infra-aws origin/e2e-engine -- infra`: impostazione `mongoPort` = 27018 e `adminPort` = 8443 in `cdk.json` e `config.ts`; la security group apre `mongoPort` invece di 27017; `FENVIX_LISTEN`/`FENVIX_ADMIN_LISTEN` con le porte nuove; `httpPutResponseHopLimit: 1`; i test relativi. Non l'ho rifatto.

### Cosa era ancora da fare (trovato in infra)
| # | Problema in infra | Soluzione |
|---|---|---|
| 1 | README: "porta 27017 (database) … admin port (27018)" e tabella delle impostazioni con `adminPort` 27018 | README riscritto: 27018 aperta (TLS), 443 aperta, 8443 chiusa a tutto |
| 2 | Il motore partiva **senza flag** (`ExecStart=/opt/fenvix/bin/fenvix-engine`) e le variabili `FENVIX_*` non sono lette dal motore: sarebbe partito su `127.0.0.1:27018`, S3 `http://localhost:9000` bucket `bench`, senza admin, senza auth, senza TLS | `lib/engine-command.ts`, l'unico punto con i nomi dei flag: `--listen=0.0.0.0:27018 --admin-listen=172.17.0.1:8443 --admin-token-file=/run/fenvix/admin-token --auth --tls-mode=requireTLS --tls-certificate-key-file=/etc/fenvix/tls/engine.pem --store=s3 --bucket=<bucket>`; `AWS_REGION`/`AWS_DEFAULT_REGION` nell'unità systemd. Tolte tutte le `FENVIX_*` |
| 3 | Token admin passato come variabile `FENVIX_ADMIN_TOKEN` (non letta) | Scritto a ogni avvio da SSM in `/run/fenvix/admin-token` (0600, proprietario `fenvix`, `RuntimeDirectory` che sparisce quando il motore si ferma), passato con `--admin-token-file`. Mai nella riga di comando, mai nell'user data, mai nei log |
| 4 | Porta admin legata a `0.0.0.0` e protetta solo da una regola self-referencing della SG | La porta admin ascolta solo sul bridge Docker `172.17.0.1` (fissato in `/etc/docker/daemon.json`), raggiungibile dal server e dai suoi container, da nessun'altra parte; tolta la regola della SG (ora la SG ha solo 27018 e 443) |
| 5 | `FENVIX_TLS_MODE=self-signed` (modalità inesistente), ARN ACM passato "per informazione" | Certificato ACM pubblico **esportabile** per regione, esportato in PEM (catena + chiave, 0600, `fenvix`) a ogni avvio del motore e da un timer giornaliero che riavvia motore e terminatore TLS **solo se il certificato è cambiato** (il motore legge il PEM solo all'avvio; `rotateCertificates` non ricarica niente). Permesso `acm:ExportCertificate` solo su quel certificato |
| 6 | Certificato e DNS `*.db.<dominio>`: non copre `<nome>-<ws>.<regione>.db.<dominio>` (due etichette prima di `db`) | Certificato `*.<regione>.db.<dominio>` (+ `console.<dominio>` nella prima regione), record A `*.<regione>.db.<dominio>` per regione. Test che dimostra che il vecchio nome non copre un host reale e il nuovo sì |
| 7 | Segreti richiesti: `engine/admin-token` e `control-plane/session-secret` (non usato dal control plane) | `lib/parameters.ts`: 8 obbligatori + `engine-user-key-previous` facoltativo; `session-secret` tolto. Prima di avviare il control plane si controlla che `control-plane/engine-admin-token` sia uguale a `engine/admin-token`. Se manca un parametro il servizio non parte e il log elenca i nomi mancanti (testato) |
| 8 | Container del control plane con solo `FENVIX_REGION`, `PORT=8443`, `BASE_DOMAIN` | `lib/control-plane-env.ts`, un'unica lista facile da estendere: `NODE_ENV=production`, `ENGINE_DRIVER=real`, `ENGINE_ADMIN_ENDPOINTS=http://host.docker.internal:8443`, `ENGINE_ADMIN_ALLOW_PLAIN_HTTP=true`, `DATA_ENGINE_ENDPOINTS=host.docker.internal:27018`, `DATA_ENGINE_TLS=true`, `DATA_ENGINE_TLS_SERVER_NAME=engine.<regione>.db.<dominio>`, `CONNECTION_PORT=27018`, `CONNECTION_DB_NAME=engine`, `HOST_TEMPLATE=<name>-<workspace>.<region>.db.<BASE_DOMAIN>`, `BASE_DOMAIN`, `REGIONS`, `API_PUBLIC_URL`, `DASHBOARD_ORIGINS`, `TRUST_PROXY=true`, `ENGINE_PROVISIONER_USERNAME`, `ENGINE_RETENTION_WINDOW_SECS`, le `DATA_*` di `.env.example`. Un test esegue il vero `loadConfig` di `control-plane/src/config.ts` su questo ambiente + segreti finti: lo accetta (driver real, Data Explorer mongo, utenti per database attivi) e lo rifiuta se manca `ENGINE_USER_KEY` |
| 9 | `docker run` senza `--add-host`: il container non raggiungeva il motore | `--add-host=host.docker.internal:host-gateway` |
| 10 | **Non in elenco, trovato:** il control plane serve HTTP in chiaro (Fastify, nessun TLS) e l'infra lo pubblicava sulla 443 chiamandolo "HTTPS"; in produzione `API_PUBLIC_URL` deve essere `https://` | Terminatore TLS Caddy (`public.ecr.aws/docker/library/caddy:2.8.4`, verificato che il tag esiste) sulla 443 con lo stesso certificato esportato, `console.<dominio>` → `fenvix-control-plane:3000` su una rete Docker privata. Il container del control plane non pubblica più porte |
| 11 | **Non in elenco, trovato:** `-ExecStartPre=/usr/bin/docker rm -f …` (sintassi sbagliata: systemd ignora la riga) | `ExecStartPre=-/usr/bin/docker rm -f …` (e `pull` tollerante: se il registry non risponde si usa l'immagine già scaricata) |
| 12 | Ruolo dell'istanza S3: anche `GetObjectVersion`, `ListBucketVersions`, `ListBucketMultipartUploads`, `GetBucketLocation` | Ridotto a quello che usa il client object store: `GetObject`, `PutObject`, `DeleteObject`, `AbortMultipartUpload`, `ListBucket`. La lista negata a tutti gli altri nella bucket policy resta ampia |
| 13 | **Non in elenco, trovato:** nessun modo di creare l'utente `fenvix_provisioner` sul server (serve l'eccezione localhost del motore) | Script `/usr/local/bin/fenvix-create-engine-users` (README, Step 10): password root di emergenza digitata a mano (mai salvata sul server), password del provisioner da SSM, passate per variabile d'ambiente, nessun messaggio del motore stampato (il motore ripete il comando, password inclusa) |

### Differenze tra `engine-alignment.md` e il codice del motore (vince il codice)
- `engine-alignment.md` dice che il branch fuso non esisteva. **Ora `fusion-ops` esiste** (`e98ed24`), ma è `merge-engine` + `control-ops`: ha l'interfaccia admin e **non** ha `--auth`/`--tls-mode` (nessun `auth.rs`/`tls.rs`). Un binario con tutti i flag usati qui ancora non esiste.
- `compat-gaps` è avanzato a `5df2720` (il documento cita `2742441`); i flag di auth/TLS sono invariati (`--auth`, `--tls-mode disabled|allowTLS|preferTLS|requireTLS`, `--tls-certificate-key-file` con catena + chiave in un PEM, `--tls-ca-file`).
- Su tutti i branch lo store S3 ha ancora regione `us-east-1`, credenziali `minioadmin` e `allow_http` fissi nel codice; non esiste `--region`. **Con il binario attuale il motore non può usare il bucket su AWS** (serve la modifica lato motore descritta in 2.5 del documento).
- Non esiste un flag "modalità produzione". La produzione è l'insieme di flag sopra più l'assenza dei controlli di test (`--no-leases`, `--unsafe-skip-ownership-checks`, `--ack-before-durable`, `--no-ctl-recovery`) e delle variabili `CTL_FAILPOINT`/`CTL_USAGE_DAY_OFFSET_MS`; un test lo verifica.
- Il documento propone `--admin-listen 0.0.0.0:8443`; ho scelto il bridge Docker (più stretto, stesso risultato per il control plane). Propone `--endpoint https://s3.<regione>.amazonaws.com` facoltativo: come chiesto non lo passo (il binario finale dovrà usare l'endpoint AWS quando `--endpoint` non c'è). `--idle-secs 60` è già il default; `--retention-window-secs` non lo passo perché il control plane imposta la finestra per ogni database (`ENGINE_RETENTION_WINDOW_SECS`, default 7 giorni, impostazione `engineRetentionWindowSecs`).
- Nomi SSM: quelli del documento sono corretti. In più servono `supabase-url` e `supabase-anon-key` (il control plane le richiede e non stanno bene nel codice); `API_PUBLIC_URL` e `DASHBOARD_ORIGINS` non sono segreti e vengono dalle impostazioni.
- Il token admin: il motore lo legge dal file con `trim()` e vuole almeno 16 caratteri; il control plane richiede lo stesso minimo.

### Credenziali S3 e IMDS (punto 3 e 6)
Il motore (binario finale) prenderà regione e credenziali dall'ambiente e dal ruolo dell'istanza: l'unità gli passa `AWS_REGION`, il ruolo ha solo i permessi sul proprio bucket. Limite di salti IMDS: **1** (già impostato, lo tengo). Motivo: il motore e gli script di avvio girano sull'host (un salto) e devono avere il ruolo (bucket, SSM, export del certificato); il control plane e Caddy girano dietro un bridge Docker (due salti) e non hanno bisogno di nessuna credenziale AWS (i loro segreti arrivano in un env file letto dall'host). Con 1 un'intrusione nel control plane non ottiene le credenziali del ruolo che apre il bucket dei dati. Con 2 le otterrebbe. Unica eccezione voluta: lo script dello Step 10 usa `--network host` per una sola esecuzione manuale (serve l'eccezione localhost del motore).

## 2. File modificati e perché

| File | Perché |
|---|---|
| `lib/engine-command.ts` (nuovo) | Comando di avvio del motore e percorsi: unico punto con i nomi dei flag, commentato con branch e commit verificati |
| `lib/parameters.ts` (nuovo) | Catalogo dei parametri SSM (obbligatori/facoltativi, cosa diventano), usato da stack, user data, test; il README lo rispecchia (test) |
| `lib/control-plane-env.ts` (nuovo) | Tutte le variabili non segrete del container del control plane, in una lista |
| `lib/user-data.ts` | Unità systemd del motore con i flag, file del token, script `fenvix-fetch-config` (file per il motore, env file per il control plane, controllo uguaglianza token), `fenvix-cert-refresh` + timer, `fenvix-create-engine-users`, container del control plane e di Caddy, bridge Docker fissato |
| `lib/fenvix-stack.ts` | SG senza regola admin; certificato e DNS per regione; `acm:ExportCertificate`; azioni S3 ridotte; control plane solo nella prima regione; output `DatabaseHosts`, `ControlPlaneUrl`, `NameServers` |
| `lib/config.ts` | `baseDomain` e `dashboardOrigins` obbligatori, `proxyImage`, `engineRetentionWindowSecs`; con più regioni serve `hostedZoneId` |
| `lib/nag-suppressions.ts` | Motivazione EC23 aggiornata (27018, admin in nessuna regola) |
| `cdk.json` | Nuove impostazioni (`baseDomain` e `dashboardOrigins` vuoti: il synth si ferma e dice cosa manca) |
| `deploy-policy.json` | Solo i nomi (Sid) delle istruzioni DNS/ACM, che non sono più "facoltative" |
| `test/*` | Aggiornati e nuovi: `engine-command.test.ts`, `parameters.test.ts`, `control-plane-env.test.ts`; `user-data.test.ts` esegue davvero lo script dei segreti e quello del certificato (openssl vero, export ACM finto) |
| `README.md` | Guida passo-passo: decisioni, segreti con comandi CloudShell, dominio e name server, verifiche dopo il deploy con le uscite attese, creazione degli utenti del motore, rinnovo del certificato |
| `results-infra.md` | Sezione nuova in testa; righe superate marcate |
| `report-infra-align.md` | Questo report |

## 3. Esito dei test e di `cdk synth`

- `npx tsc --noEmit`: nessun errore.
- `npx jest`: **8 suite, 101 test, tutti passati** (ultima esecuzione completa prima del commit finale).
- Controlli di mutazione: admin su `0.0.0.0` → 5 test falliti; regola SG self-referencing rimessa + certificato `*.db.` → 5 test falliti; file ripristinati.
- `cdk synth --quiet` con la CLI vera, variabili AWS rimosse dall'ambiente e rete puntata a un proxy morto: esito 0, un template di 38,4 KB; user data 13,4 KB (limite 16 KB). Solo gli avvisi W3010 (zona di disponibilità fissa, voluto).
- Controllo del template generato: ingressi solo `0.0.0.0/0` su 27018 e 443; nessuna regola copre 8443; bucket con blocco pubblico completo e cifratura AES256; ruolo motore = 5 azioni S3 sul suo bucket, lettura SSM `/fenvix/prod/*`, `kms:Decrypt` via SSM, Session Manager, `acm:ExportCertificate` sul suo certificato; IMDS `HttpTokens=required`, hop 1; certificato `*.eu-central-1.db.example.com` + `console.example.com`, `CertificateExport: ENABLED`; record `*.eu-central-1.db.example.com.` e `console.example.com.`; nessuna risorsa `SSM::Parameter`; nell'user data nessun segreto (l'unica corrispondenza della ricerca è il nome del parametro nel controllo `--match`).
- cdk-nag: 10 risultati grezzi (stesse regole di prima), 0 non giustificati.

## 4. Cosa manca prima del primo deploy

**Dipende dal motore (bloccante):**
1. Un binario unico con interfaccia admin **e** auth/TLS (`fusion-ops` + `compat-gaps`).
2. Nello stesso binario: S3 con credenziali e regione dall'ambiente/ruolo dell'istanza e endpoint AWS quando `--endpoint` manca (oggi `minioadmin`/`us-east-1`/`localhost:9000`).
3. Pubblicarlo su un URL https scaricabile senza login, con SHA-256. Se cambia un nome di flag: solo `lib/engine-command.ts` e `test/engine-command.test.ts`.
4. Verificare sul binario finale che le 5 azioni S3 bastino (se servisse per esempio `ListBucketMultipartUploads`, si aggiunge in `fenvix-stack.ts`).

**Dipende dal control plane:** immagine costruita e pubblicata senza login; database Postgres e progetto Supabase pronti (control-plane/README.md).

**Dipende da te (decisioni, con la mia raccomandazione):**
1. **Dominio** (obbligatorio). Raccomandazione: un dominio dedicato a FENVIX con la zona creata dallo stack (opzione A del README); se prevedi più regioni o il dominio ha già altri record, crea tu la zona in Route 53 e passa `FENVIX_HOSTED_ZONE_ID` (opzione B). Segnaposto: `baseDomain` vuoto in `cdk.json`.
2. **Certificato**: implementato ACM esportabile (a pagamento, vedi listino ACM nella console). Alternativa gratuita: Let's Encrypt con DNS-01, che però richiede che il server possa modificare la zona DNS (potrebbe dirottare `console.<dominio>`). Raccomando ACM.
3. **Indirizzo della dashboard** (`dashboardOrigins`, segnaposto vuoto) e nome dell'API: ho tenuto `console.<dominio>` (già nell'infra); il README del control plane usa `api.<dominio>` negli esempi. Se preferisci `api.`, è una riga in `consoleHost()`.
4. **Finestra di ripristino** di default 7 giorni (`engineRetentionWindowSecs`): conferma o cambia.
5. **Più regioni**: ogni regione ha motore, bucket, certificato e DNS propri, ma il control plane gira nella prima e gestisce solo quel motore. Raccomando una sola regione finché non si decide come il control plane raggiunge le altre.
6. Fuori dall'infra ma da decidere prima dei clienti veri: le credenziali dei clienti (`app_user` nella stringa di connessione non esiste sul motore; vedi `results-e2e-engine.md`).

**Passi manuali (README):** creare gli 8 parametri (Step 2), conservare la password root di emergenza, deploy, name server, Step 10 (utenti del motore), verifiche Step 9 e 11.

## 5. Rischi residui

1. **Niente è stato eseguito su AWS**: user data su Amazon Linux 2023, `aws acm export-certificate` con passphrase `fileb://` (testato solo contro una risposta finta con lo stesso formato), rinnovo dei certificati esportabili, Caddy con quella configurazione, `host-gateway` raggiungibile da una rete Docker utente verso `172.17.0.1`, Session Manager. La policy di deploy potrebbe aver bisogno di un permesso in più per richiedere un certificato esportabile.
2. **Lo script dello Step 10** non è stato eseguito contro un motore: usa il driver `mongodb` dell'immagine del control plane (lo stesso dei test e2e) e l'eccezione localhost; con `--network host` ha accesso all'IMDS per la durata dell'esecuzione; usa `tlsAllowInvalidHostnames` solo verso `127.0.0.1`. Se la password root di emergenza va persa, l'eccezione localhost è chiusa e non si può ricreare un root.
3. **Lacune note del motore**: il provisioner può creare un utente `root` (manca il controllo `grantRole`); i rifiuti ripetono il comando con la password. La porta admin è HTTP senza TLS: protetta dal fatto che ascolta solo sul bridge, ma ogni container sull'host la raggiunge (oggi girano solo i nostri due).
4. **Chiave privata del certificato**: chi ottiene il ruolo dell'istanza può esportarla. Rinnovo = riavvio del motore (qualche secondo, di notte, solo quando il certificato cambia).
5. **Porta dati aperta a Internet** (TLS + auth obbligatori, ma motore giovane, nessun limite di connessioni per IP).
6. User data a 13,4 KB su 16: c'è margine ma non molto.
7. **Divulgazione**: nel sandbox erano presenti `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` nell'ambiente (non ne ho letto i valori). Il `cdk synth` l'ho eseguito con quelle variabili rimosse e la rete verso un proxy morto; i test non fanno chiamate AWS. Ho fatto una sola richiesta di rete esterna: la verifica che l'immagine `caddy:2.8.4` esista su `public.ecr.aws`.

## 6. Branch e commit

Branch `infra-align` (da `origin/e2e-engine` @ `0fde489`), solo `infra/`, nessun merge, nessuna PR. Commit: `baae779` (codice, test, README) e il commit che aggiunge questo report e `results-infra.md` (hash finale nel messaggio in chat / `git log`).
