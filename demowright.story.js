// Il video demo di Dadaguard: uno SCRIPT, non un file .mp4 che invecchia in un cassetto.
//
// Perché sta qui: il video girato a giugno mostrava una dashboard che non esiste più. Da allora la
// navigazione è diventata quattro gruppi con la home «Adesso», e sono nate Deploy, Spesa, Limiti,
// Sicurezza e Topologia — il video continuava a girare, e raccontava un prodotto sbagliato. Un video
// che vive nel repo si ri-registra con un comando: `demowright` pilota il browser sui dati della
// MODALITÀ DEMO (zero AWS, zero credenziali) e cuce caption, cursore e zoom dentro i frame.
//
// Registrare (server demo su :3001, poi un comando per lingua):
//   npm run build && DADAGUARD_DEMO=1 PORT=3001 node server/index.js
//   npx @matte97p/demowright run demowright.config.js    -o assets/demo.mp4      # EN, landscape
//   npx @matte97p/demowright run demowright.config.it.js -o output/demo-it.mp4   # IT, +verticale
// Con due formati i nomi li decide demowright: `output/demo-it.landscape.mp4` e `.vertical.mp4`.
// L'inglese va in `assets/` perché è l'asset del README; l'italiano in `output/`, che è gitignorato:
// serve per i social e si rigenera, e tre mp4 da 10 MB per rilascio resterebbero in cronologia git
// per sempre.
//
// La GIF del README è un ESTRATTO dei primi 29 secondi (l'aggancio + «Adesso» + il servizio su ma
// non coerente), non il tour intero: a 80s pesava 11 MB. Si rifà così, con l'ffmpeg che demowright
// si porta dietro (`node_modules/ffmpeg-static/ffmpeg`), e sta sotto i 6 MB:
//   ffmpeg -ss 0 -t 29 -i assets/demo.mp4 -vf "fps=8,scale=700:-1:flags=lanczos,split[a][b];\
//     [a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" -y assets/demo.gif
//
// Due lingue perché la UI segue il locale del browser: il README parla a chi arriva da GitHub
// (inglese), il verticale serve per LinkedIn (italiano). Stessa storia, stessi selettori, una fonte.
//
// ⚠️ I selettori di `zoom`/`highlight` si risolvono con `document.querySelector` DENTRO la pagina:
// solo CSS. Niente testo (è tradotto) e niente `nth-child` (cambia al primo riordino) → si agganciano
// alle ancore `data-view`/`data-signal`/`data-build`/`data-service` (vedi `web/pages/pageKit.jsx`).
// Un selettore mancante non ferma `zoom`/`highlight` ma ferma `wait`/`click`: se il video si rompe,
// si rompe su una navigazione, non su un'inquadratura vuota.

// Voce della sidebar: la chiave del menu antd è il percorso, quindi l'ancora è il percorso stesso.
const nav = (route) => `[data-menu-id$="-${route}"]`

// Camera più svelta dei default (750ms per lo zoom, 600 per il ritorno): in un tour ci sono nove
// inquadrature, e un terzo di secondo a testa fa tre secondi di movimento che non dicono niente. Uno
// step che porta la sua `duration` la tiene: il default riempie solo dove non è scritto.
const camera = (s) =>
  s.type === 'zoom' ? { duration: 520, ...s } : s.type === 'zoomReset' ? { duration: 420, ...s } : s

export function story(lang = 'en') {
  const en = lang !== 'it'
  const say = (inEnglish, inItaliano) => (en ? inEnglish : inItaliano)

  return {
    name: en ? 'dadaguard' : 'dadaguard-it',
    url: 'http://localhost:3001',
    // La UI di Dadaguard si traduce dal locale del context: qui si decide la lingua del prodotto,
    // non solo quella delle caption.
    locale: en ? 'en-US' : 'it-IT',
    // 1280×720: è esattamente la misura in cui esce il formato landscape, quindi nessun
    // ridimensionamento e testo nitido anche nella GIF del README. Ci si può stare perché il capitolo
    // Servizi passa alle card: la TABELLA a 1280 taglierebbe la colonna Build (dove sta `v1.9.0 ·
    // atteso v2.0.0`) e per rimediare servirebbero 1600px, cioè scalare tutto il video a 0,8×.
    // Come effetto collaterale, a 1280 la griglia dei pannelli mette le anomalie di costo a capo a
    // sinistra invece che a filo destro — e un elemento a filo destro non si può zoomare: l'origine
    // dello zoom è il suo centro, quindi ingrandendo esce dallo schermo.
    viewport: { width: 1280, height: 720 },
    theme: { accent: '#7c3aed' },
    steps: [
      // ── Adesso: la domanda che viene prima di tutte ──────────────────────────────────────────
      { type: 'wait', selector: '[data-signal]' },
      {
        type: 'caption',
        text: say('A 200 OK only tells you the endpoint answers.', 'Un 200 OK ti dice solo che l’endpoint risponde.'),
        duration: 2800,
      },
      {
        type: 'caption',
        text: say(
          'Dadaguard asks the harder question: is it up AND coherent?',
          'Dadaguard fa la domanda difficile: è su E coerente?',
        ),
        duration: 3200,
      },
      // Sul primo numero e non sulla banda: la banda è larga tutta la pagina, quindi il suo centro
      // — l'origine dello zoom — cade nel vuoto a destra, e i contatori finiscono fuori inquadratura.
      { type: 'zoom', selector: '[data-view="hero"] > span', scale: 1.5 },
      {
        type: 'caption',
        text: say('The home page is «Now»: what changed, and what bites right now.', 'La home è «Adesso»: cosa è cambiato e cosa morde ora.'),
        duration: 2800,
      },
      { type: 'zoomReset' },
      // Anello e non zoom: una riga è larga quanto la pagina, e lo zoom la ingrandisce attorno al
      // proprio centro — le estremità (il pallino a sinistra, l'orario a destra) finiscono fuori.
      // L'anello mette a fuoco senza tagliare niente, e a 1280 nativo la riga si legge già.
      { type: 'highlight', selector: '[data-signal="deploy"]', pad: 6 },
      {
        type: 'caption',
        text: say(
          'One feed from every source — services, deploys, budgets, firewall.',
          'Un feed da tutte le fonti — servizi, deploy, budget, firewall.',
        ),
        duration: 3200,
      },
      { type: 'highlightHide' },

      // ── Servizi: il giallo che nessun uptime monitor ti dà ───────────────────────────────────
      { type: 'click', selector: nav('/servizi') },
      { type: 'wait', selector: '[data-service="web"]' },
      { type: 'zoom', selector: '[data-view="summary"]', scale: 1.6 },
      {
        type: 'caption',
        text: say('Seventeen services: two down, seven to look at, one disabled.', 'Diciassette servizi: due giù, sette da guardare, uno spento.'),
        duration: 2800,
      },
      { type: 'zoomReset' },

      // Si passa alle card, e non è un vezzo: la tabella è larga 1465px, quindi la colonna Build —
      // dove sta il confronto fra versione che gira e versione attesa — vive oltre il bordo dello
      // schermo e nessuno zoom la riporta dentro (lo zoom scala, non scrolla). Nella card gli stessi
      // check stanno impilati in 322px: si leggono anche nella GIF del README.
      { type: 'click', selector: '[data-view="view-switch"] .ant-segmented-item:last-child' },
      { type: 'wait', selector: '.dg-card[data-service="web"]' },
      { type: 'scroll', selector: '.dg-card[data-service="web"]', duration: 500 },
      { type: 'zoom', selector: '.dg-card[data-service="web"]', scale: 1.8 },
      {
        type: 'caption',
        text: say(
          'This one answers 200 — and runs v1.9.0 where v2.0.0 was expected.',
          'Questo risponde 200 — e gira v1.9.0 dove era atteso v2.0.0.',
        ),
        duration: 3400,
      },
      {
        type: 'caption',
        text: say('Up, but not coherent. Elsewhere it is green.', 'Su, ma non coerente. Altrove è verde.'),
        duration: 2600,
      },
      { type: 'zoomReset' },
      { type: 'scroll', selector: '.dg-card[data-service="image-resizer"]', duration: 500 },
      { type: 'zoom', selector: '.dg-card[data-service="image-resizer"]', scale: 1.8 },
      {
        type: 'caption',
        text: say('This one is really down: errors spiking, and two alarms firing.', 'Questo è davvero giù: errori in salita e due allarmi attivi.'),
        duration: 2800,
      },
      { type: 'zoomReset' },

      { type: 'scroll', y: 0, duration: 400 },

      // ── Deploy: chi ha premuto, non chi ha scritto il commit ─────────────────────────────────
      { type: 'click', selector: nav('/deploy') },
      { type: 'wait', selector: '[data-build]' },
      {
        type: 'caption',
        text: say('What shipped, per account — and who pressed the button.', 'Cosa è uscito, per account — e chi ha premuto.'),
        duration: 2800,
      },
      { type: 'scroll', selector: '[data-build="billing-worker"]', duration: 500 },
      { type: 'highlight', selector: '[data-build="billing-worker"]', pad: 6 },
      {
        type: 'caption',
        text: say(
          'A restart forced outside CI, and refused. It produced no build, so no other view would say it.',
          'Un riavvio forzato fuori dalla CI, e respinto. Non ha prodotto build: nessun’altra vista lo direbbe.',
        ),
        duration: 4200,
      },
      { type: 'highlightHide' },

      { type: 'scroll', y: 0, duration: 400 },

      // ── Spesa: la spesa contro quella DECISA ─────────────────────────────────────────────────
      { type: 'click', selector: nav('/spesa') },
      { type: 'wait', selector: '[data-view="budget"]' },
      {
        type: 'caption',
        text: say('What it costs, against what you decided to spend.', 'Quanto costa, contro quanto avevi deciso di spendere.'),
        duration: 2800,
      },
      { type: 'scroll', selector: '[data-account="management"]', duration: 500 },
      { type: 'zoom', selector: '[data-account="management"]', scale: 1.45 },
      {
        type: 'caption',
        text: say(
          'The AI budget is at 104% — and the projection to month end says 269%.',
          'Il budget AI è al 104% — e la proiezione a fine mese dice 269%.',
        ),
        duration: 3600,
      },
      { type: 'zoomReset' },
      { type: 'scroll', selector: '[data-view="anomalies"]', duration: 500 },
      { type: 'zoom', selector: '[data-view="anomalies"]', scale: 1.45 },
      {
        type: 'caption',
        text: say('Plus the cost anomalies AWS already spotted — here before the bill.', 'Più le anomalie che AWS ha già rilevato — qui prima che in bolletta.'),
        duration: 3400,
      },
      { type: 'zoomReset' },

      { type: 'scroll', y: 0, duration: 400 },

      // ── Sicurezza: il traffico che non è mai arrivato ────────────────────────────────────────
      { type: 'click', selector: nav('/sicurezza') },
      { type: 'wait', selector: '[data-view="waf"]' },
      { type: 'zoom', selector: '[data-view="waf"]', scale: 1.5 },
      {
        type: 'caption',
        text: say(
          '1,743 requests the firewall stopped in 24h: traffic no application log ever saw.',
          '1.743 richieste che il firewall ha fermato in 24h: traffico che nessun log applicativo ha visto.',
        ),
        duration: 4000,
      },
      { type: 'zoomReset' },
      // Anello, non zoom: come le altre righe a piena larghezza (vedi il feed di «Adesso»). Prima si
      // porta la riga a metà pagina: i finding stanno sotto la card del WAF, cioè dove va la caption
      // — e una caption che copre l'anello che ha appena acceso è peggio di nessun anello.
      { type: 'scroll', selector: '[data-finding="public"]', duration: 500 },
      { type: 'highlight', selector: '[data-finding="public"]', pad: 6 },
      {
        type: 'caption',
        text: say(
          'Below it: public surface, expiring certificates, admin-wide IAM policies.',
          'Sotto: superficie pubblica, certificati che scadono, policy IAM da admin.',
        ),
        duration: 3400,
      },
      { type: 'highlightHide' },

      // ── Topologia: le dipendenze non le dichiara nessuno ─────────────────────────────────────
      { type: 'click', selector: nav('/topologia') },
      { type: 'wait', selector: '.react-flow__node' },
      {
        type: 'caption',
        text: say(
          'Dependencies are inferred from AWS — env vars, event sources, load balancers.',
          'Le dipendenze sono dedotte da AWS — variabili d’ambiente, event source, load balancer.',
        ),
        duration: 3600,
      },
      // Il grafo sta in fondo alla pagina: senza portarlo al centro, lo zoom (che apre attorno al
      // nodo) inquadra soprattutto la griglia vuota sopra le scatole.
      { type: 'scroll', selector: '[data-id="prod::image-resizer"]', duration: 500 },
      { type: 'zoom', selector: '[data-id="prod::image-resizer"]', scale: 2.2 },
      {
        type: 'caption',
        text: say('A red arrow means that dependency is down.', 'Una freccia rossa vuol dire che quella dipendenza è giù.'),
        duration: 2800,
      },
      { type: 'zoomReset' },

      {
        type: 'endcard',
        title: 'Dadaguard',
        subtitle: say(
          'coherence watchdog for AWS · read-only · no LLM · github.com/matte97p/dadaguard',
          'watchdog di coerenza per AWS · sola lettura · no LLM · github.com/matte97p/dadaguard',
        ),
        duration: 3000,
      },
    ].map(camera),
  }
}
