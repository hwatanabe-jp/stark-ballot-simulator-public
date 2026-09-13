# The preflight alias must not depend on the mutable Lambda resource. Terraform
# includes references in both arms of a conditional in its dependency graph.
variable "verifier_phase" {
  type = string
  validation {
    condition     = var.verifier_phase == "preflight"
    error_message = "The initial verifier preflight configuration requires the preflight phase."
  }
}

locals {
  image_signature_verifier_standalone             = true
  image_signature_verifier_initialization         = false
  image_signature_verifier_alias_function_version = var.image_signature_verifier_reconciled_function_version
}
