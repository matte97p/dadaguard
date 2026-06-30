# Dadaguard su AWS ECS Fargate, dietro Cloudflare Tunnel + Access.
#
# Crea: 1 servizio Fargate con 2 container (dadaguard + sidecar cloudflared),
# i due ruoli IAM (execution + task), un security group SOLO egress e il log group.
# L'ingresso NON è una porta pubblica: passa dal Cloudflare Tunnel (Zero Trust).
#
# Questa è la via AVANZATA (AWS-native). Per provare Dadaguard basta `docker compose up`.
# Prerequisiti che NON crea questa ricetta: una VPC con subnet private + NAT, un cluster
# ECS, un Cloudflare Tunnel (con il suo token) e — in ogni account da monitorare — il
# ruolo `dadaguard-readonly` (vedi ../dadaguard-readonly-role.example.tf).

provider "aws" {
  region = var.region
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# --- execution role: pull immagine + log + lettura dei 2 secret SSM per iniettarli ---
resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "secrets_read" {
  statement {
    sid       = "ReadInjectedSecrets"
    effect    = "Allow"
    actions   = ["ssm:GetParameters"]
    resources = [var.config_ssm_arn, var.tunnel_token_ssm_arn]
  }
  statement {
    sid       = "DecryptSecureString"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = ["*"] # chiave KMS dei parametri SecureString (alias/aws/ssm o CMK dedicata)
  }
}

resource "aws_iam_role_policy" "secrets_read" {
  name   = "secrets-read"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.secrets_read.json
}

# --- task role: l'app assume i ruoli read-only cross-account, niente altro ---
resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "assume_readonly" {
  statement {
    sid       = "AssumeCrossAccountReadOnly"
    effect    = "Allow"
    actions   = ["sts:AssumeRole"]
    resources = var.readonly_role_arns
  }
}

resource "aws_iam_role_policy" "assume_readonly" {
  name   = "assume-readonly"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.assume_readonly.json
}

# --- SG: SOLO egress. Nessun inbound (l'ingresso è il Tunnel, outbound-only). ---
resource "aws_security_group" "this" {
  name        = var.name
  description = "Dadaguard Fargate - solo egress (outbound-only via Cloudflare Tunnel)"
  vpc_id      = var.vpc_id

  egress {
    description = "Egress: Cloudflare Tunnel (443) + API AWS cross-account (STS/describe)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name         = "dadaguard"
      image        = var.image
      essential    = true
      portMappings = [{ containerPort = var.container_port, protocol = "tcp" }]
      environment  = [{ name = "PORT", value = tostring(var.container_port) }]
      secrets      = [{ name = "DADAGUARD_CONFIG", valueFrom = var.config_ssm_arn }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "dadaguard"
        }
      }
      healthCheck = {
        command     = ["CMD-SHELL", "node -e 'fetch(\"http://127.0.0.1:${var.container_port}/\").then(()=>process.exit(0),()=>process.exit(1))'"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }
    },
    {
      name      = "cloudflared"
      image     = var.cloudflared_image
      essential = true
      command   = ["tunnel", "--no-autoupdate", "run"]
      # Forza HTTP/2: in Fargate i buffer UDP limitati rendono QUIC inaffidabile
      # (connessioni su ma data-plane che non instrada -> 502 sull'edge).
      environment = [{ name = "TUNNEL_TRANSPORT_PROTOCOL", value = "http2" }]
      secrets     = [{ name = "TUNNEL_TOKEN", valueFrom = var.tunnel_token_ssm_arn }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "cloudflared"
        }
      }
    },
  ])
}

resource "aws_ecs_service" "this" {
  name            = var.name
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.this.id]
    assign_public_ip = false # subnet private + NAT; l'ingresso e' il Tunnel
  }

  # Qui Terraform possiede anche i deploy: cambia `image` e `terraform apply` rilascia
  # la nuova versione. Se invece un tuo CI (es. GitHub Actions) aggiorna le revision
  # della task definition, scommenta il blocco sotto cosi' Terraform non le sovrascrive.
  # lifecycle {
  #   ignore_changes = [task_definition]
  # }
}
