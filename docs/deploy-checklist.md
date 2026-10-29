# Primo deploy: checklist esatta (eu-west-1, Irlanda)

Questa è la lista dei passi del primo deploy, nell'ordine in cui vanno fatti, con i parametri, il modo di verificare ogni passo e il modo di tornare indietro. I dettagli di ogni passo (cosa fa, messaggi di errore) sono in `infra/README.md`; qui c'è l'ordine.

Regole che valgono per tutta la lista:

- **Regione: `eu-west-1` (Irlanda)** per tutto: console AWS, CloudShell, stack, parametri SSM, bucket, progetto Supabase. Quota server verificata in Irlanda: 5 vCPU, il `t3.medium` ne usa 2.
- **Nessun segreto passa da una chat, da un file o da un commit.** I segreti si generano in CloudShell e finiscono direttamente in SSM Parameter Store (non compaiono a schermo), oppure si scrivono a mano solo dove servono (editor SQL di Supabase, gestore di password). Nessun passo chiede di incollarli a qualcuno.
- **Ordine:** (1) lo stack con il certificato di **prova** (staging) e senza artefatti; (2) gli artefatti (motore e immagine del control plane) pubblicati da GitHub Actions nel bucket creato al passo 1; (3) lo stack con gli artefatti fissati, ancora con il certificato di prova; (4) il certificato **vero**. Ogni deploy della fase 3 e 4 sostituisce il server (5-15 minuti); i dati sono in S3 e non si perdono.
- Gli esempi di valori qui sotto **non sono segreti** (dominio, email, id di zona inventati): sostituiscili con i tuoi.

---

## Fase 0. Fuori da AWS (a mano, tu)

### 0.1 Supabase (progetto in eu-west-1)
Segui `control-plane/README.md`, "Founder steps", passi 1-4 e 7:
1. Controlla che il progetto firmi i token con chiavi asimmetriche: `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json` deve elencare almeno una chiave.
2. Editor SQL: esegui in ordine `supabase/migrations/0001_init.sql` (se non è già applicata), `0002_control_plane.sql`, `0004_data_explorer.sql`, `0005_engine_users.sql`. **Non** `0003_close_dashboard_write_path.sql`: va eseguita solo quando il dashboard chiama l'API (control-plane/README.md, passo 9).
3. Password del ruolo `fenvix_control_plane`: generala sul tuo computer (`openssl rand -base64 36`), scrivila **solo** nell'editor SQL (`alter role fenvix_control_plane with password '...';`) e nel gestore di password.
4. Stringa di connessione: Project Settings → Database → Connection string, pooler in modalità *transaction* (host del pooler di eu-west-1, `aws-0-eu-west-1.pooler.supabase.com` o quello che mostra la console), utente `fenvix_control_plane.<project-ref>`. Tienila nel gestore di password: la inserirai al passo 1.2 senza mostrarla.
5. Authentication → URL configuration: gli indirizzi di callback su `https://api.<dominio>/v1/...` e il dashboard su `https://console.<dominio>/` (control-plane/README.md, passo 7, con il tuo dominio).

Verifica: il JWKS elenca una chiave; nell'editor SQL `select rolname from pg_roles where rolname = 'fenvix_control_plane';` restituisce una riga.

### 0.2 DNS di Cloudflare (opzione B, consigliata: solo `db.<dominio>` va in Route 53)
Prima del deploy (dopo il passo 1.3, che crea la zona e ti dà i 4 name server):

| Tipo | Nome | Valore | Proxy |
|---|---|---|---|
| NS (4 record) | `db` | i 4 name server della zona Route 53 `db.<dominio>` | (non applicabile) |
| CNAME | `_acme-challenge.api` | `_acme-challenge-api.db.<dominio>` | **DNS only** (nuvola grigia) |
| CAA (solo se ne hai già) | `@` | `0 issue "letsencrypt.org"` e `0 issuewild "letsencrypt.org"` | |

Dopo il deploy della fase 1 (output `ApiRecordToCreate`):

| Tipo | Nome | Valore | Proxy |
|---|---|---|---|
| A | `api` | l'output `PublicIp` | **DNS only** (nuvola grigia) |

L'IP è un Elastic IP: resta lo stesso anche quando le fasi 3 e 4 sostituiscono il server, quindi questo record si crea una volta sola.

Verifica (CloudShell o qualunque terminale): `dig +short NS db.<dominio>` mostra i 4 nomi AWS; `dig +short CNAME _acme-challenge.api.<dominio>` mostra il target; dopo la fase 1, `dig +short api.<dominio>` mostra il `PublicIp`.

### 0.3 Password di emergenza del motore
Genera sul tuo computer una password per l'utente `fenvix_root` del motore (`openssl rand -hex 24`) e mettila **solo** nel gestore di password. La scriverai una volta al passo 3.4.

### 0.4 GitHub (niente da fare ora)
I due workflow di pubblicazione servono alla fase 2. Decisione da prendere prima (vedi "Decisioni" in fondo): da quale ramo li lanci.

---

## Fase 1. Stack con certificato di prova, senza artefatti (CloudShell, eu-west-1)

### 1.1 Regione e login
Console AWS, in alto a destra **Europe (Ireland) eu-west-1**. Apri CloudShell (icona `>_`).

### 1.2 Segreti in SSM Parameter Store (con il tuo login, una volta)
Esattamente come `infra/README.md`, Step 2, con `R=eu-west-1; P=/fenvix/prod`. I valori casuali sono generati da `openssl` dentro CloudShell e scritti direttamente in SSM; i tre valori esterni (stringa di connessione Postgres, URL Supabase, chiave anon) si digitano con `read -s` e non compaiono.

Verifica (solo nomi):
```bash
aws ssm get-parameters-by-path --region eu-west-1 --path /fenvix/prod --recursive --query 'Parameters[].Name' --output text
```
Atteso: gli 8 nomi obbligatori della tabella "The secrets" del README.

### 1.3 Zona Route 53 `db.<dominio>`
Route 53 → Hosted zones → Create hosted zone, nome `db.<dominio>`, *Public*. Annota l'id (`Z...`) e i 4 name server; fai ora i record della tabella 0.2 (NS e CNAME).

### 1.4 Provider OIDC di GitHub: c'è già?
IAM → Identity providers. Se esiste già `token.actions.githubusercontent.com`, copia il suo ARN: lo userai come `FENVIX_GITHUB_OIDC_PROVIDER_ARN`. Se non esiste, non fare nulla: lo crea lo stack (un account ne può avere uno solo).

### 1.5 Ruolo di deploy
`infra/README.md`, Step 3: ruolo `fenvix-deployer` con la policy inline `infra/deploy-policy.json` **di questa versione** (aggiunge il provider OIDC e il controllo della proprietà del bucket; se avevi già il ruolo, sostituisci la policy). Poi "Switch role" su `fenvix-deployer`.

### 1.6 Codice
```bash
git clone https://github.com/Mircoguidetti/fenvix-app.git
```
```bash
cd olvix-app && git checkout infra-align && cd infra && npm ci
```

### 1.7 Parametri della fase 1
```bash
export BASE_DOMAIN="fenvix.dev"
export FENVIX_BUDGET_EMAIL="founder@example.com"
export FENVIX_ACME_EMAIL="ops@example.com"
export FENVIX_DASHBOARD_ORIGINS="https://console.fenvix.dev"
export FENVIX_HOSTED_ZONE_ID="Z0123456789EXAMPLE"
export FENVIX_ACME_STAGING="true"
```
Solo se al passo 1.4 il provider esisteva già:
```bash
export FENVIX_GITHUB_OIDC_PROVIDER_ARN="arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com"
```
I quattro parametri degli artefatti (`FENVIX_ENGINE_VERSION`, `FENVIX_ENGINE_SHA256`, `FENVIX_CONTROL_PLANE_VERSION`, `FENVIX_CONTROL_PLANE_SHA256`) restano **vuoti**: il bucket da cui verranno non esiste ancora. Restano ai valori di `cdk.json`: regione `eu-west-1`, `t3.medium`, disco 20 GB, budget 100 USD, repository che possono pubblicare `Mircoguidetti/fenvix-engine` (motore) e `Mircoguidetti/fenvix-app` (control plane), ramo `main` per entrambi.

### 1.8 Controllo senza toccare AWS
```bash
npm test
```
```bash
npx cdk synth --quiet
```
Atteso: `Tests: ... passed`; `synth` senza errori (l'avviso W3010 sulla zona di disponibilità fissata è voluto).

### 1.9 Deploy
```bash
npx cdk deploy --all --require-approval broadening
```
Leggi la tabella dei permessi (ruoli del server, dei due publisher GitHub, del budget; provider OIDC) e conferma con `y`.

Output da annotare: `ArtifactsBucketName`, `PublishEngineRoleArn`, `PublishControlPlaneRoleArn` (servono alla fase 2), `PublicIp`, `ApiRecordToCreate`. Crea ora il record `A api` (tabella 0.2).

### 1.10 Verifica della fase 1
EC2 → Instances → l'istanza `fenvix` → Connect → Session Manager:
```bash
sudo tail -5 /var/log/fenvix-bootstrap.log
```
```bash
sudo grep fenvix-tls /var/log/fenvix-bootstrap.log | tail -5
```
```bash
sudo openssl x509 -in /etc/fenvix/tls/fullchain.pem -noout -subject -issuer -enddate
```
Atteso: l'ultima riga del log è `fenvix: NO RELEASE PINNED ... no service started`; `fenvix-tls: certificate installed`; un emittente che inizia con `(STAGING)` e i nomi `*.eu-west-1.db.<dominio>` e `api.<dominio>`. Nessun servizio del motore o del control plane gira (è giusto).

Se il certificato non arriva: `infra/README.md`, Step 9 (DNS, CAA); il server riprova da solo ogni 20 minuti.

### 1.11 Tornare indietro dalla fase 1
```bash
npx cdk destroy --all
```
Toglie tutto tranne i due bucket (dati e artefatti), che restano per scelta (README, "Tear everything down").

---

## Fase 2. Artefatti (GitHub Actions, nessun accesso AWS da parte tua)

### 2.1 Secret dei repository
In **entrambi** i repository, Settings → Secrets and variables → Actions → New repository secret. I valori vengono dagli output del passo 1.9 e si incollano **solo** lì (GitHub li nasconde anche nei log pubblici di fenvix-engine):

| Repository | `AWS_PUBLISH_ROLE_ARN` | `ARTIFACTS_BUCKET` |
|---|---|---|
| `Mircoguidetti/fenvix-engine` | output `PublishEngineRoleArn` | output `ArtifactsBucketName` |
| `Mircoguidetti/fenvix-app` | output `PublishControlPlaneRoleArn` | output `ArtifactsBucketName` |

Non sono credenziali (un ARN non basta per entrare: serve un token OIDC di GitHub, valido solo per quel repository e quel ramo), ma contengono l'id dell'account, che non deve finire nei log pubblici.

### 2.2 I workflow devono essere sul ramo predefinito
GitHub mostra "Run workflow" solo per i workflow presenti sul ramo predefinito (`main`), e il ruolo di pubblicazione accetta solo i rami di `engineRepoBranches` / `controlPlaneRepoBranches` (default `main`). Quindi:
- fenvix-engine: porta `.github/workflows/release-engine.yml` (ramo `release-pipeline`) su `main`;
- olvix-app: porta `.github/workflows/release-control-plane.yml` (ramo `infra-align`) su `main`.

### 2.3 Motore
fenvix-engine → Actions → **release-engine** → Run workflow, ramo `main`:
- `ref`: il commit del motore da pubblicare (per esempio quello di `network-limits`, `628273b...`, o successivo; serve `network-limits` o più nuovo, README "Trusted networks");
- `arch`: `x86_64` (il `t3.medium`);
- `publish`: sì.

Dura circa 10 minuti (la compilazione in locale ha richiesto 6 min 40 s). Alla fine, nel riepilogo del job:
```
engineVersion=20261029-628273b0a1b2-r1.1
engineSha256=<64 caratteri>
```
Annota le due righe (non sono segreti).

### 2.4 Control plane
olvix-app → Actions → **release-control-plane** → Run workflow, ramo `main`: `ref` = il commit da pubblicare, `arch` = `x86_64`, `publish` = sì. Nel riepilogo: `controlPlaneVersion=...` e `controlPlaneSha256=...`.

### 2.5 Verifica della fase 2
- I due job sono verdi e il riepilogo riporta le due coppie di valori.
- Nei log pubblici di fenvix-engine non compaiono l'id dell'account, il nome del ruolo o del bucket (sono mascherati: `***`).
- Il controllo vero del file è del server alla fase 3 (SHA-256 confrontato con i parametri).

### 2.6 Tornare indietro dalla fase 2
Niente da annullare: un artefatto pubblicato non viene usato finché la sua versione non è nei parametri dello stack. Una versione non viene mai sovrascritta; se una build è sbagliata, se ne pubblica un'altra (nuovo numero di run).

---

## Fase 3. Stack con gli artefatti fissati (ancora certificato di prova)

### 3.1 Parametri
Nella stessa sessione di CloudShell (o ripeti le righe di 1.7), aggiungi:
```bash
export FENVIX_ENGINE_VERSION="20261029-628273b0a1b2-r1.1"
export FENVIX_ENGINE_SHA256="<engineSha256 della fase 2.3>"
export FENVIX_CONTROL_PLANE_VERSION="<controlPlaneVersion della fase 2.4>"
export FENVIX_CONTROL_PLANE_SHA256="<controlPlaneSha256 della fase 2.4>"
```
Tutti e quattro o nessuno: `cdk synth` si ferma se ne manca uno.

### 3.2 Deploy
```bash
npm test && npx cdk deploy --all --require-approval broadening
```
Il server viene sostituito (lo user data è cambiato).

### 3.3 Verifica
Session Manager sul nuovo server:
```bash
sudo grep -E "fenvix-artifact|bootstrap done" /var/log/fenvix-bootstrap.log
```
```bash
sudo fenvix-artifact current
```
```bash
systemctl status fenvix-engine fenvix-control-plane fenvix-proxy --no-pager
```
Atteso: `engine/<versione>/x86_64/engine: SHA-256 ... matches`, `control-plane/<versione>/x86_64/control-plane.tar.gz: SHA-256 ... matches`, `fenvix bootstrap done`; i tre servizi `active (running)`. Poi i controlli di `infra/README.md`, Step 9.

Se il log dice `SHA-256 MISMATCH`: nessun servizio è partito; il valore nei parametri non corrisponde al file pubblicato (copiato male o build diversa). Correggi il parametro e rifai 3.2.

### 3.4 Utenti del motore (una volta)
`infra/README.md`, Step 10: `sudo /usr/local/bin/fenvix-create-engine-users`, con la password di 0.3 digitata quando richiesta.

### 3.5 Tornare indietro dalla fase 3
Svuota i quattro parametri (`unset FENVIX_ENGINE_VERSION FENVIX_ENGINE_SHA256 FENVIX_CONTROL_PLANE_VERSION FENVIX_CONTROL_PLANE_SHA256`) e rifai il deploy: torni allo stato della fase 1. Oppure rimetti la versione precedente e il suo hash.

---

## Fase 4. Certificato vero

### 4.1 Deploy
```bash
export FENVIX_ACME_STAGING="false"
```
```bash
npx cdk deploy --all --require-approval broadening
```

### 4.2 Verifica
`infra/README.md`, Step 11, da CloudShell:
```bash
D=fenvix.dev
curl -s https://api.$D/healthz
openssl s_client -connect check.eu-west-1.db.$D:27018 -servername check.eu-west-1.db.$D </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -enddate
```
Atteso: `{"ok":true}`; soggetto `*.eu-west-1.db.<dominio>`, emittente Let's Encrypt (non `(STAGING)`). Poi, su Vercel, `VITE_API_URL=https://api.<dominio>/v1` nel progetto del dashboard e nuovo deploy del dashboard (README, "Addresses").

### 4.3 Tornare indietro dalla fase 4
Se il certificato vero non arriva (per esempio CAA o DNS), il motore e il control plane non partono senza TLS. Rimetti `FENVIX_ACME_STAGING="true"` e rifai il deploy, poi correggi il DNS. Ricorda i limiti di Let's Encrypt (5 certificati uguali a settimana): non rifare la fase 4 in ciclo.

---

## Aggiornare il motore o il control plane (dopo il primo deploy)

1. Pubblica la nuova versione (fase 2.3 o 2.4) e annota versione e SHA-256.
2. Session Manager sul server:
   ```bash
   sudo fenvix-artifact update engine <versione> <sha256>
   ```
   (oppure `control-plane`). Scarica, controlla lo SHA-256 (se non coincide si ferma e non tocca la versione in uso), rende la nuova versione quella corrente, riavvia il servizio in modo ordinato (il motore, a SIGTERM, chiude i database in modo pulito; dati, WAL e lease sono in S3) e aspetta fino a 3 minuti che sia sano (servizio attivo, porta che risponde, nessun riavvio per 20 s; per il control plane il suo health check Docker). **Se non diventa sano, torna da solo alla versione precedente** e la riavvia. Per tornare indietro a mano: `sudo fenvix-artifact rollback engine`.
3. Metti la stessa versione e lo stesso SHA-256 nei parametri dello stack (3.1) e, quando vuoi, fai il deploy: così un server sostituito (ripristino, cambio di user data) installa la versione giusta. Il deploy sostituisce il server (qualche minuto di interruzione); l'aggiornamento del punto 2 no (pochi secondi).

Nessun dato si perde in nessuno dei due casi: il server non tiene dati propri.

### Regola: prima il motore, poi il control plane
Quando una release cambia sia il motore sia il control plane, l'ordine è sempre:

1. **Motore**: `sudo fenvix-artifact update engine <versione> <sha256>`, poi controlla che sia sano (`sudo fenvix-artifact current`, `systemctl status fenvix-engine --no-pager`: `active (running)`).
2. **Solo dopo, il control plane**: `sudo fenvix-artifact update control-plane <versione> <sha256>`.
3. Per tornare indietro, l'ordine inverso: prima `sudo fenvix-artifact rollback control-plane`, poi, se serve, `sudo fenvix-artifact rollback engine`.

Perché: il control plane nuovo può usare funzioni che solo il motore nuovo ha. Esempio concreto (motore `engine-round2`, control plane del branch `cp-engine-round2`): lo sblocco di un indirizzo vale per un solo database (`?database=`); un motore più vecchio ignora il parametro e **sblocca l'indirizzo su tutti i database**, anche quelli di altri clienti, prima che il control plane possa accorgersene (il control plane risponde 503, ma l'indirizzo è già sbloccato). Un motore nuovo con il control plane vecchio invece funziona (provato con la suite engine-real del control plane `3281c90` contro `engine-round2`: i flussi passano; gli unici 2 test falliti fissavano il vecchio comportamento del motore). Il motore minimo per l'infrastruttura attuale è `engine-round2` (`3bcd7e5`): un motore più vecchio non conosce `--grantable-roles` e non parte.

Con un deploy dello stack (punto 3 sopra) le due versioni arrivano insieme su un server nuovo: metti nei parametri le versioni nuove solo dopo aver fatto i punti 1 e 2 di questa regola sul server in uso.

### Procedura di supporto: togliere un blocco su tutti i database
Il motore blocca un indirizzo **su tutti i database** dopo 100 autenticazioni fallite in 60 secondi da quell'indirizzo (su database diversi). Questo blocco il cliente non lo vede nella dashboard e non può toglierlo: riguarda anche altri clienti, e il control plane non manda mai lo sblocco globale (la rotta senza `?database=` è rifiutata dal control plane stesso). Si toglie **solo a mano**, dal server, con il token della porta admin. Il blocco scade comunque da solo (5 minuti, poi il doppio a ogni nuovo blocco, fino a un'ora).

Prima di toglierlo: capisci da dove vengono gli errori (un'applicazione del cliente con una password vecchia ricomincia subito e l'indirizzo si riblocca) e annota nel ticket chi, quando e perché: questa operazione **non** finisce nell'audit del control plane.

1. Session Manager sul server della regione (console EC2, istanza `fenvix-...`, Connect, Session Manager).
2. Guarda i blocchi. Il token si legge dal file e passa a `curl` dallo standard input, così non compare nella riga di comando né nella cronologia; nessuna password viene digitata:
   ```bash
   sudo bash -c 'printf "header = \"Authorization: Bearer %s\"\n" "$(cat /run/fenvix/admin-token)" | curl -sS -K - http://172.17.0.1:8443/v1/network' | python3 -m json.tool
   ```
   Nella lista `blocked`, il blocco globale è quello con `"database": null`; `until` e `remaining_secs` dicono quando scade. Un indirizzo IPv6 compare come rete `/64`. (Se hai cambiato `adminPort`, usa quel numero al posto di `8443`.)
3. Togli il blocco dell'indirizzo (esempio `203.0.113.9`; per un IPv6 `/64` scrivi l'indirizzo senza `/64`, per esempio `2001:db8:1:2::`):
   ```bash
   IP=203.0.113.9
   ```
   ```bash
   sudo bash -c 'printf "header = \"Authorization: Bearer %s\"\n" "$(cat /run/fenvix/admin-token)" | curl -sS -K - -X DELETE "http://172.17.0.1:8443/v1/network/blocks/$1"' _ "$IP"
   ```
   Risposta attesa: `{"ip":"203.0.113.9","unblocked":true}` (`false`: l'indirizzo non aveva nulla). Attenzione: senza `?database=` il motore toglie **tutto** di quell'indirizzo, cioè il blocco globale, i blocchi sui singoli database e i contatori. Per togliere solo il blocco di un database c'è il pulsante **Unblock** della dashboard (owner o admin del cliente).
4. Ricontrolla con il comando del punto 2: l'indirizzo non è più in `blocked`.

Non copiare il token altrove, non metterlo in variabili d'ambiente esportate, non incollarlo in un ticket.

---

## Cosa costa (eu-west-1, prezzi del listino ufficiale AWS)

Prezzi letti dall'AWS Price List API pubblica (`pricing.us-east-1.amazonaws.com`, offerte per `eu-west-1`), date di pubblicazione indicate. In dollari USA, IVA esclusa.

**Artefatti** (S3 Standard, listino del 15/10/2026: 0,023 $/GB-mese per i primi 50 TB; PUT 0,005 $ ogni 1.000; GET 0,0004 $ ogni 1.000 (0,004 $ ogni 10.000); traffico in ingresso gratuito; dal bucket al server nella stessa regione attraverso il gateway endpoint: nessun costo di trasferimento):

| Voce | Ipotesi | Al mese |
|---|---|---|
| Spazio | motore 48,7 MB (misurato) + archivio del control plane ~83 MB (stima) = ~0,13 GB a release; 10 release al mese, tutte tenute | 1° mese ~1,3 GB → ~0,03 $; dopo 12 mesi ~16 GB → ~0,37 $ |
| Scritture | 2 PUT a release, 10 release | < 0,001 $ |
| Letture | 2 GET a ogni avvio o aggiornamento del server | < 0,001 $ |
| Cifratura | SSE-S3 (nessuna chiave KMS) | 0 $ |
| OIDC, STS, ruoli IAM | | 0 $ |
| **Totale artefatti** | | **~0,03 $ il primo mese, < 0,50 $ dopo un anno** |

Le copie sostituite scadono dopo 30 giorni; le versioni pubblicate restano finché non le cancelli (servono per tornare indietro).

**Il resto dello stack** (stessa fonte, per confronto): EC2 `t3.medium` 0,0456 $/h ≈ 33,29 $ (listino del 28/10/2026); disco gp3 20 GB ≈ 1,76 $; IPv4 pubblico 0,005 $/h ≈ 3,65 $; zona Route 53 0,50 $; un segreto in Secrets Manager 0,40 $; un allarme CloudWatch 0,10 $; monitoraggio dettagliato EC2 qualche dollaro. Circa **42-45 $/mese** fissi, più spazio e richieste del bucket dei dati e traffico verso internet (secondo l'uso). Dettagli: `infra/report-infra-align.md`, sezione 11.4.
