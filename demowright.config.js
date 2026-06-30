// Demo video di Dadaguard, registrato da demowright sui dati del DEMO MODE (zero AWS).
// Avvia il server in demo e registra:
//   DADAGUARD_DEMO=1 PORT=3001 node server/index.js
//   npx @matte97p/demowright run demowright.config.js -o assets/demo.mp4
// Vive nel repo: cambi la UI, ri-registri, il video è di nuovo attuale.
export default {
  name: 'dadaguard',
  url: 'http://localhost:3001',
  viewport: { width: 1280, height: 720 },
  theme: { accent: '#7c3aed' },
  formats: ['landscape'],
  steps: [
    { type: 'wait', selector: '.ant-card' },
    { type: 'caption', text: 'A 200 OK only tells you the endpoint answers.', duration: 2800 },
    { type: 'caption', text: 'Dadaguard asks a harder question: is it up AND coherent?', duration: 3200 },

    { type: 'zoom', selector: '[data-service="checkout-api"]', scale: 1.3 },
    { type: 'caption', text: 'Reachable, right build, tasks running, secrets present, matches Terraform — truly green.', duration: 3800 },
    { type: 'zoomReset' },

    { type: 'caption', text: 'But "green" elsewhere can hide trouble.', duration: 2600 },
    { type: 'zoom', selector: '[data-service="web"]', scale: 1.3 },
    { type: 'caption', text: 'Answers 200 — but runs v1.9.0 when v2.0.0 was expected, and memory drifted from Terraform.', duration: 4000 },
    { type: 'zoomReset' },

    { type: 'zoom', selector: '[data-service="image-resizer"]', scale: 1.3 },
    { type: 'caption', text: 'This one is down — with an alarm firing.', duration: 2600 },
    { type: 'zoomReset' },

    { type: 'zoom', selector: '[data-service="payments-worker"]', scale: 1.3 },
    { type: 'caption', text: 'Errors at 4.2%, p95 1.8s, an alarm on Errors.', duration: 2800 },
    { type: 'zoomReset' },

    { type: 'caption', text: 'Cost, waste, topology, quotas, account health — a click away.', duration: 2800 },
    { type: 'highlight', selector: '.ant-layout-header', duration: 2000 },
    { type: 'highlightHide' },

    { type: 'endcard', title: 'Dadaguard', subtitle: 'coherence watchdog for AWS · open source', duration: 2600 },
  ],
}
