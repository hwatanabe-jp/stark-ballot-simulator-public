#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

usage() {
  cat <<'EOF'
Usage:
  scripts/terraform/render-admin-iam-docs.sh [--env-file .env.local] \
    [--policy-output terraform/terraform-admin-policy.local.json] \
    [--trust-output terraform/terraform-admin-trust-policy.local.json]

Reads Terraform admin IAM values from an optional .env-style file and writes
git-ignored local IAM policy documents. The command reports variable names only,
not account IDs or bucket names.

Required:
  TERRAFORM_AWS_ACCOUNT_ID or AWS_ACCOUNT_ID
  TERRAFORM_STATE_BUCKET or TERRAFORM_STATE_BUCKET_NAME
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

validate_account_id() {
  local value="$1"
  if [[ ! "$value" =~ ^[0-9]{12}$ ]]; then
    echo "TERRAFORM_AWS_ACCOUNT_ID must be a 12-digit account ID." >&2
    exit 2
  fi
}

validate_bucket_name() {
  local value="$1"
  if [[ ! "$value" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || [[ "$value" == *..* ]]; then
    echo "TERRAFORM_STATE_BUCKET must be a valid S3 bucket name." >&2
    exit 2
  fi
}

render_template() {
  local template="$1"
  local output="$2"

  if [ ! -f "$template" ]; then
    echo "Template not found: $template" >&2
    exit 2
  fi

  mkdir -p "$(dirname "$output")"
  RENDER_ACCOUNT_ID="$account_id" RENDER_STATE_BUCKET="$state_bucket" \
    perl -pe 's/<AWS_ACCOUNT_ID>/$ENV{RENDER_ACCOUNT_ID}/g; s/<TERRAFORM_STATE_BUCKET>/$ENV{RENDER_STATE_BUCKET}/g' \
    "$template" > "$output"

  if grep -q '<AWS_ACCOUNT_ID>\|<TERRAFORM_STATE_BUCKET>' "$output"; then
    echo "Rendered output still contains placeholders: $output" >&2
    exit 2
  fi
}

env_file=".env.local"
env_file_explicit=0
policy_output="terraform/terraform-admin-policy.local.json"
trust_output="terraform/terraform-admin-trust-policy.local.json"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      env_file="${2:-}"
      env_file_explicit=1
      shift 2
      ;;
    --policy-output)
      policy_output="${2:-}"
      shift 2
      ;;
    --trust-output)
      trust_output="${2:-}"
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

if [ -f "$env_file" ]; then
  load_env_file "$env_file"
elif [ "$env_file_explicit" -eq 1 ]; then
  echo "Env file not found: $env_file" >&2
  exit 2
fi

account_id="$(first_nonempty TERRAFORM_AWS_ACCOUNT_ID AWS_ACCOUNT_ID || true)"
state_bucket="$(first_nonempty TERRAFORM_STATE_BUCKET TERRAFORM_STATE_BUCKET_NAME || true)"

missing=()
if [ -z "$account_id" ]; then
  missing+=("TERRAFORM_AWS_ACCOUNT_ID")
fi
if [ -z "$state_bucket" ]; then
  missing+=("TERRAFORM_STATE_BUCKET")
fi

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing required Terraform admin IAM values:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 2
fi

reject_placeholder "TERRAFORM_AWS_ACCOUNT_ID" "$account_id"
reject_placeholder "TERRAFORM_STATE_BUCKET" "$state_bucket"
validate_account_id "$account_id"
validate_bucket_name "$state_bucket"

render_template "terraform/terraform-admin-policy.json" "$policy_output"
render_template "terraform/terraform-admin-trust-policy.json" "$trust_output"

echo "Wrote local Terraform admin IAM documents."
echo "Policy output: $policy_output"
echo "Trust output: $trust_output"
