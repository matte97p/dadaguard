variable "name" {
  description = "Nome del servizio / task family."
  type        = string
  default     = "dadaguard"
}

variable "region" {
  description = "Region AWS dell'account host (dove gira Fargate)."
  type        = string
}

variable "cluster_arn" {
  description = "ARN del cluster ECS dove schedulare il servizio."
  type        = string
}

variable "vpc_id" {
  description = "VPC del security group."
  type        = string
}

variable "subnet_ids" {
  description = "Subnet PRIVATE (con NAT) in cui far girare il task. L'ingresso passa dal Tunnel, non serve IP pubblico."
  type        = list(string)
}

variable "image" {
  description = "Immagine del container Dadaguard, tag incluso (GHCR pubblica, o una tua ECR/registry)."
  type        = string
  default     = "ghcr.io/matte97p/dadaguard:v0.1.0"
}

variable "readonly_role_arns" {
  description = "ARN dei ruoli dadaguard-readonly cross-account che il task puo' assumere (uno per account monitorato)."
  type        = list(string)
}

variable "config_ssm_arn" {
  description = "ARN del parametro SSM SecureString con lo YAML di config (iniettato come DADAGUARD_CONFIG). Vedi ../../services.example.yaml."
  type        = string
}

variable "tunnel_token_ssm_arn" {
  description = "ARN del parametro SSM SecureString con il token del Cloudflare Tunnel."
  type        = string
}

variable "container_port" {
  description = "Porta su cui Express serve frontend + API."
  type        = number
  default     = 3001
}

variable "cpu" {
  description = "CPU del task Fargate (unita')."
  type        = string
  default     = "512"
}

variable "memory" {
  description = "Memoria del task Fargate (MiB)."
  type        = string
  default     = "1024"
}

variable "desired_count" {
  description = "Numero di task. 1 basta per un tool interno (no HA)."
  type        = number
  default     = 1
}

variable "cloudflared_image" {
  description = "Immagine del sidecar Cloudflare Tunnel. Pinna a una versione in produzione."
  type        = string
  default     = "cloudflare/cloudflared:latest"
}

variable "log_retention_days" {
  description = "Retention dei log CloudWatch."
  type        = number
  default     = 30
}
