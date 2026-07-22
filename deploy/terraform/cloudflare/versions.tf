terraform {
  required_version = ">= 1.5"
  required_providers {
    # Cloudflare v5: risorse Zero Trust rinominate `cloudflare_zero_trust_*`; in v5 l'attributo
    # `self_hosted_domains` dell'application è calcolato da `destinations` (non metterli entrambi).
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}
