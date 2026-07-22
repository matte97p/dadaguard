output "public_url" {
  value       = "https://${local.public_host}"
  description = "URL pubblico di Dadaguard. Il guardiano anti-esposizione lo ricava da solo dall'header della richiesta (via Cloudflare) — non serve passarlo all'app. Utile qui per reference/verifica."
}

output "application_id" {
  value       = cloudflare_zero_trust_access_application.this.id
  description = "ID della Access application."
}

output "policy_id" {
  value       = cloudflare_zero_trust_access_policy.this.id
  description = "ID della Access policy (CHI può entrare)."
}
