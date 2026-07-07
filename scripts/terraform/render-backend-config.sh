#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

usage() {
  cat <<'EOF'
Usage:
  scripts/terraform/render-backend-config.sh [--env-file .env.local] [--output infra/terraform/legacy/backend.local.hcl]

Reads Terraform backend values from an optional .env-style file and writes a
git-ignored backend config for terraform init. The command reports variable
names only, not bucket names.

Required:
  TERRAFORM_STATE_BUCKET or TERRAFORM_STATE_BUCKET_NAME

Optional:
  TERRAFORM_AWS_REGION, AWS_REGION, or AWS_DEFAULT_REGION  # default: ap-northeast-1
  TERRAFORM_ACCOUNT_ALIAS, TERRAFORM_DEPLOYMENT_ENVIRONMENT, TERRAFORM_STATE_SCOPE
  TERRAFORM_STATE_KMS_KEY_ID or TERRAFORM_STATE_KMS_ALIAS
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

validate_bucket_name() {
  local value="$1"
  if [[ ! "$value" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || [[ "$value" == *..* ]]; then
    echo "TERRAFORM_STATE_BUCKET must be a valid S3 bucket name." >&2
    exit 2
  fi
}

validate_region() {
  local value="$1"
  if [[ ! "$value" =~ ^[a-z]{2}-[a-z]+-[0-9]{1}$ ]]; then
    echo "TERRAFORM_AWS_REGION must be a valid AWS region name." >&2
    exit 2
  fi
}

validate_account_alias() {
  local value="$1"
  if [[ ! "$value" =~ ^[a-z][a-z0-9-]{1,62}$ ]]; then
    echo "TERRAFORM_ACCOUNT_ALIAS must be a lowercase account alias such as stark-dev." >&2
    exit 2
  fi
}

validate_deployment_environment() {
  local value="$1"
  case "$value" in
    develop|main)
      ;;
    *)
      echo "TERRAFORM_DEPLOYMENT_ENVIRONMENT must be develop or main." >&2
      exit 2
      ;;
  esac
}

validate_state_scope() {
  local value="$1"
  case "$value" in
    bootstrap|foundation|app)
      ;;
    *)
      echo "TERRAFORM_STATE_SCOPE must be bootstrap, foundation, or app." >&2
      exit 2
      ;;
  esac
}

require_authorized_target_identity() {
  local identity="$1"

  case "$identity" in
    stark-dev/develop/bootstrap|stark-dev/develop/foundation|stark-dev/develop/app)
      return 0
      ;;
    *)
      echo "Current backend rendering is authorized only for stark-dev/develop/bootstrap, stark-dev/develop/foundation, and stark-dev/develop/app." >&2
      echo "Production bootstrap and app state identities require a later authorization record." >&2
      exit 2
      ;;
  esac
}

target_identity_mode() {
  local provided=0
  local missing=()

  if [ -n "$account_alias" ]; then
    provided=$((provided + 1))
  else
    missing+=("TERRAFORM_ACCOUNT_ALIAS")
  fi
  if [ -n "$deployment_environment" ]; then
    provided=$((provided + 1))
  else
    missing+=("TERRAFORM_DEPLOYMENT_ENVIRONMENT")
  fi
  if [ -n "$state_scope" ]; then
    provided=$((provided + 1))
  else
    missing+=("TERRAFORM_STATE_SCOPE")
  fi

  if [ "$provided" -eq 0 ]; then
    return 1
  fi
  if [ "$provided" -ne 3 ]; then
    echo "Target account backend mode requires all state identity values:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    exit 2
  fi
  return 0
}

env_file=".env.local"
env_file_explicit=0
output_file="infra/terraform/legacy/backend.local.hcl"

while [ "$#" -gt 0 ]; do
  case "$1" in
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

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

env_source="shell environment"
if [ -f "$env_file" ]; then
  load_env_file "$env_file"
  env_source="$env_file"
elif [ "$env_file_explicit" -eq 1 ]; then
  echo "Env file not found: $env_file" >&2
  exit 2
fi

state_bucket="$(first_nonempty TERRAFORM_STATE_BUCKET TERRAFORM_STATE_BUCKET_NAME || true)"
aws_region="$(first_nonempty TERRAFORM_AWS_REGION AWS_REGION AWS_DEFAULT_REGION || true)"
aws_region="${aws_region:-ap-northeast-1}"
account_alias="$(first_nonempty TERRAFORM_ACCOUNT_ALIAS || true)"
deployment_environment="$(first_nonempty TERRAFORM_DEPLOYMENT_ENVIRONMENT || true)"
state_scope="$(first_nonempty TERRAFORM_STATE_SCOPE || true)"
state_kms_key_id="$(first_nonempty TERRAFORM_STATE_KMS_KEY_ID TERRAFORM_STATE_KMS_ALIAS || true)"

missing=()
if [ -z "$state_bucket" ]; then
  missing+=("TERRAFORM_STATE_BUCKET")
fi

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing required Terraform backend values:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 2
fi

reject_placeholder "TERRAFORM_STATE_BUCKET" "$state_bucket"
reject_placeholder "TERRAFORM_AWS_REGION" "$aws_region"
validate_bucket_name "$state_bucket"
validate_region "$aws_region"

backend_key="terraform.tfstate"
target_mode=0
if target_identity_mode; then
  target_mode=1
  reject_placeholder "TERRAFORM_ACCOUNT_ALIAS" "$account_alias"
  reject_placeholder "TERRAFORM_DEPLOYMENT_ENVIRONMENT" "$deployment_environment"
  reject_placeholder "TERRAFORM_STATE_SCOPE" "$state_scope"
  validate_account_alias "$account_alias"
  validate_deployment_environment "$deployment_environment"
  validate_state_scope "$state_scope"
  require_authorized_target_identity "${account_alias}/${deployment_environment}/${state_scope}"
  backend_key="stark-ballot-simulator/${account_alias}/${deployment_environment}/${state_scope}/terraform.tfstate"
fi

if [ -n "$state_kms_key_id" ]; then
  reject_placeholder "TERRAFORM_STATE_KMS_KEY_ID" "$state_kms_key_id"
fi

mkdir -p "$(dirname "$output_file")"
{
  echo "# Generated from $env_source by scripts/terraform/render-backend-config.sh."
  echo "# Local backend values only. Do not commit this file."
  if [ "$target_mode" -eq 1 ]; then
    echo "# Target state identity: <account-alias>/<environment>/<state-scope>."
  fi
  echo
  printf 'bucket       = %s\n' "$(hcl_quote "$state_bucket")"
  printf 'key          = %s\n' "$(hcl_quote "$backend_key")"
  printf 'region       = %s\n' "$(hcl_quote "$aws_region")"
  if [ -n "$state_kms_key_id" ]; then
    printf 'kms_key_id   = %s\n' "$(hcl_quote "$state_kms_key_id")"
  fi
  echo "use_lockfile = true"
  echo "encrypt      = true"
} > "$output_file"

echo "Wrote local Terraform backend config."
echo "Output: $output_file"
