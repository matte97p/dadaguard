variable "account_id" {
  type        = string
  description = "Cloudflare account id (Zero Trust è account-scoped)."
}

variable "zone_id" {
  type        = string
  description = "Cloudflare zone id del dominio con cui pubblichi Dadaguard."
}

variable "zone_name" {
  type        = string
  description = "Dominio della zona, es. `example.com`."
}

variable "hostname" {
  type        = string
  default     = "dadaguard"
  description = "Sottodominio: l'app sarà su `<hostname>.<zone_name>`."
}

variable "tunnel_id" {
  type        = string
  description = <<-EOT
    ID del Cloudflare Tunnel (cloudflared) che pubblica Dadaguard. Il DNS creato qui punta a
    `<tunnel_id>.cfargotunnel.com`. Il tunnel (e il suo token per il connettore) si crea una volta —
    dashboard Zero Trust → Networks → Tunnels, oppure `cloudflared tunnel create` — e il token va
    nel secret store del tuo hosting (per la ricetta Fargate: un SSM SecureString, vedi ../).
  EOT
}

variable "allowed_email_domains" {
  type        = list(string)
  default     = []
  description = "Domini email ammessi da Access, es. [\"example.com\"]. Il team, non «everyone»."
}

variable "allowed_emails" {
  type        = list(string)
  default     = []
  description = "Singole email ammesse (oltre ai domini), es. [\"ops@altrove.com\"]."
}

variable "allowed_idps" {
  type        = list(string)
  default     = []
  description = "ID degli Identity Provider Zero Trust ammessi. Vuoto = tutti gli IdP dell'account."
}

variable "session_duration" {
  type        = string
  default     = "24h"
  description = "Durata sessione Access (v5 forza comunque un default se lasciato null)."
}
