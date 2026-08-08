import { Menu } from 'antd'

// Navigazione laterale, raggruppata.
//
// Perché non più la fila di bottoni nell'header: erano nove voci in ordine di arrivo, senza gerarchia —
// «Free Tier» pesava come «Dashboard» — e la barra era satura, tanto che le due viste nuove (WAF e
// budget) hanno dovuto entrare dentro pagine esistenti perché una decima voce non ci stava. Il
// problema non era lo spazio: era che non c'era un posto DOVE metterle.
//
// I gruppi sono le quattro domande che si fanno qui: cosa sta girando · cosa è uscito · quanto costa ·
// chi può fare cosa. «Adesso» sta fuori dai gruppi perché non è un argomento: è la risposta alla
// domanda che viene prima di tutte, e quindi la prima voce e la home.
export default function SideNav({ groups = [], active, onPick, collapsed, t = (k) => k }) {
  const items = groups.map((g) =>
    g.group
      ? { key: g.group, label: t(`navGroup.${g.group}`), type: 'group', children: g.items.map((i) => ({ key: i.to, icon: i.icon, label: t(`nav.${i.key}`) })) }
      : { key: g.to, icon: g.icon, label: t(`nav.${g.key}`) },
  )
  return (
    <Menu
      mode="inline"
      // La chiave è il percorso: così la voce attiva si deduce dall'URL invece di essere uno stato da
      // tenere in sincrono (che è il modo in cui una sidebar finisce a evidenziare la pagina sbagliata).
      selectedKeys={[active]}
      items={items}
      onClick={({ key }) => onPick(key)}
      inlineCollapsed={collapsed}
      style={{ borderInlineEnd: 'none', background: 'transparent' }}
    />
  )
}
