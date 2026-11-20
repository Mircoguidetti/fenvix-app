# Dashboard su Vercel (console.fenvix.dev)

**Perché:** AWS non ci lascia creare CloudFront finché non verifica l'account (richiesta di supporto aperta il
2026-11-19). Quindi il sito della dashboard (la parte che si vede nel browser) va su Vercel, gratis; l'API resta su AWS,
a `https://github.fenvix.dev`, e non cambia. È come spostare la vetrina in un altro negozio: il magazzino (l'API e il
database) resta dov'è.

**Cosa fai tu:** solo click nel browser, una volta. Non lanci niente sul tuo computer. Tempo stimato: 20-30 minuti
(**ESTIMATED**), più l'attesa del certificato HTTPS (di solito pochi minuti, **DECLARED** da Vercel).

**Cosa succede da solo dopo:** ogni merge su `main` → Vercel ricostruisce e pubblica la dashboard da solo; la pipeline
GitHub (Deploy) aggiorna solo l'API su AWS.

---

## Valori che ti servono

| Nome | Valore | Dove lo trovi |
|---|---|---|
| `VITE_API_URL` | `https://github.fenvix.dev/v1` | è questo, copialo così |
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` | Supabase → il progetto → **Project Settings** → **Data API** (o **API**) → **Project URL** |
| `VITE_SUPABASE_ANON_KEY` | la chiave `anon` `public` | Supabase → **Project Settings** → **API Keys** → scheda **Legacy API keys** → `anon` `public` → **Copy**. È la stessa che hai già messo in AWS (Parameter Store `/fenvix/prod/bootstrap/supabase-anon-key`). |
| `VITE_DATA_BACKEND` | `mock` | **solo** per le anteprime (Preview), mai per Production |

**Mai** mettere in Vercel la chiave `service_role`, la password del database o altri segreti. La chiave `anon` è
pubblica per costruzione (finisce comunque nel browser di chiunque apra il sito), quindi va bene.
**Non** creare `VITE_STYLEGUIDE`: accende una pagina interna di prova.

**Perché `https://github.fenvix.dev/v1`:** è l'unico indirizzo dell'API (l'indirizzo interno di AWS è spento,
`disableExecuteApiEndpoint` in `infra/github-app/lib/stack.ts`); lì `/v1/*` va alla funzione dell'API della dashboard;
è anche l'output `DashboardApiUrl` dello stack e lo stesso valore che usava la pipeline AWS.

---

## Passi

> **Il progetto Vercel esiste già** (`fenvix-app`, nel team Vercel `fenvix`: costruisce già le anteprime dei pull
> request). Allora **salta i passi 1-3**: apri <https://vercel.com/fenvix/fenvix-app> → **Settings** → **Environment
> Variables** e controlla che ci siano `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (tutti gli
> ambienti) con i valori della tabella sopra; aggiungi quelli che mancano, poi continua dal passo 4 usando il progetto
> `fenvix-app` dove sotto c'è scritto `fenvix-console`. Controlla anche **Settings** → **Build and Deployment**: i
> campi Build Command, Output Directory e Install Command devono essere vuoti o senza **Override** (decide `vercel.json`).

1. **Crea l'account Vercel.** Vai su <https://vercel.com/signup> → scegli **Hobby** → **Continue with GitHub** → accedi
   con il tuo account GitHub (Mircoguidetti) → **Authorize Vercel**. Se hai già un account Vercel, accedi e basta.

2. **Dai a Vercel l'accesso al solo repository `fenvix-app`.** Nel pannello Vercel → **Add New…** (in alto a destra) →
   **Project** → sotto **Import Git Repository**, se `fenvix-app` non compare: **Adjust GitHub App Permissions →** (o
   **Install**) → scegli l'account **Mircoguidetti** → **Only select repositories** → seleziona `fenvix-app` →
   **Save** (o **Install**). Torni su Vercel e `fenvix-app` compare nella lista.

3. **Importa il progetto.** Accanto a `fenvix-app` → **Import**. Nella schermata **Configure Project**:
   - **Project Name:** `fenvix-console`
   - **Framework Preset:** `Vite` (lo legge da `vercel.json`; se mostra altro, scegli `Vite`)
   - **Root Directory:** `./` (lascialo così)
   - **Build and Output Settings:** non toccare niente (comandi e cartella sono già in `vercel.json`:
     `npm ci`, `npm run build`, `dist`)
   - **Environment Variables:** aggiungi questi tre, uno per volta (**Key**, **Value**, poi **Add**):
     `VITE_API_URL` = `https://github.fenvix.dev/v1`;
     `VITE_SUPABASE_URL` = il Project URL (tabella sopra);
     `VITE_SUPABASE_ANON_KEY` = la chiave `anon` (tabella sopra).
   - Clicca **Deploy**. Dopo 1-3 minuti (**ESTIMATED**) vedi **Congratulations!** e un indirizzo
     `https://fenvix-console-….vercel.app`. Su quell'indirizzo l'accesso **non** funziona ancora (l'API accetta solo
     `console.fenvix.dev`): è normale, si sistema al passo 6.

4. **Anteprime con dati di esempio.** Progetto `fenvix-console` → **Settings** → **Environment Variables** → **Add
   New** (o il modulo in alto):
   - **Key:** `VITE_DATA_BACKEND`  **Value:** `mock`
   - **Environments:** togli la spunta a **Production** e a **Development**, lascia solo **Preview**
   - **Save**.

   Così le anteprime dei branch (gli indirizzi `….vercel.app` dei pull request) mostrano dati finti con un accesso
   finto, e non chiamano mai l'API vera. La produzione non cambia.

5. **Aggiungi il dominio.** Progetto `fenvix-console` → **Settings** → **Domains** → **Add Domain** → scrivi
   `console.fenvix.dev` → **Add** (se chiede l'ambiente: **Production**; se propone anche il redirect da
   `www`/apex: **no**, solo `console.fenvix.dev`). Vercel mostra **Invalid Configuration** e un record da creare:
   **Type** `CNAME`, **Name** `console`, **Value** un indirizzo che finisce in `vercel-dns.com` (per esempio
   `cname.vercel-dns.com`, oppure uno più lungo tipo `…vercel-dns-0xx.com`). **Copia esattamente il Value che
   mostra Vercel.**

6. **Record DNS in Cloudflare.** <https://dash.cloudflare.com> → il dominio **fenvix.dev** → **DNS** → **Records**.
   - Se esiste già un record con **Name** `console` (non quelli che iniziano con `_`, che servono ai certificati):
     **Edit** e cambia il contenuto come sotto. Altrimenti **Add record**.
   - **Type:** `CNAME`
   - **Name:** `console`
   - **Target:** il Value copiato da Vercel al passo 5
   - **Proxy status:** **DNS only** (nuvola **grigia**: clicca la nuvola arancione finché diventa grigia)
   - **TTL:** `Auto`
   - **Save**.

   Torna su Vercel → **Settings** → **Domains**: entro qualche minuto (**DECLARED** da Vercel; a volte fino a un'ora)
   `console.fenvix.dev` diventa **Valid Configuration** e il certificato HTTPS viene emesso da solo.
   La pipeline AWS non tocca più questo record (finché l'interruttore del passo 9 è spento).

7. **URL di accesso in Supabase.** <https://supabase.com/dashboard> → il progetto → **Authentication** → **URL
   Configuration**:
   - **Site URL:** `https://console.fenvix.dev` → **Save** (probabilmente c'è già: lo avevi messo per AWS)
   - **Redirect URLs** → **Add URL** → `https://console.fenvix.dev/**` → **Save URLs** (se c'è già, niente da fare).
     Basta questo: il sito chiede a Supabase di tornare a `https://console.fenvix.dev/`, che rientra in
     `https://console.fenvix.dev/**`.
   - **Non** aggiungere indirizzi `*.vercel.app`: le anteprime usano l'accesso finto (passo 4) e non passano da Supabase.

8. **Ricostruisci la produzione** (serve solo se hai cambiato variabili dopo il primo deploy). Progetto
   `fenvix-console` → **Deployments** → l'ultimo deploy di **Production** → **⋯** → **Redeploy** → **Redeploy**.

9. **Interruttore della dashboard su AWS: lascialo spento.** In GitHub, la variabile del repository
   `FENVIX_DASHBOARD_ON_AWS` (Settings → Secrets and variables → Actions → **Variables**) **non deve esistere**, oppure
   deve valere `false`. Spenta, la pipeline di Deploy aggiorna solo l'API su AWS e non tocca CloudFront né
   `console.fenvix.dev`. Quando AWS verificherà l'account, sarà il coordinatore a dirti se e quando riaccenderla
   (valore `true`); prima va tolto il dominio da Vercel, altrimenti i due servizi si contendono `console.fenvix.dev`.

10. **Controllo finale.** Apri <https://console.fenvix.dev> → deve comparire la pagina di accesso di FENVIX, senza
    messaggi tipo "This deployment is missing …". Accedi (GitHub, Google o email): devi arrivare alla dashboard,
    senza l'errore "could not reach the server". Poi apri <https://github.fenvix.dev/healthz>: deve rispondere
    `{"ok":true,…}`.

---

## Se qualcosa non va

| Cosa vedi | Cosa fare |
|---|---|
| Sulla pagina di accesso: "This deployment is missing VITE_…" | Passo 3: manca quella variabile (o ha uno spazio di troppo). Correggila in **Settings → Environment Variables**, poi passo 8. |
| Dopo l'accesso: "could not reach the server" | Stai usando un indirizzo `….vercel.app` invece di `https://console.fenvix.dev` (l'API accetta solo quello), oppure `VITE_API_URL` non è esattamente `https://github.fenvix.dev/v1`. |
| Supabase dopo l'accesso dice che l'indirizzo di ritorno non è permesso | Passo 7: controlla `https://console.fenvix.dev/**` in **Redirect URLs**. |
| Vercel resta su **Invalid Configuration** dopo un'ora | Passo 6: la nuvola deve essere **grigia** (DNS only) e il Target identico a quello di Vercel. Se Vercel parla di **CAA**: in Cloudflare → DNS, se esistono record di tipo `CAA` su `fenvix.dev`, aggiungine uno con **Tag** `Only allow specific hostnames` e **CA domain name** `letsencrypt.org`. |
| Il build su Vercel fallisce | Apri il deploy → **Building** e manda il log al coordinatore. Non modificare il codice. |

**Nota sul piano Hobby:** Vercel dichiara il piano Hobby per uso personale e non commerciale (**DECLARED**, termini
d'uso di Vercel). Per partire va bene; quando ci saranno clienti paganti il coordinatore ti dirà se passare a Pro o
tornare su AWS.
