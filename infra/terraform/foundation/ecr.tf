resource "aws_ecr_repository" "toolchain" {
  name                 = local.toolchain_repository_name
  image_tag_mutability = "IMMUTABLE"

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
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

  tags = local.common_tags
}

resource "aws_ecr_lifecycle_policy" "toolchain" {
  repository = aws_ecr_repository.toolchain.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain the latest 200 candidate toolchain images"
      selection = {
        tagStatus     = "tagged"
        tagPrefixList = ["candidate-"]
        countType     = "imageCountMoreThan"
        countNumber   = 200
      }
      action = {
        type = "expire"
      }
    }]
  })
}

resource "aws_ecr_lifecycle_policy" "prover" {
  repository = aws_ecr_repository.prover.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain the latest 200 candidate prover images"
      selection = {
        tagStatus     = "tagged"
        tagPrefixList = ["candidate-"]
        countType     = "imageCountMoreThan"
        countNumber   = 200
      }
      action = {
        type = "expire"
      }
    }]
  })
}
