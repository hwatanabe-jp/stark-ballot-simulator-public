#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

terraform_backend_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
deployment_target_configuration_path="${terraform_backend_script_dir}/../../packages/deployment-authority/deployment-targets.json"
deployment_authority_module_path="${terraform_backend_script_dir}/../../packages/deployment-authority/src/index.js"

usage() {
  cat <<'EOF'
Usage:
  scripts/terraform/render-backend-config.sh [--env-file .env.local] [--output infra/terraform/legacy/backend.local.hcl]

Reads Terraform backend values from an optional .env-style file and writes a
git-ignored backend config for terraform init. The command reports variable
names only, not bucket names.

Required outside reviewed target mode:
  TERRAFORM_STATE_BUCKET or TERRAFORM_STATE_BUCKET_NAME
  TERRAFORM_AWS_REGION, AWS_REGION, or AWS_DEFAULT_REGION

Optional:
  TERRAFORM_ACCOUNT_ALIAS, TERRAFORM_DEPLOYMENT_ENVIRONMENT, TERRAFORM_STATE_SCOPE
  TERRAFORM_STATE_KMS_KEY_ID or TERRAFORM_STATE_KMS_ALIAS (outside reviewed target mode)
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

require_canonical_deployment_target_admission() {
  if ! node --input-type=module --eval 'await import(process.argv[1]);' "$deployment_authority_module_path" >/dev/null 2>&1; then
    echo "Reviewed deployment target configuration failed canonical admission." >&2
    exit 2
  fi
}

resolve_reviewed_target_root() {
  local target_key="$1"
  local lane="$2"
  local resolved

  require_canonical_deployment_target_admission
  if ! resolved="$({
    jq -er --arg target_key "$target_key" --arg lane "$lane" '
      select(keys == ["allowedTargets", "configurationType"])
      | select(.configurationType == "deployment-target-configuration")
      | .allowedTargets[$target_key] as $target
      | $target.lanes[$lane] as $root
      | [
          $target.region,
          $root.stateIdentity,
          $root.backendKey,
          $target.sharedNames.terraformStateBucket,
          $target.sharedNames.terraformStateKmsAlias
        ] as $values
      | select(
          $target.targetKey == $target_key
          and $root.scope == $lane
          and all($values[]; type == "string" and length > 0)
        )
      | $values
      | @tsv
    ' "$deployment_target_configuration_path"
  } 2>/dev/null)"; then
    echo "Terraform target ${target_key}/${lane} is not authorized by the reviewed deployment configuration." >&2
    exit 2
  fi

  printf '%s' "$resolved"
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
account_alias="$(first_nonempty TERRAFORM_ACCOUNT_ALIAS || true)"
deployment_environment="$(first_nonempty TERRAFORM_DEPLOYMENT_ENVIRONMENT || true)"
state_scope="$(first_nonempty TERRAFORM_STATE_SCOPE || true)"
state_kms_key_id="$(first_nonempty TERRAFORM_STATE_KMS_KEY_ID TERRAFORM_STATE_KMS_ALIAS || true)"

backend_key="terraform.tfstate"
target_mode=0
if target_identity_mode; then
  reviewed_backend_key=""
  reviewed_region=""
  reviewed_root=""
  reviewed_state_identity=""
  reviewed_state_bucket=""
  reviewed_state_kms_alias=""
  target_key="${account_alias}/${deployment_environment}"
  target_mode=1
  reject_placeholder "TERRAFORM_ACCOUNT_ALIAS" "$account_alias"
  reject_placeholder "TERRAFORM_DEPLOYMENT_ENVIRONMENT" "$deployment_environment"
  reject_placeholder "TERRAFORM_STATE_SCOPE" "$state_scope"
  validate_account_alias "$account_alias"
  validate_deployment_environment "$deployment_environment"
  validate_state_scope "$state_scope"
  if ! reviewed_root="$(resolve_reviewed_target_root "$target_key" "$state_scope")"; then
    exit 2
  fi
  IFS=$'\t' read -r \
    reviewed_region \
    reviewed_state_identity \
    reviewed_backend_key \
    reviewed_state_bucket \
    reviewed_state_kms_alias \
    <<< "$reviewed_root"
  if [ "${account_alias}/${deployment_environment}/${state_scope}" != "$reviewed_state_identity" ]; then
    echo "Terraform target state identity does not match the reviewed deployment configuration." >&2
    exit 2
  fi
  if [ -n "$aws_region" ] && [ "$aws_region" != "$reviewed_region" ]; then
    echo "Terraform target region does not match the reviewed deployment configuration." >&2
    echo "Reviewed target region: $reviewed_region" >&2
    exit 2
  fi
  if [ -n "$state_bucket" ]; then
    reject_placeholder "TERRAFORM_STATE_BUCKET" "$state_bucket"
    validate_bucket_name "$state_bucket"
    if [ "$state_bucket" != "$reviewed_state_bucket" ]; then
      echo "Terraform target state bucket does not match the reviewed deployment configuration." >&2
      exit 2
    fi
  fi
  if [ -n "$state_kms_key_id" ] && [ "$state_kms_key_id" != "$reviewed_state_kms_alias" ]; then
    echo "Terraform target state KMS key does not match the reviewed deployment configuration." >&2
    exit 2
  fi
  aws_region="$reviewed_region"
  backend_key="$reviewed_backend_key"
  state_bucket="$reviewed_state_bucket"
  state_kms_key_id="$reviewed_state_kms_alias"
else
  if [ -z "$state_bucket" ]; then
    echo "Missing required Terraform backend values:" >&2
    echo "  - TERRAFORM_STATE_BUCKET" >&2
    exit 2
  fi
  if [ -z "$aws_region" ]; then
    echo "TERRAFORM_AWS_REGION, AWS_REGION, or AWS_DEFAULT_REGION is required outside reviewed target mode." >&2
    exit 2
  fi
  reject_placeholder "TERRAFORM_STATE_BUCKET" "$state_bucket"
  validate_bucket_name "$state_bucket"
fi

reject_placeholder "TERRAFORM_AWS_REGION" "$aws_region"
validate_region "$aws_region"

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
