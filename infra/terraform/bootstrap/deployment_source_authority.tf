data "aws_iam_policy_document" "pipeline_assume_role" {
  count = local.pipeline_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["codepipeline.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "codebuild_assume_role" {
  count = local.pipeline_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_codeconnections_connection" "source" {
  count = local.pipeline_enabled ? 1 : 0

  name          = local.codeconnection_name
  provider_type = "GitHub"

  tags = merge(local.common_tags, {
    Name = local.codeconnection_name
  })
}
