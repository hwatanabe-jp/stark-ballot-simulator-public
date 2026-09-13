output "image_signature_preflight" {
  description = "Non-secret verifier coordinates; no App deployment identity or runtime is claimed."
  value = {
    for key, value in local.image_signature_verifier_current_authority : key => value
    if key != "runtime_alias_arn"
  }
}
