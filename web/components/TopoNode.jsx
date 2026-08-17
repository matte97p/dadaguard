import { Handle, Position } from '@xyflow/react'
import {
  ApiOutlined,
  AppstoreOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  FieldTimeOutlined,
  FunctionOutlined,
  GlobalOutlined,
  HddOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  BranchesOutlined,
  QuestionOutlined,
} from '@ant-design/icons'
import { splitFamily } from '../serviceName.js'
import { FONT, MONO } from '../theme.js'

// I pezzi disegnati della mappa dell'architettura: il BOX di un gruppo (livello 1), la CARD di una
// risorsa (livello 2), lo STUB di un vicino fuori dal gruppo.
//
// Un diagramma di architettura si legge per forma prima che per testo: l'icona dice che cos'è, la
// colonna dice a che livello vive, l'accento dice se c'è un guasto. Il testo distingue due cose dello
// stesso tipo, non porta il peso del messaggio.

// Le maniglie stanno a SINISTRA e a DESTRA perché il disegno scorre in orizzontale (ingresso →
// applicazioni → dati). Con le maniglie in alto e in basso gli archi uscivano dal fondo di un box per
// rientrare in cima a quello accanto, disegnando cappi: è il difetto classico di ReactFlow quando la
// posizione delle maniglie non segue la direzione del layout.
const MANIGLIE = (
  <>
    <Handle type="target" position={Position.Left} className="dg-topo-handle" />
    <Handle type="source" position={Position.Right} className="dg-topo-handle" />
  </>
)

const ICONA_GRUPPO = {
  ingress: GlobalOutlined,
  app: CloudServerOutlined,
  data: DatabaseOutlined,
  sched: FieldTimeOutlined,
  event: ThunderboltOutlined,
  models: RobotOutlined,
  other: AppstoreOutlined,
}

const ICONA_TIPO = {
  alb: GlobalOutlined,
  cloudfront: GlobalOutlined,
  apigateway: ApiOutlined,
  'cloudflare-worker': GlobalOutlined,
  ecs: CloudServerOutlined,
  ec2: HddOutlined,
  lambda: FunctionOutlined,
  'ecs-scheduled': FieldTimeOutlined,
  sfn: BranchesOutlined,
  rds: DatabaseOutlined,
  elasticache: ThunderboltOutlined,
  dynamodb: DatabaseOutlined,
  s3: HddOutlined,
  sqs: BranchesOutlined,
  kinesis: BranchesOutlined,
  bedrock: RobotOutlined,
}

// BOX di gruppo: il nodo del primo livello. Titolo, una riga di riassunto, e il conto dei membri.
export function TopoGroup({ data, selected }) {
  const Icona = ICONA_GRUPPO[data.key] ?? AppstoreOutlined
  const r = data.rollup
  return (
    <div
      className={`dg-topo-box${selected ? ' dg-topo-sel' : ''}${data.dim ? ' dg-topo-dim' : ''}`}
      style={{ '--dg-topo-accent': data.colore }}
      title={data.titolo}
    >
      {MANIGLIE}
      <div className="dg-topo-box-head">
        <span className="dg-topo-icon">
          <Icona />
        </span>
        <span className="dg-topo-box-title">{data.titolo}</span>
        <span className="dg-topo-rep">{r.membri}</span>
      </div>
      {/* I nomi di cosa c'è dentro: è la differenza fra un contenitore e un'informazione. Testa di
          famiglia compattata, come ovunque nell'app — qui i nomi condividono tutti lo stesso prefisso
          di ambiente e senza compattarli si legge otto volte la stessa parola. */}
      {data.nomi?.length > 0 && (
        <div className="dg-topo-box-names">
          {/* La testa condivisa UNA volta sola, in cima: scritta su ogni riga occuperebbe lo spazio
              della parte che distingue, e i nomi finirebbero tagliati proprio lì. */}
          {data.testa && <div className="dg-topo-box-fam">{data.testa}…</div>}
          {data.nomi.map((n) => (
            <div key={n} className="dg-topo-box-name" title={n}>
              {n}
            </div>
          ))}
          {data.altri > 0 && <div className="dg-topo-box-more">+{data.altri}</div>}
        </div>
      )}
      <div className="dg-topo-box-body">
        {/* PROBLEMI, non «X su N attivi»: un servizio senza traffico è `idle`, e contarlo fra i non
            attivi trasforma «nessuno l'ha chiamato» in «è rotto». Zero problemi si dice, non si tace:
            un box muto si legge come «non lo so». */}
        <span style={{ color: r.problemi ? '#ff4d4f' : undefined, fontWeight: r.problemi ? 600 : 400 }}>
          {r.problemi ? data.frasi.problemi : data.frasi.nessunProblema}
        </span>
        {r.task && (
          <span className={r.task.male ? 'dg-topo-rep-male' : undefined}>
            {r.task.attivi}/{r.task.voluti} {data.frasi.task}
          </span>
        )}
        {r.prossimo && <span>{data.frasi.prossimo}</span>}
        {r.fermi > 0 && <span style={{ opacity: 0.6 }}>{data.frasi.fermi}</span>}
      </div>
    </div>
  )
}

// CARD di una risorsa: il nodo del secondo livello.
export function TopoNode({ data, selected }) {
  const Icona = ICONA_TIPO[data.type] ?? QuestionOutlined
  const { family, tail } = splitFamily(data.name, data.prefissi)
  return (
    <div
      className={`dg-topo-node${data.ghost ? ' dg-topo-ghost' : ''}${data.dim ? ' dg-topo-dim' : ''}${selected ? ' dg-topo-sel' : ''}`}
      style={{ '--dg-topo-accent': data.color }}
      title={data.title}
    >
      {MANIGLIE}
      <span className="dg-topo-icon">
        <Icona />
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span className="dg-topo-name" style={{ fontFamily: MONO }}>
          {/* Testa condivisa muta, coda in evidenza: metà dei nomi qui iniziano con lo stesso prefisso
              di ambiente, e su una card da 200px l'ellissi mangerebbe la parte che distingue. */}
          {family && <span style={{ opacity: 0.4, fontWeight: 400 }}>{family}</span>}
          {tail}
        </span>
        {data.meta && (
          <span className="dg-topo-meta" style={{ fontSize: FONT.micro }}>
            {data.meta}
          </span>
        )}
      </span>
      {data.repliche && (
        <span className={`dg-topo-rep${data.repliche.male ? ' dg-topo-rep-male' : ''}`}>{data.repliche.testo}</span>
      )}
    </div>
  )
}

// STUB: un vicino che sta FUORI dal gruppo aperto. Uno per gruppo, non uno per risorsa — sennò il
// secondo livello ridiventa il grafo intero, che è la cosa da cui si sta scappando. Serve a non perdere
// di vista con chi parla il gruppo mentre lo si guarda da dentro.
export function TopoStub({ data }) {
  return (
    <div className={`dg-topo-stub dg-topo-stub-${data.verso}`} title={data.nomi.join('\n')}>
      {MANIGLIE}
      <span className="dg-topo-stub-title">{data.titolo}</span>
      <span className="dg-topo-rep">{data.n}</span>
    </div>
  )
}

export const TIPI_NODO = { gruppo: TopoGroup, svc: TopoNode, stub: TopoStub }
