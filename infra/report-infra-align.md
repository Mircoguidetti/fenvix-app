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

## 7. Seguito: Let's Encrypt al posto di ACM esportabile

Partito da `origin/infra-align` @ `d63ef74`, commit aggiunti sopra sullo stesso branch. Toccata solo `infra/`. Nessuna attività AWS (nessun deploy, nessuna chiamata API, credenziali tolte dall'ambiente per ogni comando), nessuna chiamata a Let's Encrypt (neppure staging): i test usano un client ACME finto. Pebble non l'ho fatto girare: compilarlo richiede moduli Go da `proxy.golang.org`/`golang.org`, fuori dalla rete consentita. Uniche richieste esterne: GitHub (sorgente di lego v5.5.2, i due archivi linux e il file dei checksum della release) e il registry npm già usato.

### 7.1 Cosa ho cambiato

| File | Modifica |
|---|---|
| `lib/fenvix-stack.ts` | Tolti `acm.Certificate` (`CertificateExport: ENABLED`) e `acm:ExportCertificate`. Aggiunte le istruzioni Route 53 del ruolo (7.3), lettura/scrittura del parametro di stato TLS e `kms:Encrypt`/`GenerateDataKey` solo via SSM e solo per quel parametro (contesto di cifratura `PARAMETER_ARN`), i parametri String del bundle di avvio con lettura solo di quei nomi (7.5). Zona `db.<dominio>` o `<dominio>` secondo `dnsZone`; con `db` il record `console` non è nello stack e l'output `ManualDnsRecords` dice cosa creare a mano |
| `lib/acme.ts` (nuovo) | Versione e SHA-256 di lego, endpoint produzione/staging, nomi del certificato e dei record `_acme-challenge`, nome del parametro di stato, lo script `fenvix-tls` |
| `lib/user-data.ts` | Tolto `certRefreshScript` (export ACM). Download di lego con verifica SHA-256 per architettura; `fenvix-tls` come `ExecStartPre` del motore e di Caddy; `fenvix-tls.timer` due volte al giorno; `/etc/fenvix/tls` di `fenvix`, 0700; Caddy legge lo stesso `engine.pem` (cartella montata in sola lettura); script e unità spostati nel bundle di avvio |
| `lib/config.ts` | `acmeEmail` obbligatorio senza default (validato, niente apici o caratteri di shell), `acmeStaging` (`true`/`false`, default `false`), `dnsZone` (`domain` o `db`) |
| `lib/engine-command.ts` | Tolto `proxyCertDir`; commento del PEM aggiornato |
| `lib/nag-suppressions.ts` | Motivazione IAM5 aggiornata; un solo `appliesTo` nuovo: `arn:aws:route53:::change/*` |
| `cdk.json` | `dnsZone: "db"`, `acmeStaging: "false"`; `acmeEmail` assente apposta (il synth si ferma e chiede `FENVIX_ACME_EMAIL`) |
| `deploy-policy.json` | 7.7 |
| `test/*` | 7.8 |
| `README.md` | "The domain" (opzioni A e B, record), "The certificate" (rinnovo, limiti, staging), Step 5/7/9/11, rinnovo, teardown |
| `results-infra.md` | Nota in testa: le righe su ACM sono superate |

Riferimenti ad ACM rimasti: nessuno nel codice, nel template, nella policy di deploy, nelle soppressioni. Restano solo nelle sezioni storiche di questo report e di `results-infra.md`, marcate come superate.

### 7.2 Client ACME: lego 5.5.2

Scelto **lego** (go-acme/lego) **v5.5.2** (23 settembre 2026). Un solo binario statico Go; nessun Python, pip o venv sull'host; provider Route 53 incluso, con le credenziali del ruolo dell'istanza dalla catena standard dell'SDK (IMDSv2). Download da `github.com/go-acme/lego/releases/download/v5.5.2/lego_v5.5.2_linux_{amd64,arm64}.tar.gz`, verificato con SHA-256 fissato nel codice: `2a35505…bef` (amd64) e `15b14ec…e8c` (arm64). Ho scaricato io i due archivi, calcolato gli hash e confrontati con `lego_5.5.2_checksums.txt` della release: coincidono. Se l'hash non corrisponde, l'avvio si ferma (`set -e`, `sha256sum -c`). Niente `curl | sh` (un test lo controlla). Non ho preso la v5.6.0 perché è uscita oggi.

Perché non certbot: certbot + `certbot-dns-route53` in un venv portano boto3/botocore e una decina di dipendenze. Per installarle in modo verificabile servono un lockfile con l'hash di ogni pacchetto (`pip --require-hashes`) e la versione di Python di Amazon Linux. Con lego basta un hash per architettura.

Ho letto il sorgente di v5.5.2 per usare i flag e le chiamate esatte. `lego run` ottiene o rinnova. Il provider Route 53 chiama `ListResourceRecordSets` (legge i valori TXT del nome della challenge), `ChangeResourceRecordSets` (`UPSERT`, poi `DELETE` o `UPSERT` alla pulizia), `GetChange` (attesa `INSYNC`), e `ListHostedZonesByName` **solo se `AWS_HOSTED_ZONE_ID` non è impostato**. Lo script lo imposta, quindi quella chiamata, l'unica che richiede `"*"`, non serve. lego segue i CNAME di `_acme-challenge` (serve all'opzione B per `console`).

Flag usati: `--dns route53 --key-type ec256 --cert.name fenvix --renew-days 30 --ari-disable --no-random-sleep --force-cert-domains --log.format text`. ARI disattivato perché la regola dei 30 giorni sia quella decisa e testabile. Il ritardo casuale lo dà già il timer (`RandomizedDelaySec=1h`).

### 7.3 IAM Route 53 (ruolo dell'istanza)

```
AcmeChallengeTxtOnly   route53:ChangeResourceRecordSets  su arn:...:route53:::hostedzone/<zona dello stack>
  ForAllValues:StringEquals
    route53:ChangeResourceRecordSetsRecordTypes          = [TXT]
    route53:ChangeResourceRecordSetsNormalizedRecordNames = [_acme-challenge.<regione>.db.<dominio>, _acme-challenge.console.<dominio>]
                                                            (con dnsZone=db: _acme-challenge.console.db.<dominio>)
    route53:ChangeResourceRecordSetsActions              = [UPSERT, DELETE]
AcmeChallengeRead      route53:ListResourceRecordSets    su la stessa zona
AcmeChallengeWait      route53:GetChange                 su arn:aws:route53:::change/*
```
Nessun `Resource "*"` su Route 53: `GetChange` accetta l'ARN `change/*` (l'id della change non esiste prima della richiesta) e `ListHostedZonesByName` non serve (7.2). Il ruolo non può toccare record A, altri tipi, altri nomi o altre zone. Ogni regione può scrivere solo il proprio nome. `console` è solo nella regione del control plane.

In più, rispetto alla richiesta, ho dato `ListResourceRecordSets` sulla zona, perché lego v5.5.2 lo chiama prima di ogni scrittura. Rivela i nomi e i valori dei record della zona (con l'opzione B solo `db.<dominio>`), non permette modifiche.

**CNAME-delegation verso una zona dedicata: scartata come zona separata, adottata solo per `console` nell'opzione B.** Una zona dedicata solo alle challenge (ad esempio `acme.<dominio>`, con `_acme-challenge.X` CNAME verso di essa) servirebbe se il ruolo dovesse scrivere nella zona dei record veri senza condizioni. Qui le condizioni (tipo TXT, nomi esatti, azioni) limitano già la scrittura nella zona dello stack a quei nomi. Una zona in più costerebbe $0,50 al mese, CNAME fissi da tenere e un punto di rottura in più, senza ridurre il rischio residuo: chi scrive il TXT ottiene il certificato, ovunque stia il TXT. La uso invece dove serve davvero: con l'opzione B `console.<dominio>` sta nel DNS principale (Cloudflare/GoDaddy), dove il server non ha accesso. Un CNAME creato a mano `_acme-challenge.console.<dominio>` → `_acme-challenge.console.db.<dominio>` gli permette di dimostrare `console` scrivendo solo in Route 53.

**Rischio residuo (dichiarato):** chi ottiene il ruolo dell'istanza, cioè chi ha il controllo dell'host (il limite di salti IMDS = 1 lo nega ai container), può emettere certificati validi per `*.<regione>.db.<dominio>` e `console.<dominio>` e leggere la chiave salvata in SSM. Può quindi impersonare i nostri nomi se riesce anche a deviare il traffico, cosa che il ruolo da solo non permette (niente record A). È lo stesso livello di chi ha l'host, che ha comunque la chiave in `/etc/fenvix/tls`. Un CAA con `accounturi` non aiuterebbe: l'account ACME sta sullo stesso host. Mitigazioni possibili, non fatte: un record CAA `0 issue "letsencrypt.org"` sulla zona (blocca le altre CA) e il monitoraggio Certificate Transparency (ad esempio crt.sh) per i nostri nomi.

### 7.4 Persistenza fuori dall'istanza

Scelta: **un parametro SSM SecureString, tier Advanced, `/fenvix-tls/<env>/acme-state`** per regione. Contiene `tar.gz` + base64 di account ACME (chiave e registrazione), certificato, chiave e un file `fenvix.meta` (endpoint ACME + nomi). Scritto dal server con `put-parameter --overwrite --value file://...`, così il valore non compare mai nella riga di comando. Il server ne ha `GetParameter`/`PutParameter` solo su quell'ARN; il servizio KMS si usa solo tramite SSM. È fuori da `/fenvix/<env>/`, che i servizi leggono a ogni avvio. Lo stack non lo crea (CloudFormation non crea SecureString), quindi `cdk destroy` non lo cancella (README, teardown).

Dimensione: 2,0 KB nei test (certificati finti, più corti di quelli veri); con una catena Let's Encrypt reale e chiavi EC P-256 la stimo a 3–4 KB (stima, non misurata), vicina al limite Standard di 4 KB, quindi tier Advanced (8 KB). Lo script rifiuta di salvare oltre 8 KB, con un avviso.

| Opzione | Costo | Perché no |
|---|---|---|
| **SSM Advanced SecureString** (scelta) | $0,05 al mese per parametro (≈ $0,60 all'anno per regione); chiamate API in throughput standard gratis | riusa SSM e la chiave `aws/ssm` come gli altri segreti, nessuna risorsa nuova |
| Secrets Manager | $0,40 al mese per segreto + $0,05 ogni 10.000 chiamate | 8 volte il costo; risorsa nello stack con un valore iniziale e soppressione nag (rotazione) |
| Oggetto S3 cifrato in un bucket separato | centesimi | un bucket in più, con policy, cifratura, blocco pubblico e log da giustificare; più permessi |

Logica all'avvio (`fenvix-tls`, testata): se sul disco non c'è niente di utilizzabile, legge lo stato da SSM. Se è valido, è per gli stessi nomi e lo stesso endpoint e mancano più di 30 giorni alla scadenza, lo installa **senza contattare Let's Encrypt**. Se mancano meno di 30 giorni, rinnova con lo stesso account. Se manca o è per altri nomi o un altro endpoint (staging/produzione), emette. Se SSM non è leggibile (errore diverso da `ParameterNotFound`) e sul disco non c'è un certificato valido, si ferma **senza** chiedere a Let's Encrypt. Se l'emissione fallisce e non c'è un certificato valido, esce 1 con `FATAL: no valid certificate. The engine and the TLS terminator do not start without a certificate (...)`: il motore e Caddy non partono. Se fallisce un rinnovo mentre il certificato installato è ancora valido, lo tiene e avvisa. Se fallisce il salvataggio, avvisa e riprova al giro dopo (il servizio parte).

Limite delle 5 validazioni fallite all'ora: systemd riavvia il motore ogni 5 s e ogni avvio esegue `fenvix-tls`. Senza freno, un DNS sbagliato farebbe decine di tentativi l'ora. Dopo un fallimento lo script non contatta Let's Encrypt per 20 minuti (al massimo 3 tentativi l'ora). Lo sblocco manuale è nel README. Limite dei 5 certificati identici a settimana: con lo stato salvato, un'istanza ricreata non emette.

Mai stampati chiave, token o segreti: l'output di lego e dell'AWS CLI passa da un filtro che toglie le righe con `-----`/`PRIVATE` e sostituisce ogni sequenza di 32+ caratteri base64/base64url con `[redacted]` (tiene le ultime 15 righe, 300 caratteri ciascuna). Il test fa stampare al lego finto un token e un'intestazione di chiave e controlla che non escano; un altro test confronta ogni riga di ogni chiave generata con tutto l'output di tutte le esecuzioni.

### 7.5 Limite di 16 KB dell'user data

Con lo script nuovo l'user data sarebbe arrivato a **17,0 KB**. Non ho tolto controlli. Ho spostato script e unità (fetch-config, fenvix-tls, create-engine-users, unità tls, control plane, Caddy, env statico) in un **bundle di avvio**: uno script bash con gli stessi heredoc, compresso gzip+base64 e diviso in **parametri SSM String Standard** (gratuiti, massimo 4 KB l'uno) creati dallo stack, `/fenvix-boot/<env>/scripts-0..N` (oggi 2: 4.096 + 2.648 caratteri). L'user data (ora **3,9 KB**) li scarica, ricompone il bundle, verifica lo **SHA-256 fissato nell'user data** e solo allora lo esegue. Il ruolo ha `ssm:GetParameter` solo su quei nomi. Il bundle non contiene valori di CloudFormation (un controllo lo impone): id della zona e nome del bucket restano nell'user data, e l'unità del motore resta lì perché contiene il bucket. Un cambio del bundle cambia l'hash nell'user data, quindi l'istanza viene sostituita come prima.

Perché non un asset CDK, come proposto nella richiesta: un asset richiede `cdk bootstrap`. Il bootstrap crea lo stack CDKToolkit con un bucket, un repository ECR e ruoli di deploy/esecuzione (quello di esecuzione di default con `AdministratorAccess`). Oggi lo stack usa `BootstraplessSynthesizer` e la policy di deploy è ristretta proprio per non averlo. Con i parametri String i requisiti restano: file fuori dall'user data, verifica SHA-256, lettura limitata a quegli oggetti. In più, niente bootstrap e niente costo. Documentato nel README (Step 7).

### 7.6 DNS (README, "The domain")

- **Opzione A** (`dnsZone=domain`): tutto il dominio su Route 53. Al registrar si mettono i 4 name server; prima vanno ricreati in Route 53 tutti i record esistenti (sito Vercel: i valori indicati da Vercel in Settings, Domains; `MX`, `TXT` SPF/DKIM/DMARC/verifiche, `CAA`). **Con Cloudflare Registrar non è possibile** (un dominio registrato lì deve usare il DNS di Cloudflare).
- **Opzione B (raccomandata, default `dnsZone=db`)**: Route 53 ha solo `db.<dominio>`. Dove sta il DNS principale si creano a mano: 4 record `NS` `db` → name server di Route 53; `A` `console` → Elastic IP; `CNAME` `_acme-challenge.console` → `_acme-challenge.console.db.<dominio>` (su Cloudflare "DNS only"). Il sito Vercel e la posta non si toccano, funziona con Cloudflare Registrar, e i permessi del server restano dentro `db.<dominio>`. Lo stack stampa i valori (`NameServers`, `ManualDnsRecords`).

### 7.7 `deploy-policy.json`

1. **Tolta** `CertificateRequest` (`acm:RequestCertificate`, `Resource "*"`).
2. **Tolta** `CertificateManage` (`acm:DescribeCertificate`, `acm:DeleteCertificate`, `acm:AddTagsToCertificate`, `acm:ListTagsForCertificate`).
3. **Aggiunta** `BootScriptParametersOnly`: `ssm:PutParameter`, `ssm:DeleteParameter`, `ssm:GetParameter`, `ssm:GetParameters`, `ssm:AddTagsToResource`, `ssm:RemoveTagsFromResource`, `ssm:ListTagsForResource` solo su `arn:aws:ssm:eu-central-1:865859654353:parameter/fenvix-boot/*`, per i parametri del bundle creati da CloudFormation (i tag `project`/`env` arrivano dallo stack). Un test controlla che il ruolo di deploy non possa scrivere `/fenvix/<env>/` né `/fenvix-tls/`.

Route 53 e IAM non richiedono altro: `DnsManageZones` copre già zona e record, e le policy nuove del ruolo dell'istanza sono `iam:PutRolePolicy` su `fenvix-*`, già presente. Il parametro di stato TLS lo crea il server, non il deploy. Nota: le due voci ACM tolte servirebbero solo per cancellare un certificato ACM di uno stack già deployato. Lo stack non è mai stato deployato, quindi non c'è niente da cancellare.

### 7.8 Test

- **Prima** (`d63ef74`): 8 suite, **101 test**, tutti passati.
- **Dopo**: 9 suite, **128 test**, tutti passati (`npx jest`, variabili AWS tolte). `npx tsc --noEmit`: nessun errore.
- Nuovo `test/tls.test.ts` (12 test): esegue **davvero** `fenvix-tls` con openssl vero, un `lego` finto (emette un certificato EC per i nomi ricevuti, valido N giorni, e registra argomenti e ambiente) e un `aws` finto (SSM su file; rifiuta un valore non passato come `file://`). Casi coperti:
  - primo avvio: una richiesta con i flag esatti e `AWS_HOSTED_ZONE_ID`; PEM = catena + chiave in **0600**; la chiave corrisponde al certificato; cartella dati 0700; salvato in SSM; nessun riavvio;
  - run del timer con certificato valido: nessuna richiesta, nessun salvataggio, nessun riavvio;
  - istanza nuova: ripristino da SSM, nessuna richiesta, stessa impronta, stesso account;
  - meno di 30 giorni: rinnovo, installazione, **un** riavvio di motore e Caddy; al run successivo niente;
  - stato ripristinato vicino alla scadenza: rinnovo con l'account ripristinato;
  - emissione fallita senza certificato: exit 1, messaggio chiaro, nessun PEM, token e chiave non stampati, nessun nuovo tentativo per 20 minuti;
  - rinnovo fallito con certificato valido: tenuto, exit 0, nessun riavvio;
  - SSM illeggibile: exit 1 senza contattare Let's Encrypt;
  - salvataggio fallito: avviso, poi salvato al giro dopo;
  - certificato staging salvato: ignorato da un server di produzione;
  - regione senza control plane: riavvia solo il motore;
  - nessuna riga di nessuna chiave in nessun output.
- `infra.test.ts`:
  - nessuna risorsa `CertificateManager`, nessun `acm:` nel template;
  - policy Route 53 con risorsa, condizioni e azioni esatte, anche con `dnsZone=db` e zona esistente; nessun `"*"`;
  - parametro di stato e KMS per contesto di cifratura;
  - bundle in SSM uguale all'hash dell'user data; parametri String Standard ≤ 4 KB e dipendenza dell'istanza;
  - **le righe di avvio eseguite davvero** contro i parametri del template: ricompongono il bundle e rifiutano un bundle modificato;
  - user data < 16 KB;
  - `acmeEmail` obbligatorio (anche: `cdk.json` non lo contiene);
  - `acmeStaging` cambia solo l'endpoint (diff riga per riga del bundle e dell'user data);
  - due regioni con nomi della challenge distinti.
- `deploy-policy.test.ts`: nessun permesso ACM; scritture SSM solo su `/fenvix-boot/*`.
- Il test sul download del bundle ha trovato un bug vero, corretto prima del commit: un `'\n'` diventato un a-capo letterale dentro `tr -d '...'` spezzava la riga e saltava la verifica SHA-256.

**Controlli di mutazione** (modifica voluta, `jest` completo, ripristino con `git checkout`; alla fine il working tree era pulito):

| Mutazione | Esito di `jest` (128 test) |
|---|---|
| `ChangeResourceRecordSets` su `Resource "*"` | 4 falliti (Resource "*", policy Route 53 esatta, azioni Route 53, caso `dnsZone=db`) |
| un nome in più nella condizione (l'apex del dominio) | 3 falliti (policy esatta, caso `dnsZone=db`, due regioni) |
| record `A` ammessi oltre a `TXT` | 1 fallito (policy esatta) |
| `engine.pem` installato 0644 | 1 fallito (primo avvio: modo 0600) |
| riavvio sempre, non solo a certificato cambiato | 3 falliti (run del timer senza cambi, rinnovo, ripetizione) |
| richiesta a Let's Encrypt a ogni run (niente controllo dei 30 giorni) | 4 falliti (riuso, ripristino, rinnovo, salvataggio) |
| output di lego/AWS stampato senza filtro | 1 fallito (token non stampato) |
| servizio avviato senza TLS se l'emissione fallisce (`exit 0`) | 1 fallito (exit 1 e messaggio) |
| certificato ACM esportabile + `acm:ExportCertificate` rimessi | 3 falliti (nessun ACM, record senza ACM, policy di deploy senza azione per il tipo) |
| verifica SHA-256 di lego tolta | 1 fallito |
| `acmeEmail` con un default | 2 falliti |

Una prima variante, "condizione sui nomi tolta", faceva fallire solo la compilazione (import non più usato) e quindi non provava nulla. L'ho sostituita con la mutazione "un nome in più", che compila. Il primo giro è stato interrotto dal limite di tempo durante la prova ACM; ho ripristinato il file con `git checkout` e rifatto le ultime quattro prove.

**`cdk synth`** con la CLI vera, variabili AWS tolte, `AWS_EC2_METADATA_DISABLED=true`, file di configurazione AWS vuoti, `HTTPS_PROXY`/`HTTP_PROXY` verso `127.0.0.1:9` (proxy morto): esito 0, template di 38,4 KB, solo l'avviso W3010 (AZ fissata, voluto). Nel template:
- ingressi solo `0.0.0.0/0` su 27018 e 443; nessuna regola copre 8443;
- nessuna risorsa ACM, nessun `acm:`;
- user data 3,9 KB senza segreti: nessun `-----BEGIN`, nessuna chiave AWS; l'unica corrispondenza di "password" è il nome del parametro SSM letto a runtime dallo script dello Step 10;
- IMDS `required`, hop 1;
- bundle (2 parametri) con hash uguale a quello nell'user data;
- ruolo dell'istanza = 5 azioni S3 sul bucket, lettura `/fenvix/prod/*`, `kms:Decrypt` via SSM, Session Manager, le 3 istruzioni Route 53 sopra, get/put di `/fenvix-tls/prod/acme-state`, `kms:Encrypt`/`GenerateDataKey` via SSM per quel parametro, lettura di `/fenvix-boot/prod/scripts-0` e `-1`.

**cdk-nag**: 10 risultati grezzi, 0 non giustificati. L'unico nuovo è `IAM5` su `route53:::change/*`, giustificato.

Verificato a parte con Go 1.24 (libreria standard): `tls.X509KeyPair` accetta lo stesso file catena + chiave sia come certificato sia come chiave. È la funzione che usa il caricatore di file di Caddy. Caddy in sé non l'ho eseguito.

### 7.9 Decisioni che servono a te

1. **Opzione DNS**: raccomando B (`dnsZone=db`, già il default). Se il dominio lo compri su Cloudflare Registrar, A non è possibile.
2. **`acmeEmail`**: un indirizzo che leggi (`FENVIX_ACME_EMAIL`). Non ne ho messo nessuno.
3. **Primo deploy con `acmeStaging=true`** (raccomandato), poi `false` e un secondo deploy. Costa una sostituzione dell'istanza; evita di consumare i limiti di produzione se il DNS non è ancora a posto.
4. **CAA** `0 issue "letsencrypt.org"` sul dominio: facoltativo, non l'ho aggiunto. Con l'opzione B va messo dove sta il DNS principale e vale anche per i certificati che Vercel ottiene (Vercel usa Let's Encrypt, quindi è compatibile; da verificare se Vercel usa anche altre CA).
5. Accettare il rischio residuo del 7.3 e `ListResourceRecordSets` sulla zona.

### 7.10 Cosa NON ho potuto verificare (serve AWS o un dominio vero)

- Emissione reale da Let's Encrypt (produzione e staging), con la propagazione DNS e la validazione DNS-01. lego non è mai stato eseguito contro un server ACME: i test usano un lego finto. Ho eseguito il binario vero solo per `--version` e `run --help`, per controllare i flag.
- Il provider Route 53 di lego sull'istanza con le credenziali IMDSv2, e che le chiamate passino le condizioni IAM (in particolare i nomi normalizzati e il wildcard: per `*.<regione>.db` il nome scritto è `_acme-challenge.<regione>.db.<dominio>`, ricavato dal codice, non provato).
- Il CNAME di `console` nell'opzione B seguito da lego e da Let's Encrypt.
- `put-parameter --tier Advanced` del server e i permessi KMS: per la chiave gestita `aws/ssm` basta di norma la key policy; la mia istruzione con contesto `PARAMETER_ARN` è in più ma non è provata su SSM Advanced. Se il salvataggio fallisse, il servizio parte comunque e il log lo dice (Step 9).
- Il rinnovo reale dopo 60 giorni e il timer systemd; il riavvio di motore e Caddy su Amazon Linux 2023; `flock` e `try-restart` lì.
- La lettura del bundle da SSM all'avvio sull'istanza e la creazione dei parametri da CloudFormation con la policy di deploy (permessi SSM nuovi).
- Caddy 2.8.4 con `tls /certs/engine.pem /certs/engine.pem` (verificato solo il comportamento di Go, 7.8).
- La procedura DNS sui pannelli reali di Cloudflare e GoDaddy (scritta, non eseguita).

### 7.11 Commit

Branch `infra-align`, sopra `d63ef74`: `a263f23` (codice e test), poi il commit di questo report, del README e di `results-infra.md` (hash in `git log`). Nessun merge, nessuna pull request.
