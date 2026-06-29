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
      "lambda:ListFunctions", "lambda:GetFunction", "lambda:GetFunctionConfiguration",
      "autoscaling:DescribeAutoScalingGroups",
      "rds:DescribeDBClusters", "rds:DescribeDBInstances",
      "elasticloadbalancing:DescribeLoadBalancers",
      "elasticloadbalancing:DescribeTargetGroups",
      "elasticloadbalancing:DescribeTargetHealth",
      "ec2:DescribeInstances", "ec2:DescribeInstanceStatus",
      "cloudwatch:GetMetricData",
      "scheduler:GetSchedule", "scheduler:ListSchedules",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "TopologyReadOnly" # deduzione dipendenze: event source Lambda + regole dei security group
    effect = "Allow"
    actions = [
      "lambda:ListEventSourceMappings",
      "ec2:DescribeSecurityGroups",
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
