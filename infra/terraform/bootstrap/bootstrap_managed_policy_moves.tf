moved {
  from = aws_iam_policy.bootstrap_apply_app_lane_artifacts_management
  to   = aws_iam_policy.terraform_baseline_authority_runtime_management
}

moved {
  from = aws_iam_role_policy_attachment.bootstrap_apply_app_lane_artifacts_management
  to   = aws_iam_role_policy_attachment.terraform_baseline_authority_runtime_management
}
