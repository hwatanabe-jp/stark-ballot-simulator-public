resource "aws_ecr_repository" "toolchain" {
  name                 = local.toolchain_repository_name
  image_tag_mutability = "IMMUTABLE"

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = local.common_tags
}

resource "aws_ecr_repository" "prover" {
  name                 = local.prover_repository_name
  image_tag_mutability = "IMMUTABLE"

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = local.common_tags
}
