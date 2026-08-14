import { Handle, Position } from '@xyflow/react'
import {
  ApiOutlined,
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

// I nodi del disegno dell'architettura. Prima erano rettangoli con dentro una stringa
// («nome · tipo»): leggibili a fatica, tutti uguali, e su settanta nodi diventavano un muro di
// riquadri. Un diagramma di architettura si legge per FORMA prima che per testo — l'icona dice che
// cos'è quella cosa, l'accento a sinistra come sta, la posizione a che livello vive — e il testo
// serve solo a distinguere due cose dello stesso tipo.

// Icona per tipo di risorsa. Non è decorazione: su una tela con trenta nodi è il primo canale che
// l'occhio usa, e legge «un database, due lambda, un load balancer» prima di leggere un solo nome.
const ICONA = {
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

export function TopoNode({ data, selected }) {
  const Icona = ICONA[data.type] ?? QuestionOutlined
  const { family, tail } = splitFamily(data.name, data.prefissi)
  return (
    <div
      className={`dg-topo-node${data.ghost ? ' dg-topo-ghost' : ''}${data.dim ? ' dg-topo-dim' : ''}${selected ? ' dg-topo-sel' : ''}`}
      style={{ '--dg-topo-accent': data.color }}
      title={data.title}
    >
      <Handle type="target" position={Position.Top} className="dg-topo-handle" />
      <span className="dg-topo-icon">
        <Icona />
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span className="dg-topo-name" style={{ fontFamily: MONO }}>
          {/* Testa condivisa muta, coda in evidenza: metà dei nomi qui iniziano con lo stesso
              prefisso di ambiente, e su una card da 200px l'ellissi mangerebbe la parte che distingue. */}
          {family && <span style={{ opacity: 0.4, fontWeight: 400 }}>{family}</span>}
          {tail}
        </span>
        {data.meta && (
          <span className="dg-topo-meta" style={{ fontSize: FONT.micro }}>
            {data.meta}
          </span>
        )}
      </span>
      {/* Repliche attive/desiderate. Sta a destra e in cifre a larghezza fissa: «2/3» su una card è la
          seconda cosa che si guarda dopo il colore, e quando le due cifre non coincidono va rosso —
          «attivo» e «quante ne dovrebbero girare» sono due domande diverse, e il verde risponde solo
          alla prima. */}
      {data.repliche && (
        <span className={`dg-topo-rep${data.repliche.male ? ' dg-topo-rep-male' : ''}`}>{data.repliche.testo}</span>
      )}
      <Handle type="source" position={Position.Bottom} className="dg-topo-handle" />
    </div>
  )
}

// La FASCIA di una corsia: sta sotto ai nodi e dice a che livello dell'architettura sei (chi riceve la
// richiesta, chi la serve, dove stanno i dati, cosa gira a orario). È il pezzo che trasforma una
// nuvola di riquadri in un disegno che si legge dall'alto in basso.
export function TopoLane({ data }) {
  return (
    <div className="dg-topo-lane" style={{ width: data.width, height: data.height }}>
      <span className="dg-topo-lane-label">{data.label}</span>
    </div>
  )
}

export const TIPI_NODO = { svc: TopoNode, lane: TopoLane }
