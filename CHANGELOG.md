# Changelog

All notable changes to Dadaguard are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Changed
- **Lo stato non è più solo un colore, e il perché si legge dove guardi** — in tabella la colonna
  «Stato» era larga 108px e su una riga sana conteneva **un pallino e nient'altro**: la colonna con
  meno informazione per pixel di tutta la vista, e — peggio — lo stato «su» codificato col **solo
  colore**, perché il badge col testo compare solo quando c'è un problema. Chi non distingue verde da
  rosso non aveva alcun segnale. Ora il glifo ha una **forma** diversa per stato (✓ su · ! degradato ·
  ✕ giù · ⊖ spento · ? sconosciuto) in 56px, e il badge con la **causa** si è spostato accanto al nome
  del servizio: leggerlo due colonne più a sinistra voleva dire tornare indietro con gli occhi.
- **Il riepilogo in cima è diventato il filtro** — «2 giù · 7 attenzione · 1 spento · 7 ok» erano
  numeri da guardare; ora ogni conteggio è un bottone che filtra, e usa il filtro «Stato» che **esiste
  già** nella barra invece di aggiungere un secondo meccanismo parallelo (due filtri per la stessa
  cosa si contraddicono e non si capisce quale stia agendo). I conteggi restano sempre quelli della
  **flotta intera**: se si restringessero alla selezione, dopo un clic su «giù» la striscia direbbe
  «2 giù» e nient'altro, cancellando la strada per tornare. Il numero grande dice invece cosa stai
  guardando ora — con un filtro attivo diventa `2/17`, così un filtro dimenticato non si traveste da
  flotta vuota. Bottoni veri: raggiungibili col tab, `aria-pressed`, anello di fuoco visibile.

### Fixed
- **Colonna «Latenza» vuota su servizi che una latenza ce l'avevano** — con le sonde accese il
  pannello *aveva* il numero (`risponde · HTTP 200 · 179ms` nella riga espansa) e nella colonna
  apposita mostrava `—`: dato raccolto e buttato via. Ora la colonna cade sulla misura della sonda
  quando il servizio non pubblica una metrica sua, **etichettandola** `sonda`, con la spiegazione nel
  tooltip: è il giro completo da fuori (rete + Cloudflare + servizio) e per costruzione è più grande
  della latenza che il servizio misura di sé. Mescolare le due tacendolo farebbe confrontare mele con
  arance («il backend è 10 volte più lento»). La metrica del servizio, quando c'è, vince: la sua
  parola vale più della nostra. L'ordinamento usa entrambe (stesso numero confrontabile) e chi non ha
  latenza resta in fondo in entrambi i versi, senza fingere uno zero.

### Fixed
- **«Risponde · HTTP 200» su un'app protetta da un login** — la sonda di liveness seguiva i redirect,
  quindi dietro Cloudflare Access leggeva `200` sulla **pagina di login** e dichiarava sano un servizio
  che poteva essere spento. Verificato sul vero: `GET dadaguard.get-cato.com` → `302` →
  `tech-cato.cloudflareaccess.com/cdn-cgi/access/login/…` → `200`. Ora i redirect si **leggono** invece
  di seguirli: se portano a una porta di autenticazione nota (Access, Okta, Auth0, Google, Microsoft) lo
  stato è **sconosciuto** con la spiegazione — da fuori, in anonimo, non si può dire se l'app è sana, e
  dirlo è peggio che non saperlo. Un redirect interno (http→https, dominio canonico) resta «su»; uno
  verso un altro host dice quale. Per avere un verde vero serve un `healthUrl` che bypassi il login.

### Added
- **Le notifiche e le sonde si accendono davvero** — il notificatore Slack e il segnale #1 esistevano
  nel codice ma in cloud restavano inerti: mancavano i webhook nel task e la mappa `health:` in
  config. La ricetta Terraform ora accetta `slack_webhook_ssm_arn`, `slack_webhook_cron_ssm_arn` e
  `cloudflare_api_token_ssm_arn` (facoltativi: `null` = spento, e i `secrets` si aggiungono solo se
  l'ARN c'è — un `valueFrom` verso un parametro inesistente non fallisce il plan, fa fallire l'AVVIO
  del task), e `deploy/enable-notifications.sh` accende tutto su un'istanza già in esecuzione, in
  modo idempotente. Serve perché il workflow di deploy riusa la task definition **viva** cambiandone
  solo l'immagine: una revision registrata così sopravvive ai deploy successivi.
  Le sonde dichiarate coprono **solo** gli host verificati serviti da AWS — una richiesta marcata è
  stata ritrovata in `/ecs/cato-staging/{backend,frontend}`. Restano fuori i tre microservizi di
  staging (rispondono da Railway: `x-railway-*`) e `app.get-cato.com` (Vercel: `x-vercel-id`): là un
  verde parlerebbe del vecchio hosting.
- **La sonda di liveness ora si può accendere sui servizi scoperti** — il segnale #1 richiede un
  `healthUrl`, ma un servizio trovato dall'auto-discovery non ha un posto dove dichiararlo: era l'unico
  check spento su tutto il pannello. Nuova mappa `health:` in config, con le stesse chiavi di `urls:`
  (`<nome>` o `<account>/<nome>`), che vale un URL intero o un **path** risolto su `urls:` — un
  `backend: /health` accende la sonda senza ridichiarare il servizio. Un path **senza** URL di base non
  sonda niente: i servizi scoperti espongono il DNS grezzo dell'ALB, che da fuori non risponde, e
  inventarci sopra un `/health` produrrebbe un rosso che non parla dell'applicazione. Un `healthUrl`
  scritto a mano vince sempre sulla mappa.
- **Notifiche Slack: due destinazioni, e una cosa che non si manda affatto** — se i cron avvisano già
  da sé quando crashano (in Cato lo fa `catocron`, col messaggio d'errore vero), ridirlo è duplicare, e
  due canali che dicono la stessa cosa insegnano a ignorarli entrambi. Ora i check dei cron espongono
  un **esito strutturato** (`missed` / `failed` / `ok`, non dedotto dal testo) e il notificatore lo usa
  per instradare: **«mai partito»** va nel canale dei cron (è il buco che nessuno può coprire
  dall'interno: schedule non applicato, target sbagliato, IAM, concorrenza a zero), **«caduto»** non si
  manda (`DADAGUARD_NOTIFY_CRON_FAILED=1` per riaccenderlo), **tutto il resto** — ECS a 0/N, endpoint,
  secret, drift, backup, certificati, sicurezza, Bedrock, Cloudflare — va nel webhook principale,
  perché oggi non ha voce da nessuna parte. Il **rientro** torna dove l'allarme è stato aperto.

### Added
- **Test di contratto sulle risposte AWS vere** — i test provavano la nostra logica su dati scritti da
  noi, e per questo non hanno trovato i tre guasti del 27/07: stavano tutti nell'**incontro** con AWS.
  `scripts/record-aws-fixtures.mjs` registra **una volta** le risposte vere (sola lettura,
  sanificate: id account, ARN, nomi di risorsa, identità e valori delle env var diventano segnaposto
  stabili — resta la *forma*), e `test/contract.test.js` le rigioca senza rete né credenziali. Le tre
  forme che ci sono costate la giornata sono ora tre test: la pagina di `FilterLogEvents` **vuota con
  un `nextToken`** (il cron fallito mostrato verde), il `ScheduleExpressionTimezone: Europe/Rome` (i
  cron sani dati per fermi) e il tag immagine con lo sha di 40 cifre. Ogni fixture registra anche **la
  richiesta** con cui è stata ottenuta: una risposta senza la sua domanda non è un contratto — è così
  che si è scoperto che i timestamp di `GetMetricData` sono inizi di secchio, non istanti di
  esecuzione. Un test separato **vigila sulla sanificazione** delle fixture, perché il repo è pubblico
  e una regola scritta una volta si dimentica.

### Added
- **Notifiche Slack: da dashboard a watchdog** — Dadaguard non aspetta più che qualcuno apra la pagina.
  Con `DADAGUARD_SLACK_WEBHOOK` configurato il server guarda la flotta a intervalli e scrive su Slack
  **quando qualcosa attraversa il confine problema/non-problema**: `🔴` quando va giù o si degrada,
  `🟢` quando rientra, col segnale colpevole, il suo testo e il link alla dashboard. È la differenza
  che si è vista oggi: il cron di produzione fallito all'01:01 l'abbiamo scoperto alle 14:30 guardando
  una card. Le tre regole che rendono una notifica sopportabile sono nel codice e nei test: **al primo
  giro prende solo nota** (su Fargate il filesystem è effimero, e un rilascio non deve rovesciare in
  chat lo stato del mondo), **debounce** di N letture consecutive (un throttle CloudWatch di trenta
  secondi non sveglia nessuno), **un messaggio per transizione, non per stato**. `up → idle` non è un
  guasto e `→ sconosciuto` è un problema del controllo, non del servizio: nessuno dei due parla.
  `<!channel>` solo sui guasti in produzione. Se Slack è irraggiungibile lo stato non viene salvato e
  al giro dopo la transizione si riprova. Senza webhook il watcher non parte e non fa una sola
  chiamata AWS.

### Added
- **Colonna Latenza ordinabile** — «chi è il più lento?» è la domanda naturale di una tabella e non si
  poteva fare: solo le Lambda esponevano un numero (`p95Ms`), Bedrock/SageMaker no, e ordinare le
  stringhe mostrate metterebbe «~4m 30s» prima di «~51s». Ora la metrica di latenza porta il suo
  valore in millisecondi (`ms`) e la colonna ordina su quello, primo clic = i più lenti in cima; chi
  non ha latenza resta in fondo in entrambi i versi invece di fingere di essere a zero.

### Fixed
- **Lo stato «ok» non è più solo un colore** — sulle righe e sulle card sane il tag («OK») è nascosto
  di proposito, quindi restava un pallino verde e nulla più: per chi usa uno screen reader, o non
  distingue verde da rosso, l'informazione non c'era. Ora il pallino ha un nome accessibile
  (`role="img"` + `aria-label`, visibile anche al puntatore), e il pallino dell'ambiente — che è
  decorazione, l'etichetta è accanto — è marcato come tale invece di annunciarsi senza nome.
- **«1 errori»** — l'etichetta di una metrica che accompagna un conteggio ora concorda col numero
  («1 errore», «0 errori», «2 esecuzioni»), sia nella frase della tabella sia nelle tile delle card.
  L'interpolatore del server ha imparato la forma plurale `{n#singolare#plurale}` che il client aveva
  già, e in entrambi la forma si risolve **anche senza il conteggio** (prima un chiamante distratto
  avrebbe stampato in pagina il segnaposto grezzo).
- **Il deploy diventa verde solo quando il servizio serve traffico** — `update-service` ritorna appena
  ECS accetta la richiesta, non quando i task nuovi rispondono: il workflow risultava riuscito mentre
  l'app serviva ancora il codice precedente (visto: due minuti di bundle vecchio dopo un merge
  «riuscito»). Ora attende `services-stable` e, se il rollout non converge entro il timeout,
  **fallisce** stampando stato del rollout ed eventi del servizio.

### Changed
- **CHANGELOG per versione** — le voci stavano tutte sotto `[Unreleased]` mentre 0.4.45→0.4.55 erano
  già uscite: ora ognuna sta sotto la versione che l'ha spedita (ricostruite dai tag), così il
  changelog dice cosa c'è in ciò che gira.

## [0.4.55] — 2026-07-27

### Changed
- **Tabella più leggibile** — la struttura teneva, la lettura no: su una riga larga 1500px l'occhio
  perdeva la riga a metà strada. Ora **righe alternate** e un **separatore verticale** tra il blocco
  «chi» (stato · servizio · ambiente) e il blocco «come va» (esecuzione · latenza · build), che dà un
  punto di riferimento a metà. **Altezza di riga costante**: l'andamento della latenza sta accanto al
  numero invece che sotto, e le cifre sono a larghezza fissa (`tabular-nums`) così le latenze si
  incolonnano e le confronti a occhio. Una **colonna in meno** (Tipo, che era già un filtro nella
  barra in cima, è scesa nella riga espansa) e l'ordine rifatto: dopo il nome viene ciò che conta —
  esecuzione e latenza — con la build in coda, che è provenienza, non urgenza. La colonna Esecuzione
  non ripete più la p95 che la colonna Latenza dice già: quando ci sono metriche la cella le compone
  (numero + etichetta muta), mettendo l'etichetta prima quando il valore è descrittivo
  («motore aurora-postgresql») e dopo quando è un numero («3/3 istanze»).

## [0.4.54] — 2026-07-27

### Added
- **Vista tabella della flotta (predefinita)** — una riga per servizio invece di una card: con 48
  servizi le card sono un muro, e nessuna rifinitura le salva. Colonne fisse **Stato · Servizio ·
  Ambiente · Tipo · Build · Esecuzione · Latenza**, ordinabili e filtrabili (il pattern delle service
  list di Datadog/Sentry/ArgoCD); i segnali secondari (raggiungibilità, secret, sicurezza, allarmi,
  backup, Terraform) nella **riga espansa**, il dettaglio completo nel drawer, le azioni che si
  accendono sulla riga sotto il puntatore. La latenza ha una colonna sua, così il suo andamento
  eredita l'etichetta dall'intestazione. Nomi duplicati tra account (`backend` esiste in staging e in
  produzione) gestiti con chiave account+nome. Le **card restano** un clic a lato: l'interruttore in
  cima ricorda la scelta. In una schermata da 25 righe si vede tre volte quello che si vedeva prima.

## [0.4.53] — 2026-07-27

### Fixed
- **Il check dei cron ECS non dipende da un permesso in più** — il rilevamento del fallimento (0.4.52)
  usava `logs:DescribeLogStreams`, che il ruolo read-only cross-account non ha: il check passava da un
  verde sbagliato a «accesso negato». Onesto, ma cieco. Ora dove quel permesso manca si torna sul log
  group intero **inseguendo le pagine** invece di fidarsi della prima; esaurito il budget di pagine il
  check dice «non trovato», mai «fallito». Un errore che non è «accesso negato» (throttling, rete) non
  viene mascherato dal fallback: si propaga.

## [0.4.52] — 2026-07-27

### Fixed
- **Un cron FALLITO veniva mostrato verde** (cron su ECS RunTask) — l'errore si cercava su tutto il log
  group con `FilterLogEvents(limit: 1)`, ma quell'API distribuisce uno scan budget tra gli stream e può
  restituire una pagina **vuota** con un `nextToken` pur essendoci i match: con `limit: 1` succede
  sistematicamente. Il check leggeva la pagina vuota come «nessun errore». In produzione
  `refresh-bi-mvs` risultava «gira come da schedule» con **tre traceback** nell'ultima esecuzione, e lo
  stesso meccanismo faceva oscillare la card tra FALLITA e ok senza che i dati cambiassero. Ora la
  domanda è quella che la card dichiara — «com'è andata l'**ultima** esecuzione?»: su RunTask ogni
  esecuzione ha il suo log stream, quindi si prende lo stream più recente e si cerca l'errore **dentro
  quello**. Deterministico.

## [0.4.51] — 2026-07-27

### Fixed
- **Fuso dello schedule ignorato** — gli schedule di EventBridge Scheduler possono dichiarare un
  `ScheduleExpressionTimezone` (i cron Cato usano `Europe/Rome`) e Dadaguard lo scartava, leggendo
  `cron(0 17 ? * MON-FRI *)` come 17:00 **UTC** invece che locali: due ore di scarto in estate, una in
  inverno. Abbastanza per cercare l'esecuzione nella finestra sbagliata e dare per fermo un cron che
  aveva girato regolarmente — ed è il motivo per cui i due `scrape-volume-monitor` restavano rossi
  anche dopo aver corretto la finestra. Ora l'espressione è valutata nel suo fuso (via `Intl`, quindi
  l'ora legale è gestita per costruzione); fuso assente → UTC come prima, fuso inesistente → UTC
  invece di un errore.

## [0.4.50] — 2026-07-27

### Fixed
- **Falso «GIÙ» sui cron che non girano ogni giorno** — il dead man's switch deduceva una cadenza
  costante (finestra = cadenza × 1.2), così un `cron(0 17 ? * MON-FRI *)` guardato di lunedì mattina
  risultava fermo: l'ultima esecuzione attesa era **venerdì**, 67 ore prima, fuori da qualunque
  finestra «giornaliera». Due ambienti diventavano rossi nello stesso istante — l'indizio che era il
  controllo, non i cron. Ora la finestra arriva dall'**espressione vera** (fino all'ultimo fire
  atteso, più una grazia) e come riferimento si prende l'ultimo fire più vecchio della grazia, così
  nemmeno i due minuti dopo uno scatto danno un falso rosso (le metriche CloudWatch si pubblicano con
  1-3 minuti di ritardo). Il messaggio dice **quando** avrebbe dovuto girare invece della finestra
  cieca. `rate(...)` e caratteri non gestiti (L/W/#) restano sull'euristica precedente.

## [0.4.49] — 2026-07-27

### Fixed
- **La finestra anche sulle lambda on-demand** — i numeri (e quindi gli andamenti) delle lambda
  on-demand non dicevano su che periodo erano calcolati: la KPI row non mostrava la finestra e il
  tooltip del grafico usciva come «chiamate · min 2 · max 16», senza i `60m`. Le cron la avevano già.

## [0.4.48] — 2026-07-27

### Fixed
- **Mini-grafici illeggibili nelle card** — la linea stava **sciolta** sotto la riga dei numeri, subito
  dopo «latenza ~6.3s», ma disegnava le **invocazioni**: si leggeva come l'andamento della latenza,
  che era un'altra cosa. E la scala era min-max, quindi un p95 che oscillava del 3% riempiva tutta
  l'altezza e sembrava un problema. Ora ogni andamento sta **dentro la stat tile della sua metrica**
  (è la label della tile a dire cosa disegna: `latenza`, `chiamate`, `richieste`), la scala parte da
  **zero** (una variazione piccola sembra piccola) e il tooltip riporta min/max/ultimo **nell'unità
  della metrica** (`min 2.1s · max 6.3s`, non `6300`). Si disegna solo quando c'è un andamento da
  vedere: servono ≥3 punti e almeno il 10% di escursione, altrimenti niente grafico — via le linee
  piatte e la «punta» isolata della cron giornaliera (una run nella finestra non è un andamento).
  I Worker Cloudflare passano alle stesse stat tile (richieste · errori · CPU p99) invece della frase.

## [0.4.47] — 2026-07-27

### Fixed
- **Riga Build: valori grezzi che sfondavano la card** — chi tagga le immagini ECS con lo sha del
  commit vedeva 40 cifre esadecimali senza spazi (`:0e89c2198d288ec9…`): niente su cui andare a capo,
  quindi il testo usciva dal bordo e finiva sopra la card accanto. Il tag ora è **nudo** (via il `:`
  iniziale, che si leggeva come un errore di sintassi) e in card è **accorciato a 8 cifre**, con il
  valore intero nel tooltip della riga; il confronto con la versione attesa resta sul tag completo.
  Quel `:` rompeva anche il confronto (`:v2` ≠ `v2` → mismatch inventato su chi dichiara
  `expectedVersion`). Chi ha deployato perde il dominio email
  (`81815192+matte97p@users.noreply.github.com` → `matte97p`): erano tre righe per card. E la card
  ora regge qualunque stringa lunga senza sfondare (`overflow-wrap`), non solo i casi noti.

- **Artefatti nelle card** — sparkline di una serie piatta (disegnava un filetto orizzontale che
  sembrava un bordo finito lì per sbaglio), KPI tile per un singolo numero (due righe per dire
  «1/1 task attivi») e ID grezzo del modello Bedrock nel sottotitolo (due righe già nel tooltip del
  nome). I servizi **inattivi** (modelli Bedrock mai invocati) scendono sotto quelli sani: non sono
  un problema e non devono occupare la prima riga della dashboard.

## [0.4.46] — 2026-07-27

### Fixed
- **La testa comune del nome non compattava sui nomi veri** — la soglia perché un prefisso diventi
  «famiglia» era metà del gruppo: sull'account Staging reale (21 servizi non Bedrock) `cato-staging-`
  copre 12 nomi e `cato-staging-cron-` 9, entrambi sotto 13 → nessuna compattazione. Ora la soglia è
  un terzo del gruppo e i Bedrock, che hanno il loro nome parlante, escono dal conteggio invece di
  alzare l'asticella per tutti.

## [0.4.45] — 2026-07-27

### Changed
- **Card dei servizi ridisegnate** — con 25 servizi a schermo (flotte di cron) la card andava in
  crisi: nomi lunghi a capo su 4 righe perché il titolo era strozzato dai badge, un segnale sparso su
  3-4 righe, etichette disallineate da card a card e buchi a zig-zag tra le colonne. Ora: il nome sta
  su una riga (testa comune del gruppo — `cato-staging-cron-` — piccola e muta, coda in evidenza,
  niente troncature), **un segnale = una riga** con le etichette incolonnate a larghezza fissa,
  cadenza dei cron in parole nell'header (`ogni 1g` invece di `1440m`), tag di stato solo quando c'è
  qualcosa da dire (via l'«OK» verde su ogni card sana), azioni discrete che si accendono sull'hover,
  tooltip di spiegazione sull'etichetta invece di un `?` per riga, e card della stessa riga alte
  uguali. Le cron **spente di proposito** scendono in fondo al gruppo, sotto i servizi sani.

## [0.4.40] — 2026-07-24

### Added
- **Vista Deploy: «chi ha deployato»** — ogni build mostra chi l'ha lanciata (autore del commit), nella
  lista e nel drawer di dettaglio. Il dato arriva dalla variabile CodeBuild esportata `DEPLOYER` (via
  `BatchGetBuilds`, nessun permesso IAM aggiuntivo); assente sui build che non la esportano → colonna vuota.
## [0.4.1] — 2026-07-06

### Changed
- **Automated releases** — publishing now happens on push to `main`, in line with the rest of the OSS
  family. `release.yml` compares `package.json` against the versions live on Docker Hub: when the
  local version is ahead it builds and pushes the image to GHCR + Docker Hub and cuts the git tag +
  GitHub Release — no manual `git tag` needed. Pushing shipped code (server, frontend sources, deps)
  without bumping **auto patch-bumps** and publishes; changes that don't ship (docs, tests, CI) never
  trigger a release. Pushing a `v*` tag still works as the explicit path.

## [0.4.0] — 2026-07-06

### Added
- **Access-aware header** — the header now hides the pages the assumed role can't reach (e.g. **Costs**
  when the role lacks Cost Explorer). Access is resolved with `iam:SimulatePrincipalPolicy` (free,
  read-only): AWS evaluates the effective policy, so wildcards, explicit denies and permission
  boundaries are all honored — no parsing IAM documents by hand. `/api/selfcheck` reuses its STS
  identity to report a per-surface `surfaces` map (`allowed`/`denied`/`unknown`), aggregated across
  accounts: a page is hidden only when denied in **every** account, and shown on any allow or when
  undeterminable (safe default — never an empty header). Gated surfaces: **Costs**
  (`ce:GetCostAndUsage`), **Waste** (`ec2:DescribeVolumes`), **Quotas** (`servicequotas:ListServiceQuotas`),
  **IAM** (`iam:ListPolicies`); Dashboard, Security and Topology stay visible (composite, degrade
  gracefully). Results are cached per principal (2 min TTL, `DADAGUARD_ACCESS_TTL_MS`) while the STS
  liveness probe stays live. Optional new read-only permission `iam:SimulatePrincipalPolicy`: without
  it the header shows everything as before (no regression).

## [0.3.0] — 2026-07-02

### Added
- **Security page** — a new **Security** page: security & governance findings aggregated in one list,
  filterable by category and sorted by severity. Categories: **public surface** (SGs open to
  `0.0.0.0/0` on sensitive ports, RDS `publicly accessible`, internet-facing ALBs, S3 without a
  complete Public Access Block), **expiring** (ACM certs within 30 days), **IAM hygiene** (policies
  with `Action`/`Resource` `"*"`, IAM users without MFA, access keys not rotated in 90+ days), and
  **stale secrets** (Secrets Manager not rotated in 90+ days — metadata only, never the value).
  Read-only, best-effort. New read-only permissions: `acm:ListCertificates`/`DescribeCertificate`,
  `iam:ListUsers`/`ListAccessKeys`/`ListMFADevices`, `secretsmanager:ListSecrets`. Relevant findings
  **link into the IAM page**: a too-broad policy → its "by policy" view; an exposed resource or a stale
  secret → the "by resource" view ("who can reach it").
- **IAM explorer** — a new **IAM** page with up to three lenses, each shown only when it applies to the
  account (no empty tabs): "by policy" appears only if there are customer-managed policies, "SSO access"
  only if an Identity Center instance exists. **By policy**: pick a customer-managed policy
  and see who uses it (roles/users/groups) and what it grants (actions by service + resource ARNs).
  **By resource**: pick a service and see who can reach it — unified across **both** IAM policies
  (roles/services) *and* SSO permission sets (people/groups via their inline policy), so "who can reach
  the prod DB?" is answered no matter how access is granted. **SSO access**: the *real* human access via Identity Center —
  permission set → people/groups → account (with SSO there are no IAM users/groups to look at, so the
  first two lenses show empty user/group columns; this one shows how access actually works — groups are expanded to their members, so you see who's actually inside). Read-only,
  no secret values are ever read. New read-only permissions: `iam:ListPolicies`/`ListEntitiesForPolicy`,
  and — for the SSO lens, on the account hosting Identity Center — `sso:List*`/`DescribePermissionSet`
  + `identitystore:DescribeUser`/`DescribeGroup`/`ListGroupMemberships`.
- **Topology, upgraded** — the dependency view is now **its own page**, auto-laid-out with dagre, and
  infers far more than before. `env` references are read from **ECS task definitions** too (not only
  Lambda) — so an ECS/Fargate stack finally shows its wiring; plus new sources: **Step Functions**
  (resources a state machine orchestrates → `flow` edges), **Application Load Balancers** (the ECS/EC2
  services behind each target group → `lb` edges), and **IAM role policies** (the resources a service's
  role can reach → `iam` edges — the strongest signal when connection strings live in Secrets Manager,
  so the DB/queues stop looking isolated; reuses the `iam:*` read grants the security check already
  needs). Demo mode now ships a fully-wired sample graph, so the feature is visible with no AWS
  connection. New read-only permission: `states:DescribeStateMachine` (the Terraform role modules
  already granted it; only the JSON policy example was missing it).
- **Multi-page navigation** — Dadaguard is no longer one page with pop-out panels: Dashboard, Costs,
  Waste, Topology and Quotas are now real pages with their own URLs (react-router; deep links and the
  browser Back button work). The filter bar lives **on every page** and its state persists as you move
  between them — Dashboard and Topology get the full bar, the per-account pages (Costs/Waste/Quotas)
  show just Account + Region. Drift, Discover and Meta-health stay as pop-up panels opened from the header.
- **Log window selector** — the recent-logs drawer now offers 1h / 6h / 24h (was fixed at 1h); the
  backend already accepted `?minutes=`. The snapshot cap (~100 lines per call) still applies.
- **Cost month selector** — the Costs drawer can pick the reference month (last 12 months), not just
  the current MTD; the backend takes `?month=YYYY-MM` (defaults to the current month).
- **Cron auto-detection** — discovered Lambdas get their schedule inferred from EventBridge Rules, so
  cron functions are recognised as such: the card shows a ⏰ cadence badge and the **dead-man switch**
  fires when a cron misses its expected window (instead of showing it as idle). New read-only
  permissions: `events:ListRules`, `events:ListTargetsByRule`.
- **Rich, global filters** — the dashboard bar now filters by name search, account, type, status
  (multi), region, cron/on-demand, and Terraform-managed, plus a "problems only" toggle and a clear
  button. Filters apply **everywhere**: cards, Topology (its duplicate account selector is gone), and
  the aggregate drawers (Costs/Waste/Quotas/Meta-health) narrow to the accounts still visible.
- **Filter presets** — save, recall and delete named filter combinations (localStorage).
- **Compact filter bar + decluttered topology** — the filter bar is one compact icon row; the Topology
  dependency view graphs only connected services (auto-laid out top-down with dagre, orthogonal
  `smoothstep` edges — no more overlapping nodes or crossing curves) and lists the isolated ones
  (e.g. crons) in a side panel.
- **Discovered services fully wired** — logs/events/topology now work for auto-discovered services too
  (were 404 / edge-less); a shared 60s-cached resolved list also curbs AWS "Rate exceeded" throttling.
- **Amazon Bedrock** — new service type: per-model usage from CloudWatch (invocations, client/server
  errors, throttling, latency). Auto-discovered from the models you've actually invoked (CloudWatch
  `ListMetrics`), or declared with `aws: { type: bedrock, model: <modelId> }`.
- **More service types** — OpenSearch (cluster status + nodes), SES (send volume, bounce/complaint
  rate), SageMaker (endpoint invocations/errors/latency) — all via CloudWatch and auto-discovered.
- **Calmer cards** — metadata (build sha, timestamps) is dimmed so the eye lands on status first;
  the Terraform-drift row is now the Terraform logo colored by state (green/red/yellow), no text;
  long execution latencies are humanized (`p95 245759ms` → `p95 4m 6s`, near-timeout `(300s)` → `(5m)`).
- **Truer Lambda states** — a function/cron that fails **100% of its invocations** is now **down**
  (was only "warning"); the cron dead-man window has a **10-min floor** so high-frequency crons (1m/5m)
  don't false-alarm on CloudWatch metric-publication lag; the on-demand idle threshold is **60 min**
  (was 15, too aggressive).
- **Throttling resilience** — several layers so busy dashboards stop hitting `TooManyRequests`:
  CloudWatch `GetMetricData` is **batched** (one call per credentials+window, ≤500 metrics, instead of
  one per service); AWS clients **share one credential provider per account** (a single STS AssumeRole
  instead of one per client); adaptive retry (client-side rate limiting under 429); and a 5-min
  resolved-services cache, plus a shared cache + single-flight for Lambda `GetFunctionConfiguration`
  (build/drift/runtime read the same function's config in one refresh → one control-plane call instead
  of three, and repeat refreshes reuse it for a TTL — the main reason a cron fleet stopped hitting 429).
  Tunables: `DADAGUARD_AWS_MAX_ATTEMPTS`, `DADAGUARD_DISCOVERY_TTL_MS`, `DADAGUARD_CONCURRENCY`, `DADAGUARD_LAMBDA_CFG_TTL_MS`.
  And when a burst still exhausts the retries, the build field shows a clean *"AWS rate limit — retry on
  refresh"* instead of the raw `TooManyRequestsException: HTTP 429` SDK exception.
- **Terraform badge** — the "Terraform-compliant" row is now a green/red badge, readable at a glance.

### Changed
- **Auto-discovery merges with the watchlist, on by default** — discovered services are now added to
  those declared in `services.yaml` (declared ones win and keep their overrides), instead of running
  only when the watchlist is empty. Works in cloud too. Opt out with `DADAGUARD_DISCOVER=0`.

### Fixed
- **Missing server-side translations** — Bedrock, SageMaker, SES and OpenSearch runtime summaries
  rendered raw i18n keys (e.g. `bedrock.invocations`) because those strings lived only in the web
  dictionary, never in the server one. Added all it/en strings; a new test fails if any `namespace.key`
  used in a runtime/check is absent from the server dictionary, so a new provider can't ship untranslated.
- **Clean AWS error messages** — throttling, access-denied, not-found, expired-token and timeout errors
  now show a readable, localized message in cards/drawers instead of the raw SDK exception. A shared
  `cleanAwsReason()` covers every check and endpoint (runtime, backups, version, drift, secrets, logs,
  quotas, IAM, self-check, events, changes, waste, costs, liveness); Lambda alias errors distinguish
  "alias missing" from a real AWS error.
- **Humanized numbers** — latency reads `4m 6s`/`450ms` (shared `fmtMs`) and invocation/item counts are
  compacted with `fmtCount`, across Bedrock/SageMaker/SES/DynamoDB and the client-side latency chip.
- **Plural forms** — the web i18n gained a `{n#singular#plural}` form; fixed "1 servizi", "1 volumi",
  "1 risorse" and friends in the status summary, Waste, Discover and Dashboard.
- **Fully-translated strings** — the Topology "down" edge label and the Waste "/month" suffix were
  hardcoded Italian (stayed Italian in English mode); now translated. Waste also gets an empty state.
- **Redacted drift output** — the full `terragrunt plan` shown in the drift drawer masks attribute
  string values: `key = (redacted)`, both sides of a `->` diff, **list/set elements**, and **heredoc
  bodies** (`user_data`, inline policies) — the places secrets most often hide — so a non-`sensitive`
  value can't leak. Redaction runs before the size cap, so truncation can't expose a fragment either.
- **Post-audit polish** — API Gateway request count is compacted (`137k`), the "no account" label is
  translated (was hardcoded Italian, stayed IT in English), and dead/duplicate i18n keys left by the
  error/format refactor were removed (server `version.throttled`/`drift.throttled`, 17 web summary keys
  that duplicated the server ones and had already drifted).
- **Localized AWS errors on every route** — error messages on the on-demand routes (waste, costs, quotas,
  logs, events, meta-health, IAM policies) are now localized too: the frontend sends `?lang=` and each
  endpoint threads `t` down to `cleanAwsReason`. Before, only `/api/status` was localized and these fell
  back to English.
- **Robustness polish** — formatters guard against non-finite input (return `—`); the last fixed plurals
  (`iam.attachments`, `logs.hidden`) use the plural form; Quotas numbers get thousands separators; SQS/S3
  no longer mislabel throttle/access-denied as "not found" (they rethrow so `cleanAwsReason` handles it);
  removed 7 dead web i18n keys; the i18n test now scans the whole server (not just runtime/checks).

## [0.2.0] — 2026-06-30

Adoption, trust and scale — the jump from "deep tool" to "the dashboard a DevOps reaches for".

### Added
- **Zero-config auto-discovery** — starts with no `services.yaml`: discovers what's running in each
  account (read-only, in memory). `services.yaml` becomes an override to pin watchlist/versions/accounts.
- **Demo mode** (`DADAGUARD_DEMO=1`) — a fake 12-service fleet covering every state, zero AWS. Try it,
  record a demo, or evaluate the UI without credentials.
- **AWS Organizations + multi-region** — an `org` block enumerates members (`organizations:ListAccounts`)
  and assumes the read-only role in each; auto-discovery sweeps every member × region.
- **Recent changes (CloudTrail)** — write API calls on a resource (who/what/when + errorCode): the cause
  behind a service turning yellow/red, alongside operational events.
- **Account reachability (meta-health)** — an STS probe per account + a header indicator; broken plumbing
  (expired creds, wrong ExternalId) no longer hides as a falsely "unknown" signal.
- **AWS console deep-links** — one click from any card to the exact resource (17 types).
- **Expected-version provenance** — `expectedVersionUrl` resolves the expected version from a dynamic
  source of truth; the UI always shows where "expected" came from.
- **Brand** — a dog mascot logo + favicon, and a demo video/GIF in the README (rendered by demowright).

### Changed
- **Deploy-aware grace for ECS** — no false reds during rollouts: a running<desired count during a
  deployment reads as "rollout in progress", not a fault (`DADAGUARD_DEPLOY_GRACE_SECONDS`, default 120).

### Read-only role
- New permissions: **`cloudtrail:LookupEvents`** (recent changes) and **`organizations:ListAccounts`**
  (org mode only). Re-apply the role to enable them.

## [0.1.0] — 2026-06-30

First public release. A local-first, **read-only**, **no-LLM** watchdog that answers
*"is my stack up **and coherent**?"* by correlating AWS + secrets (SSM/Doppler) + Terraform.

### Signals
- **Reachable** — liveness + latency of an HTTP endpoint.
- **Build / deploy** — what runs and since when, zero-config: image tag + deploy time (ECS),
  version + last-modified (Lambda), AMI + launch time (EC2). Compares to `expectedVersion` when set.
- **Runtime** — real desired-vs-running for ECS · ASG · Lambda (with cron dead-man switch) · RDS ·
  ALB · EC2 · **SQS** (queue depth) · **DynamoDB** · **ElastiCache**.
- **Terraform** — lightweight drift (state ↔ AWS) and full `terragrunt plan` on demand, which now
  distinguishes *in-sync* / *to-apply* / *real drift*; plus resources not managed by Terraform.
- **Secrets** — present in SSM/Doppler (by name only, never values); missing-between-environments.
- **Security** — open security groups (`0.0.0.0/0`) and IAM wildcard policies (opt-in per service).
- **Costs & waste** — real MTD spend (usage vs credits) and list-price waste (idle EIP/NAT/EBS).
- **Topology** — dependencies inferred from AWS (Lambda env, event sources, security groups) and a
  network map (VPC → subnet → service, with egress), both with a per-account filter.

### Interfaces
- Web dashboard (React + Ant Design), **it/en** UI with per-mode default language.
- **CLI/CI** — `npm run check` with exit codes to gate pipelines (`--json`, `--service`, `--fail-on`).
- **`/metrics`** (Prometheus) + **`/healthz`** — let Grafana/Alertmanager do dashboards, alerting and
  history without Dadaguard becoming a stateful service.

### Deploy
- `docker compose up` for one-command self-host; published image on GHCR.
- Cross-account read-only via AssumeRole + ExternalId; least-privilege role example (Terraform + JSON).
- `npm run config:push` to publish the watchlist to a cloud instance (SSM + redeploy).

### Principles
Read-only on the infra · no LLM · fetch-on-load, zero storage · secrets by name only.
