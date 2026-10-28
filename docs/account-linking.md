# Un account per email verificata: indagine, regola, unione dei doppioni

Branch `account-linking`, partito da `origin/main`. Niente è stato eseguito su Supabase reale, niente
AWS, nessun segreto: tutto è stato provato su un Postgres 16 locale e sul **server di autenticazione vero
di Supabase** (GoTrue `v2.180.0`, immagine Docker `supabase/gotrue`) con identità GitHub/Google finte.
La migrazione 0003 non è stata eseguita da nessuna parte.

## In breve

- **Causa del doppio account (riprodotta):** al primo accesso con GitHub l'indirizzo risultava **non
  verificato** su GitHub. Supabase Auth in quel caso non collega, e siccome l'indirizzo era già di un
  altro account crea un utente "ombra" **senza email**; il nostro trigger gli dà subito un workspace.
  Quando poi l'indirizzo viene verificato su GitHub, Supabase ritrova l'identità GitHub (per id GitHub,
  non per email), entra nell'ombra e la conferma: secondo utente, secondo workspace. Ipotesi (a), con il
  trigger (c) che peggiora le cose dando un workspace a chiunque, anche non confermato.
- **(b) non è la causa:** il collegamento automatico con email verificata in Supabase Auth è sempre
  attivo, non ha un interruttore, e nel laboratorio funziona (Google poi GitHub con la stessa email
  verificata → un solo account).
- **Trovati altri due problemi**, sistemati: (1) con il collegamento manuale attivo, un utente poteva
  collegare al proprio account un GitHub che dichiara l'email **non verificata** di un'altra persona;
  quando quella persona entrava con Google finiva **nell'account dell'attaccante**. (2) La dashboard
  mostrava il testo d'errore di Supabase così com'è, e quel testo è diverso a seconda che l'email abbia
  già un account.
- **Correzione:** `supabase/migrations/0006_account_linking.sql` (regole applicate dal database dentro
  la transazione di Supabase Auth), messaggi fissi nella dashboard e nel control plane, sezione
  "Sign-in methods" nelle Impostazioni (collega GitHub/Google, rimuovi se ne resta un altro).
- **Doppioni esistenti:** `supabase/account-merge/` — query di sola lettura per trovarli, script di
  unione con dry-run e transazione, script di annullamento. Testati su Postgres locale e, end-to-end, con
  GoTrue vero.
- **Da fare tu:** la lista di controlli nel pannello è in [§4](#4-cosa-devi-controllare-tu-nel-pannello-supabase).

## 1. Il percorso di accesso oggi

| Pezzo | Cosa fa |
| --- | --- |
| `src/pages/SignIn.tsx` | Bottoni "Continue with GitHub/Google" → `session.signInWithProvider`; modulo email → `session.requestEmailLink`. |
| `src/session/supabase.ts` | `signInWithOAuth` (PKCE, `skipBrowserRedirect`, ritorno alla radice del sito); `signInWithOtp` con `shouldCreateUser: true` (chi chiede il link per un'email nuova crea subito un utente non confermato). |
| `src/session/redirect.ts` | Prima che React parta: legge `?code=` e lo scambia (`exchangeCodeForSession`), oppure legge `?error=…` e **mostrava `error_description` di Supabase così com'era**. |
| `control-plane/src/routes/session.ts` + `auth/gateway.ts` | Stesso giro lato server: PKCE con verifier in un cookie `HttpOnly` di 10 minuti, callback `/session/providers/{p}/callback` che scambia il codice e imposta `fnx_session`/`fnx_refresh`; ogni errore diventa `?error=sign_in_failed` (già senza fughe). Email link sempre `202`. |
| `control-plane/src/auth/jwt.ts` | Verifica il JWT di Supabase (JWKS, solo algoritmi asimmetrici), prende `sub`, `email`, nome, avatar. |
| `0001_init.sql` | Trigger `on_auth_user_created` (`after insert on auth.users`) → `handle_new_user()` → `ensure_workspace(user)`: se l'utente non ha membership crea workspace + `workspace_members (owner)` + `workspace_settings`. Un workspace **per riga di `auth.users`**, non per identità. `current_workspace()` / `fenvix_cp_workspace_for_user()` aprono la membership più vecchia. |

Le identità (GitHub, Google, email) stanno in `auth.identities`, legate a `auth.users.id`. Più identità
dello stesso utente = un solo `auth.users` = un solo workspace. Il doppio workspace quindi nasce solo se
nascono due righe in `auth.users`.

## 2. Da dove arriva il secondo account (verificato)

Ho letto il codice di Supabase Auth `v2.180.0` (`internal/models/linking.go`, `internal/api/external.go`,
`internal/api/identity.go`) e l'ho eseguito davvero: `supabase/tests/account-linking/baseline.mjs`
stampa cosa fa **senza** la 0006. Risultati (stessi nomi dello script):

| Caso | Cosa succede senza 0006 |
| --- | --- |
| A. Google, poi GitHub con la stessa email **verificata e primaria** | un account (collegamento automatico) ✔ |
| E. GitHub con primaria noreply e la stessa email verificata come secondaria | un account (Supabase guarda tutte le email verificate) ✔ |
| F. Link email, poi Google | un account ✔ |
| B/J. Google, poi GitHub con la stessa email **non verificata** su GitHub | accesso rifiutato, ma resta un utente **ombra senza email con il suo workspace**; quando l'email viene verificata su GitHub, GitHub entra nell'ombra → **due account, due workspace** ✘ (il caso segnalato) |
| C. GitHub con un'altra email verificata (es. lavoro/personale) | due account: è un altro indirizzo, per la regola è giusto; si risolve collegando da Impostazioni |
| D. GitHub con solo l'indirizzo noreply | due account (account con `…@users.noreply.github.com`) ✘ |
| G. Qualcuno chiede un link per la tua email e non lo apre | utente non confermato **con workspace**; poi Google lo prende e lo conferma: un account, ma il workspace era nato prima della verifica |
| H/K. Identità con email non verificata di un altro | rifiutata, ma lascia un'ombra con workspace |
| L. Collegamento manuale di un GitHub con l'email **non verificata** di un'altra persona | collegato; quando la vittima entra con Google per la prima volta **finisce nell'account dell'attaccante** ✘✘ |

Perché B/J: in `DetermineAccountLinking`, se il provider non dà nessuna email verificata la decisione è
sempre "crea account"; se l'email è già presa, l'utente nuovo viene creato **con email vuota**. Al giro
dopo l'identità GitHub viene ritrovata per `(provider, id GitHub)` → "account esiste" → l'ombra viene
confermata perché ora il provider dice "verificata". Il nostro trigger aveva già dato il workspace
all'ombra al momento dell'`insert`.

Una volta che esistono due utenti con identità sulla stessa email, Supabase non sa più a chi collegare
le identità nuove con quella email (decisione `MultipleAccounts` → errore 500): il doppione blocca anche
gli accessi futuri con altri provider.

**Come confermarlo sul caso reale:** esegui `supabase/account-merge/find_duplicates.sql` (sola lettura,
va bene nel SQL editor). Se la riga è `duplicate` e uno dei due utenti ha `email` vuota con identità
`github` sulla stessa email, è esattamente questo meccanismo. Se il secondo account ha un'email diversa
(C) o noreply (D), la causa è quella. Nei log (vedi §4) cerca `provider_email_needs_verification` vicino
alla data del primo accesso con GitHub.

## 3. La regola, e dove è applicata

| Regola | Dove |
| --- | --- |
| Stessa email verificata da **entrambe** le parti → stesso utente, stesso workspace. | Supabase Auth (collegamento automatico); la 0006 garantisce che "l'identità esistente" sia davvero verificata (regola 2 sotto). |
| Email nuova **non verificata** dal provider → mai collegata, mai accesso a un account esistente. Se l'email non ha account: serve la verifica via email (Supabase manda il link di conferma all'indirizzo); se ce l'ha: accesso rifiutato. | 0006, regola 1: un'identità con un'email che è già di un altro account non può creare un account. Supabase Auth: le identità non verificate di un utente non confermato vengono rimosse quando qualcuno verifica l'email (caso K). |
| Un account in cui si può entrare porta solo identità con email verificata dal provider, o con la sua stessa email. | 0006, regola 2 (chiude il caso L, anche per il collegamento manuale e per i cambi di email lato provider). |
| Le ombre create prima della 0006 non diventano mai un secondo account. | 0006, regola 3 (rifiuta la conferma). Vanno poi rimosse con lo script (§6). |
| GitHub noreply: nessun account nuovo con un indirizzo noreply. Se c'è un'altra email verificata su GitHub, Supabase collega con quella (caso E); se no, l'accesso è rifiutato e si chiede di verificare un'email o di entrare col link e collegare GitHub dalle Impostazioni. | 0006, regola 4; messaggio fisso nella dashboard. |
| Workspace solo a email confermata. | 0006, regola 5: il trigger crea il workspace alla conferma (insert già confermato o update di `email_confirmed_at`). `ensure_workspace` resta idempotente. |
| Collegamento esplicito da Impostazioni ("Link GitHub", "Link Google"); rimozione solo se ne resta un altro. | Dashboard (`Settings.tsx`, `session.linkProvider/unlinkIdentity`, via `linkIdentity`/`unlinkIdentity` di Supabase). Supabase Auth rifiuta comunque di togliere l'ultima (`single_identity_not_deletable`). Control plane: `GET/POST/DELETE /v1/session/identities…` (documentati in `docs/control-plane-api.md`). |
| Nessuna fuga d'informazioni. | Dashboard: un solo messaggio per ogni accesso rifiutato e uno per ogni collegamento rifiutato, qualunque sia il motivo; il testo di Supabase non viene mai mostrato; la richiesta di link email mostra sempre "Check your inbox" (salvo errore di rete). Control plane: solo `?error=sign_in_failed` / `?error=link_failed`. Le funzioni SQL di supporto non sono eseguibili da `anon`/`authenticated`. |

Tutto il collegamento passa dalle funzioni di Supabase (automatico e `linkIdentity`/`unlinkIdentity`);
la 0006 aggiunge solo vincoli, non collega nulla da sola. Le regole sono trigger `security definer` su
`auth.users` e `auth.identities`: un rifiuto fa fallire la transazione di Supabase Auth, quindi niente
resta a metà (nessuna ombra, nessun workspace). Il messaggio d'errore SQL non contiene l'email.

### Numero della migrazione

`main` ha 0001 e 0002. Sugli altri branch: `engine-adapter` ha `0003_close_dashboard_write_path.sql`;
`data-browser` anche `0004_data_explorer.sql`; `e2e-engine` anche `0005_engine_users.sql`. Ho usato
**0006**, il primo numero che nessun branch usa. La 0006 non dipende da 0003–0005 (tocca solo
`handle_new_user` e aggiunge trigger su `auth.*`), quindi l'ordine con quelle è indifferente; si può
rieseguire. Non l'ho applicata a nessun Supabase reale.

### Fughe d'informazioni: cosa resta

- La dashboard e il control plane rispondono in modo identico (verificato nel browser: stesso testo con e
  senza account esistente).
- **Residuo a monte, già presente prima:** la risposta grezza di Supabase Auth nella barra degli indirizzi
  (prima che la dashboard la ripulisca) differisce: senza account `provider_email_needs_verification`
  ("A confirmation email has been sent"), con account il testo era diverso già prima e con la 0006 il
  codice è `unexpected_failure`. Lo vede solo chi controlla un account GitHub/Google che dichiara
  quell'email **non verificata**. Non si può uniformare da qui senza cambiare Supabase Auth.
- Supabase manda l'email di conferma solo nel caso "nessun account": arriva alla casella del titolare,
  non a chi prova.
- `/otp` risponde `200` in tutti i casi (verificato), anche quando la 0006 rifiuta.

## 4. Cosa devi controllare tu nel pannello Supabase

Non vedo il progetto reale: questi sono i punti da guardare, con il nome della pagina. Dove non sono
certo dell'etichetta esatta lo dico, e indico la chiave equivalente nella configurazione.

1. **Authentication → Sign In / Providers → "Confirm email": deve essere ATTIVO.** Se è spento, Supabase
   Auth tratta **ogni** email dei provider come verificata (`mailer_autoconfirm`): il collegamento
   automatico diventa una presa di controllo e la 0006 non può distinguerlo. È il controllo più importante.
2. **Authentication → Sign In / Providers → "Allow manual linking": ATTIVO** se vuoi i bottoni "Link
   GitHub/Google" nelle Impostazioni (`security_manual_linking_enabled`). Se è spento i bottoni mostrano
   "Linking another way to sign in is not turned on for this service." Con la 0006 attivarlo è sicuro
   (caso L chiuso); **non attivarlo prima di aver applicato la 0006**.
3. **Accesso con email non verificate.** Supabase Auth ha un'opzione (`GOTRUE_MAILER_ALLOW_UNVERIFIED_EMAIL_SIGN_INS`
   nel codice) che dà la sessione anche con email non verificata. Non so se il pannello la mostra e con
   che nome: controlla con la Management API `GET https://api.supabase.com/v1/projects/<ref>/config/auth`
   (token personale) che `mailer_autoconfirm` sia `false`, `security_manual_linking_enabled` sia come al
   punto 2, e che qualunque chiave contenente `allow_unverified_email_sign_ins` sia `false` o assente.
4. **Versione di Supabase Auth.** Il comportamento è verificato su `v2.180.0`. La versione del tuo progetto
   si legge con `GET https://<ref>.supabase.co/auth/v1/health` (campo `version`). Se è molto diversa,
   rieseguire il laboratorio con `GOTRUE_IMAGE=supabase/gotrue:<versione>`.
5. **GitHub.** Se il provider è una *OAuth App*: niente da fare (Supabase chiede `user:email`). Se è una
   *GitHub App*: su GitHub → Settings → Developer settings → GitHub Apps → la tua app → Permissions &
   events → Account permissions → **Email addresses: Read-only**, altrimenti Supabase non riceve le email
   (verificate o no) e l'accesso GitHub fallisce.
6. **Log.** Nella sezione Logs del pannello, i log di Auth: cerca `provider_email_needs_verification` e
   l'email della persona attorno al suo primo accesso GitHub per confermare la causa. Dopo la 0006 i
   rifiuti delle regole compaiono come `Error creating identity` / errori database.
7. **Redirect URLs** (Authentication → URL Configuration): niente di nuovo, il collegamento torna alla
   radice del sito come l'accesso.
8. **Prima di applicare la 0006 in produzione** provala su un database di prova del progetto (branch di
   Supabase o `supabase start` in locale): crea trigger su `auth.identities`. Su `auth.users` 0001 lo fa
   già, quindi i permessi dovrebbero esserci; se però ricevi `must be owner of table identities`,
   fermati e scrivimi: non provare workaround.

## 5. Dashboard e control plane

- **Impostazioni → "Sign-in methods"**: elenco dei modi di entrare (GitHub, Google, Email link) con
  l'email del provider; "Link GitHub"/"Link Google" per quelli mancanti; "Remove" con conferma, disattivato
  se è l'unico ("This is your only way to sign in, so it cannot be removed."). Dopo il ritorno dal
  provider si torna su `/settings` con conferma o con il messaggio fisso di rifiuto.
- **Messaggi fissi** (`src/session/redirect.ts`): accesso rifiutato → "That sign-in did not work. If the
  email address of your GitHub or Google account is not verified there, verify it and try again, or sign
  in with an email link. Already use FENVIX another way? Sign in that way, then link this account in
  Settings."; collegamento rifiutato → "That account was not linked. An account can be linked when its
  email address is verified with the provider (or is this account's address) and it does not already sign
  in to another FENVIX account."
- **Control plane**: `GET /v1/session/identities`, `POST /v1/session/identities/{provider}` (stesso giro
  PKCE dell'accesso, ritorno con `?linked=` o `?error=link_failed`), `DELETE /v1/session/identities/{id}`
  (`409` se è l'ultimo). Aggiunti al contratto (`docs/control-plane-api.md`, ora 40 endpoint).

Limiti noti: chi chiede un link email per un indirizzo che un altro account ha solo su un'identità (es.
l'email di lavoro del suo GitHub) non riceve nulla (vede comunque "Check your inbox"): deve entrare con
l'email dell'account. Se l'email di un'identità già collegata cambia lato provider in un'email non
verificata e diversa da quella dell'account, quell'accesso viene rifiutato finché non la verifica.

## 6. Account doppi già esistenti

File in `supabase/account-merge/` (non sono migrazioni, nessuno li esegue in automatico; vanno eseguiti
con `psql`, non nel SQL editor, perché usano `\if`/`-v`):

1. `find_duplicates.sql` — sola lettura. Elenca coppie `duplicate` (due utenti che hanno entrambi provato
   la stessa email) e `shadow` (utenti mai confermati che portano su un'identità non verificata l'email di
   un altro), con utenti, provider, workspace, numero di database e `suggested_keep_user`.
2. `merge_accounts.sql` — `psql "$URL" -v keep_user=<uuid> -v drop_user=<uuid> -f …` fa un **dry-run**:
   esegue tutta l'unione in una transazione, stampa ogni passo (database spostati e rinominati, chiavi,
   fatture, membri, impostazioni dei due workspace a confronto) e fa **ROLLBACK**. Con `-v execute=1`
   la stessa cosa con COMMIT, in una sola transazione: se un passo fallisce non cambia niente.
3. `undo_merge.sql` — `-v merge_id=<n>` (dry-run) e poi `-v execute=1`: rimette tutto com'era usando le
   copie salvate in `fenvix_account_merge` (schema creato dallo script, non accessibile ai ruoli del browser).

Cosa fa l'unione: verifica che i due utenti abbiano in comune un'email verificata (altrimenti si ferma:
"may be two people"), che il workspace uscente non abbia operazioni in corso, che non ci siano fatture con
lo stesso numero né la stessa chiave API nei due workspace, che non esistano tabelle sconosciute che
puntano a workspace/utenti (in quel caso si ferma e le elenca); poi sposta database, tag, uso giornaliero
e orario, risvegli, chiavi API, fatture, operazioni, audit log (e `data_audit_log` del branch
`data-browser` se c'è), chiavi di idempotenza (quelle presenti in entrambi vengono tolte dal workspace
uscente: sono cache di 24 ore); porta i membri del workspace uscente nel workspace tenuto col loro ruolo;
rende `keep_user` owner del workspace tenuto e gli dà le membership di `drop_user` in altri workspace;
sposta su `keep_user` **solo le identità con email verificata** (così GitHub/Google entrano nell'account
tenuto; quelle non verificate vengono cancellate, mai spostate); elimina il workspace uscente (le sue
impostazioni restano nelle copie) e l'utente doppione (le sue sessioni finiscono); scrive
`account.merged` nell'audit log. Un'ombra mai confermata con workspace non vuoto fa fermare lo script.

**Database con lo stesso nome nei due workspace — regola:**
- il database del workspace **tenuto** conserva il nome; quello in arrivo diventa `<nome>-2` (poi `-3`, …),
  accorciando il nome se serve perché resti nel formato (`^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$`, max 48) e
  saltando i nomi già usati (anche, se esiste l'indice `databases_host_unique` del branch engine-adapter,
  da workspace con lo stesso codice di 8 caratteri);
- per default lo script **si ferma** ed elenca i nomi in conflitto; la rinomina avviene solo con
  `-v on_name_conflict=rename`, e il dry-run mostra ogni rinomina prima;
- quale workspace tenere si sceglie con `-v keep_workspace=<uuid>` (default: quello di `keep_user`).
  Conviene tenere quello i cui database sono usati dai client: **sul branch engine-adapter l'hostname di un
  database contiene il codice del workspace** (`<nome>-<codice>.<regione>.db.…`), quindi ogni database
  spostato cambia hostname, rinominato o no. Lo script lo segnala ma **non aggiorna l'engine** (che riceve
  il workspace alla creazione): con l'engine reale va coordinato prima.

Test (`node supabase/account-merge/test-merge.mjs`, Postgres locale, 38 controlli): dry-run che non
cambia niente (impronta md5 di ogni tabella identica, nemmeno lo schema di backup resta); conflitto di
nomi che ferma; unione reale con verifica di ogni tabella; annullamento che riporta **ogni tabella
identica** a prima; unione tenendo l'altro workspace e suo annullamento; ombra rimossa senza spostarne
l'identità; rifiuti (nessuna email in comune, tabella sconosciuta, operazione in corso) che non cambiano
nulla; tabella `data_audit_log` spostata. Con GoTrue vero (scenario 17): duplicato creato col
comportamento vecchio → dry-run → unione → **GitHub entra nell'account tenuto** → annullamento → GitHub
torna al doppione.

## 7. Test eseguiti (tutti verdi)

| Comando | Risultato |
| --- | --- |
| `bash supabase/tests/account-linking/run.sh` (GoTrue `v2.180.0` vero in Docker, provider finti GitHub e OIDC, SMTP finto, 0001+0002+0006) | 48/48 scenari Auth + 13/13 nel browser sulla dashboard compilata |
| `BASELINE=1 …run.sh` | stampa il comportamento senza 0006 (tabella §2) |
| `node supabase/account-merge/test-merge.mjs` | 38/38 |
| `npm run test:rls` (ora applica anche 0006 ed esegue `supabase/tests/account-linking.sql`) | RLS OK, FUNCTIONS OK, ACCOUNT LINKING OK, seed |
| `npm run test:e2e` (finto Supabase, ora con 0006) | 16/16 |
| `npm run check` (mock, desktop e telefono) | 34/34, incluso il nuovo "sign-in methods" |
| `npm run typecheck`, `npm run test:unit` | ok |
| control plane `npm test` (con 0006) | 144 ok, 1 saltato (era già saltato su `main`) |

Note sul laboratorio: Google non si può puntare altrove che `accounts.google.com`, quindi "Google" è un
provider OIDC finto passato dal provider Keycloak di Supabase, che legge gli stessi campi (`sub`,
`email`, `email_verified`). Il collegamento in Supabase Auth non dipende dal nome del provider (tutti i
provider OAuth sono nello stesso dominio di collegamento), quindi il percorso di codice è lo stesso.
Non ho potuto provare il vero Google, il vero GitHub, la tua configurazione SMTP né i permessi del tuo
progetto sulle tabelle `auth`.

## 8. File

- `supabase/migrations/0006_account_linking.sql` — le regole.
- `supabase/account-merge/` — `find_duplicates.sql`, `merge_accounts.sql`, `undo_merge.sql`, `test-merge.mjs`.
- `supabase/tests/account-linking/` — laboratorio con GoTrue vero: `run.sh`, `fake-providers.mjs`, `lab.mjs`, `baseline.mjs`, `scenarios.mjs`, `dashboard-e2e.mjs`.
- `supabase/tests/account-linking.sql` — le regole su Postgres semplice; `supabase/tests/local-stub.sql` ha le colonne di `auth` che servono.
- `src/session/*`, `src/pages/Settings.tsx`, `src/pages/SignIn.tsx`, `src/styles.css` — dashboard.
- `control-plane/src/auth/gateway.ts`, `control-plane/src/routes/session.ts`, `control-plane/src/http.ts` e test — control plane.
- `docs/control-plane-api.md` — i tre endpoint nuovi e la regola nella sezione 3.
