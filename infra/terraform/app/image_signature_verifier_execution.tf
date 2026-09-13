# Ordinary App and its retained-input contract never select initialization.
locals {
  image_signature_verifier_standalone     = false
  image_signature_verifier_initialization = false
  image_signature_verifier_alias_function_version = (
    var.image_signature_verifier_selected_authority == null
    ? var.image_signature_verifier_reconciled_function_version
    : var.image_signature_verifier_selected_authority.function_version
  )
}
