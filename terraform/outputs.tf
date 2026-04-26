# Terraform Outputs
# これらの出力値は Amplify 側で管理している環境変数と対応します
# Terraform / CLI ワークフローから Amplify の環境変数は更新しません

# 基本情報
output "environment" {
  description = "Deployment environment"
  value       = var.environment
}

output "aws_region" {
  description = "AWS Region"
  value       = var.aws_region
}

output "s3_bucket_name" {
  description = "S3 Bucket name for proof bundles (used by Amplify env var S3_PROOF_BUCKET)"
  value       = aws_s3_bucket.proof_bundles.bucket
}

output "ecr_repository_url" {
  description = "ECR repository URL for zkVM prover images"
  value       = aws_ecr_repository.zkvm_prover.repository_url
}

output "risc0_toolchain_repository_url" {
  description = "ECR repository URL for RISC Zero toolchain base images"
  value       = aws_ecr_repository.risc0_toolchain.repository_url
}

output "prover_state_machine_arn" {
  description = "Step Functions state machine ARN (PROVER_STATE_MACHINE_ARN)"
  value       = aws_sfn_state_machine.prover_dispatcher.arn
}

output "prover_work_queue_arn" {
  description = "SQS queue ARN for prover work messages (PROVER_WORK_QUEUE_ARN)"
  value       = aws_sqs_queue.prover_work.arn
}

output "prover_work_queue_url" {
  description = "SQS queue URL for prover work messages (PROVER_WORK_QUEUE_URL)"
  value       = aws_sqs_queue.prover_work.id
}
