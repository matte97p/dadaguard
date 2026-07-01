import { Modal, Typography } from 'antd'

const { Text } = Typography

// Contenitore condiviso per i pannelli AGGREGATI (Costi/Sprechi/Quote/Meta-salute): un modal
// centrato quasi a tutto schermo. Meno brusco di un drawer 100% e — con maxHeight invece di height —
// si adatta al contenuto (niente mezzo schermo vuoto quando un pannello ha poche righe) e scrolla
// solo quando serve. `extra` = controlli in testata (es. il selettore mese dei Costi); `hint` =
// promemoria che i filtri si impostano dalla barra della dashboard (qui la barra è coperta).
export default function PanelModal({ open, onClose, title, extra, hint, width = '92vw', children }) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      centered
      width={width}
      style={{ maxWidth: 1500 }}
      styles={{ body: { maxHeight: '82vh', overflowY: 'auto', paddingTop: 4 } }}
      title={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, paddingRight: 28 }}>
          <span>{title}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {extra}
            {hint && (
              <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                {hint}
              </Text>
            )}
          </div>
        </div>
      }
    >
      {children}
    </Modal>
  )
}

// Griglia responsiva riusabile: card-account affiancate (340–480px), allineate a sinistra e in alto.
// La usano i pannelli per riempire la larghezza del modal invece di impilare gli account in colonna.
export const PANEL_GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 480px))',
  gap: 20,
  alignItems: 'start',
  justifyContent: 'start',
}

// Bordo leggero attorno a ogni card-account, per separarle nella griglia.
export const PANEL_CARD = {
  border: '1px solid rgba(128,128,128,0.18)',
  borderRadius: 10,
  padding: 16,
}
