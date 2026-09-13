# Copied only into the private verifier-only saved-plan configuration.
# Ordinary App configuration never declares this selector.
variable "verifier_phase" {
  type = string
  validation {
    condition     = var.verifier_phase == "prerequisite"
    error_message = "The initial verifier configuration requires the prerequisite phase."
  }
}

locals {
  image_signature_verifier_standalone             = true
  image_signature_verifier_initialization         = true
  image_signature_verifier_alias_function_version = aws_lambda_function.image_signature_verifier.version
}
