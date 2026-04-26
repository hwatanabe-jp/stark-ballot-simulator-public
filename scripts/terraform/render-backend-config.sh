#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

usage() {
  cat <<'EOF'
Usage:
  scripts/terraform/render-backend-config.sh [--env-file .env.local] [--output terraform/backend.local.hcl]

Reads Terraform backend values from an optional .env-style file and writes a
git-ignored backend config for terraform init. The command reports variable
names only, not bucket names.

Required:
  TERRAFORM_STATE_BUCKET or TERRAFORM_STATE_BUCKET_NAME

Optional:
  TERRAFORM_AWS_REGION, AWS_REGION, or AWS_DEFAULT_REGION  # default: ap-northeast-1
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

env_file=".env.local"
env_file_explicit=0
output_file="terraform/backend.local.hcl"

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

mkdir -p "$(dirname "$output_file")"
{
  echo "# Generated from $env_source by scripts/terraform/render-backend-config.sh."
  echo "# Local backend values only. Do not commit this file."
  echo
  printf 'bucket       = %s\n' "$(hcl_quote "$state_bucket")"
  printf 'key          = %s\n' "$(hcl_quote "terraform.tfstate")"
  printf 'region       = %s\n' "$(hcl_quote "$aws_region")"
  echo "use_lockfile = true"
  echo "encrypt      = true"
} > "$output_file"

echo "Wrote local Terraform backend config."
echo "Output: $output_file"
