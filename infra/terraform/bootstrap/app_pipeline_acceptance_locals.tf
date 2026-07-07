locals {
  app_acceptance_publish_command = <<-EOT
set -eu
test -n "$CODEBUILD_RESOLVED_SOURCE_VERSION"
test -d "${local.app_accepted_marker_path}/$CODEBUILD_RESOLVED_SOURCE_VERSION"
aws s3 sync "${local.app_accepted_marker_path}/$CODEBUILD_RESOLVED_SOURCE_VERSION/" "s3://${local.app_pipeline_artifact_bucket_name}/${local.app_accepted_marker_path}/$CODEBUILD_RESOLVED_SOURCE_VERSION/" --delete --no-progress
aws s3 cp "${local.app_accepted_marker_path}/index.json" "s3://${local.app_pipeline_artifact_bucket_name}/${local.app_accepted_marker_path}/index.json" --no-progress
EOT
}
