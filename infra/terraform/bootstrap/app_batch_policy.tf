locals {
  app_batch_named_resources = [
    "arn:aws:batch:${var.aws_region}:${var.aws_account_id}:compute-environment/${local.app_runtime_name_prefix}-prover",
    "arn:aws:batch:${var.aws_region}:${var.aws_account_id}:job-queue/${local.app_runtime_name_prefix}-prover",
    "arn:aws:batch:${var.aws_region}:${var.aws_account_id}:job-definition/${local.app_runtime_name_prefix}-prover:*",
    "arn:aws:batch:${var.aws_region}:${var.aws_account_id}:job-definition/${local.app_runtime_name_prefix}-prover",
    "arn:aws:batch:${var.aws_region}:${var.aws_account_id}:consumable-resource/${local.app_runtime_name_prefix}-prover-slots",
  ]
  app_batch_stack_arn        = "arn:aws:cloudformation:${var.aws_region}:${var.aws_account_id}:stack/${local.app_runtime_name_prefix}-prover-job/*"
  app_batch_service_role_arn = "arn:aws:iam::${var.aws_account_id}:role/aws-service-role/batch.amazonaws.com/AWSServiceRoleForBatch"
}

data "aws_iam_policy_document" "app_batch_read" {
  statement {
    sid       = "DescribeBatchRuntime"
    effect    = "Allow"
    actions   = ["batch:DescribeComputeEnvironments", "batch:DescribeJobQueues", "batch:DescribeJobDefinitions"]
    resources = ["*"]
  }
  statement {
    sid       = "ReadBatchTags"
    effect    = "Allow"
    actions   = ["batch:ListTagsForResource", "batch:DescribeConsumableResource"]
    resources = local.app_batch_named_resources
  }
  statement {
    sid       = "ReadProverJobStack"
    effect    = "Allow"
    actions   = ["cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents", "cloudformation:GetTemplate", "cloudformation:ListStackResources"]
    resources = [local.app_batch_stack_arn]
  }

}

data "aws_iam_policy_document" "app_batch_write" {
  source_policy_documents = [data.aws_iam_policy_document.app_batch_read.json]
  statement {
    sid    = "ManageTargetBatchRuntime"
    effect = "Allow"
    actions = [
      "batch:CreateComputeEnvironment", "batch:UpdateComputeEnvironment", "batch:DeleteComputeEnvironment",
      "batch:CreateJobQueue", "batch:UpdateJobQueue", "batch:DeleteJobQueue",
      "batch:RegisterJobDefinition", "batch:DeregisterJobDefinition", "batch:CreateConsumableResource", "batch:UpdateConsumableResource", "batch:DeleteConsumableResource", "batch:SetCapacityTags",
      "batch:TagResource", "batch:UntagResource",
    ]
    resources = local.app_batch_named_resources
  }
  statement {
    sid       = "ManageProverJobStack"
    effect    = "Allow"
    actions   = ["cloudformation:CreateStack", "cloudformation:UpdateStack", "cloudformation:DeleteStack"]
    resources = [local.app_batch_stack_arn]
  }
  statement {
    sid       = "CreateBatchServiceRole"
    effect    = "Allow"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = [local.app_batch_service_role_arn]
    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values   = ["batch.amazonaws.com"]
    }
  }

}

resource "aws_iam_policy" "app_batch_write" {
  count  = local.app_pipeline_enabled ? 1 : 0
  name   = "${local.app_runtime_name_prefix}-batch-deployment"
  policy = data.aws_iam_policy_document.app_batch_write.json
  tags   = local.common_tags
}

resource "aws_iam_role_policy_attachment" "app_batch_write" {
  count      = local.app_pipeline_enabled ? 1 : 0
  role       = aws_iam_role.app_terraform_apply[0].name
  policy_arn = aws_iam_policy.app_batch_write[0].arn
}

resource "aws_iam_policy" "app_batch_read" {
  count  = local.app_pipeline_enabled ? 1 : 0
  name   = "${local.app_runtime_name_prefix}-batch-read"
  policy = data.aws_iam_policy_document.app_batch_read.json
  tags   = local.common_tags
}
resource "aws_iam_role_policy_attachment" "app_batch_read" {
  count      = local.app_pipeline_enabled ? 1 : 0
  role       = aws_iam_role.app_terraform_plan[0].name
  policy_arn = aws_iam_policy.app_batch_read[0].arn
}
