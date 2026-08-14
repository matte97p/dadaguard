import { useEffect, useState } from 'react'
import { Typography } from 'antd'
import { SyncOutlined } from '@ant-design/icons'
import { FONT } from '../theme.js'

const { Text } = Typography

// Indicatore di freschezza: «aggiornato Ns fa» che scorre in tempo reale + icona che gira durante il
// refresh in background. Rende visibile che la vista si aggiorna da sola (niente più tab fermo a uno
// snapshot vecchio senza accorgersene, che era la causa dello sfasamento con la notifica Slack).
//
// Sta in un componente condiviso, e va messo NELLA BARRA DEI CONTROLLI: appeso in fondo alla pagina,
// dopo le tabelle, sembra una riga avanzata da qualcos'altro — chi legge non lo collega alla vista che
// sta guardando, e infatti la prima reazione è stata «aggiorno… al fondo a caso». Accanto ai filtri
// invece dice quello che deve dire: questi dati sono di adesso, e si rinfrescano da soli.
export default function PollStatus({ lastUpdated, refreshing, t = (k) => k }) {
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  let label = ''
  if (refreshing) label = t('poll.updating')
  else if (lastUpdated) {
    const s = Math.max(0, Math.round((Date.now() - lastUpdated) / 1000))
    label = s < 5 ? t('poll.justNow') : s < 60 ? t('poll.secAgo', { s }) : t('poll.minAgo', { m: Math.floor(s / 60) })
  }
  if (!label) return null
  return (
    <Text type="secondary" style={{ fontSize: FONT.small, whiteSpace: 'nowrap' }}>
      <SyncOutlined spin={refreshing} style={{ marginInlineEnd: 5, opacity: 0.7 }} />
      {label}
    </Text>
  )
}
