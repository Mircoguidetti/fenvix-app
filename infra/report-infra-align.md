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
2. **(Superato, vedi sezione 7: ora Let's Encrypt.)** **Certificato**: implementato ACM esportabile (a pagamento, vedi listino ACM nella console). Alternativa gratuita: Let's Encrypt con DNS-01, che però richiede che il server possa modificare la zona DNS (potrebbe dirottare `console.<dominio>`). Raccomando ACM.
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

## 7. Let's Encrypt al posto di ACM esportabile

Commit sopra `d63ef74` sullo stesso branch `infra-align`, solo `infra/`. Nessuna attività AWS (niente deploy, nessuna chiamata API, credenziali tolte dall'ambiente di ogni comando), nessuna chiamata a Let's Encrypt (né produzione né staging). Rete usata: PyPI (versioni e hash di certbot, `pip download` di verifica, certbot installato in una cartella temporanea per provarne la riga di comando), npm (`npm ci`), GitHub solo per `git ls-remote` dei tag di lego (vedi 7.2).

### 7.1 Cosa ho cambiato
| Area | Prima | Dopo |
|---|---|---|
| Certificato | `AWS::CertificateManager::Certificate` esportabile per regione, `acm:ExportCertificate`, script `fenvix-cert-refresh` + timer giornaliero | Nessuna risorsa ACM, nessuna azione `acm:`. Certificato Let's Encrypt emesso **sull'host** da certbot (DNS-01 in Route 53): `lib/acme.ts`, `lib/scripts/fenvix-tls.sh`, `lib/scripts/fenvix-acme-dns-hook.sh` |
| Nomi | `*.<regione>.db.<dominio>` + `console.<dominio>` (prima regione) | Uguali: un solo certificato per regione; `console.<dominio>` solo nella regione che fa girare il control plane (oggi l'unica). Nelle altre regioni il ruolo non può nemmeno scrivere il record di challenge di `console` |
| File sul server | `/etc/fenvix/tls/engine.pem` (root:fenvix 0750) + `/etc/fenvix/tls/proxy/{cert,key}.pem` | `/etc/fenvix/tls/` proprietà `fenvix`, 0700; `engine.pem` (catena poi chiave PKCS#8, il formato di prima), `fullchain.pem`, `key.pem`, tutti 0600. Caddy monta la stessa cartella in sola lettura |
| Rinnovo | Timer giornaliero, export ACM, riavvio se l'impronta cambia | `fenvix-tls.timer` alle 00:00 e 12:00 UTC (+ fino a 1 h casuale); non fa nulla (nemmeno chiamate di rete) se mancano più di 30 giorni; altrimenti emette, installa e riavvia motore e Caddy **solo se l'impronta SHA-256 è cambiata** (stessa logica di confronto di prima) |
| Persistenza | (ACM) | Secret `fenvix-<env>-tls-<regione>` in Secrets Manager, creato dallo stack con valore `{}`; il server ci scrive `{"server","fullchain","key"}` |
| Avvio senza TLS | Export fallito senza file → il motore non parte | `fenvix-tls` in `ExecStartPre=+` di motore e Caddy: se manca un certificato valido esce con 1 e un messaggio chiaro, il servizio non parte. `TimeoutStartSec=15min` (una prima emissione può durare minuti) |
| Impostazioni | — | `acmeEmail` obbligatoria (vuota in `cdk.json`, il synth si ferma), `acmeStaging` (default `false`), `dnsZone` (`db` default, oppure `domain`) |
| User data | 13,4 KB in chiaro | Script di avvio ~25,4 KB → gzip + base64 nell'user data: **13,9 KB** (13,98 KB con un dominio di 55 caratteri), SHA-256 verificato prima di eseguirlo, copia leggibile in `/opt/fenvix/boot.sh` |
| Policy di deploy | Vedi 7.5 | Vedi 7.5 |
| README | ACM | Sezioni nuove "The domain and DNS", "TLS certificate (Let's Encrypt)", "The boot script and the 16 KB limit"; passi 5, 7, 9, 11, rinnovo, regioni, smantellamento aggiornati |

### 7.2 Scelte e perché
1. **Client ACME: certbot 5.8.0 (non lego).** lego sarebbe un unico binario Go, ma qui non posso scaricare gli asset delle release GitHub (il proxy risponde 403), quindi non posso calcolare né verificare l'hash SHA-256 del tarball: avrei dovuto lasciarlo come segnaposto da riempire, contro la richiesta "scaricato in modo verificabile". certbot invece viene da PyPI con `pip install --require-hashes --only-binary=:all:` in un venv Python 3.11 sull'host: **ogni** pacchetto (17, certbot 5.8.0 pubblicato il 1/9/2026) è fissato a una versione e a gli SHA-256 delle sue wheel per CPython 3.11 manylinux x86_64 e aarch64 (`lib/acme-requirements.txt`, generato da `scripts/gen-acme-requirements.py` dagli hash dell'API JSON di PyPI). Niente compilazione sul server, niente `curl | sh`. Ho verificato con `pip download --require-hashes` che il file si risolve per entrambe le architetture (17 file ciascuna). certbot richiede Python ≥ 3.10: su Amazon Linux 2023 il `python3` di sistema è 3.9, quindi installo `python3.11` (non verificato su AL2023, vedi 7.6).
2. **Niente plugin `certbot-dns-route53`: hook `--manual` con la AWS CLI.** Il plugin cerca la zona con `route53:ListHostedZones` su `Resource "*"` e non segue i CNAME (serve per l'opzione DNS B). L'hook (`fenvix-acme-dns-hook`, ~30 righe, testato) conosce già zona e nomi, quindi il ruolo ha **solo** `ChangeResourceRecordSets` sulla zona dello stack (con condizioni) e `GetChange` su `arn:aws:route53:::change/*`. Nessuna azione Route 53 su `Resource "*"`: `ListHostedZonesByName` non serve. In più niente boto3 da installare.
3. **IAM Route 53** (`AcmeDnsChallengeTxtOnly`): `ForAllValues:StringEquals` su `ChangeResourceRecordSetsNormalizedRecordNames` = i soli nomi `_acme-challenge` della regione, `ChangeResourceRecordSetsRecordTypes` = `TXT`, `ChangeResourceRecordSetsActions` = `UPSERT`,`DELETE`, più `Null` = `false` sul nome (con `ForAllValues` una richiesta senza la chiave passerebbe). Il ruolo non può toccare i record A, altri nomi, altri tipi, altre zone.
4. **CNAME-delegation di `_acme-challenge` verso una zona dedicata: scartata come regola generale, usata solo dove serve.** Con le condition key sopra il ruolo può già scrivere solo i TXT di challenge: una zona dedicata non riduce ciò che un attaccante può fare (emettere certificati per i nostri nomi resta possibile in entrambi i casi) e aggiunge una zona e record da mantenere. La uso solo per `console.<dominio>` nell'opzione DNS B, perché lì `console` sta presso il DNS principale (Cloudflare/GoDaddy) e non in Route 53: `_acme-challenge.console.<dominio>` CNAME → `_acme-challenge-console.db.<dominio>`, record che sta già nella zona `db.<dominio>`.
5. **Persistenza: Secrets Manager.** ~0,40 $/mese per secret per regione + 0,05 $ ogni 10.000 chiamate (il server lo legge solo quando il certificato locale manca o scade fra meno di 30 giorni, e lo scrive a ogni emissione: poche chiamate al mese). Alternative scartate: parametro SSM advanced SecureString (0,05 $/mese, ma CloudFormation non sa creare SecureString, quindi lo avrebbe creato il server con `ssm:PutParameter`, fuori dallo stack, e sotto il percorso `/fenvix/<env>/` che il server legge a ogni avvio); oggetto S3 cifrato in un bucket separato (quasi gratis ma un bucket in più con policy, log, risultati cdk-nag). Il secret ha un nome fisso `fenvix-<env>-tls-<regione>` per poter limitare la policy di deploy a `secret:fenvix-*`; cifratura con la chiave AWS gestita `aws/secretsmanager`; solo il ruolo del motore ha `GetSecretValue`/`PutSecretValue` su quell'ARN, il ruolo di deploy non può leggerlo.
6. **Logica di `fenvix-tls`**: (a) certificato installato valido ancora 30 giorni, nomi giusti (SAN uguali all'elenco), stesso server ACME, chiave che corrisponde, emittente non `STAGING` se è configurata la produzione → niente da fare; (b) altrimenti la copia in Secrets Manager se passa lo stesso controllo → installata, nessuna emissione; (c) altrimenti emissione con certbot (`--force-renewal`, RSA 2048, account certbot persistente in `/var/lib/fenvix-acme`), poi copia in Secrets Manager e installazione. Se l'emissione fallisce: nuovo tentativo non prima di 20 minuti (file marcatore, resta anche se il processo viene ucciso), quindi al massimo 3 fallimenti l'ora contro il limite di 5; se il certificato installato è ancora valido lo si tiene (WARNING), altrimenti exit 1 e il servizio non parte. Se Secrets Manager non è leggibile e non c'è un certificato valido: exit 1 **senza** emettere (emettere a ogni sostituzione del server senza poterlo salvare consumerebbe il limite di 5 a settimana). Se la scrittura in Secrets Manager fallisce: WARNING, il certificato viene comunque usato. Un `flock` evita due emissioni contemporanee (motore e Caddy partono insieme); il lock viene rilasciato prima del riavvio dei servizi. Non stampa mai chiave né contenuto del secret.
7. **acmeStaging** cambia solo `ACME_SERVER` in `/etc/fenvix/tls.env` (test: una sola riga diversa nello script di avvio e template identico a parte l'user data). Un certificato staging non viene mai servito quando è configurata la produzione (né dal disco né da Secrets Manager).
8. **16 KB di user data: compressione invece di un asset CDK.** Lo script in chiaro sarebbe 25,4 KB. Un asset CDK richiederebbe `cdk bootstrap` (bucket, ruoli `cdk-*`) e molti più permessi nella policy di deploy, che oggi non ne ha bisogno. Ho compresso lo script con gzip dentro l'user data: niente download, nessun controllo tolto, integrità garantita da EC2 e da un SHA-256 controllato in bash; i test decomprimono e confrontano byte per byte. Restano ~2,4 KB di margine: se lo script cresce ancora, il passo successivo è l'asset S3 come avevi indicato. **Questa è una deviazione dalla tua istruzione, va confermata (7.4).**
9. **DNS: raccomando l'opzione B** (`dnsZone=db`, default): Route 53 solo per `db.<dominio>`. Motivi: se compri il dominio da **Cloudflare, Cloudflare Registrar impone il DNS di Cloudflare** e l'opzione A (tutto il dominio in Route 53) non è possibile; il sito Vercel e la posta non vengono toccati; il server non può in nessun modo toccare il DNS del sito. Record da creare a mano presso il DNS principale: 4 `NS` `db` → name server della zona Route 53; `CNAME` `_acme-challenge.console` → `_acme-challenge-console.db.<dominio>`; `A` `console` → `PublicIp` (su Cloudflare "DNS only"); eventuale `CAA` che permetta `letsencrypt.org`. Lo stack crea `*.<regione>.db.<dominio>` nella zona; i TXT di challenge li crea e toglie il server. L'opzione A (`dnsZone=domain`, solo GoDaddy) richiede di ricreare in Route 53 i record Vercel e di posta prima di cambiare i name server; lo stack crea anche `console`. Il README descrive entrambe e consiglia di creare la zona a mano prima del deploy (`FENVIX_HOSTED_ZONE_ID`), così la delega è pronta alla prima richiesta di certificato e non si consumano validazioni fallite.

### 7.3 Test
- Prima (`d63ef74`): **8 suite, 101 test**, tutti passati.
- Dopo: **9 suite, 134 test: 133 passati, 1 saltato** (il test con il vero certbot, che gira solo con `FENVIX_TEST_CERTBOT`). Con `FENVIX_TEST_CERTBOT` puntato a certbot 5.8.0 installato in una cartella temporanea: **134 passati**. `tsc --noEmit`: nessun errore.
- Nuovi o riscritti: suite `test/tls.test.ts` (script veri eseguiti con bash e openssl veri, certbot finto che firma con una CA finta, `aws` finto per Secrets Manager e Route 53, `systemctl` finto): prima emissione; file 0600 e cartella 0700; certificato valido → nessuna chiamata e nessun riavvio; server sostituito → riuso da Secrets Manager senza emissione; scadenza sotto i 30 giorni → nuova emissione e **un** riavvio di motore e Caddy; emissione fallita senza certificato → exit 1, nessun file, secondo tentativo bloccato per 20 minuti; emissione fallita con certificato ancora valido → lo tiene; Secrets Manager illeggibile → exit 1 senza emettere; Secrets Manager non scrivibile → WARNING; cambio dei nomi → nuova emissione; staging mai servito in produzione (anche se marcato "produzione" nel secret); nessuna riga della chiave nell'output; hook DNS (UPSERT/DELETE, attesa, CNAME di `console` con `dnsZone=db`, rifiuto di nomi estranei e di valori non base64url senza chiamare AWS). `infra.test.ts`: nessuna risorsa/azione ACM; policy Route 53 con zona e condizioni esatte; `Resource "*"` mai su Route 53 o Secrets Manager; Secrets Manager solo sul proprio secret; secret creato con `{}`; `acmeEmail` obbligatoria; `acmeStaging` cambia solo l'endpoint; opzioni `db`/`domain`; due regioni con permessi separati. `user-data.test.ts`: dimensione < 16 KB anche con dominio lungo, decodifica in bash con controllo SHA-256 (e rifiuto di un payload alterato), controllo dei due id inseriti da CloudFormation, requisiti tutti con `==` e hash, `--require-hashes --only-binary`. `deploy-policy.test.ts`: nessuna azione `acm:`, Secrets Manager solo `fenvix-*`, mai `GetSecretValue`.
- **Vero certbot 5.8.0** (facoltativo, eseguito qui): accetta esattamente la riga di comando di `fenvix-tls` e fallisce solo sulla connessione a `127.0.0.1:9` (nessuna rete esterna). Mi ha fatto trovare un errore del test (l'hook deve essere eseguibile; sul server lo è, 0755). **Pebble non l'ho eseguito**: si scarica dalle release GitHub, non raggiungibili da qui.
- **Mutazioni** (ognuna applicata, test eseguiti, file ripristinato): `ChangeResourceRecordSets` su `Resource "*"` → 4 test falliti; condizioni Route 53 tolte → 3 falliti; tipo `A` aggiunto alle condizioni → 1 fallito; chiave `key.pem` 0644 → 1 fallito; riavvio sempre (anche senza cambio) → 2 falliti; certificato ACM esportabile + `acm:ExportCertificate` rimessi → 2 falliti. (Una prima versione della mutazione "condizioni tolte" rompeva la compilazione invece delle asserzioni: l'ho rifatta.)
- **`cdk synth`** con la CLI vera, `env -i` (nessuna variabile AWS) e proxy verso `127.0.0.1:9`: esito 0, template di 39,8 KB, solo gli avvisi W3010 già noti. Controllo del template: risorse senza `CertificateManager`, nessuna stringa `acm:`/`CertificateExport`; ingressi solo 27018 e 443 da `0.0.0.0/0`, 8443 in nessuna regola, `--admin-listen=172.17.0.1:8443`; IMDS `required`, hop 1; ruolo motore = S3 sul suo bucket, SSM `/fenvix/prod/*`, `kms:Decrypt` via SSM, Session Manager, `secretsmanager:GetSecretValue/PutSecretValue` sul suo secret, `route53:ChangeResourceRecordSets` sulla sua zona con condizioni, `route53:GetChange` su `change/*`; secret `fenvix-prod-tls-eu-central-1` con valore `{}`; user data 13,9 KB senza `BEGIN`, `PRIVATE KEY`, `AKIA` (l'unica occorrenza di `admin-token=` è il nome del parametro nel controllo `--match`, come prima).
- **cdk-nag**: 12 risultati grezzi (prima 10: in più `SMG4` sul secret senza rotazione Lambda e `IAM5` per `change/*`), tutti giustificati in `lib/nag-suppressions.ts`; 0 non giustificati con `dnsZone=domain`, `dnsZone=db` + staging, e due regioni.

### 7.4 Decisioni che servono a te
1. **User data compresso invece dell'asset CDK** (7.2.8). Raccomando di tenerlo; se preferisci comunque l'asset, serve `cdk bootstrap` e una policy di deploy più ampia.
2. **Opzione DNS**: B (raccomandata, obbligata se compri da Cloudflare) o A (solo GoDaddy). Default `dnsZone=db`.
3. **`acmeEmail`**: un indirizzo vero (meglio una casella condivisa). Non l'ho inventato: `cdk.json` è vuoto e il synth si ferma.
4. **Primo deploy con `acmeStaging=true`?** Raccomandato per provare delega DNS e challenge senza consumare i limiti; poi `false` e nuovo deploy (il server viene sostituito e prende il certificato di produzione).
5. **`console.<dominio>` solo nella prima regione** (come prima). Hai scritto "per ogni regione"; con più regioni darei il nome `console` solo dove gira il control plane, per non allargare i permessi DNS delle altre. Dimmi se lo vuoi ovunque.
6. Rischio residuo da accettare: chi ottiene il ruolo dell'istanza può **emettere certificati per i nostri nomi** (scrive i TXT di challenge) e **leggere la chiave** dal secret. Non può cambiare i record A né altri nomi o zone.

### 7.5 Policy di deploy (`deploy-policy.json`), modifiche
- Tolta `CertificateRequest` (`acm:RequestCertificate`).
- Tolta `CertificateManage` (`acm:DescribeCertificate`, `acm:DeleteCertificate`, `acm:AddTagsToCertificate`, `acm:ListTagsForCertificate`).
- Aggiunta `SecretsCreateNamedFenvix`: `secretsmanager:CreateSecret`, `secretsmanager:TagResource` su `arn:aws:secretsmanager:eu-central-1:865859654353:secret:fenvix-*`, con `aws:RequestTag/project = fenvix`.
- Aggiunta `SecretsManageNamedFenvix`: `secretsmanager:DescribeSecret`, `UpdateSecret`, `DeleteSecret`, `UntagResource` sullo stesso ARN. Nessun `GetSecretValue`/`PutSecretValue`: chi fa il deploy non legge la chiave.
- IAM e Route 53: nessuna modifica (le policy inline dei ruoli `fenvix-*` e le azioni sulle zone c'erano già).

### 7.6 Cosa NON ho potuto verificare (richiede AWS o il dominio vero)
- Un'emissione reale presso Let's Encrypt (produzione o staging) e un rinnovo reale: mai eseguiti, per scelta e per regola.
- Le condition key Route 53 valutate da IAM vero (in particolare `ForAllValues` + `Null` sui nomi normalizzati) e che `GetChange` su `change/*` basti: verificato solo il template.
- Che il ruolo legga e scriva il secret senza permessi KMS espliciti (chiave AWS gestita `aws/secretsmanager`): è il comportamento documentato, non provato.
- Su Amazon Linux 2023: i pacchetti `python3.11` e `python3.11-pip`, `python3.11 -m venv`, l'installazione delle wheel con il `pip` del venv, la versione di `pip` e i tag manylinux che sceglie; `flock`, `openssl x509 -ext` (OpenSSL 3) e la AWS CLI v2 (`aws route53 wait resource-record-sets-changed`, `aws secretsmanager ... file://`) li ho provati solo qui, con un `aws` finto.
- Il motore reale con un certificato Let's Encrypt RSA 2048 in PKCS#8 (stesso formato dell'export ACM di prima, ma il binario finale non esiste ancora) e Caddy con `fullchain.pem`/`key.pem` di proprietà `fenvix` montati in sola lettura (Caddy gira come root nel container).
- La delega `db.<dominio>` presso Cloudflare/GoDaddy, il CNAME di `console` seguito da Let's Encrypt, i tempi di propagazione.
- Il comportamento di CloudFormation alla cancellazione del secret (periodo di recupero) e alla ricreazione con lo stesso nome: il README dà il comando `--force-delete-without-recovery` se servisse.

### 7.7 Commit
`29ce019` (codice, test, README, policy) e il commit che aggiunge questa sezione e aggiorna `results-infra.md`, sopra `d63ef74`.


## 8. Indirizzo dell'API: `api.<dominio>` al posto di `console.<dominio>`

Partito da `origin/infra-align` @ `3a7c3f1` (verificato prima di toccare qualcosa). Modificata solo `infra/`. Nessuna attività AWS, nessuna chiamata a Let's Encrypt, nessun segreto reale. Rete usata: solo il registry npm (`npm ci`).

Indirizzi decisi: `fenvix.dev` landing e documentazione (Vercel), `console.fenvix.dev` dashboard (Vercel), `api.fenvix.dev` API del control plane (questo stack), `<nome>-<ws>.<regione>.db.fenvix.dev` database.

### 8.1 Cosa ho cambiato
| Punto | Prima | Ora |
|---|---|---|
| Funzione dell'host | `consoleHost()` → `console.<dominio>` | `apiHost()` → `api.<dominio>` (`lib/control-plane-env.ts`), ogni uso aggiornato (`acme.ts`, `fenvix-stack.ts`, `user-data.ts`) |
| SAN del certificato (prima regione) | `*.<regione>.db.<dominio>` + `console.<dominio>` | `*.<regione>.db.<dominio>` + `api.<dominio>` |
| Record DNS (opzione A) | A `console.<dominio>` (id `Console`) | A `api.<dominio>` (id `Api`; cambia l'id logico, irrilevante perché non c'è nulla di deployato) |
| Challenge DNS-01 e condizione IAM Route 53 | `_acme-challenge.console.<dominio>` (A) / `_acme-challenge-console.db.<dominio>` (B) | `_acme-challenge.api.<dominio>` (A) / `_acme-challenge-api.db.<dominio>` (B). Restano solo TXT, solo UPSERT/DELETE, solo la zona dello stack, `Null` obbligatorio |
| CNAME opzione B | `_acme-challenge.console` → `_acme-challenge-console.db.<dominio>` | `_acme-challenge.api` → `_acme-challenge-api.db.<dominio>` |
| Output | `ConsoleRecordToCreate`, `ConsoleChallengeRecordToCreate`, `ControlPlaneUrl=https://console.<dominio>/v1` | `ApiRecordToCreate`, `ApiChallengeRecordToCreate`, `ControlPlaneUrl=https://api.<dominio>/v1` |
| Caddy | `https://console.<dominio>:443` | `https://api.<dominio>:443` |
| Variabili del control plane | `API_PUBLIC_URL=https://console.<dominio>/v1` | `API_PUBLIC_URL=https://api.<dominio>/v1`; `DASHBOARD_ORIGINS` = `dashboardOrigins` come prima |
| `dashboardOrigins` | obbligatorio, senza default, solo forma `https://host[:porta]` | sempre obbligatorio e senza default (`cdk.json` resta vuoto). In più rifiuta: l'origine dell'API stessa (`https://api.<dominio>`, anche con porta), qualunque host `db.<dominio>` / `*.db.<dominio>`, e una lista vuota dopo il taglio (es. `" , "`) |
| Script (`lib/scripts/`), `deploy-policy.json`, `cdk.json` | non citano il nome | invariati (verificato con ricerca e con il test sul codice) |
| README | `console.<dominio>`, esempi `fenvix.cloud`, dashboard `app.fenvix.cloud` | sezione nuova "Addresses"; tutte le sezioni su `api.<dominio>`; esempi su `fenvix.dev` e `https://console.fenvix.dev`; tabella dei record da creare a mano su Cloudflare (opzione B: 4 NS `db`, CNAME `_acme-challenge.api`, A `api` → `PublicIp`, entrambi "DNS only", CAA se già presenti); `VITE_API_URL` sul progetto Vercel della dashboard; regola sui cookie; smontaggio: cancellare `api` e `_acme-challenge.api`, non `console` |
| `results-infra.md` | `console.<domain>` nella riga sullo stato attuale | `api.<domain>` con rimando a questa sezione |

Il CORS: `DASHBOARD_ORIGINS` è ciò che `control-plane/src/config.ts` legge in `cfg.dashboardOrigins`, che `control-plane/src/app.ts` passa a `@fastify/cors` come `origin`. Il test esistente che carica il `loadConfig` vero del control plane ora controlla anche che le origini risultino esattamente `['https://console.fenvix.dev']` e l'API `https://api.example.com/v1` (eseguito, Node 22).

### 8.2 Test
- **Prima** (su `3a7c3f1`): 9 suite, **133 passati, 1 saltato**, 134 totali.
- **Dopo**: 10 suite, **139 passati, 1 saltato**, 140 totali. Il saltato è lo stesso di prima: il controllo con il certbot vero (`FENVIX_TEST_CERTBOT` non impostato, certbot non installato qui).
- Test esistenti aggiornati al nuovo nome (`infra`, `user-data`, `tls`, `control-plane-env`, `helpers`: `dashboardOrigins=https://console.fenvix.dev`).
- Nuova suite `test/api-host.test.ts` (6 test): con `baseDomain=fenvix.dev`, `dashboardOrigins=https://console.fenvix.dev`, opzioni `db` e `domain`, nel template intero più lo user data decompresso `console.fenvix.dev` compare **solo** nella riga `DASHBOARD_ORIGINS`; con un'altra origine non compare affatto; output, record e condizioni IAM su `api`; `dashboardOrigins` rifiuta API e host dei database; ricerca nel codice di `infra/` (`lib/`, `bin/`, `cdk.json`, `deploy-policy.json`) di ogni forma che costruisce `console.<dominio>` (`console.${`, `'console.`, `_acme-challenge.console`/`-console`, i vecchi nomi di funzioni e output). Questo test ha trovato subito un caso vero: il mio messaggio d'errore conteneva `https://console.${baseDomain}`; l'ho tolto.
- **Mutazioni** (una alla volta, suite `api-host`, `infra`, `user-data`, `tls`; file ripristinato con `git checkout` dopo ognuna, albero pulito verificato):

| # | Mutazione | Test falliti |
|---|---|---|
| 1 | Policy Route 53: aggiunto `_acme-challenge.console.<dominio>` ai nomi ammessi | 8 |
| 2 | Policy Route 53: aggiunto `api.<dominio>` (il record A: il server potrebbe dirottare l'API) | 4 |
| 3 | Policy Route 53: tolta la condizione `Null` sui nomi | 1 |
| 4 | Policy Route 53: tipi `TXT` + `A` | 1 |
| 5 | Certificato: SAN `console.<dominio>` al posto di `api.<dominio>` | 7 |
| 6 | Certificato: `console.<dominio>` aggiunto come nome in più | 6 |
| 7 | `apiHost()` che restituisce `console.<dominio>` | 15 |
| 8 | Solo Caddy su `console.<dominio>` (scritto in modo che compili) | 5 |
| 9 | Tolto il rifiuto dell'origine dell'API in `dashboardOrigins` | 1 |

  (Il primo tentativo della 8 non arrivava ai test: `tsc` la bloccava per un import inutilizzato. L'ho riscritta perché compilasse.)
- `tsc --noEmit`: esito 0.
- `cdk synth --quiet` con la CLI vera, `env -i` (nessuna variabile AWS, credenziali mai lette) e proxy verso `127.0.0.1:9`, `baseDomain=fenvix.dev`, `dashboardOrigins=https://console.fenvix.dev`, email segnaposto `@example.com`: esito 0 con `dnsZone=db` (template 39,8 KB) e con `dnsZone=domain` (39,6 KB), solo gli avvisi W3010 noti. Controllo del template (entrambi): nessuna risorsa ACM/`CertificateManager`, nessuna stringa `acm:`; ingressi solo `0.0.0.0/0` su 27018 e 443, la 8443 in nessuna regola (solo `--admin-listen=172.17.0.1:8443` e l'endpoint interno del control plane); user data 13,9 KB senza `BEGIN`, `PRIVATE KEY`, `AKIA`, `password=` (l'unica occorrenza di `admin-token=` è il nome del parametro nel controllo `--match`, come prima); `route53:ChangeResourceRecordSets` solo sulla zona dello stack con nomi `_acme-challenge.eu-central-1.db.fenvix.dev` + `_acme-challenge-api.db.fenvix.dev` (B) oppure `_acme-challenge.api.fenvix.dev` (A); record `*.eu-central-1.db.fenvix.dev` (B) più `api.fenvix.dev` (A); `API_PUBLIC_URL=https://api.fenvix.dev/v1`, `DASHBOARD_ORIGINS=https://console.fenvix.dev`, Caddy `https://api.fenvix.dev:443`; `console.fenvix.dev` assente fuori da `DASHBOARD_ORIGINS`.
- cdk-nag: 0 risultati non giustificati nelle tre configurazioni del test (default, `db` + staging, due regioni). `lib/nag-suppressions.ts` non è cambiato.

### 8.3 Decisioni che servono a te
1. **`VITE_API_URL` con o senza `/v1`.** Mi hai scritto `https://api.<dominio>`, ma la dashboard (`.env.example`, `src/data/explorer-http.ts`) si aspetta l'URL **con** `/v1` (fa `fetch(apiUrl + path)`). Nel README ho scritto `VITE_API_URL=https://api.fenvix.dev/v1`. Va impostata nel progetto Vercel della dashboard (Settings, Environment Variables) e poi rifatto il deploy della dashboard: io non ho toccato nulla fuori da `infra/`.
2. **Regola sui cookie** (nel README): niente `Domain=.fenvix.dev`; cookie solo host-only su `console.fenvix.dev`. Oggi la dashboard manda il token come `Authorization: Bearer` con `credentials: "omit"`; la regola serve a non cambiarlo per sbaglio. Non ho controllato come Supabase salva la sessione nel browser (fuori da `infra/`).
3. **Il rifiuto in `dashboardOrigins`** di `https://api.<dominio>` e di `*.db.<dominio>` è un controllo nuovo che non mi avevi chiesto esplicitamente; se ti serve un'eccezione (non ne vedo), è una riga in `lib/config.ts`.
4. Restano valide le decisioni aperte della sezione 7.4 (staging al primo deploy, `acmeEmail`, opzione DNS); la 7.4.5 ora si legge "`api.<dominio>` solo nella prima regione".

### 8.4 Cosa NON ho potuto verificare (richiede AWS, Cloudflare o Vercel)
- Che IAM vero accetti i nuovi nomi nelle condition key Route 53 e neghi gli altri: verificato solo il template.
- Che Let's Encrypt segua il CNAME `_acme-challenge.api.fenvix.dev` → `_acme-challenge-api.db.fenvix.dev` su Cloudflare in modalità "DNS only", e i tempi di propagazione.
- Un'emissione o un rinnovo reali per `api.fenvix.dev`.
- Che la dashboard su `console.fenvix.dev` chiami davvero `https://api.fenvix.dev/v1` passando il CORS in un browser vero (verificato solo che il `loadConfig` del control plane riceve la lista giusta).
- Tutto quanto elencato in 7.6 resta non verificato.

### 8.5 Commit
Su `infra-align`, sopra `3a7c3f1`: `57755e3` (codice, test, README, `results-infra.md`) e il commit che aggiunge questa sezione.

## 9. Allineamento al motore finale (test5 `final-engine`, motore `41ed169`)

Punta controllata prima di iniziare: `origin/infra-align` = `2694131`. Solo `infra/`. Nessuna attività AWS; le variabili `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` tolte dall'ambiente in ogni comando (valori mai letti). Rete usata: GitHub (clone di `Mircoguidetti/test5` e di `apache/arrow-rs-object-store` al tag `v0.14.2`) e registry npm (`npm ci`).

**Fonte.** Ho letto il codice del motore a `41ed169`, non solo il report: `mongo-server/src/main.rs` (`struct Args`, la costruzione del client S3), `mongo-server/src/ctl/mod.rs` (`CtlArgs`, lettura del token), `tls.rs`, `admin_cmds.rs`, `auth.rs`, `authz.rs` + `builtin_roles.json`, `ctl/http.rs`, `ctl/api.rs`, `ctl/pitr.rs`, `lease.rs`. La punta del branch (`e038db7`) cambia solo report e strumenti: `main.rs` è identico a `41ed169`. Per le credenziali S3 ho letto `object_store` 0.14.2 (la versione nel `Cargo.lock` del motore): `src/aws/builder.rs`, `src/aws/credential.rs`, `src/client/mod.rs`, `src/client/token.rs`.

### 9.1 Flag e variabili d'ambiente del motore, confronto con infra

Flag (tutti `clap`, `--nome-con-trattini`). "Default" = non passato da infra.

| infra assume | il motore ha (codice `41ed169`) | azione |
|---|---|---|
| binario `/opt/fenvix/bin/fenvix-engine` | il binario si chiama `mongo-server` | salvato come `/opt/fenvix/bin/mongo-server`; il nome sta solo in `ENGINE_BINARY_NAME` (`lib/engine-command.ts`); un test fallisce se compare altrove in `lib/` o `test/`. L'URL di download (`engineUrl`) resta un'impostazione libera |
| `--listen=0.0.0.0:27018` | `--listen` (default `127.0.0.1:27018`) | invariato |
| `--admin-listen=172.17.0.1:8443` | `--admin-listen` (senza: niente porta admin, niente agenti ctl, niente ripresa dopo crash) | invariato |
| `--admin-token-file` | **esistono tutti e tre**: `--admin-token-file`, `--admin-token`, `MONGO_ADMIN_TOKEN`; ordine: file, poi flag, poi variabile; il file viene letto e ripulito (`trim`); minimo 16 caratteri | tengo il **file** (`/run/fenvix/admin-token`, 0600, cartella 0700, scritto da SSM a ogni avvio). Perché non la variabile: un `Environment=` è stampato da `systemctl show`/`status`, si eredita nei processi figli e si legge da `/proc/<pid>/environ`; il file non va in riga di comando né nel journal |
| `--auth` | `--auth` | invariato |
| `--tls-mode=requireTLS` | `disabled\|allowTLS\|preferTLS\|requireTLS` | invariato |
| `--tls-certificate-key-file=/etc/fenvix/tls/engine.pem` | un file PEM con tutti i certificati (catena) e la chiave (PKCS#8, PKCS#1 o SEC1) | invariato: `engine.pem` è catena + chiave PKCS#8 RSA |
| nessun `--tls-ca-file` | `--tls-ca-file` è **facoltativo**: serve solo a verificare i **certificati client**; se c'è, il motore chiede un certificato a ogni client e rifiuta chi non lo presenta (salvo `--tls-allow-connections-without-certificates`) | non lo passo (i clienti usano utente e password); un test vieta il flag |
| regione da `AWS_REGION` nell'unità | `--region` facoltativo, ma con `--store s3` serve uno tra `--region`, `AWS_REGION`, `AWS_DEFAULT_REGION`, altrimenti il motore non parte | **aggiunto** `--region=<regione>`; tengo anche `AWS_REGION`/`AWS_DEFAULT_REGION` (stesso valore, stessa sorgente) |
| `--store=s3 --bucket=...` | `--store s3\|local\|memory`, `--bucket` (default `bench`) | invariato |
| nessun `--endpoint` (temevo il default MinIO) | `--endpoint` vuoto = AWS (anche `AWS_ENDPOINT`) | risolto: nessun endpoint, nessun MinIO |
| nessun `--holder` | `--holder` (default: `<pid>-<casuale>` a ogni avvio) | **aggiunto** `--holder=<instance id>`, vedi 9.3 |
| nessun `--idle-secs` | default 60 | **esplicito** `--idle-secs=60` |
| `engineRetentionWindowSecs`=604800 solo nel control plane | `--retention-window-secs` (default **0**: nessun punto di ripristino per i database senza impostazione propria) | **aggiunto** `--retention-window-secs=<engineRetentionWindowSecs>` (604800) |
| nessun `--wal-gc-mode` | default `bulk`; `slatedb` rompe i restore (7 su 7 falliti nel report del motore) | **esplicito** `--wal-gc-mode=bulk` |
| — | `--lease-ttl-secs` 30, `--replica-set` vuoto, `--advertise`, `--process-lease`, `--ttl-sweep-secs`, `--ttl-wake-sleeping`, `--ttl-*`, `--wal-flush-ms` 0, `--writer-poll-secs` 30, `--wal-gc-secs` 20, `--sst-gc-secs` 60, `--sst-gc-min-unref-secs` 120, `--group-commit-window-ms` 0, `--group-commit-adaptive`, `--durable-reads` true, `--max-concurrent-wakes` 0, `--retention-interval-secs` 600, `--retention-prune-secs` 600, `--usage-flush-secs` 60, `--pin-lease-ttl-secs` 30, `--export-ttl-secs` 86400 | lasciati al default (elenco nel commento di `engineArgs`). `--replica-set` vuoto = server standalone: niente transazioni multi-documento né change stream per i driver (decisione 9.5.3) |
| — | controlli di test: `--no-leases`, `--unsafe-skip-ownership-checks`, `--ack-before-durable`, `--no-ctl-recovery`, `--no-maintenance`, `--no-ttl`, `--gc-control-delete-live`, `--l0-max-ssts`, `--l0-sst-bytes`, `--serialize-reads`, `--no-group-commit`, `--log-commands`, `--local-dir` | mai passati; un test li vieta |

Variabili d'ambiente lette dal motore (ricerca di `env::var`/`var_os` in `mongo-server/src` e `src`):

| variabile | uso | infra |
|---|---|---|
| tutte le `AWS_*` (via `AmazonS3Builder::from_env()`): `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, `AWS_CONTAINER_CREDENTIALS_*`, `AWS_METADATA_ENDPOINT`, `AWS_IMDSV1_FALLBACK`, ... | configurazione S3 e credenziali | l'unità imposta solo `AWS_REGION` e `AWS_DEFAULT_REGION`; nessuna chiave |
| `MONGO_ADMIN_TOKEN` | token admin (terza scelta) | non usata (file) |
| `MONGO_NO_FETCH_SCAN`, `MONGO_BUILD_CHUNK`, `MONGO_TEST_DISABLE_WAL_RETENTION_GUARD`, `CTL_DISABLE_WAL_RETENTION`, `CTL_USAGE_DAY_OFFSET_MS`, `CTL_FAILPOINT` | controlli di test | non impostate (un servizio systemd non eredita l'ambiente di chi lo avvia) |

### 9.2 Credenziali S3: cosa ho verificato leggendo il codice
- Il motore (`main.rs`, `--store s3`) costruisce il client con `AmazonS3Builder::from_env()` più bucket, regione ed endpoint; **non passa chiavi**.
- `object_store` 0.14.2, `builder.rs` riga 1168 e seguenti, ordine delle sorgenti: credenziali date al builder → chiavi statiche (`AWS_ACCESS_KEY_ID`+`AWS_SECRET_ACCESS_KEY`) → token d'identità web (`AWS_WEB_IDENTITY_TOKEN_FILE`+`AWS_ROLE_ARN`) → credenziali del container ECS (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`) → EKS Pod Identity → **altrimenti `InstanceCredentialProvider`** su `http://169.254.169.254`. Nell'unità nessuna di quelle variabili è impostata, quindi si arriva al ruolo dell'istanza.
- `credential.rs` `instance_creds`: prima `PUT /latest/api/token` con `X-aws-ec2-metadata-token-ttl-seconds: 600` (**IMDSv2**), poi `GET .../iam/security-credentials/` e `GET .../<ruolo>` con l'header del token. Il ripiego su IMDSv1 avviene solo se `imdsv1_fallback` è vero, e il suo default è falso (`ConfigValue<bool>` di default): con `HttpTokens: required` non serve.
- Client dei metadati: HTTP permesso, timeout di connessione 1 s (`metadata_options`). Le credenziali vengono messe in cache e rinnovate quando mancano meno di 5 minuti alla scadenza (`token.rs`, `min_ttl` 300 s).
- **Hop limit 1**: il motore è un processo sull'host (non in un container), quindi la risposta PUT arriva con un solo salto. Il template ha `HttpTokens: required`, `HttpPutResponseHopLimit: 1`.
- Permessi: il ruolo ha `s3:GetObject/PutObject/DeleteObject/AbortMultipartUpload` sugli oggetti e `s3:ListBucket` sul bucket. La pulizia WAL `bulk` usa la cancellazione multipla (DeleteObjects), che richiede `s3:DeleteObject`: presente.

Non verificato: che il tarball di `object_store` 0.14.2 scaricato da crates.io (checksum nel `Cargo.lock`) sia identico al tag GitHub che ho letto (crates.io non raggiungibile da qui); che `reqwest` non usi un proxy (lo farebbe solo con `HTTP_PROXY`/`HTTPS_PROXY` nell'ambiente del servizio, che l'unità non imposta); che slatedb non legga altre variabili (non ho letto il suo codice).

### 9.3 Scelte sui valori
- **`--holder=<instance id>`.** Il proprietario dei lease. Con il default (diverso a ogni avvio), dopo un crash il motore riavviato trova i lease dei database aperti intestati al processo morto e li può riprendere solo dopo la scadenza (`--lease-ttl-secs` 30, rinnovo ogni 10 s): fino a 30 s di errori "retry" su quei database. Con un id stabile, `lease.rs` riconosce il lease come proprio (`holder == self.holder`) e lo riprende subito. È sicuro solo se due processi vivi non hanno mai lo stesso id: l'instance id è unico per istanza (una sostituzione da CloudFormation crea un'istanza nuova con id diverso, che aspetta i lease della vecchia) e systemd tiene un solo motore per istanza. Non uso l'hostname (può essere generico) né il machine-id (dipende da come è fatta l'AMI). Implementazione: il boot script legge l'id da IMDSv2 (`curl` con token, `--retry 3`), lo controlla con `^i-[0-9a-f]{8,17}$` (altrimenti si ferma) e lo scrive nell'unità al posto di `@INSTANCE_ID@` prima di `systemctl enable`. Un test esegue il controllo e la sostituzione veri e prova 5 valori sbagliati. Anche `/v1/health` della porta admin mostra il `holder`.
- **`--idle-secs=60`.** Default del motore e valore con cui è stato verificato (report del motore, esempio di produzione). Un database aperto costa richieste S3 periodiche (rinnovo del lease ogni 10 s, lettura del manifest ogni 30 s); chiuso non costa nulla, ma il primo comando dopo la chiusura paga un risveglio a freddo. Alzarlo riduce i risvegli e aumenta il costo dei database poco usati: da decidere con i numeri del primo mese.
- **`--retention-window-secs=604800`.** Il control plane imposta già 604800 su ogni database che crea; il flag è la rete di sicurezza per i database senza impostazione (per esempio se la chiamata `PUT /retention` fallisse) e prende lo stesso valore (`engineRetentionWindowSecs`, una sola sorgente). Conseguenza: vale anche per il tenant `admin` (utenti e ruoli), che terrà 7 giorni di WAL (pochi dati).
- **`--wal-gc-mode=bulk`.** È il default; lo fisso perché è l'unica modalità con cui i restore sono esatti.

### 9.4 Utenti, token, TLS
- **Utenti con `--auth` (Step 10).** Lo script `fenvix-create-engine-users` è ancora corretto per il motore finale, verificato sul codice: (1) eccezione localhost in `auth.rs` (`authorize`): finché non esiste alcun utente, `createUser`/`createRole` su `admin` sono ammessi solo se il client si collega da un indirizzo di loopback; lo script usa `docker run --network host` verso `127.0.0.1:27018`, quindi è loopback; TLS richiesto, lo script usa `tls: true` + `tlsAllowInvalidHostnames` (il certificato è per `*.<regione>.db.<dominio>`, non per 127.0.0.1); (2) SCRAM-SHA-256 c'è; `mechanisms: ["SCRAM-SHA-256"]` è accettato da `create_user`; (3) il ruolo `fenvix_provisioner` sulla risorsa `{db: "", collection: ""}` con 7 azioni tutte note al motore (`action_known`); `fenvix_root` (ruolo `root`) può concederlo (`may_grant`). Ho solo corretto un commento: il motore oggi oscura le password nei messaggi di errore (report del motore 2.2); lo script continua comunque a stampare solo i codici d'errore. Non eseguito su un motore vero.
- **Rinnovo del certificato.** Il motore ha `rotateCertificates` e ricarica davvero i file (`tls.rs` `rotate`, test `test_09c_tls_rotate.py` del motore, eseguito però **senza** `--auth`). Con `--auth`, `authz::required` non ha una voce per `rotateCertificates` e lo tratta come comando sconosciuto: serve l'azione `anyAction`, che in `builtin_roles.json` ha solo `__system`; `root` non ce l'ha. Quindi con `--auth` nessun nostro utente può farlo. **Tengo il riavvio** (motore e Caddy solo quando il certificato cambia, già così); README aggiornato con il motivo. Se il motore aggiungesse `rotateCertificates → azione rotateCertificates sul cluster` (come mongod: ce l'hanno `root`, `hostManager`, `clusterAdmin`), si potrebbe sostituire il riavvio con il comando (decisione 9.5.2).
- **Porta admin.** `GET /v1/health` (non `/health`): il token si controlla prima del percorso, quindi senza token risponde 401 su qualunque percorso; README corretto su `/v1/health`.

### 9.5 Decisioni che servono a te
1. **`--holder` = instance id** (9.3): se preferisci il default del motore (nessun rischio di id condivisi, ma fino a 30 s di attesa dopo un crash), è una riga in `engineArgs` più le tre righe IMDS nel boot script.
2. **`rotateCertificates` con `--auth`**: chiedere al motore di mapparlo sull'azione `rotateCertificates` del cluster (come mongod) toglierebbe il riavvio a ogni rinnovo (ogni ~60 giorni, pochi secondi di disconnessione). Oggi non serve cambiare nulla in infra.
3. **Replica set**: con `--replica-set` vuoto i driver vedono un server standalone e **non permettono transazioni multi-documento né change stream**. Abilitarli richiede `--replica-set` + `--advertise` con un nome host che i clienti raggiungono e che il certificato copre: decisione di prodotto, non l'ho attivato.
4. **`--idle-secs`**: 60 ora; da rivedere con i costi reali.
5. **Ruolo del provisioner**: nel motore la risorsa `{db: "", collection: ""}` copre anche il database `admin` (`Res::covers`), quindi il provisioner può concedere ruoli **su `admin`** (per esempio `userAdmin@admin`, o creare ruoli personalizzati su `admin`). `may_grant` impedisce di dare privilegi di cluster che il provisioner non ha, ma non ho verificato fin dove arrivi un utente con ruoli su `admin` (per esempio scritture dirette su `admin.system.users`). Va chiuso dal control plane (non concedere mai ruoli su `admin`) e provato con un test sul motore; non è cambiato qui.

### 9.6 Test, synth e template
- Prima (su `2694131`): `tsc --noEmit` esito 0; jest **139 passati, 1 saltato** (il test con certbot reale, solo con `FENVIX_TEST_CERTBOT`), 140 totali, 10 suite; user data 13.910 byte.
- Dopo: `tsc --noEmit` esito 0; jest **141 passati, 1 saltato**, 142 totali, 10 suite. Nuovi: nome del binario in un solo punto; holder da IMDSv2 controllato e sostituito prima di `enable` (eseguito con bash). Aggiornati: elenco esatto dei flag, flag vietati (più controlli di test, `--tls-ca-file`, `--wal-gc-mode` diversi da bulk), unità con `--region`/`--holder`.
- `cdk synth --quiet` con la CLI vera, `env -i` (nessuna variabile AWS) e proxy verso `127.0.0.1:9`: esito 0, template 40,1 KB, solo gli avvisi W3010 noti.
- Template: ingressi solo `0.0.0.0/0` su 27018 e 443, **8443 in nessuna regola** (compare solo in `--admin-listen=172.17.0.1:8443` e nell'endpoint interno del control plane); user data **14.171 byte** (limite 16.384; dominio lungo 14.275 nel test): ci stiamo, nessun controllo tolto; nessun `BEGIN`, `PRIVATE KEY`, `AKIA`, `password=`, `MONGO_ADMIN_TOKEN` (l'unico `admin-token=` è il nome del parametro nel `--match`, come prima); IMDS `required`, hop 1; permessi del ruolo motore invariati (S3 sul suo bucket, SSM `/fenvix/prod/*`, `kms:Decrypt` via SSM, Session Manager, il suo secret TLS, la sua zona Route 53 con condizioni). cdk-nag: 0 risultati non giustificati nelle tre configurazioni del test; `lib/nag-suppressions.ts` non è cambiato.
- `shellcheck` non è installato qui: lo script è stato controllato solo con `bash -n` e con l'esecuzione delle parti nei test.

### 9.7 Cosa NON ho potuto verificare (richiede AWS o un motore in esecuzione)
- Che il motore su EC2 ottenga davvero le credenziali dal ruolo dell'istanza via IMDSv2 con hop 1 e scriva nel bucket (verificato solo leggendo il codice, 9.2), e che la bucket policy accetti la sessione del ruolo.
- Che le PUT condizionali dei lease (`If-None-Match`/`If-Match`) funzionino sul bucket vero (il report del motore le ha provate su MinIO, non su S3).
- Il boot reale: lettura dell'instance id da IMDSv2 su AL2023, l'avvio del binario `mongo-server` con questi flag, i messaggi di log attesi nello Step 9.
- Lo script dello Step 10 contro il motore vero (eccezione localhost, creazione di ruolo e utenti).
- Che `rotateCertificates` con `--auth` risponda davvero Unauthorized a `root` (dedotto dal codice, 9.4).
- Il tempo di chiusura del motore allo stop di systemd (`close_all` di molti database) rispetto al timeout di default di 90 s: non l'ho cambiato.
- Tutto quanto elencato in 7.6 e 8.4.

### 9.8 Commit
Su `infra-align`, sopra `2694131`: `7cd2107` (codice, test, README) e il commit che aggiunge questa sezione. Nel README il nome `mongo-server` compare in due frasi (Step 5 e Step 9): da aggiornare insieme a `ENGINE_BINARY_NAME` quando il binario verrà rinominato.

## 10. Reti fidate del motore (`--trusted-networks`, test5 `network-limits` @ `1c9fee7`)

Punta controllata prima di iniziare: `origin/infra-align` = `7036589`. Solo `infra/`. Nessuna attività AWS; le variabili `AWS_*` tolte dall'ambiente in ogni comando (valori mai letti); `cdk synth` con `env -i` e proxy verso `127.0.0.1:9`.

**Perché serve.** Il motore `network-limits` controlla la lista di IP ammessi di ogni database e conta le autenticazioni fallite per indirizzo (5 su un database o 10 su tutti in 60 s bloccano l'indirizzo per 5 minuti, poi il doppio fino a un'ora). Le connessioni dalle reti fidate saltano lista, blocchi e conteggio. Il predefinito del motore è solo il loopback: nel nostro deploy il control plane (Data Explorer e provisioner) gira in un container, quindi senza il flag la lista di un cliente si applicherebbe anche al Data Explorer e gli errori del control plane verrebbero contati (5 errori del provisioner su `admin` lo bloccano: provato sul motore vero in `control-plane/tests/engine-real/network.test.ts`).

### 10.1 Quale rete vede il motore (trovato leggendo `lib/user-data.ts`)
- La rete del bridge Docker predefinito **era già fissata**: `bip` `172.17.0.1/16` in `/etc/docker/daemon.json`, quindi subnet `172.17.0.0/16`, e `172.17.0.1` (l'indirizzo su cui ascolta la porta admin e a cui punta `host.docker.internal`) è dentro (test).
- **Ma il container del control plane non è sul bridge predefinito**: è sulla rete Docker definita dall'utente `fenvix` (la stessa di Caddy, che raggiunge il control plane per nome). La sua subnet **non era fissata** (`docker network create fenvix` senza `--subnet`: Docker la sceglie dai suoi pool, di solito `172.18.0.0/16`, non garantito). Il control plane si collega a `host.docker.internal:27018` = `172.17.0.1`, ma il pacchetto parte dal container con il suo indirizzo sulla rete `fenvix` e arriva all'host senza traduzione d'indirizzo (la MASQUERADE di Docker vale solo per il traffico che esce dall'host): **il motore vede l'indirizzo della rete `fenvix`, non `172.17.0.x`**. Fidarsi solo di `172.17.0.0/16` non sarebbe bastato.
- Correzione: la subnet di `fenvix` ora è fissata nello stesso punto del codice dove è definito il bridge (`lib/engine-command.ts`: `DOCKER_BRIDGE_IP`, `DOCKER_BRIDGE_PREFIX`, `DOCKER_BRIDGE_SUBNET`, `DOCKER_NETWORK`, `DOCKER_NETWORK_SUBNET` = `172.18.0.0/24`, `TRUSTED_NETWORKS`). Le due unità che usano la rete la creano con `--subnet=172.18.0.0/24`; siccome `docker network create` non tocca una rete già esistente, un nuovo script `/usr/local/bin/fenvix-check-network` (ExecStartPre senza `-`) ferma control plane e Caddy con un messaggio chiaro se `fenvix` esiste con un'altra subnet.

### 10.2 Il flag
`--trusted-networks=127.0.0.0/8,::1/128,172.17.0.0/16,172.18.0.0/24` (ultimo flag di `engineArgs`). Sono tutte reti dell'host: loopback (lo script dello Step 10 usa `--network host` verso `127.0.0.1`), bridge predefinito, rete del control plane e di Caddy. Nessuna rete da cui arrivano i clienti: la porta 27018 non è pubblicata da Docker né dietro un proxy, quindi i clienti arrivano con il loro indirizzo vero (il motore non legge PROXY protocol). Nella rete `fenvix` c'è anche Caddy: un Caddy compromesso salterebbe le liste, ma non ha password dei database (rischio accettato, scritto qui). I test verificano: elenco esatto; `172.17.0.1` dentro `172.17.0.0/16` e `bip` coerente; reti IPv4 private (loopback o `172.16.0.0/12`), nessuna sovrapposta alla VPC `10.40.0.0/24` né tra loro, niente `0.0.0.0/0` o `::/0`; `--subnet` in entrambe le unità; lo script di controllo eseguito con un `docker` finto (subnet giusta: 0; sbagliata o assente: errore con la subnet attesa nel messaggio).

**Compatibilità:** un motore più vecchio di `network-limits` non conosce il flag e non parte (systemd lo riavvia ogni 5 s). La release del motore (`engineUrl`/`engineSha256`) deve essere `network-limits` o successiva: scritto nel README.

### 10.3 Limite di 16 KB dello user data
Prima: 14.206 byte (test con il dominio di prova; 14.275 con il dominio lungo). Dopo: **14.457 byte** (dominio lungo 14.522); nel template sintetizzato, con i due id CloudFormation come segnaposto, 14.386 byte. Ci stiamo (margine circa 1,9 KB), nessun controllo tolto.

### 10.4 Test e synth
- Prima (su `7036589`): `tsc --noEmit` esito 0; jest **141 passati, 1 saltato**, 142 totali, 10 suite.
- Dopo: `tsc --noEmit` esito 0; jest **146 passati, 1 saltato**, 147 totali, 11 suite. Nuovo `test/trusted-networks.test.ts` (5 test, scritto prima del codice: falliva perché le costanti non esistevano). Cambiato di proposito `test/engine-command.test.ts`: l'elenco esatto dei flag ora include `--trusted-networks` (comportamento cambiato).
- `cdk synth --quiet` con la CLI vera, `env -i` (nessuna variabile AWS) e proxy verso `127.0.0.1:9`: esito 0, template 40,3 KB, solo i 2 avvisi W3010 noti. Nel boot script decodificato dal template: `--trusted-networks=...` una volta, `network create --subnet=172.18.0.0/24 fenvix` due volte, `bip` `172.17.0.1/16`, `--admin-listen=172.17.0.1:8443`; nessun `BEGIN`, `PRIVATE KEY`, `AKIA`, `password=`, `MONGO_ADMIN_TOKEN`; ingressi solo `0.0.0.0/0` su 27018 e 443.

### 10.5 Cosa NON ho potuto verificare
- Su un server vero: che il traffico dal container della rete `fenvix` verso `172.17.0.1:27018` arrivi davvero al motore con l'indirizzo `172.18.0.x` (ragionamento sul percorso dei pacchetti e sulle regole di Docker; nel sandbox non c'è Docker). La verifica dopo il deploy è nello Step 9 del README e nel campo `dataExplorer.trusted` che il control plane mostra nella scheda Network (falso se il motore non si fida del suo indirizzo).
- L'avvio di `fenvix-check-network` sotto systemd su AL2023 e l'output reale di `docker network inspect` (il formato `{{range .IPAM.Config}}{{.Subnet}}{{end}}` è quello documentato; provato solo con un `docker` finto).
- Il comportamento dietro un NAT, IPv6 da un client vero, il carico.

### 10.6 Commit
Su `infra-align`, sopra `7036589`: un commit con codice, test, README e questa sezione.
