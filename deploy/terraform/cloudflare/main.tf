# Front-door di Dadaguard come CODICE (template generico, zero valori specifici).
#
# Dadaguard non ha login proprio: il login è Cloudflare Access DAVANTI. Questo modulo mette in IaC i
# tre pezzi che altrimenti si fanno a click nella dashboard (e che qualcuno può aprire a «everyone»
# per sbaglio, senza che nessuno se ne accorga):
#   1. la Access POLICY  — CHI può entrare (domini email / email del team)
#   2. la Access APPLICATION — su quale hostname si applica
#   3. il RECORD DNS      — pubblica l'hostname sul tunnel cloudflared
#
# Il tunnel cloudflared (e il suo token per il connettore) resta un prerequisito una-tantum: vedi
# var.tunnel_id. La ricetta AWS/Fargate del connettore è in ../ (sidecar cloudflared).

locals {
  public_host = "${var.hostname}.${var.zone_name}"

  # include della policy = domini email + email singole. Un ordine deterministico → niente diff spurii.
  includes = concat(
    [for d in var.allowed_email_domains : { email_domain = { domain = d } }],
    [for e in var.allowed_emails : { email = { email = e } }],
  )
}

# Fail-fast: senza nessun ammesso, la policy non ha senso (protezione inefficace o lockout totale).
resource "terraform_data" "guard_nonempty" {
  lifecycle {
    precondition {
      condition     = length(local.includes) > 0
      error_message = "Access aperta a nessuno: valorizza allowed_email_domains e/o allowed_emails (il team, non «everyone»)."
    }
  }
}

# 1) CHI entra — policy Access riusabile (decision=allow, solo il team).
resource "cloudflare_zero_trust_access_policy" "this" {
  account_id = var.account_id
  name       = "dadaguard"
  decision   = "allow"
  include    = local.includes
}

# 2) DOVE si applica — application self-hosted sull'hostname pubblico.
resource "cloudflare_zero_trust_access_application" "this" {
  account_id                = var.account_id
  name                      = "dadaguard"
  domain                    = local.public_host
  type                      = "self_hosted"
  session_duration          = var.session_duration
  app_launcher_visible      = true
  auto_redirect_to_identity = length(var.allowed_idps) == 1
  allowed_idps              = length(var.allowed_idps) > 0 ? var.allowed_idps : null
  # v5: self_hosted_domains è calcolato da destinations → si dichiara solo destinations.
  destinations = [{ type = "public", uri = local.public_host }]
  policies     = [{ id = cloudflare_zero_trust_access_policy.this.id, precedence = 1 }]
}

# 3) DNS — pubblica l'hostname sul tunnel (record proxied → <tunnel-id>.cfargotunnel.com).
resource "cloudflare_dns_record" "this" {
  zone_id = var.zone_id
  name    = local.public_host
  type    = "CNAME"
  content = "${var.tunnel_id}.cfargotunnel.com"
  proxied = true
  ttl     = 1 # 1 = automatico (obbligatorio per i record proxied)
}
