locals {
  app_acceptance_publish_command = <<-EOT
APP_PIPELINE_ARTIFACT_BUCKET="${local.app_pipeline_artifact_bucket_name}" \
  bash infra/terraform/bootstrap/app-pipeline-scripts/app-acceptance-publish.sh
EOT
  app_acceptance_event_publish_command = (
    "bash infra/terraform/bootstrap/app-pipeline-scripts/app-acceptance-event-publish.sh"
  )
}
