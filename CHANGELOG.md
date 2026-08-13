# Changelog

All notable changes to Dadaguard are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **Le due azioni che non lasciavano traccia da nessuna parte.** La pagina dei rilasci mostrava i riavvii
  forzati e gli hotfix; restavano invisibili le due cose più invasive che si fanno a mano su AWS, e
  CloudTrail le sapeva da sempre. Ora compaiono accanto alle altre: l'**apertura a mano di una porta su
  un security group** (il break-glass: serve quando Teleport o IAM sono giù, lascia drift rispetto a
  Terragrunt e va richiusa) con la sua **riga gemella di chiusura**, così le due insieme dicono se la
  porta è ancora aperta, e la **shell aperta dentro a un container** che gira, che vede tutti i segreti
  del servizio. Di entrambe si dice **chi**, e se è passata da Teleport (sessione registrata) o da una
  console con AdministratorAccess. Anche i tentativi **respinti** si vedono: un break-glass negato
  spiega perché qualcuno è rimasto fuori, e nasconderlo lascia la domanda aperta.

### Added
- **«La mia modifica è già in produzione?», in una riga.** La domanda si risponde oggi aprendo un compare
  su GitHub e confrontando due tag a mano, mentre i dati erano già dentro Dadaguard (le build CodeBuild
  per account). Ora `/api/rilasci` mette **staging e produzione affiancati per servizio**, con il commit
  di ognuno e il verdetto, e in fondo la **coda del non rilasciato**. Tre scelte che decidono se la lista
  si legge: quello che «gira» è l'ultimo deploy **riuscito** (una build fallita o in corso non ha cambiato
  la produzione); un servizio che vive in un ambiente **solo** non è «da rilasciare» ma «solo staging»,
  sennò `acme-admin` e le sonde sarebbero rumore permanente; e `?format=testo` risponde in testo piatto,
  perché dal terminale o da una skill rifare la tabella dal JSON significa riscrivere la stessa logica
  fuori da qui. Nessuna chiamata AWS in più: il giro CodeBuild è quello che `/api/deploys` faceva già,
  ora estratto in una funzione che i due endpoint condividono.

### Added
- **`expectedHealthy` sui load balancer: quando «1 sano su 2» è la normalità.** Un target group può avere
  per costruzione un solo target sano: è il caso del writer di un Postgres in replica, dove l'health check
  chiede «sei il primario?» e lo standby registrato risponde no, quindi resta `unhealthy` per sempre.
  Dadaguard lo chiamava ATTENZIONE a ogni giro: visto su un writer Postgres di staging il 13/08/2026,
  subito dopo il rientro dello standby. Con `aws: { type: alb, expectedHealthy: 1 }` quello diventa lo
  stato di regime, la card lo scrive («1/2 target sani (attesi 1)») e la notifica tace. Zero sani resta
  GIÙ comunque: la soglia si sposta, il rosso no. Un `expectedHealthy` più alto dei target registrati vale
  «tutti», così una config vecchia o un cluster ridimensionato non inventano un guasto.

  Sui load balancer **scoperti** dalla discovery, che non hanno un blocco `aws:` in cui scriverlo, la
  soglia si dichiara con la mappa `expectedHealthy:` in `services.yaml`, indicizzata per `<account>/<nome>`
  o per nome secco, come già si fa per `urls` e `health`. Senza quella mappa la modifica sarebbe stata
  irraggiungibile proprio nel caso per cui è nata: il writer di un Postgres è un load balancer scoperto.

### Changed
- **Il registro di «cosa è già uscito» sono i tag, non `package.json` su main.** L'auto patch-bump si
  scriveva il bump come commit `[skip ci]` su `main`; da quando `main` ha un ruleset che richiede il check
  `test`, quel push viene rifiutato — `GH013: Required status check "test" is expected` — e non può
  passare, perché un commit `[skip ci]` non farà mai girare nessun check. Visto dal vivo: il rilascio di
  `v0.4.101` è morto lì. Ora il bump vive **solo nel working tree della run**: entra nell'immagine (il
  Dockerfile copia `package.json`) e resta registrato dal tag `v<versione>` che la Release stacca in fondo,
  che è anche il riferimento con cui il giro dopo decide se ci sono file spediti cambiati. Conseguenza da
  sapere: su `main` `package.json` resta indietro rispetto all'ultima versione pubblicata, ed è normale —
  la verità è `git tag -l 'v*' | sort -V | tail -1`.

### Added
- **La suite gira sulle PR e blocca il deploy.** `deploy.yml` e `release.yml` partono entrambi da un push
  su `main`, cioè **dopo** il merge, e in parallelo: i test li lanciava solo chi scriveva la modifica,
  sulla sua macchina, una PR con la suite rossa risultava `CLEAN · MERGEABLE`, e il primo a scoprirlo era
  il deploy in produzione. Ora `test.yml` gira su ogni PR **e** come primo job dei due workflow di
  rilascio (`workflow_call` + `needs: test`), quindi un rosso non arriva né su ECS né sul registry
  pubblico. Fa anche `npm run build`, che CONTRIBUTING.md chiede da sempre e nessuno verificava: la suite
  è tutta lato server, quindi un errore in `web/*.jsx` passava verde e poi fermava il `docker build` su
  main. Resta fuori, di proposito, la *branch protection*: vive nelle impostazioni del repo, non nel
  codice, e va accesa a mano (`test` come required status check).

### Changed
- **Le notifiche dicono cosa è rotto, non quale modulo l'ha visto.** Due righe lette in canale il
  13/08/2026 — `acme-staging-alb-int [STAGING] ATTENZIONE · esecuzione — 6/7 target sani` e
  `webhook-dispatch [STAGING] ATTENZIONE · esecuzione — 28 chiamate · 10.7% errori · p95 751ms` —
  non permettevano di decidere niente: «esecuzione» è il nome del check `runtime`, lo stesso per
  ventidue tipi di risorsa, e il dettaglio era la frase scritta per la **card**, dove accanto ci sono
  le metriche e il pannello dei task. In chat non c'è niente accanto.

  Tre cose, tutte nello stesso posto:
  - **La causa nomina la risorsa**: `· target`, `· cron`, `· certificato`, `· coda`, `· CDN`. Tipo
    ignoto → si resta su «esecuzione». Una Lambda a schedule si riconosce da `outcome`, che esiste
    solo sui cron.
  - **`alert`, il dettaglio scritto per la chat.** Un check può esporlo accanto a `summary`: la card
    tiene la sua frase compatta, la notifica riceve soggetto, conseguenza e soglia. Chi non ce l'ha
    non cambia. Così `6/7 target sani` diventa `1 target su 7 non sano: i-0abc
    (Target.FailedHealthChecks)` — id e motivo arrivavano già dalla stessa `DescribeTargetHealth`, si
    buttavano — e `10.7% errori` diventa `3 errori su 28 chiamate (10.7%) in 60m · scatta a: un errore
    o un throttle qualsiasi`: valore assoluto, finestra (che il ramo cron scriveva e l'on-demand no) e
    **la regola**, come già faceva Bedrock. Stessa cura su SQS (la soglia `maxDepth`), SES (le soglie
    di reputazione AWS), API Gateway (la finestra di 15 minuti, mai detta), EC2 (**quale** dei due
    controlli AWS è fallito: l'host sotto o il sistema operativo dentro), drift (`no · memoria 512MB`
    era la risposta alla colonna «in sync?» della card) e OpenSearch/RDS (il colore del cluster e
    «1/2 istanze» ora dicono cosa perde chi li usa, e se è fuori il nodo di **scrittura**).
  - **Un tetto e una pulizia sola**: il `⚠` dentro al testo si toglie (l'icona di stato è già la prima
    cosa della riga) e il dettaglio si taglia a 160 caratteri — sommate, le spiegazioni allungano la
    riga fino a mandare a capo tre volte su mobile. Il taglio è **in mezzo**, non in fondo: la coda è
    dove stanno soglia e conseguenza, cioè l'unica frase che dice se il numero davanti è un problema.
    Tagliare in fondo avrebbe buttato via esattamente quello che questa modifica aggiunge.

### Fixed
- **Una distribuzione CloudFront spenta di proposito non è più un guasto — ma solo se lo dichiari.**
  `Enabled: false` dava `degraded` per sempre col testo `Deployed · disabilitata`, che si contraddice
  da sé. Ora, con `aws: { type: cloudfront, disabled: true }`, è `disabled` come le cron spente di
  proposito; **senza** quella riga resta un allarme, col testo che dice cosa è successo — perché da
  AWS «l'ho spenta io» e «l'ha spenta un apply per sbaglio» hanno la stessa faccia, e un CDN di
  produzione che si spegne è la cosa per cui esiste un watchdog. Stessa logica dello schedule
  EventBridge `DISABLED`, che le Lambda leggono dallo state Terraform: l'intento va dichiarato.
- **Stati AWS in italiano anche fuori da RDS ed EC2.** `ACTIVE`, `InProgress`, `UPDATING` uscivano
  grezzi da ALB, DynamoDB, EKS, Kinesis, CloudFront ed ElastiCache — una parola inglese in mezzo a una
  frase italiana, e in una notifica è l'unica parola che conta. Mappa unica (`awsState`), codice non
  mappato lasciato grezzo invece di perso.
- **«3 allarme/i attivo/i»** usa la forma plurale che esisteva già: `3 allarmi attivi`, `1 allarme
  attivo`. Ed `m.targets` era dichiarata due volte per lingua.
- **Navigazione riorganizzata, e una pagina nuova che risponde alla domanda che si fa per prima.**
  Le nove voci nell'header erano in ordine di arrivo e senza gerarchia — «Free Tier» pesava come
  «Dashboard» — e la barra era satura: le due viste nuove (WAF e budget) hanno dovuto entrare dentro
  pagine esistenti perché una decima voce non ci stava. Il problema non era lo spazio, era che non
  c'era un posto **dove** metterle.

  Ora c'è una **sidebar in quattro gruppi**, e i gruppi sono le domande che si fanno qui: *cosa gira ·
  cosa è uscito · quanto costa · chi può fare cosa*. Due fusioni, entrambe di viste che rispondevano
  alla stessa domanda in due posti:
  - **Spesa** = Costi + Sprechi. La spesa vera di Cost Explorer e la stima a listino di quello che
    stiamo buttando sono due misure della stessa cosa; come voci separate, chi cercava «quanto
    buttiamo» apriva Costi.
  - **Limiti** = Quote + Free Tier. Due muri diversi (le quote bloccano, il free tier fa pagare) con
    lo stesso significato operativo: quanto manca prima che qualcosa si rompa o inizi a costare. Come
    due voci separate non si guardava mai nessuna delle due.

  I percorsi di prima continuano a funzionare: `/costi`, `/sprechi`, `/quote` e `/freetier`
  reindirizzano alla scheda giusta, e la scheda sta nell'URL (un link a «Sprechi» porta sugli
  sprechi). Una riorganizzazione che rompe i segnalibri fa sembrare rotta l'applicazione.

  La flotta si è spostata su `/servizi` e la home è **«Adesso»**: raccoglie da tutte le fonti solo ciò
  che è cambiato nella finestra (24h/72h/7g) o che morde in questo momento — servizi giù, build
  fallite, hotfix fuori dalla CI, riavvii a mano, richieste fermate dal WAF, budget sforati, anomalie
  di costo — e ogni riga porta alla pagina che ne sa di più. Prima quella domanda attraversava quattro
  viste, da aprire a memoria.

  Cosa **non** compare, di proposito: i rilasci automatici riusciti. Un elenco che contiene anche la
  normalità non si legge — le tre righe che contano scorrerebbero via in mezzo a quelle verdi. E
  «niente da segnalare» è un esito scritto per intero, con quante cose sono state guardate: una pagina
  vuota si legge come rotta.

  Sotto: i colori di stato stanno in un file di token (`web/theme.js`) invece di essere ripetuti a mano
  in una dozzina di file. Il rischio non era la ripetizione, era che due pagine divergessero senza che
  nessuno se ne accorgesse — e allora lo stesso stato si legge di due colori diversi in due punti,
  cioè il colore smette di essere un segnale.

### Added
- **I deploy fatti A MANO si vedono, e si vede chi li ha fatti.** La pagina Deploy elencava le build
  dei progetti `*-deploy`: va bene per il rilascio normale, ma lasciava fuori per costruzione l'azione
  più intenzionale che esista — `ecs update-service --force-new-deployment` su un servizio incastrato.
  Quella non costruisce niente, quindi non c'era nessuna build da elencare, e la pagina restava muta:
  chi guardava concludeva che nessuno avesse toccato la produzione.

  Ora i riavvii forzati sono righe come le altre (`stessa immagine, nessuna build`, con chi l'ha
  forzato e da quale cluster), e ci sono anche quelli **respinti** — un riavvio negato per permessi
  spiega perché il servizio è ancora fermo, ed era invisibile due volte.

  Le build lanciate fuori dalla CI, poi, non sono più «manuale» come qualunque build partita da
  console: un **hotfix** ha la sua etichetta rossa e, nel dettaglio, la riga che dice cosa significa
  davvero — nessun test e nessun dependency-audit hanno visto quel codice. E **chi ha premuto** non è
  chi la pagina mostrava: `author` viene dalla variabile `DEPLOYER`, che è l'autore del *commit*; su
  un hotfix la persona che ha forzato il rilascio è un'altra, e adesso ci sono entrambe.

  Fonte: CloudTrail `LookupEvents` (event history, ~90 giorni, nessun trail da creare) — il permesso
  era già concesso al ruolo readonly. Un `UpdateService` che porta una `taskDefinition` **non** conta
  come riavvio: è il passo finale di una build, e contarlo avrebbe fatto sembrare doppi tutti i
  rilasci normali. I riavvii restano fuori dal tasso di successo e dal trend: un riavvio riuscito non
  dice niente sull'affidabilità dei rilasci, e sommarlo avrebbe fatto sembrare più sano proprio il
  servizio che si sta riavviando per tenerlo in piedi.

- **WAF Cloudflare: quanto traffico il firewall ha fermato, per zona e per regola** (pagina Sicurezza).
  È il buco più silenzioso che ci fosse: una richiesta bloccata dal WAF non compare in nessun log
  applicativo, non muove nessuna metrica ECS e non produce nessun errore da guardare — il servizio è
  verde e l'utente semplicemente non è mai arrivato.
  Le richieste **fermate** e quelle **osservate** (`log`) sono due totali separati, e non si sommano:
  mettere una regola in `log` non impedisce a un'altra di bloccare la stessa richiesta, e chi legge un
  totale unico conclude di aver disinnescato il problema mentre il traffico continua a cadere.
  Ogni regola dice **dove si aggiusta** (regola nostra in IaC · managed WAF di Cloudflare · rate limit:
  tre posti diversi) e i **percorsi** colpiti, che sono ciò che distingue un blocco giusto da uno
  sbagliato. L'ordine è per richieste fermate, non per volume: una regola con un milione di `log` non è
  un problema, una che ferma dodici richieste su `/checkout` lo è.

- **Budget AWS e anomalie di costo** (pagina Costi, in cima). La pagina diceva quanto stai spendendo,
  non se quella cifra è dentro a quello che avevi deciso: quel numero viveva nei budget AWS, che
  avvisano su Slack e poi non compaiono da nessuna parte.
  Di ogni budget si mostrano **consumo e proiezione**, che sono due domande diverse — «sono già
  fuori?» e «ci finirò fuori?». Un budget al 65% con la proiezione al 123% è il momento in cui c'è
  ancora tempo per intervenire, ed è invisibile se mostri solo la prima cifra: per questo lo
  sforamento *previsto* pesa come quello già avvenuto.
  Le **anomalie** sono l'altra metà: gli scostamenti che AWS rileva rispetto al proprio modello di
  spesa (un cron che gira cento volte invece di una si vede lì prima che si veda in bolletta), con
  impatto in valuta e causa principale. Sotto un dollaro non si mostrano: sono centesimi su servizi
  minuscoli, e allenare a ignorare una sezione è l'unico modo di renderla inutile.

- **La demo mostra anche gli Sprechi.** Rispondevano `{}` e la pagina diceva «nessun account con
  risorse»: come voce di menu a sé passava per una flotta pulita, ma da scheda accanto ai Costi chi
  apre la demo ci clicca — e una scheda vuota nella vitrina si legge come rotta.

### Fixed
- **Pagina Deploy: i filtri filtrano davvero, e l'autore non è più scritto due volte.** Tre difetti
  che insieme facevano concludere «i filtri non funzionano», che è la conclusione peggiore: chi legge
  smette di fidarsi anche di quello che la pagina mostra bene.
  1. Il filtro **Account** della barra in alto era dichiarato per questa pagina ma non le arrivava
     mai: selezionavi *Production* e restavano tutti e cinque gli account. Ora la pagina filtra sulla
     chiave dell'account, la stessa che usa `/api/deploys`.
  2. La barra offriva anche **Regione**, che qui non filtra niente perché una build di deploy non ha
     regione. Tolto — come già fatto sulla pagina Costi: un filtro inerte insegna a diffidare di
     tutti gli altri.
  3. I **numeroni in cima e le pillole per account** contavano sempre l'intera flotta: mettevi
     *Falliti*, l'elenco si restringeva ma sopra restava `ok 109`. Ora contano le build visibili, e
     l'elenco dei servizi selezionabili si limita agli account visibili (prima offriva servizi di
     account nascosti, e sceglierli svuotava la pagina senza spiegare perché).

  Sulle righe **Cloudflare** l'autore compariva due volte: una nell'intestazione come `da matteo` e
  una nella riga sotto per email, perché quello spazio — dove per AWS c'è la durata — veniva riempito
  con l'autore. Resta l'intestazione; l'email intera è nel dettaglio della build.

  E chi committa con la noreply di GitHub non è più un numero di serie:
  `81815192+matte97p@users.noreply.github.com` era mostrato come `81815192+matte97p`, ora è
  `matte97p` (il valore grezzo nel tooltip). La regola è il gemello client di `shortActor`, con un
  test che confronta i due: se divergono, la stessa persona comparirebbe con due nomi in due punti
  della UI.

### Added
- **Salute dei target dietro il load balancer, sui servizi ECS** — e con questo i microservizi
  **interni** hanno finalmente un segnale di liveness. La diagnosi precedente era sbagliata: non
  aspettavano un cutover di DNS, sono interni **per costruzione** (dietro un ALB interno, un target
  group a testa), quindi una sonda HTTP da fuori non li raggiungerà mai — né adesso né dopo. Il segnale
  giusto non passa dalla rete ma dall'API: `DescribeTargetHealth` dice se il load balancer li considera
  sani *da dentro*.
  Vale anche per i servizi pubblici, perché dice una cosa che «task attivi» **non** dice: un servizio
  può avere 2/2 container su e **0/2 target sani** — health check che falliscono, porta sbagliata,
  draining — e allora il load balancer non gli manda traffico, cioè per chi lo usa è **giù**, mentre il
  conteggio dei task lo mostrava verde. Ora quel caso è rosso.
  Durante un deploy il segnale **non** giudica: i target vecchi vanno in draining e i nuovi si
  registrano, e metà non sani lì è normale — un rosso a ogni rilascio insegnerebbe solo a ignorarlo.
  La regola è una funzione pura con sei test, perché è quella che decide se una card è rossa.

### Added
- **Mappa alias delle persone (`people:` in config)** — il tag `deployedBy` è l'email dell'autore del
  commit, e la stessa persona può committare con più identità git: il pannello mostrava
  `ggiacometti` su un deploy e `giovanni1.giacometti` su un altro, e chi guarda conclude che sono due
  colleghi. Una riga per alias, chiave = identità grezza (o la sua forma accorciata, senza distinzione
  di maiuscole), valore = nome da mostrare.
  **Non** è dedotta dai nomi somiglianti, e non lo sarà: quando un'euristica del genere sbaglia,
  attribuisce un deploy in produzione a qualcun altro — e qui dentro esistono davvero persone con nomi
  simili. Senza mappa il comportamento è quello di prima.

### Added
- **Un account che non si riesce a leggere lo dice in pagina** — il server riportava già le letture
  fallite (`discoveryProblems`, aggiunte stamattina) ma finivano solo nei log: sul pannello quell'account
  sembrava semplicemente **vuoto**, e «non c'è niente» è l'opposto di «non sono riuscito a guardare».
  Ora un avviso in cima elenca account, regione, quali letture sono fallite e perché. **Non è
  chiudibile**: un avviso che si può far sparire, su un dato che manca, torna a essere una bugia comoda.
  In modalità demo c'è un account illeggibile di esempio, così il caso si vede senza doverlo provocare.

### Added
- **Traccia delle chiamate AWS (`DADAGUARD_TRACE=1`)** — conta chiamate e tempo per servizio AWS,
  agganciandosi al gestore HTTP, così vede **tutte** le chiamate (AssumeRole e retry compresi) senza
  strumentare un modulo alla volta. Nata perché due volte ho stimato a occhio dove andasse il tempo e
  mi sono sbagliato: le metriche CloudWatch erano già unite in batch, e il costo vero stava altrove.
  Spenta per default.

### Changed
- **Molte meno chiamate AWS per la stessa risposta.** Misurato sui 4 account veri, con la traccia:

| | prima | dopo |
|---|---|---|
| state Terraform (S3) | 69 chiamate · 7,4s | 0 (in cache 10 min) |
| ECS | 48 chiamate · 5,7s | **3** · 0,3s |
| load balancer | 22 chiamate · 1,5s | 0 (in cache 10 min) |
| check `version` | 8,9s | **0,6s** |
| giro completo forzato | 4,25s | **3,6s** |

  Le tre cose che lo permettono, in ordine di guadagno:
  - **lo state Terraform si rilegge ogni 10 minuti, non a ogni richiesta**: si elenca il bucket e si
    scarica ogni `.tfstate` (uno per layer, decine per ambiente) — era il costo più alto di tutti, più
    di ECS. Cambia solo quando qualcuno fa `apply`, che dura minuti;
  - **`DescribeServices` era chiamata due volte per servizio ECS**, una dal check `runtime` e una da
    `version`, che girano in parallelo sullo stesso servizio con la stessa richiesta. Ora la promessa
    è condivisa: una sola chiamata;
  - **una task definition, dato l'ARN, è immutabile** — rileggerla non può dare un risultato diverso,
    quindi tenerla in cache non è un compromesso. Un deploy registra una revisione nuova, cioè una
    chiave nuova: si invalida da sé. Idem per il DNS dei load balancer.
- **L'indice dei nomi dei secret in cache 5 minuti** (36 chiamate paginate, ~1,7s per risposta): i nomi
  cambiano quando qualcuno aggiunge un parametro, cioè settimane. ⚠️ È l'unica delle quattro modifiche
  **non** misurata contro AWS: il token SSO è scaduto a metà sessione. Il pattern è identico a quello
  dello state e i test coprono il comportamento della cache.

### Changed
- **Le notifiche parlano la grammatica di casa** — il formato inventava un terzo dialetto rispetto a
  quello che il team legge già in `#aws-deploy` (notifiche di deploy) e `#aws-cron-test` (esiti dei
  cron), costringendo a imparare due convenzioni per la stessa cosa. Allineate una per una: emoji come
  **shortcode** Slack (`:red_circle:`, `:warning:`, `:white_check_mark:`) e non unicode, nome del
  servizio in **backtick** e non in grassetto, ambiente in **MAIUSCOLO tra parentesi quadre**
  (`[PROD]`, `[STAGING]`) e non minuscolo tra tonde, esito **a parole** e non con la freccia
  `→ *STATO*`, dettaglio sulla **stessa riga** dopo `—` e non in una citazione a capo, fatti separati
  da `·`. Il link finale usa l'etichetta dei messaggi di deploy — «stato su Dadaguard» — che già
  rimandano allo stesso posto: chi li legge riconosce la porta.

```
<!channel> :red_circle: `refresh-bi-mvs` [PROD] GIÙ · esecuzione — mai partito: nessuna esecuzione…
:warning: `backend` [STAGING] ATTENZIONE · non risponde — HTTP 503
:white_check_mark: `frontend` [STAGING] tornato OK · <…|stato su Dadaguard>
```

### Changed
- **Le pagine non aspettano più un giro completo di controlli** — ogni apertura rifaceva da zero i 52
  servizi × 8 segnali su 4 account: **5,8s**, ogni volta, anche con due schede aperte, anche per due
  persone insieme, anche solo tornando sulla scheda (c'è un refresh al focus). Ora lo stato ha una cache
  di **30 secondi**: la prima apertura paga il giro, le successive rispondono in **4 millisecondi**.
  I dati guardano finestre di 24 ore, quindi 30 secondi di età non cambiano una diagnosi — e l'età è
  scritta in pagina («ultimo fetch»), che è la differenza tra una cache e una bugia. È lo stesso
  mestiere che `/metrics` fa da tempo. Il bottone **«Aggiorna» salta la cache** (`?fresh=1`): un
  aggiornamento che restituisce la risposta di prima non è un aggiornamento.
- **Concorrenza dei controlli da 8 a 16** — il lavoro è attesa di rete, non calcolo. Misurato sui 52
  servizi veri: 8 → 5,8s · 16 → 4,9s · 24 → 4,4s · 32 → 5,4s (peggiora), senza un solo throttle. Si
  resta a 16 e non a 24 perché la misura è su un portatile, mentre il task Fargate ha una frazione di
  vCPU: là il collo di bottiglia si sposta prima sulla CPU. Alzabile con `DADAGUARD_CONCURRENCY`.

### Added
- **Dadaguard misura quanto ci mette Dadaguard** — ogni risposta di `/api/status` logga il tempo
  totale, quello della risoluzione degli account e la somma per **tipo** di controllo, ordinata dal più
  costoso; e il tempo viaggia anche nel payload (`ms`). Serviva per ottimizzare senza indovinare — è
  così che si è visto che il costo sta in `runtime` (metriche CloudWatch, 17,8s di chiamate) e in
  `version` (CloudTrail, 9,5s), mentre gli altri sei segnali insieme non arrivano a mezzo secondo
  perché sono già precaricati per account. E resta utile: se un domani peggiora, si vede dove.

### Fixed
- **«Nessun account configurato» sulla pagina Costi, mentre i costi c'erano** — le pagine per-account
  filtrano sulle etichette degli account, e quella lista arriva da `/api/status`, che con decine di
  servizi da controllare risponde in **secondi**. Nel frattempo la lista era un insieme **vuoto**, e un
  filtro vuoto non lascia passare niente: la pagina scriveva che non c'erano account configurati mentre
  i dati dei costi erano già arrivati. Ora «non ho ancora la lista» (`null`) e «la lista esclude tutto»
  sono due cose distinte: nel primo caso non si filtra affatto.
  È lo stesso errore del resto della giornata — **assente e vuoto non sono la stessa cosa**, e
  confonderli fa affermare il falso con la faccia di chi sa.
- **Il vuoto della pagina Costi distingue i due casi** — «nessun account leggibile» e «il filtro attivo
  li nasconde tutti» dicevano la stessa frase, mandando a cercare un problema di configurazione che non
  esisteva.

### Fixed
- **La pagina saltava all'arrivo dello stato della flotta** — la barra dei filtri ha bisogno dei dati
  (le sue opzioni vengono da account e servizi), ma il suo **spazio** no: restava nascosta finché
  `/api/status` non rispondeva — e con 48 servizi da controllare sono **secondi** — poi compariva e
  spingeva giù l'intera pagina, facendo perdere il punto in cui si stava leggendo. Ora lo spazio è
  riservato da una sagoma con lo stesso numero di controlli e la stessa altezza. Vale su tutte le
  pagine, non solo sui Costi.
- **Il primo fotogramma della pagina Costi era vuoto** — `loading` partiva da `false` mentre al mount
  una richiesta parte **sempre**: si dipingeva un fotogramma senza né scheletro né dati prima che
  l'effetto la facesse partire.

### Added
- **`org.selfUsesRole`** — nell'account che ospita Dadaguard si può assumere il ruolo read-only come
  per tutti gli altri, invece di usare le credenziali del task. Serve quando lì il ruolo **esiste**:
  il task role resta minimo (sa solo fare `sts:AssumeRole`) e si riusa la stessa policy revisionata,
  invece di duplicare in-account tutti i permessi di lettura — che poi divergono alla prima modifica.
  Resta una **scelta** e non un automatismo: se il ruolo non c'è, il default continua a usare le
  credenziali dell'ambiente, perché tentare un AssumeRole verso un ruolo assente fallisce con un
  `AccessDenied` che sembra un problema di permessi mentre è la ricetta sbagliata.

### Fixed
- **La scoperta inghiottiva gli errori: un account che non si riesce a leggere sembrava un account
  vuoto** — ogni collettore aveva il suo `.catch(() => [])` **muto**, quindi permessi mancanti, un ruolo
  non assumibile o un throttling producevano «zero risorse e zero log». Per un monitor è il fallimento
  peggiore possibile: *non si distingue dal successo*. Trovato sul vero — dopo aver acceso la scoperta
  via Organizations, l'account Security compariva con zero servizi mentre ne ha due; CloudTrail ha
  mostrato che Dadaguard non tentava nemmeno di assumere il ruolo, e nei log non c'era una riga.
  Le API di elenco AWS **non** danno errore quando non c'è nulla: restituiscono una lista vuota. Quindi
  un errore lì è sempre un problema reale. Ora ogni lettura fallita viene raccolta, loggata con account
  e regione, e riportata in `/api/status` (`discoveryProblems`) — così il pannello può dire «non ho
  potuto leggere questo account» invece di mostrarlo vuoto.

### Fixed
- **Accendere la scoperta degli account avrebbe spento i controlli di drift, in silenzio** — la fusione
  era `{...dichiarati, ...scoperti}`: l'account trovato via AWS Organizations **sostituiva in blocco**
  quello dichiarato a mano, e con lui sparivano `color` e soprattutto `terraform.stateBucket` — che è
  ciò che alimenta i segnali di **drift** e di **risorse non gestite**. Quei due check avrebbero smesso
  di funzionare senza un errore, nel momento esatto in cui si abilitava `org`: il tipo di guasto che si
  scopre settimane dopo, quando serve. Ora la fusione è **campo per campo** e vince il dichiarato
  (è intento umano); lo scoperto riempie solo ciò che manca, e gli account che nessuno ha dichiarato
  entrano così come sono.

### Added
- **Filtro «Livello» sui costi, come su Analytics** — la Cost Category (`Livello`: compute, database,
  llms, deploy…) filtra **tutta** la pagina: riquadri, andamento 13 mesi e le ripartizioni. È il
  «TYPE» della pagina interna; l'«ENVIRONMENT» è il filtro Account che c'era già. Verificato che una
  Cost Category si legge **anche dagli account membri**, non solo dal payer — quindi non serve
  cambiare architettura per interrogarla.
- **Ripartizione «Per livello»**, gemella di «Per componente»: ogni livello si apre sul dettaglio per
  servizio AWS. Doppio scopo — è anche la fonte dei valori del menu, così sapere quali livelli
  esistono non costa una chiamata in più (un elenco scritto a mano andrebbe stantio al primo livello
  nuovo: la tassonomia di la nostra flotta è stata rivista di recente).
- **Scheletri di caricamento** — la pagina mostrava uno spinner al centro e poi *saltava* di 600px
  quando i dati atterravano, e le tre sezioni nuove non avevano alcuno stato di attesa: comparivano di
  colpo spostando quello che stavi leggendo. Ora ogni sezione riserva la sua forma (compreso lo spazio
  esatto del grafico), e al cambio mese i dati vecchi restano visibili invece di lasciare un vuoto.
  Stesso schema già usato in Deploy.

### Fixed
- **La costruzione del filtro Cost Explorer era sparsa in tre punti** — ora è una funzione sola, che
  sceglie la forma in base a quanti termini ci sono davvero: un `And` di **un** elemento è un errore di
  validazione, non un filtro più semplice.
- **In demo il filtro Livello agisce davvero** sui dati finti: un menu che non fa niente insegna che
  il menu non serve.

### Fixed
- **Abilitando la scoperta degli account, il payer finiva in errore** — `buildOrgAccounts` costruiva un
  `roleArn` per **ogni** membro dell'organizzazione, compreso l'account in cui Dadaguard **gira**: verso
  se stessi non c'è alcun ruolo da assumere, e il tentativo falliva con un `AccessDenied` che sembra un
  problema di permessi mentre è solo la ricetta sbagliata. Ed è l'account peggiore da perdere: è il
  payer, dove vive la spesa di Bedrock, Marketplace e CodeBuild. Ora Dadaguard riconosce il proprio
  account (`sts:GetCallerIdentity`, gratis e senza permessi) e lo marca `inAccount`. Se l'identità non
  si ottiene, il comportamento resta quello di prima.

### Fixed
- **Un account con spesa e ZERO servizi monitorati spariva dalle pagine per-account** — le etichette
  degli account si ricavavano dai **servizi**, quindi l'account che non ne aveva nemmeno uno non
  compariva né nel filtro né in Costi/Sprechi/Quote. È esattamente il caso del **payer**, dove vivono
  Bedrock, Marketplace e CodeBuild: la sua spesa non si vedeva, e chi guardava concludeva «non costa
  niente» invece di «non lo sto guardando» — il modo peggiore di sbagliare per un pannello.
  Ora `/api/status` espone gli **account risolti** (con `queryable`, che dice quali si possono
  davvero leggere) e le liste partono da lì.
- **Il filtro «Regione» sulla pagina Costi non filtrava i costi: faceva sparire l'account** — Cost
  Explorer è globale e la query non raggruppa per regione, quindi quel filtro agiva solo sulla lista
  degli account (per la regione dei loro *servizi*). Rimosso da quella pagina: resta dove le risorse
  hanno davvero una regione (Sprechi, Quote, Topologia).

### Added
- **`inAccount: true` in config** — dichiara l'account in cui Dadaguard **stesso** gira, che usa le
  credenziali dell'ambiente (in cloud il task role) invece di assumere un ruolo. Prima un account senza
  `profile` né `roleArn` veniva semplicemente saltato, quindi il payer non era interrogabile: ma
  «nessuna credenziale» e «le credenziali di qui» sono due cose diverse, e indovinare significherebbe
  leggere l'account sbagliato riportandolo sotto un altro nome. Va sempre accompagnato da `accountId`:
  sul payer, senza filtro, Cost Explorer risponde coi costi di **tutta** l'organizzazione.

### Added
- **Andamento dei costi su 13 mesi: consumo a listino contro fatturato** — la pagina rispondeva a
  «quanto», mai a «sta crescendo?», che è l'unica delle due che fa agire. Due serie sullo stesso asse
  (sono entrambe dollari), scala che parte da zero, e il mese in corso **tratteggiato** — senza quel
  tratteggio l'ultimo punto si legge come un crollo, quando è solo un mese incompleto. Una sola
  chiamata a Cost Explorer copre tutti i mesi, e non dipende dal mese selezionato: cambiare mese non
  la rifà. Colori scelti col validatore del design system (passano in chiaro e in scuro, incluse le
  simulazioni di daltonismo) e mai unico segnale: legenda, valori scritti sull'ultimo punto, e la
  tabella dei numeri sotto per chi non ha un puntatore.
- **AI separata dall'infrastruttura** — Bedrock e AWS Marketplace (i modelli Claude, che NON passano da
  Bedrock in fattura) hanno un riquadro proprio e un interruttore «senza AI» sul grafico. Con i modelli
  che valgono la maggior parte del conto, un totale unico nasconde l'andamento dell'infrastruttura:
  sale l'uso dei modelli e sembra che sia cresciuto tutto.
- **Costi per componente** — dal tag di allocazione costi (`component`, sovrascrivibile con
  `DADAGUARD_COMPONENT_TAG`): il servizio AWS dice *cosa* costa, il tag dice *di chi è*, ed è il secondo
  a far decidere. Ogni voce si apre sul dettaglio per servizio. Il **non taggato** resta in elenco:
  nasconderlo farebbe sembrare completa un'attribuzione che non lo è.
- **Cache di un'ora sulle risposte di Cost Explorer** — si paga a chiamata (~$0.01) e il dato si
  aggiorna poche volte al giorno: senza cache ogni apertura della pagina rifaceva una chiamata **per
  account**. Le richieste concorrenti condividono la stessa promessa, e un errore non resta in cache
  (altrimenti un `AccessDenied` momentaneo diventava un'ora di pagina rotta).

### Fixed
- **Il nome del tag dei componenti era in minuscolo, e sarebbe stato muto** — in Cost Explorer le
  chiavi dei tag sono **case-sensitive** e sbagliare la maiuscola non dà errore: dà *tutto non
  taggato*. Il tag attivo da noi è `Component` (verificato con
  `aws ce list-cost-allocation-tags --status Active`). E se la risposta torna comunque tutta non
  taggata, ora la pagina lo **dice** — col nome del tag cercato e il comando per controllare — invece
  di mostrare una riga sola e far credere che quella sia l'attribuzione vera.
- **Le tasse finivano dentro il consumo per servizio** — nell'aggregazione ogni `RECORD_TYPE` che non
  fosse credito o rimborso veniva sommato al servizio, tasse incluse: il consumo risultava gonfiato e
  il netto sbagliato. Ora sono tre voci distinte — consumo a listino, tasse (addebitate **sopra**),
  crediti (registrazioni **negative**) — e il totale è la loro somma. Con le tasse a zero non si
  vedeva; restava un errore.

### Changed
- **Log ed eventi non coprono più il servizio che stai guardando** — erano due drawer che si aprivano
  SOPRA il pannello del servizio: il contesto («di chi sono questi log?») finiva sotto, e chiudendone
  uno riappariva l'altro. Ora c'è **una superficie sola per servizio**, larga come serve ai log
  (760px), con le schede *Panoramica · Log · Eventi*. Le icone in tabella e nelle card aprono il
  pannello direttamente sulla scheda giusta. Le schede si montano alla prima apertura, quindi la
  chiamata resta on-demand: aprire un servizio non scarica i suoi log. Con una scheda sola la barra
  non compare (non è una scelta: è decorazione).
- **Le schede appaiono solo dove hanno qualcosa da dire** — «Log» solo dove esiste un log group da
  leggere (lambda, ECS, ECS schedulato), «Eventi» solo dove AWS li racconta (non per un worker
  Cloudflare, che non sta in CloudTrail). Una scheda che si apre su «questo tipo non ha log» la
  clicchi una volta, poi non credi più al pannello.

### Removed
- **Il bottone «Costi» dal pannello del servizio** — portava alla pagina Costi **senza alcun filtro**,
  e quella pagina ragiona per servizio **AWS** (EC2, S3, Bedrock), non per servizio monitorato: da lì
  non esisteva modo di vedere quanto costa *quel* servizio. Per un worker Cloudflare portava perfino
  nel provider sbagliato. Un bottone che promette e non mantiene è peggio di un bottone che non c'è.
- **«Deploy» invece resta, ma ora mantiene**: apre la pagina Deploy **già filtrata** su quel servizio
  (`?service=…`, che la pagina legge all'avvio) e appare **solo** dove esiste davvero una build da
  mostrare — su un bucket o un cluster la pagina Deploy non avrebbe nulla da dire.

### Changed
- **Tutta la riga apre il servizio** — il bersaglio era il solo nome, alto 18px su una riga alta 32: su
  una tabella densa il bersaglio grande è metà del lavoro. Ora il clic vale su tutta la riga, senza
  rubare i gesti che vivono dentro di lei: link (endpoint, log, eventi, rimuovi), bottoni, freccia di
  espansione e l'intera colonna azioni restano loro. E se stai **selezionando del testo** il clic non
  apre niente: trascinare per copiare un nome finisce con un mouseup, che è un clic — aprire un
  pannello lì fa perdere la selezione appena fatta.
  Il nome del servizio è diventato un **controllo vero** (`role="button"`, raggiungibile col tab,
  Invio/Spazio, fuoco visibile): una `<tr>` non si mette a fuoco, quindi senza questo la tastiera
  avrebbe perso l'unico modo di aprire il pannello dalla tabella — che, a dirla tutta, non ce l'aveva
  nemmeno prima.

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
  che poteva essere spento. Verificato sul vero: `GET dadaguard.example.com` → `302` →
  `example.cloudflareaccess.com/cdn-cgi/access/login/…` → `200`. Ora i redirect si **leggono** invece
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
  stata ritrovata in `/ecs/acme-staging/{backend,frontend}`. Restano fuori i tre microservizi di
  staging (rispondono da Railway: `x-railway-*`) e `app.example.com` (Vercel: `x-vercel-id`): là un
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
  da sé quando crashano (da noi lo fa `catocron`, col messaggio d'errore vero), ridirlo è duplicare, e
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
  `ScheduleExpressionTimezone` (i cron la nostra flotta usano `Europe/Rome`) e Dadaguard lo scartava, leggendo
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
  «famiglia» era metà del gruppo: sull'account Staging reale (21 servizi non Bedrock) `acme-staging-`
  copre 12 nomi e `acme-staging-cron-` 9, entrambi sotto 13 → nessuna compattazione. Ora la soglia è
  un terzo del gruppo e i Bedrock, che hanno il loro nome parlante, escono dal conteggio invece di
  alzare l'asticella per tutti.

## [0.4.45] — 2026-07-27

### Changed
- **Card dei servizi ridisegnate** — con 25 servizi a schermo (flotte di cron) la card andava in
  crisi: nomi lunghi a capo su 4 righe perché il titolo era strozzato dai badge, un segnale sparso su
  3-4 righe, etichette disallineate da card a card e buchi a zig-zag tra le colonne. Ora: il nome sta
  su una riga (testa comune del gruppo — `acme-staging-cron-` — piccola e muta, coda in evidenza,
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
