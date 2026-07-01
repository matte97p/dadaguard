# Ruolo READ-ONLY che Dadaguard assume in OGNI account monitorato.
# Applicalo una volta per account target (staging, prod, ...). Placeholder generici.
# Dadaguard è read-only by design: questa policy NON concede alcuna azione di scrittura.

variable "dadaguard_task_role_arn" {
  description = "ARN del task role ECS dove gira Dadaguard (account host)"
  type        = string
}

variable "external_id" {
  description = "Stringa condivisa anti confused-deputy (uguale a services.yaml)"
  type        = string
  sensitive   = true
}

variable "tf_state_bucket" {
  description = "Bucket S3 dello state Terraform da leggere (#6 drift, #7 unmanaged). Vuoto = skip."
  type        = string
  default     = ""
}

# --- chi può assumere il ruolo: solo il task role host, e solo con l'ExternalId ---
data "aws_iam_policy_document" "trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = [var.dadaguard_task_role_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [var.external_id]
    }
  }
}

# --- cosa può fare: SOLO lettura, esattamente le API che Dadaguard chiama ---
data "aws_iam_policy_document" "readonly" {
  statement {
    sid    = "RuntimeReadOnly"
    effect = "Allow"
    actions = [
      "ecs:ListClusters", "ecs:ListServices", "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition", # #2 build: tag immagine del task in uso
      "lambda:ListFunctions", "lambda:GetFunction", "lambda:GetFunctionConfiguration",
      "lambda:GetAlias", # #2 build: versione dietro l'alias Lambda
      "autoscaling:DescribeAutoScalingGroups",
      "rds:DescribeDBClusters", "rds:DescribeDBInstances",
      "rds:DescribeDBClusterSnapshots", "rds:DescribeDBSnapshots", # recency backup
      "rds:DescribeEvents", "autoscaling:DescribeScalingActivities", # eventi recenti (RDS/ASG)
      "acm:DescribeCertificate", # #scadenza certificati
      "elasticloadbalancing:DescribeLoadBalancers",
      "elasticloadbalancing:DescribeTargetGroups",
      "elasticloadbalancing:DescribeTargetHealth",
      "ec2:DescribeInstances", "ec2:DescribeInstanceStatus",
      "cloudwatch:GetMetricData",
      "cloudwatch:ListMetrics",    # discovery Bedrock: i ModelId invocati (metriche AWS/Bedrock)
      "cloudwatch:DescribeAlarms", # allarmi in stato ALARM correlati alla risorsa
      "servicequotas:ListServiceQuotas", # quote vicine al limite (uso vs limite via CloudWatch)
      "scheduler:GetSchedule", "scheduler:ListSchedules",
      "sqs:GetQueueUrl", "sqs:GetQueueAttributes",   # #3 runtime SQS (profondità coda)
      "dynamodb:DescribeTable",                       # #3 runtime DynamoDB (stato tabella)
      "elasticache:DescribeCacheClusters",            # #3 runtime ElastiCache (stato cluster)
      "states:DescribeStateMachine", "states:ListExecutions", # Step Functions
      "eks:DescribeCluster",                                  # EKS
      "cloudfront:GetDistribution",                           # CloudFront (globale, us-east-1)
      "sns:GetTopicAttributes",                               # SNS
      "kinesis:DescribeStreamSummary",                        # Kinesis
      "s3:ListBucket", "s3:GetBucketPolicyStatus",            # S3 (esistenza + esposizione pubblica)
    ]
    resources = ["*"]
  }

  statement {
    sid    = "TopologyReadOnly" # topologia: dipendenze (event source + SG) e mappa di rete (VPC/subnet/IGW)
    effect = "Allow"
    actions = [
      "lambda:ListEventSourceMappings",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSubnets",          # vista Rete: subnet → VPC, AZ, pubblica/privata
      "ec2:DescribeVpcs",             # vista Rete: nome/CIDR della VPC
      "ec2:DescribeInternetGateways", # vista Rete: egress (IGW); NAT gateway già concesso in WasteReadOnly
      "events:ListRules",             # cron: EventBridge Rule schedulata → cadenza per il dead-man switch
      "events:ListTargetsByRule",     # cron: quale Lambda innesca la rule
    ]
    resources = ["*"]
  }

  statement {
    sid       = "WasteReadOnly" # #10 risorse orfane costose
    effect    = "Allow"
    actions   = ["ec2:DescribeAddresses", "ec2:DescribeNatGateways", "ec2:DescribeVolumes"]
    resources = ["*"]
  }

  statement {
    sid       = "LogsReadOnly" # pannello "Log recenti" (on-demand): ultimi eventi CloudWatch Logs
    effect    = "Allow"
    actions   = ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:DescribeLogGroups"]
    resources = ["*"]
  }

  statement {
    sid    = "SecurityReadOnly" # #11 quick-win: SG aperti + policy IAM con wildcard
    effect = "Allow"
    actions = [
      # SG aperti a internet (0.0.0.0/0): ec2:DescribeSecurityGroups già concesso sopra (Topology).
      # IAM read: legge SOLO le policy del ruolo del servizio, per trovare Action/Resource "*".
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:GetRolePolicy",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "SecretsByNameOnly" # #4 — NIENTE kms:Decrypt: solo i nomi, mai i valori
    effect    = "Allow"
    actions   = ["ssm:GetParametersByPath", "ssm:DescribeParameters"]
    resources = ["*"]
  }

  statement {
    sid       = "CostExplorer" # sezione costi (Cost Explorer, endpoint us-east-1)
    effect    = "Allow"
    actions   = ["ce:GetCostAndUsage"]
    resources = ["*"]
  }

  statement {
    sid       = "ChangesReadOnly" # #7 causalità: chi/cosa/quando ha cambiato la risorsa (CloudTrail)
    effect    = "Allow"
    actions   = ["cloudtrail:LookupEvents"]
    resources = ["*"]
  }

  statement {
    sid       = "OrgReadOnly" # #8 enumerazione account via AWS Organizations (solo sull'identità che elenca)
    effect    = "Allow"
    actions   = ["organizations:ListAccounts"]
    resources = ["*"]
  }
}

# --- state Terraform su S3 (opzionale): sola lettura del bucket dichiarato ---
data "aws_iam_policy_document" "tf_state" {
  count = var.tf_state_bucket == "" ? 0 : 1
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.tf_state_bucket}", "arn:aws:s3:::${var.tf_state_bucket}/*"]
  }
}

resource "aws_iam_role" "dadaguard_readonly" {
  name                 = "dadaguard-readonly"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "readonly" {
  name   = "dadaguard-readonly"
  role   = aws_iam_role.dadaguard_readonly.id
  policy = data.aws_iam_policy_document.readonly.json
}

resource "aws_iam_role_policy" "tf_state" {
  count  = var.tf_state_bucket == "" ? 0 : 1
  name   = "dadaguard-tf-state"
  role   = aws_iam_role.dadaguard_readonly.id
  policy = data.aws_iam_policy_document.tf_state[0].json
}

output "role_arn" {
  description = "Mettilo in services.yaml come accounts.<env>.roleArn"
  value       = aws_iam_role.dadaguard_readonly.arn
}
