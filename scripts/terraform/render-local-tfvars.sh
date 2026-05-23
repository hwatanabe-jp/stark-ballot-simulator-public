#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

usage() {
  cat <<'EOF'
Usage:
  scripts/terraform/render-local-tfvars.sh <develop|main> [--env-file .env.local] [--output terraform/<env>.local.tfvars]

Reads Terraform deployment values from an .env-style file and writes a git-ignored
local tfvars file. The command reports variable names only, not secret or account values.

Required values may be provided directly:
  TERRAFORM_ECS_IMAGE_URI_<ENV>
  TERRAFORM_ECR_SIGNING_PROFILE_ARN
  TERRAFORM_FINALIZE_CALLBACK_LAMBDA_ARN_<ENV>
  TERRAFORM_CODESTAR_CONNECTION_ARN
  TERRAFORM_CODEBUILD_SOURCE_LOCATION
  TERRAFORM_S3_CORS_ALLOWED_ORIGINS_<ENV>  # comma-separated origins

Or derived from:
  TERRAFORM_AWS_ACCOUNT_ID
  TERRAFORM_ZKVM_PROVER_DIGEST_<ENV>
  TERRAFORM_ECR_SIGNING_PROFILE_NAME
  TERRAFORM_FINALIZE_CALLBACK_FUNCTION_NAME_<ENV>
  TERRAFORM_CODESTAR_CONNECTION_ID
EOF
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

load_env_file() {
  local env_file="$1"
  local line key value

  if [ ! -f "$env_file" ]; then
    echo "Env file not found: $env_file" >&2
    exit 2
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    line="$(trim "$line")"
    case "$line" in
      ''|'#'*)
        continue
        ;;
    esac

    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="$(trim "${BASH_REMATCH[2]}")"
      if [[ "$value" == \"*\" && "$value" == *\" ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
        value="${value:1:${#value}-2}"
      fi
      if [ -z "${!key+x}" ]; then
        export "$key=$value"
      fi
    fi
  done < "$env_file"
}

first_nonempty() {
  local name value
  for name in "$@"; do
    value="${!name:-}"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 1
}

hcl_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

reject_placeholder() {
  local label="$1"
  local value="$2"

  case "$value" in
    *'<'*|*'>'*|*change-me*|*CHANGE_ME*|*placeholder*|*PLACEHOLDER*)
      echo "Value for $label still looks like a placeholder." >&2
      exit 2
      ;;
  esac
}

require_digest() {
  local label="$1"
  local value="$2"

  if [[ ! "$value" =~ @sha256:[0-9a-f]{64}$ ]]; then
    echo "$label must be digest-pinned with @sha256:<64 lowercase hex chars>." >&2
    exit 2
  fi
}

has_nonempty_csv_value() {
  local raw="$1"
  local -a values=()
  local value

  if [ -n "$raw" ]; then
    IFS=',' read -r -a values <<< "$raw"
  fi

  for value in "${values[@]}"; do
    value="$(trim "$value")"
    if [ -n "$value" ]; then
      return 0
    fi
  done

  return 1
}

validate_origins() {
  local label="$1"
  local raw="$2"
  local -a origins=()
  local origin

  if [ -n "$raw" ]; then
    IFS=',' read -r -a origins <<< "$raw"
  fi

  for origin in "${origins[@]}"; do
    origin="$(trim "$origin")"
    if [ -z "$origin" ]; then
      continue
    fi
    reject_placeholder "$label" "$origin"
    if [[ ! "$origin" =~ ^https?://[^[:space:],]+$ ]]; then
      echo "$label entries must be HTTP(S) origins without spaces or commas." >&2
      exit 2
    fi
  done
}

validate_codebuild_source_location() {
  local label="$1"
  local value="$2"

  if [[ ! "$value" =~ ^https://github\.com/[^[:space:]/]+/[^[:space:]/]+(\.git)?$ ]]; then
    echo "$label must be a concrete GitHub HTTPS repository URL." >&2
    exit 2
  fi
}

render_origins() {
  local raw="$1"
  local -a origins=()
  local origin

  if [ -n "$raw" ]; then
    IFS=',' read -r -a origins <<< "$raw"
  fi

  if [ "${#origins[@]}" -eq 0 ]; then
    printf '[]'
    return 0
  fi

  printf '['
  local first=1
  for origin in "${origins[@]}"; do
    origin="$(trim "$origin")"
    if [ -z "$origin" ]; then
      continue
    fi
    if [ "$first" -eq 0 ]; then
      printf ', '
    fi
    hcl_quote "$origin"
    first=0
  done
  printf ']'
}

env_name=""
env_file=".env.local"
env_file_explicit=0
output_file=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    develop|main)
      env_name="$1"
      shift
      ;;
    --env-file)
      env_file="${2:-}"
      env_file_explicit=1
      shift 2
      ;;
    --output)
      output_file="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$env_name" ]; then
  echo "Environment must be develop or main." >&2
  usage >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

if [ -z "$output_file" ]; then
  output_file="terraform/${env_name}.local.tfvars"
fi

env_source="shell environment"
if [ -f "$env_file" ]; then
  load_env_file "$env_file"
  env_source="$env_file"
elif [ "$env_file_explicit" -eq 1 ]; then
  echo "Env file not found: $env_file" >&2
  exit 2
fi

env_upper="${env_name^^}"
aws_region="$(first_nonempty "TERRAFORM_AWS_REGION_${env_upper}" TERRAFORM_AWS_REGION AWS_REGION AWS_DEFAULT_REGION || true)"
aws_region="${aws_region:-ap-northeast-1}"
project_name="$(first_nonempty "TERRAFORM_PROJECT_NAME_${env_upper}" TERRAFORM_PROJECT_NAME PROJECT_NAME || true)"
project_name="${project_name:-stark-ballot-simulator}"
account_id="$(first_nonempty "TERRAFORM_AWS_ACCOUNT_ID_${env_upper}" TERRAFORM_AWS_ACCOUNT_ID AWS_ACCOUNT_ID || true)"

ecs_image_uri="$(first_nonempty "TERRAFORM_ECS_IMAGE_URI_${env_upper}" TERRAFORM_ECS_IMAGE_URI || true)"
if [ -z "$ecs_image_uri" ]; then
  prover_digest="$(first_nonempty "TERRAFORM_ZKVM_PROVER_DIGEST_${env_upper}" TERRAFORM_ZKVM_PROVER_DIGEST || true)"
  if [[ "$prover_digest" =~ ^[0-9a-f]{64}$ ]]; then
    prover_digest="sha256:${prover_digest}"
  fi
  if [ -n "$account_id" ] && [ -n "$prover_digest" ]; then
    ecs_image_uri="${account_id}.dkr.ecr.${aws_region}.amazonaws.com/${project_name}/zkvm-prover-${env_name}@${prover_digest}"
  fi
fi

ecr_signing_profile_arn="$(first_nonempty "TERRAFORM_ECR_SIGNING_PROFILE_ARN_${env_upper}" TERRAFORM_ECR_SIGNING_PROFILE_ARN || true)"
if [ -z "$ecr_signing_profile_arn" ]; then
  signing_profile_name="$(first_nonempty "TERRAFORM_ECR_SIGNING_PROFILE_NAME_${env_upper}" TERRAFORM_ECR_SIGNING_PROFILE_NAME || true)"
  if [ -n "$account_id" ] && [ -n "$signing_profile_name" ]; then
    ecr_signing_profile_arn="arn:aws:signer:${aws_region}:${account_id}:/signing-profiles/${signing_profile_name}"
  fi
fi

finalize_callback_lambda_arn="$(first_nonempty "TERRAFORM_FINALIZE_CALLBACK_LAMBDA_ARN_${env_upper}" TERRAFORM_FINALIZE_CALLBACK_LAMBDA_ARN || true)"
if [ -z "$finalize_callback_lambda_arn" ]; then
  callback_function_name="$(first_nonempty "TERRAFORM_FINALIZE_CALLBACK_FUNCTION_NAME_${env_upper}" TERRAFORM_FINALIZE_CALLBACK_FUNCTION_NAME || true)"
  if [ -n "$account_id" ] && [ -n "$callback_function_name" ]; then
    finalize_callback_lambda_arn="arn:aws:lambda:${aws_region}:${account_id}:function:${callback_function_name}"
  fi
fi

codestar_connection_arn="$(first_nonempty "TERRAFORM_CODESTAR_CONNECTION_ARN_${env_upper}" TERRAFORM_CODESTAR_CONNECTION_ARN || true)"
if [ -z "$codestar_connection_arn" ]; then
  codestar_connection_id="$(first_nonempty "TERRAFORM_CODESTAR_CONNECTION_ID_${env_upper}" TERRAFORM_CODESTAR_CONNECTION_ID || true)"
  if [ -n "$account_id" ] && [ -n "$codestar_connection_id" ]; then
    codestar_connection_arn="arn:aws:codestar-connections:${aws_region}:${account_id}:connection/${codestar_connection_id}"
  fi
fi

codebuild_source_location="$(
  first_nonempty "TERRAFORM_CODEBUILD_SOURCE_LOCATION_${env_upper}" TERRAFORM_CODEBUILD_SOURCE_LOCATION || true
)"
s3_cors_allowed_origins="$(first_nonempty "TERRAFORM_S3_CORS_ALLOWED_ORIGINS_${env_upper}" TERRAFORM_S3_CORS_ALLOWED_ORIGINS || true)"

missing=()
if [ -z "$ecs_image_uri" ]; then
  missing+=("TERRAFORM_ECS_IMAGE_URI_${env_upper} or TERRAFORM_ZKVM_PROVER_DIGEST_${env_upper}")
fi
if [[ ! "$account_id" =~ ^[0-9]{12}$ ]]; then
  missing+=("TERRAFORM_AWS_ACCOUNT_ID_${env_upper} or TERRAFORM_AWS_ACCOUNT_ID")
fi
if [ -z "$ecr_signing_profile_arn" ]; then
  missing+=("TERRAFORM_ECR_SIGNING_PROFILE_ARN or TERRAFORM_ECR_SIGNING_PROFILE_NAME")
fi
if [ -z "$finalize_callback_lambda_arn" ]; then
  missing+=("TERRAFORM_FINALIZE_CALLBACK_LAMBDA_ARN_${env_upper} or TERRAFORM_FINALIZE_CALLBACK_FUNCTION_NAME_${env_upper}")
fi
if [ -z "$codestar_connection_arn" ]; then
  missing+=("TERRAFORM_CODESTAR_CONNECTION_ARN or TERRAFORM_CODESTAR_CONNECTION_ID")
fi
if [ -z "$codebuild_source_location" ]; then
  missing+=("TERRAFORM_CODEBUILD_SOURCE_LOCATION_${env_upper} or TERRAFORM_CODEBUILD_SOURCE_LOCATION")
fi
if ! has_nonempty_csv_value "$s3_cors_allowed_origins"; then
  missing+=("TERRAFORM_S3_CORS_ALLOWED_ORIGINS_${env_upper}")
fi

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing required Terraform deployment values:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 2
fi

for label in aws_region project_name ecs_image_uri ecr_signing_profile_arn finalize_callback_lambda_arn codestar_connection_arn codebuild_source_location; do
  reject_placeholder "$label" "${!label}"
done
reject_placeholder "aws_account_id" "$account_id"
reject_placeholder "s3_cors_allowed_origins" "$s3_cors_allowed_origins"
require_digest "ecs_image_uri" "$ecs_image_uri"
validate_codebuild_source_location "codebuild_source_location" "$codebuild_source_location"
validate_origins "s3_cors_allowed_origins" "$s3_cors_allowed_origins"

mkdir -p "$(dirname "$output_file")"
{
  echo "# Generated from $env_source by scripts/terraform/render-local-tfvars.sh."
  echo "# Local deployment values only. Do not commit this file."
  echo
  printf 'aws_region     = %s\n' "$(hcl_quote "$aws_region")"
  printf 'aws_account_id = %s\n' "$(hcl_quote "$account_id")"
  printf 'environment    = %s\n' "$(hcl_quote "$env_name")"
  echo
  printf 'project_name              = %s\n' "$(hcl_quote "$project_name")"
  printf 'codebuild_source_location = %s\n' "$(hcl_quote "$codebuild_source_location")"
  echo
  printf 'ecs_image_uri           = %s\n' "$(hcl_quote "$ecs_image_uri")"
  printf 'ecr_signing_profile_arn = %s\n' "$(hcl_quote "$ecr_signing_profile_arn")"
  echo
  printf 'finalize_callback_lambda_arn = %s\n' "$(hcl_quote "$finalize_callback_lambda_arn")"
  printf 'codestar_connection_arn      = %s\n' "$(hcl_quote "$codestar_connection_arn")"
  echo
  printf 's3_cors_allowed_origins = %s\n' "$(render_origins "$s3_cors_allowed_origins")"
} > "$output_file"

echo "Wrote local Terraform variables for ${env_name}."
echo "Output: ${output_file}"
