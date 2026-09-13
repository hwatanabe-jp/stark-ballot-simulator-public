#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

HOST_BIN="${HOST_BIN:-/opt/zkvm/bin/host}"
PROVER_ARTIFACT_TOOL_BIN="${PROVER_ARTIFACT_TOOL_BIN:-/opt/zkvm/bin/prover-artifacts}"
INPUT_PATH="${INPUT_PATH:-}"
INPUT_S3_BUCKET="${INPUT_S3_BUCKET:-}"
INPUT_S3_KEY="${INPUT_S3_KEY:-}"
OUTPUT_DIR="${OUTPUT_DIR:-/var/task/output}"
OUTPUT_S3_BUCKET="${OUTPUT_S3_BUCKET:-}"
OUTPUT_S3_PREFIX="${OUTPUT_S3_PREFIX:-}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-}"
PUBLIC_BUNDLE_MANIFEST_PATH="${PUBLIC_BUNDLE_MANIFEST_PATH:-/opt/zkvm/share/public-bundle-manifest.json}"
PROVER_SUMMARY_ACTIVE=0
PROVER_START_MS=0
PROVER_RESULT="error"
PROVER_CATEGORY="unknown"
PROVER_HOST_WRAPPER_PID=""
PROVER_DURABLE_ARTIFACTS_COMPLETE=0
PROVER_PENDING_SIGNAL=""
PROVER_SIGNAL_HANDLING_ACTIVE=0
FAILURE_MARKER_FILENAME="failure-marker.json"

epoch_millis() {
  date -u +%s%3N
}

is_target_runtime_profile() {
  [[ "${RUNTIME_PROFILE:-}" == "target-aws-async" ]]
}

validate_prover_observability() {
  if ! is_target_runtime_profile; then
    return 0
  fi
  if [[ ! "${DEPLOYMENT_ID:-}" =~ ^dep_[0-9a-f]{32}$ ]] ||
     [[ ! "${APP_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] ||
     [[ "${DEPLOY_MODE:-}" != "normal" && "${DEPLOY_MODE:-}" != "rollback" ]] ||
     [[ ! "${FINALIZATION_ID:-}" =~ ^[A-Za-z0-9_-]{1,128}$ ]] ||
     [[ -z "${LOG_IP_HASH_SALT:-}" ]] ||
     [[ "${LOG_IP_HASH_SALT:-}" == "stark-ballot-log-salt" ]]; then
    printf '%s\n' '{"level":"error","event":"config_invalid","message":"Prover observability configuration is invalid"}' >&2
    return 1
  fi
}

hash_output_key_prefix() {
  if [[ -z "${OUTPUT_S3_PREFIX:-}" || -z "${LOG_IP_HASH_SALT:-}" ]]; then
    return 0
  fi
  local digest
  digest="$(printf '%s|key|%s' "$LOG_IP_HASH_SALT" "$(normalize_prefix "$OUTPUT_S3_PREFIX")" | sha256sum)"
  printf 'key_%s' "${digest:0:12}"
}

is_prover_failure_category() {
  [[ "${1:-}" =~ ^(configuration|input|prover_execution|infrastructure_interruption|artifact|upload|timeout|unknown)$ ]]
}

emit_prover_summary() {
  local phase="$1"
  local result="$2"
  local category="$3"
  local duration_ms="$4"
  validate_prover_observability || return 1
  [[ "$phase" == "start" || "$phase" == "end" ]] || return 1
  [[ "$result" == "started" || "$result" == "success" || "$result" == "error" ]] || return 1
  [[ "$category" == "none" ]] || is_prover_failure_category "$category" || return 1
  [[ "$duration_ms" =~ ^[0-9]+$ ]] || return 1

  local key_prefix
  key_prefix="$(hash_output_key_prefix)"
  jq -cn \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
    --arg env "${RUNTIME_DEPLOYMENT_ENV:-unknown}" \
    --arg deployment_id "${DEPLOYMENT_ID:-}" \
    --arg app_source_sha "${APP_SOURCE_SHA:-}" \
    --arg deploy_mode "${DEPLOY_MODE:-}" \
    --arg finalization_id "${FINALIZATION_ID:-}" \
    --arg phase "$phase" \
    --arg result "$result" \
    --arg category "$category" \
    --arg key_prefix "$key_prefix" \
    --argjson duration_ms "$duration_ms" \
    '{ts:$ts,level:(if $result == "error" then "error" else "info" end),service:"prover",env:$env,deployment_id:$deployment_id,app_source_sha:$app_source_sha,deploy_mode:$deploy_mode,event:"prover_summary",phase:$phase,result:$result,category:$category,duration_ms:$duration_ms,finalization_id:$finalization_id} + (if $key_prefix == "" then {} else {key_prefix:$key_prefix} end)'
}

log() {
  local level="$1"; shift
  local message="$*"
  message="${message:0:512}"
  if is_target_runtime_profile && validate_prover_observability >/dev/null 2>&1; then
    jq -cn \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
      --arg level "${level,,}" \
      --arg env "${RUNTIME_DEPLOYMENT_ENV:-unknown}" \
      --arg deployment_id "$DEPLOYMENT_ID" \
      --arg app_source_sha "$APP_SOURCE_SHA" \
      --arg deploy_mode "$DEPLOY_MODE" \
      --arg finalization_id "$FINALIZATION_ID" \
      --arg message "$message" \
      '{ts:$ts,level:$level,service:"prover",env:$env,deployment_id:$deployment_id,app_source_sha:$app_source_sha,deploy_mode:$deploy_mode,event:"prover_log",message:$message,finalization_id:$finalization_id}' ||
      printf '%s\n' '{"level":"error","event":"log_sanitization_failed","message":"Log payload discarded"}'
    return
  fi
  printf '[%(%Y-%m-%dT%H:%M:%S%z)T] [%s] %s\n' -1 "$level" "$message"
}

fatal() {
  log "ERROR" "$*"
  exit 1
}

write_failure_marker() {
  local category="$1"
  is_prover_failure_category "$category" || return 1

  mkdir -p "$OUTPUT_DIR" || return 1
  local marker_path="${OUTPUT_DIR}/${FAILURE_MARKER_FILENAME}"
  local temporary_path="${marker_path}.tmp"
  if ! jq -cn \
    --arg category "$category" \
    '{category:$category}' >"$temporary_path"; then
    rm -f "$temporary_path"
    return 1
  fi
  chmod 600 "$temporary_path" || {
    rm -f "$temporary_path"
    return 1
  }
  mv "$temporary_path" "$marker_path"
}

failure_marker_response_version_id() {
  local response_path="$1"
  local version_id
  version_id="$(jq -er '.VersionId | select(type == "string")' "$response_path" 2>/dev/null)" || return 1
  if [[ -z "$version_id" || "$version_id" == "null" || "$version_id" =~ [[:space:]] ]]; then
    return 1
  fi
  printf '%s' "$version_id"
}

failure_marker_response_etag() {
  local response_path="$1"
  local etag
  etag="$(jq -er '.ETag | select(type == "string")' "$response_path" 2>/dev/null)" || return 1
  if [[ -z "$etag" || "$etag" =~ [[:space:]] ]]; then
    return 1
  fi
  printf '%s' "$etag"
}

is_failure_marker_precondition_failure() {
  local error_path="$1"
  grep -Eiq 'PreconditionFailed|Precondition Failed|HTTP 412|status code: 412' "$error_path"
}

verify_existing_failure_marker() {
  local marker_path="$1"
  local bucket="$2"
  local key="$3"
  local temporary_dir="$4"
  local head_response="${temporary_dir}/head-object.json"
  local head_error="${temporary_dir}/head-object.stderr"
  local get_response="${temporary_dir}/get-object.json"
  local get_error="${temporary_dir}/get-object.stderr"
  local existing_marker="${temporary_dir}/existing-failure-marker.json"
  local version_id head_etag fetched_version_id fetched_etag
  local owner_args=()
  if [[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
    owner_args+=(--expected-bucket-owner "$AWS_ACCOUNT_ID")
  fi

  if ! aws \
    --cli-connect-timeout 2 \
    --cli-read-timeout 5 \
    s3api head-object \
    --bucket "$bucket" \
    --key "$key" \
    "${owner_args[@]}" \
    --output json \
    --no-cli-pager >"$head_response" 2>"$head_error"; then
    return 1
  fi
  version_id="$(failure_marker_response_version_id "$head_response")" || return 1
  head_etag="$(failure_marker_response_etag "$head_response")" || return 1

  rm -f "$existing_marker"
  if ! aws \
    --cli-connect-timeout 2 \
    --cli-read-timeout 5 \
    s3api get-object \
    --bucket "$bucket" \
    --key "$key" \
    --version-id "$version_id" \
    "${owner_args[@]}" \
    "$existing_marker" \
    --output json \
    --no-cli-pager >"$get_response" 2>"$get_error"; then
    return 1
  fi
  fetched_version_id="$(failure_marker_response_version_id "$get_response")" || return 1
  fetched_etag="$(failure_marker_response_etag "$get_response")" || return 1
  [[ "$fetched_version_id" == "$version_id" && "$fetched_etag" == "$head_etag" ]] || return 1
  cmp -s "$marker_path" "$existing_marker" || return 2
}

upload_failure_marker_best_effort() {
  local marker_path="${OUTPUT_DIR}/${FAILURE_MARKER_FILENAME}"
  local normalized_prefix
  normalized_prefix="$(normalize_prefix "$OUTPUT_S3_PREFIX")"
  if [[ ! -f "$marker_path" || -z "$OUTPUT_S3_BUCKET" || -z "$normalized_prefix" ]]; then
    return 0
  fi

  local max_attempts="${FAILURE_MARKER_UPLOAD_MAX_ATTEMPTS:-3}"
  local retry_delay_seconds="${FAILURE_MARKER_UPLOAD_RETRY_DELAY_SECONDS:-1}"
  if [[ ! "$max_attempts" =~ ^[1-5]$ ]]; then
    max_attempts=3
  fi
  if [[ ! "$retry_delay_seconds" =~ ^[0-5]$ ]]; then
    retry_delay_seconds=1
  fi

  local temporary_dir
  if ! temporary_dir="$(mktemp -d /tmp/prover-failure-marker-upload.XXXXXX)"; then
    log "WARN" "Failure marker publication could not be confirmed after bounded retries" || true
    return 0
  fi
  local put_response="${temporary_dir}/put-object.json"
  local put_error="${temporary_dir}/put-object.stderr"
  local key="${normalized_prefix}/${FAILURE_MARKER_FILENAME}"
  local args=(
    --cli-connect-timeout 2
    --cli-read-timeout 5
    s3api put-object
    --bucket "$OUTPUT_S3_BUCKET"
    --key "$key"
    --body "$marker_path"
    --content-type application/json
    --server-side-encryption AES256
    --if-none-match '*'
  )
  if [[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
    args+=(--expected-bucket-owner "$AWS_ACCOUNT_ID")
  fi
  args+=(--output json --no-cli-pager)

  local attempt=1
  local publication_confirmed=0
  local publication_outcome="exhausted"
  local verification_status
  while (( attempt <= max_attempts )); do
    if aws "${args[@]}" >"$put_response" 2>"$put_error"; then
      if failure_marker_response_version_id "$put_response" >/dev/null; then
        publication_confirmed=1
        break
      fi
    elif is_failure_marker_precondition_failure "$put_error"; then
      if verify_existing_failure_marker "$marker_path" "$OUTPUT_S3_BUCKET" "$key" "$temporary_dir"; then
        publication_confirmed=1
        break
      else
        verification_status="$?"
        if [[ "$verification_status" == "2" ]]; then
          publication_outcome="conflict"
          break
        fi
      fi
    fi

    if (( attempt < max_attempts && retry_delay_seconds > 0 )); then
      sleep "$retry_delay_seconds"
    fi
    attempt=$(( attempt + 1 ))
  done

  case "$temporary_dir" in
    /tmp/prover-failure-marker-upload.*) rm -rf -- "$temporary_dir" ;;
  esac
  if [[ "$publication_confirmed" != "1" ]]; then
    if [[ "$publication_outcome" == "conflict" ]]; then
      log "WARN" "Failure marker publication conflict; existing marker retained" || true
    else
      log "WARN" "Failure marker publication could not be confirmed after bounded retries" || true
    fi
  fi
  return 0
}

normalize_prefix() {
  local value="${1:-}"
  value="${value#/}"
  value="${value%/}"
  printf '%s' "$value"
}

uses_s3_artifacts() {
  [[ -n "$INPUT_S3_BUCKET" || -n "$OUTPUT_S3_BUCKET" ]]
}

validate_production_proof_mode() {
  case "${RUNTIME_PROFILE:-}" in
    target-aws-async | local-proof-production) ;;
    *) fatal "RUNTIME_PROFILE must select a supported production prover profile" ;;
  esac
  if uses_s3_artifacts && ! is_target_runtime_profile; then
    fatal "RUNTIME_PROFILE=target-aws-async is required for S3-backed async prover execution"
  fi
}

validate_expected_bucket_owner() {
  if ! is_target_runtime_profile || ! uses_s3_artifacts; then
    return
  fi

  if [[ ! "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
    fatal "AWS_ACCOUNT_ID must be a 12-digit account ID for target S3 artifacts"
  fi
}

aws_s3_cp() {
  local source="$1"
  local destination="$2"

  if [[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
    if [[ "$source" == s3://* && "$destination" != s3://* ]]; then
      local source_path="${source#s3://}"
      local bucket="${source_path%%/*}"
      local key="${source_path#*/}"

      if [[ -z "$bucket" || "$key" == "$source_path" || -z "$key" ]]; then
        fatal "Invalid S3 source URI"
      fi

      aws s3api get-object \
        --bucket "$bucket" \
        --key "$key" \
        --expected-bucket-owner "$AWS_ACCOUNT_ID" \
        "$destination" \
        >/dev/null
      return
    fi

    if [[ "$source" != s3://* && "$destination" == s3://* ]]; then
      local destination_path="${destination#s3://}"
      local bucket="${destination_path%%/*}"
      local key="${destination_path#*/}"

      if [[ -z "$bucket" || "$key" == "$destination_path" || -z "$key" ]]; then
        fatal "Invalid S3 destination URI"
      fi

      aws s3api put-object \
        --bucket "$bucket" \
        --key "$key" \
        --body "$source" \
        --expected-bucket-owner "$AWS_ACCOUNT_ID" \
        >/dev/null
      return
    fi
  fi

  local args=(s3 cp "$source" "$destination")
  aws "${args[@]}"
}

ensure_host_binary() {
  if [[ ! -x "$HOST_BIN" ]]; then
    fatal "Configured host binary is missing or not executable"
  fi
}

ensure_prover_artifact_tool_binary() {
  if [[ ! -x "$PROVER_ARTIFACT_TOOL_BIN" ]]; then
    fatal "Configured prover artifact tool is missing or not executable"
  fi
}

resolve_input_file() {
  if [[ -n "$INPUT_PATH" ]]; then
    if [[ ! -f "$INPUT_PATH" ]]; then
      fatal "Configured INPUT_PATH does not exist"
    fi
    cp "$INPUT_PATH" "$WORK_INPUT"
    return
  fi

  if [[ -n "$INPUT_S3_BUCKET" && -n "$INPUT_S3_KEY" ]]; then
    log INFO "Downloading payload from configured S3 input"
    aws_s3_cp "s3://$INPUT_S3_BUCKET/$INPUT_S3_KEY" "$WORK_INPUT"
    return
  fi

  fatal "No input provided. Set INPUT_PATH or INPUT_S3_BUCKET/INPUT_S3_KEY"
}

validate_input_json() {
  if ! jq empty "$WORK_INPUT" >/dev/null 2>&1; then
    fatal "Invalid JSON format in input file"
  fi

  local required_fields=(
    "election_id|(.election_id)"
    "election_config_hash|(.election_config_hash)"
    "bulletin_root|(.bulletin_root)"
    "tree_size|(.tree_size)"
    "log_id|(.log_id)"
    "timestamp|(.timestamp)"
    "total_expected|(.total_expected)"
    "votes|(.votes)"
  )

  for entry in "${required_fields[@]}"; do
    local label="${entry%%|*}"
    local expr="${entry#*|}"
    if ! jq -e "$expr" "$WORK_INPUT" >/dev/null 2>&1; then
      fatal "Missing required field: ${label}"
    fi
  done
}

upload_with_retry() {
  local file_path="$1"
  local destination="$2"
  local max_attempts="${UPLOAD_MAX_ATTEMPTS:-3}"
  local backoff_base="${UPLOAD_RETRY_BASE_SECONDS:-2}"
  local attempt=1

  while (( attempt <= max_attempts )); do
    if aws_s3_cp "$file_path" "$destination"; then
      return 0
    fi

    if (( attempt == max_attempts )); then
      break
    fi

    local delay=$(( backoff_base ** attempt ))
    log WARN "Upload attempt ${attempt} failed, retrying in ${delay}s..."
    sleep "$delay"
    ((attempt++))
  done

  fatal "Failed to upload artifact after ${max_attempts} attempts"
}

write_artifact_from_tool() {
  local destination_path="$1"
  shift
  local temporary_path="${destination_path}.tmp"

  rm -f -- "$temporary_path"
  if ! "$PROVER_ARTIFACT_TOOL_BIN" "$@" >"$temporary_path"; then
    rm -f -- "$temporary_path"
    return 1
  fi
  if ! chmod 600 "$temporary_path" || ! mv -- "$temporary_path" "$destination_path"; then
    rm -f -- "$temporary_path"
    return 1
  fi
}

convert_output_to_journal() {
  local input_path="$1"
  local output_path="$2"
  local journal_path="$3"

  write_artifact_from_tool \
    "$journal_path" \
    journal \
    "$input_path" \
    "$output_path"
}

build_public_input() {
  local input_path="$1"
  local output_path="$2"
  local public_path="$3"

  write_artifact_from_tool \
    "$public_path" \
    public-input \
    "$input_path" \
    "$output_path"
}

build_election_manifest() {
  local input_path="$1"
  local output_path="$2"
  local manifest_path="$3"

  write_artifact_from_tool \
    "$manifest_path" \
    election-manifest \
    "$input_path" \
    "$output_path"
}

build_close_statement() {
  local input_path="$1"
  local output_path="$2"
  local close_path="$3"

  write_artifact_from_tool \
    "$close_path" \
    close-statement \
    "$input_path" \
    "$output_path"
}

validate_public_audit_artifacts() {
  local journal_path="$1"
  local public_input_path="$2"
  local election_manifest_path="$3"
  local close_statement_path="$4"

  "$PROVER_ARTIFACT_TOOL_BIN" \
    validate \
    "$journal_path" \
    "$public_input_path" \
    "$election_manifest_path" \
    "$close_statement_path"
}
inspect_public_bundle_archive() {
  local archive_path="$1"
  local bundle_mode="$2"

  python3 - "$PUBLIC_BUNDLE_MANIFEST_PATH" "$archive_path" "$bundle_mode" <<'PY'
import json
import re
import sys
import zipfile

manifest_path, archive_path, bundle_mode = sys.argv[1:4]
canonical_member = re.compile(r"^[a-z0-9][a-z0-9-]*\.json$")


def fail(reason):
    print(f"Public bundle archive admission failed: {reason}", file=sys.stderr)
    raise SystemExit(1)


def require_exact_keys(value, expected, label):
    if not isinstance(value, dict) or set(value) != set(expected):
        fail(f"{label} has invalid fields")


def require_members(value, label):
    if not isinstance(value, list):
        fail(f"{label} must be an array")
    members = []
    for member in value:
        if not isinstance(member, str) or canonical_member.fullmatch(member) is None:
            fail(f"{label} contains a noncanonical member")
        members.append(member)
    return members


try:
    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
except (OSError, UnicodeError, json.JSONDecodeError):
    fail("manifest is unavailable or malformed")

require_exact_keys(manifest, ["requiredInAllModes", "modes", "neverPublic"], "manifest")
require_exact_keys(manifest["modes"], ["sync", "async"], "manifest modes")
if bundle_mode not in manifest["modes"]:
    fail("bundle mode is unsupported")

required_in_all_modes = require_members(manifest["requiredInAllModes"], "requiredInAllModes")
never_public = require_members(manifest["neverPublic"], "neverPublic")
mode_members = {}
known_public = list(required_in_all_modes)
for mode_name, mode_value in manifest["modes"].items():
    require_exact_keys(mode_value, ["required", "optional"], f"mode {mode_name}")
    required = require_members(mode_value["required"], f"mode {mode_name} required")
    optional = require_members(mode_value["optional"], f"mode {mode_name} optional")
    mode_members[mode_name] = {"required": required, "optional": optional}
    known_public.extend(required)
    known_public.extend(optional)

public_by_case = set()
for member in known_public:
    case_key = member.casefold()
    if case_key in public_by_case:
        fail("manifest public membership is duplicated or case-conflicting")
    public_by_case.add(case_key)

private_by_case = set()
for member in never_public:
    case_key = member.casefold()
    if case_key in private_by_case or case_key in public_by_case:
        fail("manifest private membership is duplicated or overlaps public membership")
    private_by_case.add(case_key)

selected_mode = mode_members[bundle_mode]
required = set(required_in_all_modes + selected_mode["required"])
allowed = required | set(selected_mode["optional"])
known_public_set = set(known_public)
never_public_set = set(never_public)
seen_exact = set()
seen_by_case = {}

try:
    with zipfile.ZipFile(archive_path, "r") as archive:
        for entry in archive.infolist():
            member = entry.filename
            case_key = member.casefold()
            if member in seen_exact:
                fail("archive contains a duplicate member")
            if case_key in seen_by_case:
                fail("archive contains case-conflicting members")
            if entry.is_dir() or canonical_member.fullmatch(member) is None:
                fail("archive contains a noncanonical member")
            seen_exact.add(member)
            seen_by_case[case_key] = member
            if member in never_public_set:
                fail("archive contains a never-public member")
            if member not in allowed:
                if member in known_public_set:
                    fail("archive contains a mode-inconsistent member")
                fail("archive contains an unknown member")
            archive.read(entry)
except (OSError, RuntimeError, UnicodeError, zipfile.BadZipFile, zipfile.LargeZipFile):
    fail("archive is malformed or unreadable")

missing = sorted(required - seen_exact)
if missing:
    fail("archive is missing required members")
PY
}

create_bundle_archive() {
  local output_dir="$1"
  ensure_prover_artifact_tool_binary
  shopt -s nullglob
  local receipt_files=("$output_dir"/*-receipt.json)
  local output_files=("$output_dir"/*-output.json)

  if (( ${#receipt_files[@]} == 0 )); then
    fatal "Receipt artifact not found for bundle"
  fi
  if (( ${#output_files[@]} == 0 )); then
    fatal "Output artifact not found for bundle"
  fi

  local receipt_file="${receipt_files[0]}"
  local output_file="${output_files[0]}"
  local bundle_dir
  bundle_dir="$(mktemp -d /tmp/zkvm-bundle-XXXX)"
  local bundle_zip="${output_dir}/bundle.zip"
  local public_input_path="${output_dir}/public-input.json"
  local election_manifest_path="${output_dir}/election-manifest.json"
  local close_statement_path="${output_dir}/close-statement.json"
  local included_bitmap_path="${output_dir}/included-bitmap.json"
  local seen_bitmap_path="${output_dir}/seen-bitmap.json"

  cp "$receipt_file" "${bundle_dir}/receipt.json"
  if [[ -z "${WORK_INPUT:-}" || ! -f "$WORK_INPUT" ]]; then
    fatal "WORK_INPUT not available; cannot create public-input.json"
  fi
  convert_output_to_journal "$WORK_INPUT" "$output_file" "${bundle_dir}/journal.json"
  build_public_input "$WORK_INPUT" "$output_file" "$public_input_path"
  build_election_manifest "$WORK_INPUT" "$output_file" "$election_manifest_path"
  build_close_statement "$WORK_INPUT" "$output_file" "$close_statement_path"
  validate_public_audit_artifacts \
    "${bundle_dir}/journal.json" \
    "$public_input_path" \
    "$election_manifest_path" \
    "$close_statement_path"
  cp "$public_input_path" "${bundle_dir}/public-input.json"
  cp "$election_manifest_path" "${bundle_dir}/election-manifest.json"
  cp "$close_statement_path" "${bundle_dir}/close-statement.json"

  if [[ ! -f "$included_bitmap_path" ]]; then
    local included_bitmap_candidates=()
    local bitmap_candidate
    for bitmap_candidate in "$output_dir"/*-bitmap.json; do
      case "$bitmap_candidate" in
        "$included_bitmap_path" | "$seen_bitmap_path" | *-seen-bitmap.json) continue ;;
      esac
      included_bitmap_candidates+=("$bitmap_candidate")
    done
    if (( ${#included_bitmap_candidates[@]} == 1 )); then
      mv -- "${included_bitmap_candidates[0]}" "$included_bitmap_path"
    elif (( ${#included_bitmap_candidates[@]} > 1 )); then
      fatal "Included bitmap artifact selection is ambiguous"
    else
      log WARN "Exact included bitmap artifact not found; bitmap proof availability will be reduced"
    fi
  fi

  if [[ ! -f "$seen_bitmap_path" ]]; then
    local seen_bitmap_candidates=("$output_dir"/*-seen-bitmap.json)
    if (( ${#seen_bitmap_candidates[@]} == 1 )); then
      mv -- "${seen_bitmap_candidates[0]}" "$seen_bitmap_path"
    elif (( ${#seen_bitmap_candidates[@]} > 1 )); then
      fatal "Seen bitmap artifact selection is ambiguous"
    else
      log WARN "Exact seen bitmap artifact not found; per-index explainability will be reduced"
    fi
  fi

  rm -f "$bundle_zip"
  (cd "$bundle_dir" && zip -q -r "$bundle_zip" .)
  if ! inspect_public_bundle_archive "$bundle_zip" async; then
    rm -f "$bundle_zip"
    rm -rf "$bundle_dir"
    shopt -u nullglob
    fatal "Public bundle archive admission failed"
  fi
  rm -rf "$bundle_dir"
  shopt -u nullglob

  log INFO "Bundle archive created"
}

stage_outputs() {
  mkdir -p "$OUTPUT_DIR"
  local base="${WORK_INPUT%.json}"
  local moved=false

  for suffix in -output.json -receipt.json -journal.json -bitmap.json -seen-bitmap.json; do
    local produced="$base$suffix"
    if [[ -f "$produced" ]]; then
      mv "$produced" "$OUTPUT_DIR/"
      moved=true
    fi
  done

  for produced in "$(dirname "$WORK_INPUT")/included-bitmap.json" "$(dirname "$WORK_INPUT")/seen-bitmap.json"; do
    if [[ -f "$produced" ]]; then
      mv "$produced" "$OUTPUT_DIR/"
      moved=true
    fi
  done

  if [[ "$moved" = false ]]; then
    log WARN "No output artifacts detected"
  fi
}

upload_outputs() {
  if [[ -z "$OUTPUT_S3_BUCKET" ]]; then
    return
  fi

  local normalized_prefix
  normalized_prefix="$(normalize_prefix "$OUTPUT_S3_PREFIX")"
  log INFO "Uploading outputs to configured S3 destination"
  shopt -s nullglob
  local files=("$OUTPUT_DIR"/*)
  if (( ${#files[@]} == 0 )); then
    log WARN "No files to upload from configured output directory"
    return
  fi

  local upload_files=()
  for f in "${files[@]}"; do
    [[ -d "$f" ]] || upload_files+=("$f")
  done
  if (( ${#upload_files[@]} == 0 )); then
    log WARN "No files to upload from configured output directory"
    return
  fi

  local signal_deferral_enabled=false
  if [[ "$PROVER_SIGNAL_HANDLING_ACTIVE" == "1" ]]; then
    signal_deferral_enabled=true
    trap 'record_prover_signal TERM' TERM
    trap 'record_prover_signal INT' INT
  fi

  local index
  for index in "${!upload_files[@]}"; do
    local f="${upload_files[$index]}"
    local key
    if [[ -n "$normalized_prefix" ]]; then
      key="${normalized_prefix}/$(basename "$f")"
    else
      key="$(basename "$f")"
    fi
    upload_with_retry "$f" "s3://$OUTPUT_S3_BUCKET/$key"

    if (( index == ${#upload_files[@]} - 1 )); then
      PROVER_DURABLE_ARTIFACTS_COMPLETE=1
    fi
    if [[ -n "$PROVER_PENDING_SIGNAL" ]]; then
      if [[ "$signal_deferral_enabled" == "true" ]]; then
        install_prover_signal_traps
      fi
      handle_pending_prover_signal
    fi
  done

  if [[ "$signal_deferral_enabled" == "true" ]]; then
    install_prover_signal_traps
  fi
}

run_host_with_timeout() {
  local timeout_seconds="${ZKVM_TIMEOUT_SECONDS:-900}"
  local termination_grace_seconds="${ZKVM_TERMINATION_GRACE_SECONDS:-10}"
  if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || [[ ! "$termination_grace_seconds" =~ ^[1-9][0-9]*$ ]]; then
    fatal "zkVM timeout and termination grace must be positive integer seconds"
  fi
  log INFO "Running host (timeout: ${timeout_seconds}s)"
  # Adapter-private translation: both supported prover profiles require
  # production RISC Zero evidence, so retired development-mode variables must
  # never reach the external host process.
  unset RISC0_DEV_MODE FORCE_DEV_MODE
  local started_at_seconds="$SECONDS"
  timeout --kill-after="${termination_grace_seconds}s" "$timeout_seconds" "$HOST_BIN" "$WORK_INPUT" >/dev/null 2>&1 &
  PROVER_HOST_WRAPPER_PID="$!"

  local exit_code
  set +e
  wait "$PROVER_HOST_WRAPPER_PID"
  exit_code="$?"
  set -e
  PROVER_HOST_WRAPPER_PID=""
  local elapsed_seconds=$((SECONDS - started_at_seconds))

  if (( exit_code == 0 )); then
    return 0
  fi
  if (( exit_code == 124 || (exit_code == 137 && elapsed_seconds >= timeout_seconds) )); then
    PROVER_CATEGORY="timeout"
    fatal "zkVM execution timed out after ${timeout_seconds}s"
  fi
  PROVER_CATEGORY="prover_execution"
  fatal "zkVM execution failed with exit code ${exit_code}"
}

record_prover_signal() {
  local signal_name="$1"
  case "$signal_name" in
    TERM | INT) ;;
    *) return 1 ;;
  esac

  if [[ -z "$PROVER_PENDING_SIGNAL" ]]; then
    PROVER_PENDING_SIGNAL="$signal_name"
  fi
}

install_prover_signal_traps() {
  trap 'handle_prover_signal TERM' TERM
  trap 'handle_prover_signal INT' INT
}

handle_pending_prover_signal() {
  local signal_name="$PROVER_PENDING_SIGNAL"
  PROVER_PENDING_SIGNAL=""
  if [[ -n "$signal_name" ]]; then
    handle_prover_signal "$signal_name"
  fi
}

handle_prover_signal() {
  local signal_name="$1"
  local exit_code
  case "$signal_name" in
    TERM) exit_code=143 ;;
    INT) exit_code=130 ;;
    *) return 1 ;;
  esac
  PROVER_PENDING_SIGNAL=""

  if [[ "$PROVER_DURABLE_ARTIFACTS_COMPLETE" == "1" ]]; then
    PROVER_RESULT="success"
    PROVER_CATEGORY="none"
    exit 0
  fi

  PROVER_RESULT="error"
  PROVER_CATEGORY="infrastructure_interruption"
  if [[ -n "$PROVER_HOST_WRAPPER_PID" ]] && kill -0 "$PROVER_HOST_WRAPPER_PID" 2>/dev/null; then
    kill -s "$signal_name" "$PROVER_HOST_WRAPPER_PID" 2>/dev/null || true
    set +e
    wait "$PROVER_HOST_WRAPPER_PID" 2>/dev/null
    set -e
    PROVER_HOST_WRAPPER_PID=""
  fi
  exit "$exit_code"
}

finish_prover_execution() {
  local exit_code="$?"
  trap - EXIT TERM INT
  PROVER_SIGNAL_HANDLING_ACTIVE=0
  set +e
  if (( exit_code != 0 )); then
    write_failure_marker "$PROVER_CATEGORY" || true
    upload_failure_marker_best_effort
  fi
  if [[ "$PROVER_SUMMARY_ACTIVE" == "1" ]]; then
    local finished_ms duration_ms
    finished_ms="$(epoch_millis)"
    duration_ms=$(( finished_ms - PROVER_START_MS ))
    if (( duration_ms < 0 )); then
      duration_ms=0
    fi
    emit_prover_summary end "$PROVER_RESULT" "$PROVER_CATEGORY" "$duration_ms" || true
  fi
  if [[ -n "${WORK_INPUT:-}" ]]; then
    rm -f "$WORK_INPUT"
  fi
  exit "$exit_code"
}

main() {
  PROVER_SUMMARY_ACTIVE=1
  PROVER_RESULT="error"
  PROVER_CATEGORY="configuration"
  PROVER_HOST_WRAPPER_PID=""
  PROVER_DURABLE_ARTIFACTS_COMPLETE=0
  PROVER_PENDING_SIGNAL=""
  PROVER_SIGNAL_HANDLING_ACTIVE=1
  trap finish_prover_execution EXIT
  install_prover_signal_traps
  PROVER_START_MS="$(epoch_millis)"
  validate_prover_observability
  emit_prover_summary start started none 0

  validate_production_proof_mode
  ensure_host_binary
  ensure_prover_artifact_tool_binary

  export PATH="/opt/zkvm/bin:/opt/risc0/bin:/usr/local/bin:/usr/bin:/bin"
  export RISC0_HOME="${RISC0_HOME:-/opt/risc0}"
  export RISC0_SERVER_PATH="${RISC0_SERVER_PATH:-/opt/risc0/bin/r0vm}"
  export RUST_LOG="${RUST_LOG:-info}"

  WORK_INPUT="$(mktemp /tmp/zkvm-input-XXXX.json)"

  PROVER_CATEGORY="input"
  validate_expected_bucket_owner
  resolve_input_file
  validate_input_json

  PROVER_CATEGORY="prover_execution"
  run_host_with_timeout

  PROVER_CATEGORY="artifact"
  stage_outputs
  if [[ -n "$OUTPUT_S3_BUCKET" ]]; then
    if [[ -z "$OUTPUT_S3_PREFIX" ]]; then
      fatal "OUTPUT_S3_BUCKET is set but OUTPUT_S3_PREFIX is empty"
    fi
    create_bundle_archive "$OUTPUT_DIR"
  fi
  PROVER_CATEGORY="upload"
  upload_outputs

  PROVER_RESULT="success"
  PROVER_CATEGORY="none"
  log INFO "Proof generation completed"
}

if [[ "${ENTRYPOINT_SKIP_MAIN:-}" != "1" ]]; then
  main "$@"
fi
