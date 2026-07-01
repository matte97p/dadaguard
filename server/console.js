// Deep-link alla console AWS della risorsa ESATTA, dedotto dal tipo + identificatori.
// Puro/testabile, read-only (è solo un URL). Non serve l'account id: la console usa
// l'account in cui sei loggato. Ritorna l'URL o null se non sappiamo costruirlo.
// #5: da ogni card un click ti porta sulla risorsa giusta (il "dove" dopo il "perché").
const enc = encodeURIComponent

export function consoleUrl(service, accountRegion) {
  const a = service?.aws
  if (!a?.type) return null
  // I servizi senza `region` esplicita ereditano quella dell'account (dove la risorsa
  // vive davvero): senza questo fallback il deep-link punterebbe a us-east-1 e non la troverebbe.
  const region = a.region || service.region || accountRegion || 'us-east-1'
  const r = enc(region)
  const base = `https://${region}.console.aws.amazon.com`

  switch (a.type) {
    case 'lambda':
      return a.function ? `${base}/lambda/home?region=${r}#/functions/${enc(a.function)}` : null
    case 'ecs':
      return a.cluster && a.service
        ? `${base}/ecs/v2/clusters/${enc(a.cluster)}/services/${enc(a.service)}/health?region=${r}`
        : null
    case 'rds':
      if (a.cluster) return `${base}/rds/home?region=${r}#database:id=${enc(a.cluster)};is-cluster=true`
      if (a.instance) return `${base}/rds/home?region=${r}#database:id=${enc(a.instance)};is-cluster=false`
      return `${base}/rds/home?region=${r}#databases:`
    case 'asg':
      return a.asg ? `${base}/ec2/home?region=${r}#AutoScalingGroupDetails:id=${enc(a.asg)}` : null
    case 'ec2':
      return a.instanceId ? `${base}/ec2/home?region=${r}#InstanceDetails:instanceId=${enc(a.instanceId)}` : null
    case 'alb':
      return `${base}/ec2/home?region=${r}#LoadBalancers:`
    case 'sqs':
      return `${base}/sqs/v3/home?region=${r}#/queues`
    case 'dynamodb':
      return a.table ? `${base}/dynamodbv2/home?region=${r}#table?name=${enc(a.table)}` : null
    case 'elasticache':
      return `${base}/elasticache/home?region=${r}#/redis`
    case 'sns':
      return a.arn ? `${base}/sns/v3/home?region=${r}#/topic/${enc(a.arn)}` : null
    case 'sfn':
      return a.arn ? `${base}/states/home?region=${r}#/statemachines/view/${enc(a.arn)}` : null
    case 'eks':
      return a.cluster ? `${base}/eks/home?region=${r}#/clusters/${enc(a.cluster)}` : null
    case 's3':
      return a.bucket ? `https://s3.console.aws.amazon.com/s3/buckets/${enc(a.bucket)}` : null
    case 'kinesis':
      return a.stream ? `${base}/kinesis/home?region=${r}#/streams/details/${enc(a.stream)}` : null
    case 'cloudfront':
      return a.id ? `https://console.aws.amazon.com/cloudfront/v4/home#/distributions/${enc(a.id)}` : null
    case 'acm':
      return `${base}/acm/home?region=${r}#/certificates/list`
    case 'apigateway':
      return `${base}/apigateway/main/apis?region=${r}`
    case 'bedrock':
      return `${base}/bedrock/home?region=${r}#/` // console Bedrock (region); nessun deep-link per singolo modello
    default:
      return null
  }
}
