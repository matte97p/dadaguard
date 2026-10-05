// Il video demo di Dadaguard: uno SCRIPT, non un file .mp4 che invecchia in un cassetto.
//
// Perché sta qui: un video girato a mano racconta la UI del giorno in cui l'hai girato, e da lì in poi
// mente. Questo si ri-registra con un comando: `demowright` pilota il browser sui dati della MODALITÀ
// DEMO (zero AWS, zero credenziali) e cuce caption, cursore e zoom dentro i frame. Riscritto il
// 05/10/2026 per il nuovo design (#187, #188): home «Adesso» a semaforo, switch Sviluppo/DevOps,
// pannello del servizio con «da dove partire», palette ⌘K.
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
// La GIF del README è un ESTRATTO dei primi 30 secondi (l'aggancio, «Adesso», e `web` su ma non
// coerente), non il tour intero: a 90s peserebbe oltre 10 MB. Si rifà così, con l'ffmpeg che
// demowright si porta dietro (`node_modules/ffmpeg-static/ffmpeg`), e sta sotto i 6 MB:
//   ffmpeg -ss 0 -t 30 -i assets/demo.mp4 -vf "fps=8,scale=700:-1:flags=lanczos,split[a][b];\
//     [a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" -y assets/demo.gif
//
// Due lingue perché la UI segue il locale del browser: il README parla a chi arriva da GitHub
// (inglese), il verticale serve per LinkedIn (italiano). Stessa storia, stessi selettori, una fonte.
//
// ⚠️ I selettori di `zoom`/`highlight`/`click` si risolvono con `document.querySelector` DENTRO la
// pagina: solo CSS. Niente testo (è tradotto) e niente `nth-child` (cambia al primo riordino): ci si
// aggancia alle ancore `data-nav` (menu), `data-ruolo` e `data-view="cerca"` (barra in alto),
// `data-signal`/`data-service` (righe di «Da sistemare» e dei Servizi), `data-tab` (schede),
// `data-build` e `data-cron`, più le classi dei componenti di `web/ui/` (`.ui-verdetto`,
// `.ui-drawer`, `.ui-fix`, `.ui-cmd`, `.ui-lnk`, `.ui-pal`), che sono il design system e non cambiano
// a ogni pagina. Un selettore mancante non ferma `zoom`/`highlight` ma ferma `wait`/`click`: se il
// video si rompe, si rompe su una navigazione, non su un'inquadratura vuota.

const nav = (route) => `[data-nav="${route}"]`

// Camera più svelta dei default (750ms per lo zoom, 600 per il ritorno): in un tour ci sono molte
// inquadrature, e un terzo di secondo a testa fa secondi di movimento che non dicono niente. Uno step
// che porta la sua `duration` la tiene: il default riempie solo dove non è scritto.
const camera = (s) =>
  s.type === 'zoom' ? { duration: 520, ...s } : s.type === 'zoomReset' ? { duration: 420, ...s } : s

// Gira prima degli script della pagina, a ogni caricamento. Due cose:
//  · ruolo e tema fissi: il video parte da «Sviluppo» in chiaro qualunque cosa ricordi il browser;
//  · gli appunti: nel Chromium headless `navigator.clipboard.writeText` viene rifiutato (manca il
//    permesso), e il bottone direbbe «Selezionalo a mano» proprio nell'inquadratura che mostra che il
//    comando si copia. Qui si finge riuscito: il video non ha appunti da riempire.
const init = `
  try {
    if (!sessionStorage.getItem('dw-init')) {
      localStorage.setItem('dadaguard-ruolo', 'dev')
      localStorage.setItem('opsdash-dark', '0')
      sessionStorage.setItem('dw-init', '1')
    }
  } catch {}
  try { if (navigator.clipboard) navigator.clipboard.writeText = () => Promise.resolve() } catch {}
`

export function story(lang = 'en') {
  const en = lang !== 'it'
  const say = (inEnglish, inItaliano) => (en ? inEnglish : inItaliano)

  return {
    name: en ? 'dadaguard' : 'dadaguard-it',
    // Indirizzo sovrascrivibile: registrare non deve costringere a spegnere il server di sviluppo, che
    // di solito occupa proprio la 3001 (`DADAGUARD_DEMO_URL=http://localhost:3097`).
    url: process.env.DADAGUARD_DEMO_URL || 'http://localhost:3001',
    // La UI di Dadaguard si traduce dal locale del context: qui si decide la lingua del prodotto,
    // non solo quella delle caption.
    locale: en ? 'en-US' : 'it-IT',
    // 1366×768 e non 1280×720: a 1280 la barra in alto (cinque ambienti, Sviluppo/DevOps, ⌘K, la
    // freschezza dei dati) va a capo su due righe, e il video mostrerebbe un layout che a chi la usa
    // su un portatile non capita. demowright riscala a 1280×720 (stesso 16:9, fattore 0,94): il testo
    // resta leggibile anche nella GIF del README.
    viewport: { width: 1366, height: 768 },
    // Il marchio della UI è grafite, che sul fondo scuro della card finale sparirebbe: l'accento del
    // video (anello, clic, sottotitolo finale) è il blu «info» della UI, che non vuol dire uno stato.
    theme: { accent: '#2563c9' },
    init,
    steps: [
      // ── Adesso: la domanda che viene prima di tutte ──────────────────────────────────────────
      { type: 'wait', selector: '[data-signal]' },
      {
        type: 'caption',
        text: say('A 200 OK only tells you the endpoint answers.', 'Un 200 OK ti dice solo che l’endpoint risponde.'),
        duration: 2600,
      },
      {
        type: 'caption',
        text: say(
          'Dadaguard asks the harder question: is it up AND coherent?',
          'Dadaguard fa la domanda difficile: è su E coerente?',
        ),
        duration: 3000,
      },
      // Sul titolo e non sul blocco: il blocco è largo tutta la pagina, quindi il suo centro (l'origine
      // dello zoom) cade nel vuoto a destra e la frase esce dall'inquadratura.
      { type: 'zoom', selector: '.ui-verdetto h1', scale: 1.4 },
      {
        type: 'caption',
        text: say('The home page is «Now»: one sentence says whether to worry.', 'La home è «Adesso»: una frase ti dice se preoccuparti.'),
        duration: 2800,
      },
      { type: 'zoomReset' },
      // Anello e non zoom: una riga è larga quanto la pagina, e lo zoom la ingrandisce attorno al
      // proprio centro: le estremità (lo stato a sinistra, «Cosa fare» a destra) finirebbero fuori.
      { type: 'scroll', selector: '[data-service="image-resizer"]', duration: 800 },
      { type: 'highlight', selector: '[data-service="image-resizer"]', pad: 4 },
      {
        type: 'caption',
        text: say('Below it, what to fix: worst first, and every row says what to do.', 'Sotto, cosa sistemare: dal più grave, e ogni riga dice cosa fare.'),
        duration: 3000,
      },
      { type: 'highlightHide' },

      // ── Sviluppo / DevOps: la stessa flotta, due mestieri ────────────────────────────────────
      { type: 'click', selector: '[data-ruolo="ops"]' },
      {
        type: 'caption',
        text: say('Switch to DevOps: infrastructure, spend and access join the list.', 'Passa a DevOps: entrano infrastruttura, spesa e accessi.'),
        duration: 2800,
      },
      { type: 'scroll', selector: '[data-service="web"]', duration: 800 },
      { type: 'highlight', selector: '[data-service="web"]', pad: 4 },
      {
        type: 'caption',
        text: say('Like web. It answers 200, so an uptime monitor calls it green.', 'Come web. Risponde 200, quindi per un uptime monitor è verde.'),
        duration: 2800,
      },
      { type: 'highlightHide' },
      { type: 'click', selector: '[data-service="web"]' },
      { type: 'wait', selector: '.ui-drawer .ui-lista' },
      // Il primo `.ui-lista` del pannello è l'elenco dei controlli: online ok, versione e Terraform no.
      { type: 'highlight', selector: '.ui-drawer .ui-lista', pad: 4 },
      {
        type: 'caption',
        text: say(
          'But it runs v1.9.0 where v2.0.0 was expected, and AWS no longer matches Terraform.',
          'Ma gira v1.9.0 dove era atteso v2.0.0, e AWS non combacia più con Terraform.',
        ),
        duration: 3600,
      },
      {
        type: 'caption',
        text: say('Up, but not coherent. Here it turns orange.', 'Su, ma non coerente. Qui diventa arancio.'),
        duration: 2600,
      },
      { type: 'highlightHide' },
      { type: 'key', key: 'Escape' },

      // ── Un servizio rotto: da dove partire, il comando, i link ───────────────────────────────
      { type: 'scroll', selector: '[data-service="image-resizer"]', duration: 800 },
      { type: 'click', selector: '[data-service="image-resizer"]' },
      { type: 'wait', selector: '.ui-drawer .ui-fix' },
      { type: 'highlight', selector: '.ui-drawer .ui-fix', pad: 4 },
      {
        type: 'caption',
        text: say(
          'A broken one opens on where to start: a read-only command, ready to copy.',
          'Uno rotto si apre su da dove partire: un comando di sola lettura, pronto da copiare.',
        ),
        duration: 3400,
      },
      { type: 'click', selector: '.ui-drawer .ui-cmd button' },
      { type: 'wait', duration: 600 },
      { type: 'highlightHide' },
      { type: 'scroll', selector: '.ui-drawer .ui-lnk', duration: 800 },
      { type: 'highlight', selector: '.ui-drawer .ui-lnk', pad: 4 },
      {
        type: 'caption',
        text: say(
          'Then the consoles that know more, already filtered on this service.',
          'Poi le console che ne sanno di più, già filtrate su questo servizio.',
        ),
        duration: 3200,
      },
      { type: 'highlightHide' },
      { type: 'key', key: 'Escape' },
      { type: 'scroll', y: 0, duration: 400 },

      // ── Servizi: ogni controllo di ogni servizio ─────────────────────────────────────────────
      { type: 'click', selector: nav('/servizi') },
      { type: 'wait', selector: '[data-service="web"]' },
      { type: 'zoom', selector: '.ui-verdetto h1', scale: 1.4 },
      {
        type: 'caption',
        text: say('Services: seventeen, two broken, seven to look at.', 'Servizi: diciassette, due rotti, sette da guardare.'),
        duration: 2800,
      },
      { type: 'zoomReset' },
      { type: 'scroll', selector: '[data-service="web"]', duration: 800 },
      { type: 'highlight', selector: '[data-service="web"]', pad: 4 },
      {
        type: 'caption',
        text: say(
          'One row each, every check a dash: one orange is enough to say it is not green.',
          'Una riga a testa, ogni controllo un trattino: ne basta uno arancio per non essere verde.',
        ),
        duration: 3400,
      },
      { type: 'highlightHide' },
      { type: 'scroll', y: 0, duration: 400 },

      // ── Deploy: chi ha premuto, non chi ha scritto il commit ─────────────────────────────────
      { type: 'click', selector: nav('/deploy') },
      { type: 'wait', selector: '[data-build]' },
      {
        type: 'caption',
        text: say('Deploys: what shipped, per account, and who pressed the button.', 'Deploy: cosa è uscito, per account, e chi ha premuto.'),
        duration: 2800,
      },
      { type: 'scroll', selector: '[data-build="billing-worker"]', duration: 800 },
      { type: 'highlight', selector: '[data-build="billing-worker"]', pad: 4 },
      {
        type: 'caption',
        text: say(
          'A restart forced outside the CI, and refused. It made no build, so no other view would say it.',
          'Un riavvio forzato fuori dalla CI, e respinto. Non ha prodotto build: nessun’altra vista lo direbbe.',
        ),
        duration: 4000,
      },
      { type: 'highlightHide' },
      { type: 'scroll', y: 0, duration: 400 },

      // ── Cron: cosa gira adesso, e com'è finita ogni corsa ────────────────────────────────────
      { type: 'click', selector: nav('/cron') },
      { type: 'wait', selector: '[data-cron]' },
      { type: 'highlight', selector: '.ui-sezione', pad: 4 },
      {
        type: 'caption',
        text: say('Cron: what is running right now, against how long it usually takes.', 'Cron: cosa sta girando adesso, contro quanto ci mette di solito.'),
        duration: 3200,
      },
      { type: 'highlight', selector: '[data-cron="catalog-crawler"]', pad: 4 },
      {
        type: 'caption',
        text: say(
          'One block per run: green ended fine, red did not. Open a cron to read the logs of one single run.',
          'Un blocco per corsa: verde è finita bene, rosso no. Apri un cron e leggi i log di quella corsa.',
        ),
        duration: 3800,
      },
      { type: 'highlightHide' },

      // ── Spesa: la spesa contro quella DECISA ─────────────────────────────────────────────────
      { type: 'click', selector: nav('/spesa') },
      { type: 'wait', selector: '[data-tab="budget"]' },
      { type: 'zoom', selector: '.ui-verdetto h1', scale: 1.4 },
      {
        type: 'caption',
        text: say('Spend: what it costs so far, and where the month is heading.', 'Spesa: quanto costa finora, e dove sta andando il mese.'),
        duration: 2800,
      },
      { type: 'zoomReset' },
      { type: 'click', selector: '[data-tab="budget"]' },
      { type: 'wait', selector: '[data-tab="budget"][aria-selected="true"]' },
      { type: 'wait', selector: '.sp-col .ui-sezione .ui-row' },
      // La prima riga è il budget più a rischio: le righe sono ordinate da lì.
      { type: 'highlight', selector: '.sp-col .ui-sezione .ui-row', pad: 4 },
      {
        type: 'caption',
        text: say(
          'Against what you decided: the AI budget is at 104%, and the forecast says 269%.',
          'Contro quanto avevi deciso: il budget AI è al 104%, e la previsione dice 269%.',
        ),
        duration: 3600,
      },
      { type: 'highlightHide' },

      // ── ⌘K: un campo solo per saltare ovunque ────────────────────────────────────────────────
      { type: 'click', selector: '[data-view="cerca"]' },
      { type: 'wait', selector: '.ui-pal input' },
      { type: 'type', selector: '.ui-pal input', text: 'notif', perChar: 110 },
      {
        type: 'caption',
        text: say('⌘K jumps to any service or page.', '⌘K salta a qualunque servizio o pagina.'),
        duration: 2200,
      },
      { type: 'key', key: 'Enter' },
      { type: 'wait', selector: '.ui-drawer .ui-fix' },
      { type: 'highlight', selector: '.ui-drawer .ui-fix', pad: 4 },
      {
        type: 'caption',
        text: say(
          'notifier: a secret it needs does not exist. Dadaguard reads names, never values.',
          'notifier: manca un secret che gli serve. Dadaguard legge i nomi, mai i valori.',
        ),
        duration: 3600,
      },
      { type: 'highlightHide' },

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
