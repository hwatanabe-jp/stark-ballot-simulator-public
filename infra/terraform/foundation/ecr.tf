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

# ECR evaluates push order asynchronously; promoted and in-use images have no exemption.
resource "aws_ecr_lifecycle_policy" "images" {
  for_each = {
    toolchain = aws_ecr_repository.toolchain.name
    prover    = aws_ecr_repository.prover.name
  }
  repository = each.value
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain the five newest pushed images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}
