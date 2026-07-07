resource "aws_ssm_parameter" "prover_current_image_metadata" {
  name        = local.prover_current_metadata_parameter
  description = "Current prover image metadata candidate JSON published by CodeBuild"
  type        = "String"
  value       = "{}"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Name = "${var.project_name}-prover-current-image-metadata-${var.environment}"
  }
}
