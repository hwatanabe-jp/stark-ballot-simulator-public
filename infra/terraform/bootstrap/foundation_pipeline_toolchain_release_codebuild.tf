resource "aws_codebuild_project" "toolchain_release_candidate" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.toolchain_release_candidate_project_name
  service_role  = aws_iam_role.foundation_toolchain_release_candidate_build[0].arn
  build_timeout = 240

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_LARGE"
    image                       = "aws/codebuild/amazonlinux2-aarch64-standard:3.0"
    type                        = "ARM_CONTAINER"
    privileged_mode             = true
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "AWS_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "AWS_DEFAULT_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "IMAGE_REPO_NAME"
      value = "${local.foundation_runtime_name_prefix}/risc0-toolchain"
    }

    environment_variable {
      name  = "TOOLCHAIN_IMAGE_METADATA_BUCKET"
      value = local.foundation_release_manifest_bucket_name
    }

    environment_variable {
      name  = "SOURCE_REPOSITORY"
      value = "https://github.com/${var.github_full_repository_id}"
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.foundation_pipeline_codebuild[local.toolchain_release_candidate_project_name].name
      stream_name = "candidate"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "buildspec-risc0-toolchain.yml"
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_codebuild_project" "toolchain_release_promotion_evidence" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.toolchain_release_promotion_evidence_project_name
  service_role  = aws_iam_role.foundation_toolchain_release_promotion_evidence_build[0].arn
  build_timeout = 10

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "TOOLCHAIN_RELEASE_EVIDENCE_BUCKET"
      value = local.foundation_release_manifest_bucket_name
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.foundation_pipeline_codebuild[local.toolchain_release_promotion_evidence_project_name].name
      stream_name = "promotion-evidence"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        build = {
          commands = [
            "set -eu",
            "test -f image-info.json",
            "mkdir -p toolchain-release/evidence",
            trimspace(<<-EOT
node <<'NODE'
const fs = require('node:fs');
const metadata = JSON.parse(fs.readFileSync('image-info.json', 'utf8'));

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(name + ' is required.');
  }
  return value;
}

function requireString(name) {
  const value = metadata[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('image-info.json missing ' + name);
  }
  return value;
}

function requireGitSha(name, value) {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value)) {
    throw new Error(name + ' must be a 40- or 64-character lowercase Git SHA.');
  }
  return value;
}

const rawRequestedSourceSha = requireEnv('REQUESTED_SOURCE_SHA');
const sourceShaPinned = rawRequestedSourceSha !== '__MISSING_REQUESTED_SOURCE_SHA__';
const metadataRequestedSourceSha = requireGitSha('image-info.json requestedSourceSha', requireString('requestedSourceSha'));
const sourceSha = requireGitSha('image-info.json sourceSha', requireString('sourceSha'));
const requestedSourceSha = sourceShaPinned
  ? requireGitSha('REQUESTED_SOURCE_SHA', rawRequestedSourceSha)
  : sourceSha;
if (sourceShaPinned && metadataRequestedSourceSha !== requestedSourceSha) {
  throw new Error('image-info.json requestedSourceSha must match REQUESTED_SOURCE_SHA.');
}
const sourceShaMode = requireString('sourceShaMode');
if (sourceShaMode !== (sourceShaPinned ? 'pinned' : 'branch-head')) {
  throw new Error('image-info.json sourceShaMode must match the pipeline source pinning mode.');
}
if (sourceSha !== requestedSourceSha || metadataRequestedSourceSha !== sourceSha) {
  throw new Error('toolchain requested and resolved source SHA evidence must match.');
}

const digestPinnedImageUri = requireString('digestPinnedImageUri');
const imageDigest = requireString('imageDigest');
if (!/@sha256:[0-9a-f]{64}$/.test(digestPinnedImageUri)) {
  throw new Error('toolchain digestPinnedImageUri must be digest-pinned');
}
if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
  throw new Error('toolchain imageDigest must be sha256:<64 lowercase hex>');
}
if (metadata.signingStatus !== 'COMPLETE') {
  throw new Error('toolchain signingStatus must be COMPLETE');
}
const scanStatus = requireString('scanStatus');
if (scanStatus !== 'PASS' && scanStatus !== 'FINDINGS_PRESENT') {
  throw new Error('toolchain scanStatus must be PASS or FINDINGS_PRESENT');
}
if (!Number.isInteger(metadata.criticalHighCount) || metadata.criticalHighCount < 0) {
  throw new Error('toolchain criticalHighCount must be a non-negative integer');
}
const rawScanWaiverId = requireEnv('TOOLCHAIN_SCAN_WAIVER_ID');
const scanWaiverId = rawScanWaiverId === '__NO_TOOLCHAIN_SCAN_WAIVER__' ? null : rawScanWaiverId;
if (scanWaiverId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{2,255}$/.test(scanWaiverId)) {
  throw new Error('ToolchainScanWaiverId must be a stable non-secret evidence identifier.');
}
let recordedScanWaiverId = scanWaiverId;
if (scanStatus === 'PASS' && scanWaiverId !== null) {
  console.warn('ToolchainScanWaiverId is unused because the toolchain scan passed; dropping it from evidence.');
  recordedScanWaiverId = null;
}
if (scanStatus === 'FINDINGS_PRESENT' && scanWaiverId === null) {
  throw new Error('toolchain scan findings require a reviewed ToolchainScanWaiverId before promotion.');
}
const buildId = requireString('buildId');
const buildTimestamp = requireString('timestamp');
if (Number.isNaN(Date.parse(buildTimestamp))) {
  throw new Error('toolchain timestamp must be an ISO timestamp');
}

const evidence = {
  schemaVersion: 'develop-toolchain-promotion-evidence-v1',
  pipelineExecutionId: requireEnv('TOOLCHAIN_RELEASE_PIPELINE_EXECUTION_ID'),
  sourceSha: requestedSourceSha,
  requestedSourceSha,
  resolvedSourceSha: sourceSha,
  sourceShaMode,
  acceptedPointerKey: 'channels/develop/toolchain/accepted.json',
  scanWaiverId: recordedScanWaiverId,
  candidateMetadata: metadata,
  approval: {
    type: 'CodePipelineManualApproval',
    stage: 'ManualApproval',
    action: 'ApproveToolchainPromotion'
  },
  createdAt: new Date().toISOString()
};
fs.writeFileSync('toolchain-release/evidence/toolchain-promotion-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
NODE
EOT
            ),
            "test -n \"$TOOLCHAIN_RELEASE_EVIDENCE_BUCKET\"",
            "test -n \"$TOOLCHAIN_RELEASE_EVIDENCE_KEY\"",
            "aws s3api put-object --bucket \"$TOOLCHAIN_RELEASE_EVIDENCE_BUCKET\" --key \"$TOOLCHAIN_RELEASE_EVIDENCE_KEY\" --body toolchain-release/evidence/toolchain-promotion-evidence.json --content-type application/json --server-side-encryption AES256 --if-none-match '*' >/dev/null",
            "cat toolchain-release/evidence/toolchain-promotion-evidence.json",
          ]
        }
      }
      artifacts = {
        files = [
          "toolchain-release/evidence/toolchain-promotion-evidence.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_codebuild_project" "toolchain_release_update_accepted_pointer" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.toolchain_release_update_accepted_pointer_project_name
  service_role  = aws_iam_role.foundation_toolchain_release_update_accepted_pointer_build[0].arn
  build_timeout = 10

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "TOOLCHAIN_RELEASE_BUCKET"
      value = local.foundation_release_manifest_bucket_name
    }

    environment_variable {
      name  = "TOOLCHAIN_SIGNING_AUTHORITY_EVIDENCE_ID"
      value = "signing/profile/${local.foundation_ecr_signing_profile_name}"
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.foundation_pipeline_codebuild[local.toolchain_release_update_accepted_pointer_project_name].name
      stream_name = "update-accepted-pointer"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        build = {
          commands = [
            "set -eu",
            "test -f \"$CODEBUILD_SRC_DIR_ToolchainPromotionEvidenceOutput/toolchain-release/evidence/toolchain-promotion-evidence.json\"",
            "test -n \"$TOOLCHAIN_RELEASE_BUCKET\"",
            "test -n \"$TOOLCHAIN_ACCEPTED_POINTER_KEY\"",
            "mkdir -p toolchain-release/evidence",
            "cp \"$CODEBUILD_SRC_DIR_ToolchainPromotionEvidenceOutput/toolchain-release/evidence/toolchain-promotion-evidence.json\" toolchain-release/evidence/toolchain-promotion-evidence.json",
            trimspace(<<-EOT
node <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');

const evidence = JSON.parse(fs.readFileSync('toolchain-release/evidence/toolchain-promotion-evidence.json', 'utf8'));
const metadata = evidence.candidateMetadata;
if (!metadata || typeof metadata !== 'object') {
  throw new Error('toolchain-promotion-evidence.json must carry candidate metadata.');
}

function requireString(record, name) {
  const value = record[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('missing required field ' + name);
  }
  return value;
}

function requireDigestPinnedImageUri(value) {
  if (!/@sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error('toolchain imageUri must be digest-pinned before pointer promotion.');
  }
  return value;
}

const imageUri = requireDigestPinnedImageUri(requireString(metadata, 'digestPinnedImageUri'));
if (metadata.signingStatus !== 'COMPLETE') {
  throw new Error('toolchain signingStatus must be COMPLETE before pointer promotion.');
}
const scanWaiverId = typeof evidence.scanWaiverId === 'string' && evidence.scanWaiverId.length > 0 ? evidence.scanWaiverId : null;
if (metadata.scanStatus === 'PASS') {
  if (scanWaiverId !== null) {
    throw new Error('toolchain scan waiver must not accompany a PASS scan result.');
  }
} else if (metadata.scanStatus === 'FINDINGS_PRESENT') {
  if (scanWaiverId === null) {
    throw new Error('toolchain scan findings require a reviewed scan waiver before pointer promotion.');
  }
} else {
  throw new Error('toolchain scanStatus must be PASS or FINDINGS_PRESENT before pointer promotion.');
}

const pipelineExecutionId = requireString(evidence, 'pipelineExecutionId');
const artifactRecordKey = 'artifacts/toolchain/' + pipelineExecutionId + '/manifest.json';
const recordSourceShaMode = requireString(metadata, 'sourceShaMode');
if (recordSourceShaMode !== 'pinned' && recordSourceShaMode !== 'branch-head') {
  throw new Error('toolchain sourceShaMode must be pinned or branch-head before pointer promotion.');
}
const artifactRecord = {
  schemaVersion: 'develop-toolchain-artifact-v1',
  sourceSha: requireString(evidence, 'sourceSha'),
  sourceShaMode: recordSourceShaMode,
  imageUri,
  imageTag: requireString(metadata, 'imageTag'),
  imageDigest: requireString(metadata, 'imageDigest'),
  risc0Version: requireString(metadata, 'risc0Version'),
  rustVersion: requireString(metadata, 'rustVersion'),
  rustToolchainTag: requireString(metadata, 'rustToolchainTag'),
  signingStatus: 'COMPLETE',
  configuredSigningAuthorityEvidenceId: requireString(process.env, 'TOOLCHAIN_SIGNING_AUTHORITY_EVIDENCE_ID'),
  build: {
    candidateExecutionId: requireString(metadata, 'buildId'),
    retainedOutputLocator: requireString(process.env, 'TOOLCHAIN_RELEASE_EVIDENCE_KEY'),
    buildTimestamp: requireString(metadata, 'timestamp'),
  },
  approvals: {
    buildApprovalEvidenceId: 'toolchain-build/' + pipelineExecutionId,
    promotionApprovalEvidenceId: 'toolchain-promotion/' + pipelineExecutionId,
  },
};
if (scanWaiverId === null) {
  artifactRecord.scanStatus = 'PASS';
} else {
  artifactRecord.scanWaiverId = scanWaiverId;
}

fs.writeFileSync('toolchain-artifact-record.json', JSON.stringify(artifactRecord, null, 2) + '\n');
const artifactRecordSha256 = crypto.createHash('sha256').update(fs.readFileSync('toolchain-artifact-record.json')).digest('hex');
fs.writeFileSync('toolchain-release/evidence/artifact-record-publication.json', JSON.stringify({
  schemaVersion: 'develop-toolchain-artifact-record-publication-v1',
  artifactRecordKey,
  artifactRecordSha256,
}, null, 2) + '\n');
NODE
EOT
            ),
            "artifact_record_key=\"$(node -e \"const fs=require('node:fs'); console.log(JSON.parse(fs.readFileSync('toolchain-release/evidence/artifact-record-publication.json','utf8')).artifactRecordKey)\")\"",
            "toolchain_release_prefix=\"$(dirname \"$artifact_record_key\")\"",
            "TOOLCHAIN_ARTIFACT_RECORD_KEY=\"$artifact_record_key\" TOOLCHAIN_ARTIFACT_RECORD_BODY=toolchain-artifact-record.json TOOLCHAIN_ARTIFACT_RECORD_PUT_OUTPUT=put-toolchain-artifact-record.json TOOLCHAIN_ACCEPTED_POINTER_BODY=accepted-toolchain-pointer.json TOOLCHAIN_ACCEPTED_POINTER_HEAD_OUTPUT=previous-toolchain-pointer-etag.json TOOLCHAIN_ACCEPTED_POINTER_PUT_OUTPUT=put-accepted-toolchain-pointer.json TOOLCHAIN_ACCEPTED_POINTER_CAS_EVIDENCE=toolchain-release/evidence/accepted-pointer-cas-evidence.json TOOLCHAIN_ACCEPTED_POINTER_CONFLICT_KEY=\"$toolchain_release_prefix/accepted-pointer-conflict.json\" bash infra/terraform/bootstrap/app-pipeline-scripts/toolchain-release-promote-pointer.sh",
            "cat toolchain-release/evidence/accepted-pointer-cas-evidence.json",
          ]
        }
      }
      artifacts = {
        files = [
          "accepted-toolchain-pointer.json",
          "toolchain-artifact-record.json",
          "toolchain-release/evidence/accepted-pointer-cas-evidence.json",
          "toolchain-release/evidence/artifact-record-publication.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
