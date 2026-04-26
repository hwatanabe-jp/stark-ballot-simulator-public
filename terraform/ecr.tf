resource "aws_ecr_repository" "zkvm_prover" {
  name                 = "${var.project_name}/zkvm-prover-${var.environment}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "${var.project_name}-ecr-${var.environment}"
  }
}

resource "aws_ecr_lifecycle_policy" "zkvm_prover" {
  repository = aws_ecr_repository.zkvm_prover.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

resource "aws_ecr_repository" "risc0_toolchain" {
  provider             = aws.shared
  name                 = "${var.project_name}/risc0-toolchain"
  image_tag_mutability = "MUTABLE"

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "${var.project_name}-risc0-toolchain-shared"
  }
}

resource "aws_ecr_lifecycle_policy" "risc0_toolchain" {
  provider   = aws.shared
  repository = aws_ecr_repository.risc0_toolchain.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last ${var.risc0_toolchain_image_retention_count} images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.risc0_toolchain_image_retention_count
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}
