#!/usr/bin/env bash
# RISC Zero toolchain image resolver.
#
# Purpose: resolve the digest-pinned ARM64 RISC Zero toolchain image from ECR
# without writing private ECR URIs into tracked Dockerfiles.

set -euo pipefail
IFS=$'\n\t'

usage() {
  cat <<'EOF'
Usage:
  AWS_ACCOUNT_ID=<account-id> ./scripts/update-risc0-digest.sh [--write-env <path>]

Environment:
  AWS_ACCOUNT_ID                AWS account that owns the ECR registry
  AWS_REGION                    default: ap-northeast-1
  AWS_PROFILE                   optional AWS CLI profile
  RISC0_TOOLCHAIN_REPO_NAME     default: stark-ballot-simulator/risc0-toolchain
  RISC0_VERSION                 default: 3.0.5
  RISC0_TOOLCHAIN_IMAGE_TAG     default: ${RISC0_VERSION}-arm64

The command prints variable names and the digest only. Use --write-env to write
RISC0_TOOLCHAIN_IMAGE=<registry>/<repo>@<digest> to a git-ignored local file.
EOF
}

write_env_path=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --write-env)
      write_env_path="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

REPOSITORY="${RISC0_TOOLCHAIN_REPO_NAME:-stark-ballot-simulator/risc0-toolchain}"
RISC0_VERSION="${RISC0_VERSION:-3.0.5}"
IMAGE_TAG="${RISC0_TOOLCHAIN_IMAGE_TAG:-${RISC0_VERSION}-arm64}"
AWS_REGION="${AWS_REGION:-ap-northeast-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-}"
AWS_PROFILE="${AWS_PROFILE:-}"

AWS_PROFILE_ARGS=()
if [ -n "$AWS_PROFILE" ]; then
  AWS_PROFILE_ARGS=(--profile "$AWS_PROFILE")
fi

if [ -z "$AWS_ACCOUNT_ID" ]; then
  echo "AWS_ACCOUNT_ID must be set." >&2
  echo "Example: AWS_ACCOUNT_ID=<account-id> $0" >&2
  exit 2
fi

if [[ ! "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
  echo "AWS_ACCOUNT_ID must be a 12-digit account ID." >&2
  exit 2
fi

CALLER_ACCOUNT_ID=$(aws sts get-caller-identity \
  "${AWS_PROFILE_ARGS[@]}" \
  --query Account \
  --output text)

if [ -z "$CALLER_ACCOUNT_ID" ] || [ "$CALLER_ACCOUNT_ID" = "None" ]; then
  echo "Could not resolve the active AWS account ID." >&2
  exit 1
fi

if [ "$CALLER_ACCOUNT_ID" != "$AWS_ACCOUNT_ID" ]; then
  echo "AWS_ACCOUNT_ID does not match active AWS credentials." >&2
  exit 2
fi

echo "Resolving RISC Zero toolchain image digest..."
echo "Repository: $REPOSITORY"
echo "Tag: $IMAGE_TAG"

DIGEST=$(aws ecr describe-images \
  "${AWS_PROFILE_ARGS[@]}" \
  --repository-name "$REPOSITORY" \
  --image-ids imageTag="$IMAGE_TAG" \
  --region "$AWS_REGION" \
  --query 'imageDetails[0].imageDigest' \
  --output text)

if [ -z "$DIGEST" ] || [ "$DIGEST" = "None" ]; then
  echo "Image not found in ECR: $REPOSITORY:$IMAGE_TAG" >&2
  echo "Build and push the base image first. See docs/current/guides/3-deployment/risc0-base-image.md" >&2
  exit 1
fi

FULL_IMAGE="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$REPOSITORY@$DIGEST"

echo "Digest: $DIGEST"
echo "Use it locally with:"
echo '  docker build --build-arg RISC0_TOOLCHAIN_IMAGE="$RISC0_TOOLCHAIN_IMAGE" -f docker/Dockerfile.fargate-prover .'

if [ -n "$write_env_path" ]; then
  mkdir -p "$(dirname "$write_env_path")"
  printf 'RISC0_TOOLCHAIN_IMAGE=%s\n' "$FULL_IMAGE" > "$write_env_path"
  echo "Wrote RISC0_TOOLCHAIN_IMAGE to $write_env_path"
else
  echo "To write a local env file, rerun with --write-env .tmp/risc0-toolchain-image.env"
fi
