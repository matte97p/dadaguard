import { Spin, Typography } from 'antd'
import { FONT, SPACE } from '../theme.js'

const { Text } = Typography

// Caricamento con una FRASE. `<Spin tip="...">` senza figli non mostra niente (antd disegna il `tip`
// solo quando lo Spin avvolge del contenuto, o a tutto schermo): la scritta stava nel codice, la pagina
// mostrava una rotellina muta, e nessuno se ne accorgeva perché il codice sembrava giusto. Qui la frase
// è un elemento, quindi si vede — e dire COSA si sta caricando è metà dell'attesa (su questa app un
// giro può essere di secondi, e una rotella senza spiegazione si legge come «è bloccato»).
export default function Loading({ text, minHeight = 160 }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACE.md,
        minHeight,
        padding: SPACE.xl,
      }}
    >
      <Spin />
      {text && (
        <Text type="secondary" style={{ fontSize: FONT.small }}>
          {text}
        </Text>
      )}
    </div>
  )
}
