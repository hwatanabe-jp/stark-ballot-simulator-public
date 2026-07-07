resource "aws_codebuild_project" "prover_release_toolchain_resolver" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.prover_release_toolchain_resolver_project_name
  service_role  = aws_iam_role.foundation_prover_release_toolchain_resolver_build[0].arn
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
      name  = "TOOLCHAIN_AUTHORITY_BUCKET"
      value = local.foundation_release_manifest_bucket_name
    }

    environment_variable {
      name = "EXPECTED_TOOLCHAIN_IMAGE_PREFIX"
      value = (
        "${var.aws_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/${local.foundation_runtime_name_prefix}/risc0-toolchain@sha256:"
      )
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.foundation_pipeline_codebuild[local.prover_release_toolchain_resolver_project_name].name
      stream_name = "toolchain-resolver"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "buildspec-prover-toolchain-authority.yml"
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_codebuild_project" "prover_release_candidate" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.prover_release_candidate_project_name
  service_role  = aws_iam_role.foundation_prover_release_candidate_build[0].arn
  build_timeout = 30

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
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
      value = "${local.foundation_runtime_name_prefix}/prover"
    }

    environment_variable {
      name  = "RISC0_TOOLCHAIN_REPO_NAME"
      value = "${local.foundation_runtime_name_prefix}/risc0-toolchain"
    }

    environment_variable {
      name  = "RISC0_TOOLCHAIN_IMAGE"
      value = "__MISSING_RISC0_TOOLCHAIN_IMAGE__"
    }

    environment_variable {
      name  = "REQUIRE_TOOLCHAIN_AUTHORITY_FILE"
      value = "true"
    }

    environment_variable {
      name  = "PROVER_IMAGE_METADATA_BUCKET"
      value = local.foundation_release_manifest_bucket_name
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.foundation_pipeline_codebuild[local.prover_release_candidate_project_name].name
      stream_name = "candidate"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "buildspec.yml"
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_codebuild_project" "prover_release_promotion_evidence" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.prover_release_promotion_evidence_project_name
  service_role  = aws_iam_role.foundation_prover_release_promotion_evidence_build[0].arn
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
      name  = "PROVER_RELEASE_EVIDENCE_BUCKET"
      value = local.foundation_release_manifest_bucket_name
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.foundation_pipeline_codebuild[local.prover_release_promotion_evidence_project_name].name
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
            "test -f image-metadata.json",
            "mkdir -p prover-release/evidence",
            trimspace(<<-EOT
node <<'NODE'
const fs = require('node:fs');
const metadata = JSON.parse(fs.readFileSync('image-metadata.json', 'utf8'));

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
    throw new Error('image-metadata.json missing ' + name);
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
const metadataRequestedSourceSha = requireGitSha('image-metadata.json requestedSourceSha', requireString('requestedSourceSha'));
const resolvedSourceSha = requireGitSha('image-metadata.json resolvedSourceSha', requireString('resolvedSourceSha'));
const legacySourceSha = requireGitSha('image-metadata.json sha', requireString('sha'));
const requestedSourceSha = sourceShaPinned
  ? requireGitSha('REQUESTED_SOURCE_SHA', rawRequestedSourceSha)
  : resolvedSourceSha;
if (sourceShaPinned && metadataRequestedSourceSha !== requestedSourceSha) {
  throw new Error('image-metadata.json requestedSourceSha must match REQUESTED_SOURCE_SHA.');
}
const sourceShaMode = requireString('sourceShaMode');
if (sourceShaMode !== (sourceShaPinned ? 'pinned' : 'branch-head')) {
  throw new Error('image-metadata.json sourceShaMode must match the pipeline source pinning mode.');
}
if (resolvedSourceSha !== requestedSourceSha || legacySourceSha !== resolvedSourceSha || metadataRequestedSourceSha !== resolvedSourceSha) {
  throw new Error('prover requested and resolved source SHA evidence must match.');
}

const imageUri = requireString('imageUri');
const digest = requireString('digest');
const imageId = requireString('risc0ImageId');
const postPushImageId = requireString('postPushRisc0ImageId');
const toolchainSelection = requireString('toolchainSelection');
const selectedToolchain = {
  artifactRecordKey: requireString('selectedToolchainArtifactRecordKey'),
  artifactRecordVersionId: requireString('selectedToolchainArtifactRecordVersionId'),
  artifactRecordSha256: requireString('selectedToolchainArtifactRecordSha256'),
  imageUri: requireString('risc0ToolchainImage')
};
if (!/@sha256:[0-9a-f]{64}$/.test(imageUri)) {
  throw new Error('prover imageUri must be digest-pinned');
}
if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
  throw new Error('prover digest must be sha256:<64 lowercase hex>');
}
if (!/^0x[0-9a-f]{64}$/.test(imageId)) {
  throw new Error('prover risc0ImageId must be 0x-prefixed lowercase hex');
}
if (postPushImageId !== imageId) {
  throw new Error('prover post-push ImageID must match built ImageID');
}
if (metadata.signingStatus !== 'COMPLETE') {
  throw new Error('prover signingStatus must be COMPLETE');
}
if (metadata.methodVersion !== metadata.postPushMethodVersion) {
  throw new Error('prover post-push methodVersion must match built methodVersion');
}
if (metadata.toolchainAuthoritySchemaVersion !== 'develop-prover-toolchain-authority-v1') {
  throw new Error('prover metadata must include resolver-validated toolchain authority');
}
let acceptedToolchainPointer = null;
if (toolchainSelection === 'accepted') {
  acceptedToolchainPointer = {
    key: requireString('acceptedToolchainPointerKey'),
    versionId: requireString('acceptedToolchainPointerVersionId'),
    sha256: requireString('acceptedToolchainPointerSha256')
  };
} else if (toolchainSelection !== 'pinned') {
  throw new Error('prover toolchainSelection must be accepted or pinned');
}
const evidence = {
  schemaVersion: 'develop-prover-promotion-evidence-v1',
  pipelineExecutionId: requireEnv('PROVER_RELEASE_PIPELINE_EXECUTION_ID'),
  sourceSha: requestedSourceSha,
  requestedSourceSha,
  resolvedSourceSha,
  sourceShaMode,
  acceptedPointerKey: 'channels/develop/prover/accepted.json',
  selectedToolchain,
  acceptedToolchainPointer,
  candidateMetadata: metadata,
  approval: {
    type: 'CodePipelineManualApproval',
    stage: 'ManualApproval',
    action: 'ApproveProverPromotion'
  },
  createdAt: new Date().toISOString()
};
fs.writeFileSync('prover-release/evidence/prover-promotion-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
NODE
EOT
            ),
            "test -n \"$PROVER_RELEASE_EVIDENCE_BUCKET\"",
            "test -n \"$PROVER_RELEASE_EVIDENCE_KEY\"",
            "aws s3api put-object --bucket \"$PROVER_RELEASE_EVIDENCE_BUCKET\" --key \"$PROVER_RELEASE_EVIDENCE_KEY\" --body prover-release/evidence/prover-promotion-evidence.json --content-type application/json --server-side-encryption AES256 --if-none-match '*' >/dev/null",
            "cat prover-release/evidence/prover-promotion-evidence.json",
          ]
        }
      }
      artifacts = {
        files = [
          "prover-release/evidence/prover-promotion-evidence.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_codebuild_project" "prover_release_update_accepted_pointer" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.prover_release_update_accepted_pointer_project_name
  service_role  = aws_iam_role.foundation_prover_release_update_accepted_pointer_build[0].arn
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
      name  = "PROVER_RELEASE_BUCKET"
      value = local.foundation_release_manifest_bucket_name
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.foundation_pipeline_codebuild[local.prover_release_update_accepted_pointer_project_name].name
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
            "test -f \"$CODEBUILD_SRC_DIR_PromotionEvidenceOutput/prover-release/evidence/prover-promotion-evidence.json\"",
            "test -n \"$PROVER_RELEASE_BUCKET\"",
            "test -n \"$PROVER_ACCEPTED_POINTER_KEY\"",
            "mkdir -p prover-release/evidence",
            "cp \"$CODEBUILD_SRC_DIR_PromotionEvidenceOutput/prover-release/evidence/prover-promotion-evidence.json\" prover-release/evidence/prover-promotion-evidence.json",
            trimspace(<<-EOT
node <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');

const evidence = JSON.parse(fs.readFileSync('prover-release/evidence/prover-promotion-evidence.json', 'utf8'));
const metadata = evidence.candidateMetadata;
if (!metadata || typeof metadata !== 'object') {
  throw new Error('prover-promotion-evidence.json must carry candidate metadata.');
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
    throw new Error('prover imageUri must be digest-pinned before pointer promotion.');
  }
  return value;
}

const imageUri = requireDigestPinnedImageUri(requireString(metadata, 'imageUri'));
const expectedImageId = requireString(metadata, 'risc0ImageId');
const prePushImageId = expectedImageId;
const postPushImageId = requireString(metadata, 'postPushRisc0ImageId');
if (prePushImageId !== expectedImageId || postPushImageId !== expectedImageId) {
  throw new Error('prover ImageID equality evidence must match before pointer promotion.');
}
if (metadata.signingStatus !== 'COMPLETE') {
  throw new Error('prover signingStatus must be COMPLETE before pointer promotion.');
}
if (metadata.methodVersion !== metadata.postPushMethodVersion) {
  throw new Error('prover methodVersion equality evidence must match before pointer promotion.');
}
if (metadata.scanStatus !== 'PASS') {
  throw new Error('prover scanStatus must be explicitly PASS before pointer promotion.');
}

const pipelineExecutionId = requireString(evidence, 'pipelineExecutionId');
const releaseRecordKey = 'artifacts/prover/' + pipelineExecutionId + '/manifest.json';
const recordSourceShaMode = requireString(metadata, 'sourceShaMode');
if (recordSourceShaMode !== 'pinned' && recordSourceShaMode !== 'branch-head') {
  throw new Error('prover sourceShaMode must be pinned or branch-head before pointer promotion.');
}
const releaseRecord = {
  schemaVersion: 'develop-prover-release-v1',
  sourceSha: requireString(evidence, 'sourceSha'),
  sourceShaMode: recordSourceShaMode,
  selectedToolchain: evidence.selectedToolchain,
  imageUri,
  expectedImageId,
  methodVersion: metadata.methodVersion,
  imageIdVariant: 'default',
  scanStatus: metadata.scanStatus,
  signingStatus: 'COMPLETE',
  build: {
    candidateExecutionId: requireString(metadata, 'buildId'),
    retainedOutputLocator: requireString(process.env, 'PROVER_RELEASE_EVIDENCE_KEY'),
    buildTimestamp: requireString(metadata, 'timestamp'),
  },
  approvals: {
    buildApprovalEvidenceId: 'prover-build/' + pipelineExecutionId,
    promotionApprovalEvidenceId: 'prover-promotion/' + pipelineExecutionId,
  },
  evidence: {
    prePushImageId,
    postPushImageId,
    methodVersionEvidenceId: 'prover-method-version/' + String(metadata.methodVersion),
  },
};

fs.writeFileSync('prover-release-record.json', JSON.stringify(releaseRecord, null, 2) + '\n');
const releaseRecordSha256 = crypto.createHash('sha256').update(fs.readFileSync('prover-release-record.json')).digest('hex');
fs.writeFileSync('prover-release/evidence/release-record-publication.json', JSON.stringify({
  schemaVersion: 'develop-prover-release-record-publication-v1',
  releaseRecordKey,
  releaseRecordSha256,
}, null, 2) + '\n');
NODE
EOT
            ),
            "release_record_key=\"$(node -e \"const fs=require('node:fs'); console.log(JSON.parse(fs.readFileSync('prover-release/evidence/release-record-publication.json','utf8')).releaseRecordKey)\")\"",
            "release_record_sha256=\"$(node -e \"const fs=require('node:fs'); console.log(JSON.parse(fs.readFileSync('prover-release/evidence/release-record-publication.json','utf8')).releaseRecordSha256)\")\"",
            "prover_release_prefix=\"$(dirname \"$release_record_key\")\"",
            "PROVER_RELEASE_RECORD_KEY=\"$release_record_key\" PROVER_RELEASE_RECORD_BODY=prover-release-record.json PROVER_RELEASE_RECORD_PUT_OUTPUT=put-prover-release-record.json PROVER_ACCEPTED_POINTER_BODY=accepted-prover-pointer.json PROVER_ACCEPTED_POINTER_HEAD_OUTPUT=previous-prover-pointer-etag.json PROVER_ACCEPTED_POINTER_PUT_OUTPUT=put-accepted-prover-pointer.json PROVER_ACCEPTED_POINTER_CAS_EVIDENCE=prover-release/evidence/accepted-pointer-cas-evidence.json PROVER_ACCEPTED_POINTER_CONFLICT_KEY=\"$prover_release_prefix/accepted-pointer-conflict.json\" bash infra/terraform/bootstrap/app-pipeline-scripts/prover-release-promote-pointer.sh",
            "cat prover-release/evidence/accepted-pointer-cas-evidence.json",
          ]
        }
      }
      artifacts = {
        files = [
          "accepted-prover-pointer.json",
          "prover-release-record.json",
          "prover-release/evidence/accepted-pointer-cas-evidence.json",
          "prover-release/evidence/release-record-publication.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
