#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

usage() {
  cat <<'EOF'
Usage:
  scripts/terraform/terraform-guarded.sh <develop|main> <terraform args...>

Runs Terraform only after checking:
  - AWS caller is the expected terraform-admin assumed role
  - AWS caller account matches TERRAFORM_AWS_ACCOUNT_ID
  - Terraform workspace matches <develop|main>
  - plan/apply/destroy use a tfvars file whose environment matches <develop|main>

Run inside aws-vault, for example:
  aws-vault exec terraform-admin -- scripts/terraform/terraform-guarded.sh develop plan -var-file=develop.local.tfvars
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
    return 0
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

resolve_var_file() {
  local var_file="$1"
  local candidate

  if [[ "$var_file" = /* ]]; then
    candidate="$var_file"
  else
    candidate="terraform/$var_file"
  fi

  if [ -f "$candidate" ]; then
    (
      cd "$(dirname "$candidate")"
      printf '%s/%s' "$(pwd -P)" "$(basename "$candidate")"
    )
    return 0
  fi

  if [ -f "$var_file" ]; then
    (
      cd "$(dirname "$var_file")"
      printf '%s/%s' "$(pwd -P)" "$(basename "$var_file")"
    )
    return 0
  fi

  echo "Terraform var-file not found: $var_file" >&2
  exit 2
}

reject_environment_var() {
  local assignment="$1"
  local key

  key="${assignment%%=*}"
  key="$(trim "$key")"
  if [ "$key" = "environment" ]; then
    echo "Do not pass environment through -var; set it only in the guarded tfvars file." >&2
    exit 2
  fi
}

read_tfvars_environment() {
  local var_file="$1"
  local line value

  while IFS= read -r line || [ -n "$line" ]; do
    line="$(trim "$line")"
    case "$line" in
      environment[[:space:]]*=*)
        value="${line#*=}"
        value="$(trim "$value")"
        value="${value%%#*}"
        value="$(trim "$value")"
        value="${value%\"}"
        value="${value#\"}"
        printf '%s' "$value"
        return 0
        ;;
    esac
  done < "$var_file"

  echo "Terraform var-file must include environment = \"develop\" or \"main\"." >&2
  exit 2
}

require_expected_account() {
  local env_upper="$1"
  local expected_account_id

  expected_account_id="$(
    first_nonempty "TERRAFORM_AWS_ACCOUNT_ID_${env_upper}" TERRAFORM_AWS_ACCOUNT_ID AWS_ACCOUNT_ID || true
  )"
  if [[ ! "$expected_account_id" =~ ^[0-9]{12}$ ]]; then
    echo "Missing or invalid TERRAFORM_AWS_ACCOUNT_ID for Terraform guard." >&2
    exit 2
  fi

  printf '%s' "$expected_account_id"
}

require_terraform_admin_caller() {
  local expected_account_id="$1"
  local caller account arn required_pattern

  if ! caller="$(aws sts get-caller-identity --query '[Account,Arn]' --output text --no-cli-pager)"; then
    echo "Failed to read AWS caller identity. Run through aws-vault terraform-admin and try again." >&2
    exit 2
  fi

  account="$(printf '%s\n' "$caller" | awk '{print $1}')"
  arn="$(printf '%s\n' "$caller" | awk '{print $2}')"
  required_pattern="^arn:aws:sts::${expected_account_id}:assumed-role/terraform-admin/.+$"

  if [ "$account" != "$expected_account_id" ]; then
    echo "AWS account mismatch for Terraform." >&2
    echo "Expected account: $expected_account_id" >&2
    echo "Current account: $account" >&2
    exit 2
  fi

  if [[ ! "$arn" =~ $required_pattern ]]; then
    echo "Terraform must run as arn:aws:sts::${expected_account_id}:assumed-role/terraform-admin/*." >&2
    echo "Current caller ARN did not match the required role." >&2
    exit 2
  fi
}

require_matching_workspace() {
  local env_name="$1"
  local workspace

  if ! workspace="$(terraform -chdir=terraform workspace show)"; then
    echo "Failed to read Terraform workspace. Run terraform init first if this checkout is not initialized." >&2
    exit 2
  fi
  workspace="$(trim "$workspace")"

  if [ "$workspace" != "$env_name" ]; then
    echo "Terraform workspace mismatch." >&2
    echo "Expected workspace: $env_name" >&2
    echo "Current workspace: $workspace" >&2
    exit 2
  fi
}

require_matching_tfvars_environment() {
  local env_name="$1"
  local command_name="$2"
  shift 2
  local arg expected_var_file_name resolved_var_file tfvars_env var_file
  local next_is_var=0 next_is_var_file=0 var_file_count=0

  case "$command_name" in
    plan|apply|destroy)
      ;;
    *)
      return 0
      ;;
  esac

  for arg in "$@"; do
    if [ "$next_is_var_file" -eq 1 ]; then
      var_file="$arg"
      var_file_count=$((var_file_count + 1))
      next_is_var_file=0
      continue
    fi

    if [ "$next_is_var" -eq 1 ]; then
      reject_environment_var "$arg"
      next_is_var=0
      continue
    fi

    case "$arg" in
      -var-file=*)
        var_file="${arg#-var-file=}"
        var_file_count=$((var_file_count + 1))
        ;;
      -var-file)
        next_is_var_file=1
        ;;
      -var=*)
        reject_environment_var "${arg#-var=}"
        ;;
      -var)
        next_is_var=1
        ;;
    esac
  done

  if [ "$next_is_var_file" -eq 1 ]; then
    echo "$command_name received -var-file without a value." >&2
    exit 2
  fi
  if [ "$next_is_var" -eq 1 ]; then
    echo "$command_name received -var without a value." >&2
    exit 2
  fi

  if [ "$var_file_count" -eq 0 ]; then
    echo "$command_name requires -var-file=<env>.local.tfvars when using terraform-guarded.sh." >&2
    exit 2
  fi
  if [ "$var_file_count" -ne 1 ]; then
    echo "$command_name accepts exactly one -var-file when using terraform-guarded.sh." >&2
    exit 2
  fi

  expected_var_file_name="${env_name}.local.tfvars"
  if [ "$(basename "$var_file")" != "$expected_var_file_name" ]; then
    echo "$command_name requires -var-file=${expected_var_file_name} when using terraform-guarded.sh." >&2
    exit 2
  fi

  resolved_var_file="$(resolve_var_file "$var_file")"
  tfvars_env="$(read_tfvars_environment "$resolved_var_file")"
  if [ "$tfvars_env" != "$env_name" ]; then
    echo "tfvars environment mismatch." >&2
    echo "Expected environment: $env_name" >&2
    echo "tfvars environment: $tfvars_env" >&2
    exit 2
  fi

  printf '%s' "$resolved_var_file"
}

normalize_terraform_args() {
  local resolved_var_file="$1"
  shift
  local arg
  local next_is_var_file=0
  TERRAFORM_ARGS=()

  for arg in "$@"; do
    if [ "$next_is_var_file" -eq 1 ]; then
      TERRAFORM_ARGS+=("$resolved_var_file")
      next_is_var_file=0
      continue
    fi

    case "$arg" in
      -var-file=*)
        TERRAFORM_ARGS+=("-var-file=${resolved_var_file}")
        ;;
      -var-file)
        TERRAFORM_ARGS+=("$arg")
        next_is_var_file=1
        ;;
      *)
        TERRAFORM_ARGS+=("$arg")
        ;;
    esac
  done
}

if [ "$#" -lt 2 ]; then
  usage >&2
  exit 2
fi

env_name="$1"
shift
case "$env_name" in
  develop|main)
    ;;
  *)
    echo "Environment must be develop or main." >&2
    usage >&2
    exit 2
    ;;
esac

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"
load_env_file ".env.local"

env_upper="${env_name^^}"
expected_account_id="$(require_expected_account "$env_upper")"
require_terraform_admin_caller "$expected_account_id"
require_matching_workspace "$env_name"
validated_var_file="$(require_matching_tfvars_environment "$env_name" "$1" "$@")"
if [ -n "$validated_var_file" ]; then
  normalize_terraform_args "$validated_var_file" "$@"
else
  TERRAFORM_ARGS=("$@")
fi

echo "Terraform guard passed for ${env_name}."
exec terraform -chdir=terraform "${TERRAFORM_ARGS[@]}"
