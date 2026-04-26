resource "aws_codebuild_project" "zkvm_prover" {
  name          = "${var.project_name}-fargate-prover-${var.environment}"
  description   = "Builds the STARK Ballot Simulator zkVM prover Docker image"
  service_role  = aws_iam_role.codebuild.arn
  build_timeout = 30

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/amazonlinux2-aarch64-standard:3.0"
    type                        = "ARM_CONTAINER"
    privileged_mode             = true
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "AWS_DEFAULT_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "IMAGE_REPO_NAME"
      value = aws_ecr_repository.zkvm_prover.name
    }

    environment_variable {
      name  = "AWS_ACCOUNT_ID"
      value = data.aws_caller_identity.current.account_id
    }

    environment_variable {
      name  = "RISC0_TOOLCHAIN_REPO_NAME"
      value = aws_ecr_repository.risc0_toolchain.name
    }

    environment_variable {
      name  = "RISC0_VERSION"
      value = var.risc0_version
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.codebuild.name
      stream_name = "build"
    }
  }

  source {
    type            = "GITHUB"
    location        = var.codebuild_source_location
    buildspec       = "buildspec.yml"
    git_clone_depth = 1
  }

  source_version = "refs/heads/${var.environment}"

  tags = {
    Name = "${var.project_name}-codebuild-${var.environment}"
  }
}

resource "aws_codebuild_project" "risc0_toolchain" {
  provider      = aws.shared
  name          = var.risc0_toolchain_codebuild_name
  description   = "Builds the RISC Zero toolchain ARM64 base image"
  service_role  = aws_iam_role.codebuild_risc0_toolchain.arn
  build_timeout = 120

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_LARGE"
    image                       = "aws/codebuild/amazonlinux2-aarch64-standard:3.0"
    type                        = "ARM_CONTAINER"
    privileged_mode             = true
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "AWS_DEFAULT_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "IMAGE_REPO_NAME"
      value = aws_ecr_repository.risc0_toolchain.name
    }

    environment_variable {
      name  = "AWS_ACCOUNT_ID"
      value = data.aws_caller_identity.current.account_id
    }

    environment_variable {
      name  = "RISC0_VERSION"
      value = var.risc0_version
    }

    environment_variable {
      name  = "RISC0_COMMIT"
      value = var.risc0_commit
    }

    environment_variable {
      name  = "RUST_VERSION"
      value = var.risc0_rust_version
    }

    environment_variable {
      name  = "RUST_TOOLCHAIN_TAG"
      value = var.risc0_rust_toolchain_tag
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.codebuild_risc0_toolchain.name
      stream_name = "build"
    }
  }

  source {
    type            = "GITHUB"
    location        = var.codebuild_source_location
    buildspec       = "buildspec-risc0-toolchain.yml"
    git_clone_depth = 1
  }

  # The toolchain image is shared by develop/main, so always build it from main
  # unless a different Git ref is intentionally configured in Terraform.
  source_version = var.risc0_toolchain_source_version

  tags = {
    Name = var.risc0_toolchain_codebuild_name
  }
}
