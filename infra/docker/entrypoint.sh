#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

HOST_BIN="${HOST_BIN:-/opt/zkvm/bin/host}"
INPUT_PATH="${INPUT_PATH:-}"
INPUT_S3_BUCKET="${INPUT_S3_BUCKET:-}"
INPUT_S3_KEY="${INPUT_S3_KEY:-}"
OUTPUT_DIR="${OUTPUT_DIR:-/var/task/output}"
OUTPUT_S3_BUCKET="${OUTPUT_S3_BUCKET:-}"
OUTPUT_S3_PREFIX="${OUTPUT_S3_PREFIX:-}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-}"
PUBLIC_INPUT_SCHEMA="${PUBLIC_INPUT_SCHEMA:-stark-ballot.public_input}"
PUBLIC_INPUT_VERSION="${PUBLIC_INPUT_VERSION:-1.1}"
CURRENT_METHOD_VERSION=14
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

validate_prover_observability() {
  if [[ "${TARGET_AWS_RUNTIME:-}" != "1" ]]; then
    return 0
  fi
  if [[ ! "${DEPLOYMENT_ID:-}" =~ ^dep_[0-9a-f]{32}$ ]] ||
     [[ ! "${APP_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] ||
     [[ "${DEPLOY_MODE:-}" != "normal" && "${DEPLOY_MODE:-}" != "rollback" ]] ||
     [[ ! "${EXECUTION_ID:-}" =~ ^[A-Za-z0-9_-]{1,128}$ ]] ||
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
    --arg execution_id "${EXECUTION_ID:-}" \
    --arg phase "$phase" \
    --arg result "$result" \
    --arg category "$category" \
    --arg key_prefix "$key_prefix" \
    --argjson duration_ms "$duration_ms" \
    '{ts:$ts,level:(if $result == "error" then "error" else "info" end),service:"prover",env:$env,deployment_id:$deployment_id,app_source_sha:$app_source_sha,deploy_mode:$deploy_mode,event:"prover_summary",phase:$phase,result:$result,category:$category,duration_ms:$duration_ms,execution_id:$execution_id} + (if $key_prefix == "" then {} else {key_prefix:$key_prefix} end)'
}

log() {
  local level="$1"; shift
  local message="$*"
  message="${message:0:512}"
  if [[ "${TARGET_AWS_RUNTIME:-}" == "1" ]] && validate_prover_observability >/dev/null 2>&1; then
    jq -cn \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
      --arg level "${level,,}" \
      --arg env "${RUNTIME_DEPLOYMENT_ENV:-unknown}" \
      --arg deployment_id "$DEPLOYMENT_ID" \
      --arg app_source_sha "$APP_SOURCE_SHA" \
      --arg deploy_mode "$DEPLOY_MODE" \
      --arg execution_id "$EXECUTION_ID" \
      --arg message "$message" \
      '{ts:$ts,level:$level,service:"prover",env:$env,deployment_id:$deployment_id,app_source_sha:$app_source_sha,deploy_mode:$deploy_mode,event:"prover_log",message:$message,execution_id:$execution_id}' ||
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
  if uses_s3_artifacts && [[ "${RISC0_DEV_MODE:-}" == "1" ]]; then
    fatal "RISC0_DEV_MODE=1 is not allowed for S3-backed async prover execution"
  fi
}

validate_expected_bucket_owner() {
  if [[ "${TARGET_AWS_RUNTIME:-}" != "1" ]] || ! uses_s3_artifacts; then
    return
  fi

  if [[ ! "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
    fatal "AWS_ACCOUNT_ID must be a 12-digit account ID when TARGET_AWS_RUNTIME=1 uses S3 artifacts"
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
    "election_id (or electionId)|(.election_id // .electionId)"
    "election_config_hash (or electionConfigHash)|(.election_config_hash // .electionConfigHash)"
    "bulletin_root (or bulletinRoot)|(.bulletin_root // .bulletinRoot)"
    "tree_size (or treeSize)|(.tree_size // .treeSize)"
    "log_id (or logId)|(.log_id // .logId)"
    "timestamp|(.timestamp)"
    "total_expected (or totalExpected)|(.total_expected // .totalExpected)"
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

convert_output_to_journal() {
  local output_path="$1"
  local journal_path="$2"

  python3 - "$output_path" "$journal_path" "$CURRENT_METHOD_VERSION" <<'PY'
import json
import re
import sys

output_path, journal_path, current_method_version_raw = sys.argv[1:4]
CURRENT_METHOD_VERSION = int(current_method_version_raw)
HEX_PATTERN = re.compile(r"^[0-9a-fA-F]+$")
UUID_PATTERN = re.compile(r"^[0-9a-fA-F]{32}$")

with open(output_path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

if not isinstance(data, dict):
    raise SystemExit("Invalid zkVM output payload")

def get_value(key):
    if key in data:
        return data[key]
    return None

def normalize_hex_string(value, expected_len=None):
    if not isinstance(value, str):
        return None
    compact = value[2:] if value.startswith("0x") else value
    if len(compact) == 0 or len(compact) % 2 != 0:
        return None
    if HEX_PATTERN.fullmatch(compact) is None:
        return None
    if expected_len is not None and len(compact) != expected_len * 2:
        return None
    return "0x" + compact.lower()

def bytes_to_hex(value, expected_len=None):
    if isinstance(value, str):
        return normalize_hex_string(value, expected_len)
    if isinstance(value, list) and all(isinstance(item, int) and 0 <= item <= 255 for item in value):
        if expected_len is not None and len(value) != expected_len:
            return None
        return "0x" + bytes(value).hex()
    return None

def bytes_to_uuid(value):
    if isinstance(value, str):
        compact = value.replace("-", "")
        if UUID_PATTERN.fullmatch(compact) is None:
            return None
        hex_str = compact.lower()
        return f"{hex_str[0:8]}-{hex_str[8:12]}-{hex_str[12:16]}-{hex_str[16:20]}-{hex_str[20:32]}"
    if isinstance(value, list) and len(value) == 16 and all(isinstance(item, int) and 0 <= item <= 255 for item in value):
        hex_str = bytes(value).hex()
        return f"{hex_str[0:8]}-{hex_str[8:12]}-{hex_str[12:16]}-{hex_str[16:20]}-{hex_str[20:32]}"
    return None

def require(value, label):
    if value is None:
        raise SystemExit(f"Missing {label} in zkVM output")
    return value

def require_int(value, label):
    if not isinstance(value, int) or value < 0:
        raise SystemExit(f"Invalid {label} in zkVM output")
    return value

def require_list(value, label, expected_len=None):
    if (
        not isinstance(value, list)
        or (expected_len is not None and len(value) != expected_len)
        or any(not isinstance(item, int) or item < 0 for item in value)
    ):
        raise SystemExit(f"Invalid {label} in zkVM output")
    return value

def require_current_method_version(value, label):
    method_version = require_int(value, label)
    if method_version != CURRENT_METHOD_VERSION:
        raise SystemExit(f"Unsupported {label} in zkVM output: {method_version}")
    return method_version

election_id = require(bytes_to_uuid(get_value("electionId")), "electionId")
election_config_hash = require(bytes_to_hex(get_value("electionConfigHash"), 32), "electionConfigHash")
bulletin_root = require(bytes_to_hex(get_value("bulletinRoot"), 32), "bulletinRoot")
sth_digest = require(bytes_to_hex(get_value("sthDigest"), 32), "sthDigest")
included_bitmap_root = require(bytes_to_hex(get_value("includedBitmapRoot"), 32), "includedBitmapRoot")
seen_bitmap_root = require(bytes_to_hex(get_value("seenBitmapRoot"), 32), "seenBitmapRoot")
input_commitment = require(bytes_to_hex(get_value("inputCommitment"), 32), "inputCommitment")
image_id = require(bytes_to_hex(get_value("imageId"), 32), "imageId")

verified_tally = require_list(get_value("verifiedTally"), "verifiedTally", expected_len=5)

journal = {
    "electionId": election_id,
    "electionConfigHash": election_config_hash,
    "bulletinRoot": bulletin_root,
    "treeSize": require_int(get_value("treeSize"), "treeSize"),
    "totalExpected": require_int(get_value("totalExpected"), "totalExpected"),
    "sthDigest": sth_digest,
    "verifiedTally": verified_tally,
    "totalVotes": require_int(get_value("totalVotes"), "totalVotes"),
    "validVotes": require_int(get_value("validVotes"), "validVotes"),
    "invalidVotes": require_int(get_value("invalidVotes"), "invalidVotes"),
    "seenIndicesCount": require_int(get_value("seenIndicesCount"), "seenIndicesCount"),
    "missingSlots": require_int(get_value("missingSlots"), "missingSlots"),
    "invalidPresentedSlots": require_int(get_value("invalidPresentedSlots"), "invalidPresentedSlots"),
    "rejectedRecords": require_int(get_value("rejectedRecords"), "rejectedRecords"),
    "seenBitmapRoot": seen_bitmap_root,
    "includedBitmapRoot": included_bitmap_root,
    "excludedSlots": require_int(get_value("excludedSlots"), "excludedSlots"),
    "inputCommitment": input_commitment,
    "methodVersion": require_current_method_version(get_value("methodVersion"), "methodVersion"),
    "imageId": image_id,
}

with open(journal_path, "w", encoding="utf-8") as handle:
    json.dump(journal, handle)
PY
}

build_public_input() {
  local input_path="$1"
  local output_path="$2"
  local public_path="$3"

  python3 - "$input_path" "$output_path" "$public_path" "$PUBLIC_INPUT_SCHEMA" "$PUBLIC_INPUT_VERSION" "$CURRENT_METHOD_VERSION" <<'PY'
import json
import sys

input_path, output_path, public_path, schema, version, current_method_version_raw = sys.argv[1:7]
CURRENT_METHOD_VERSION = int(current_method_version_raw)

with open(input_path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

with open(output_path, "r", encoding="utf-8") as handle:
    output = json.load(handle)

if not isinstance(output, dict):
    raise SystemExit("Invalid zkVM output payload")

def get_value(record, *keys):
    if not isinstance(record, dict):
        return None
    for key in keys:
        if key in record:
            return record[key]
    return None

def bytes_to_hex(value, expected_len=None):
    if isinstance(value, str):
        return value if value.startswith("0x") else f"0x{value}"
    if isinstance(value, list) and all(isinstance(item, int) for item in value):
        if expected_len is not None and len(value) != expected_len:
            return None
        return "0x" + bytes(value).hex()
    return None

def bytes_to_uuid(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list) and len(value) == 16 and all(isinstance(item, int) for item in value):
        hex_str = bytes(value).hex()
        return f"{hex_str[0:8]}-{hex_str[8:12]}-{hex_str[12:16]}-{hex_str[16:20]}-{hex_str[20:32]}"
    return None

def require(value, label):
    if value is None:
        raise SystemExit(f"Missing {label} in zkVM input")
    return value

def require_int(value, label):
    if not isinstance(value, int):
        raise SystemExit(f"Invalid {label} in zkVM input")
    return value

def require_list(value, label):
    if not isinstance(value, list):
        raise SystemExit(f"Invalid {label} in zkVM input")
    return value

def require_current_method_version(value):
    if not isinstance(value, int):
        raise SystemExit("Missing methodVersion in zkVM output")
    if value != CURRENT_METHOD_VERSION:
        raise SystemExit(f"Unsupported methodVersion in zkVM output: {value}")
    return value

election_id = require(
    bytes_to_uuid(get_value(payload, "election_id", "electionId")),
    "election_id",
)
contract_generation = require(
    get_value(payload, "contract_generation", "contractGeneration"),
    "contract_generation",
)
election_config_hash = require(
    bytes_to_hex(get_value(payload, "election_config_hash", "electionConfigHash"), 32),
    "election_config_hash",
)
bulletin_root = require(
    bytes_to_hex(get_value(payload, "bulletin_root", "bulletinRoot"), 32),
    "bulletin_root",
)
tree_size = require_int(get_value(payload, "tree_size", "treeSize"), "tree_size")
total_expected = require_int(get_value(payload, "total_expected", "totalExpected"), "total_expected")
log_id = require(
    bytes_to_hex(get_value(payload, "log_id", "logId"), 32),
    "log_id",
)
timestamp = require_int(get_value(payload, "timestamp"), "timestamp")

method_version = require_current_method_version(get_value(output, "methodVersion"))

votes = require_list(get_value(payload, "votes"), "votes")
public_votes = []
for vote in votes:
    if not isinstance(vote, dict):
        raise SystemExit("Invalid vote entry")

    index = get_value(vote, "index")
    if not isinstance(index, int):
        raise SystemExit("Invalid vote index")

    commitment = bytes_to_hex(get_value(vote, "commitment"), 32)
    if commitment is None:
        raise SystemExit("Invalid vote commitment")

    merkle_path = get_value(vote, "merkle_path", "merklePath")
    if not isinstance(merkle_path, list):
        raise SystemExit("Invalid vote merkle_path")

    path_nodes = []
    for node in merkle_path:
        node_hex = bytes_to_hex(node, 32)
        if node_hex is None:
            raise SystemExit("Invalid merkle path node")
        path_nodes.append(node_hex)

    public_votes.append(
        {
            "index": index,
            "commitment": commitment,
            "merklePath": path_nodes,
        }
    )

public_input = {
    "schema": schema,
    "version": version,
    "contractGeneration": contract_generation,
    "electionId": election_id,
    "electionConfigHash": election_config_hash,
    "bulletinRoot": bulletin_root,
    "treeSize": tree_size,
    "totalExpected": total_expected,
    "logId": log_id,
    "timestamp": timestamp,
    "methodVersion": method_version,
    "votes": public_votes,
}

with open(public_path, "w", encoding="utf-8") as handle:
    json.dump(public_input, handle)
PY
}

build_election_manifest() {
  local input_path="$1"
  local manifest_path="$2"

  python3 - "$input_path" "$manifest_path" <<'PY'
import hashlib
import json
import sys

input_path, manifest_path = sys.argv[1:3]

with open(input_path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

def get_value(record, *keys):
    if not isinstance(record, dict):
        return None
    for key in keys:
        if key in record:
            return record[key]
    return None

def bytes_to_uuid(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list) and len(value) == 16 and all(isinstance(item, int) for item in value):
        hex_str = bytes(value).hex()
        return f"{hex_str[0:8]}-{hex_str[8:12]}-{hex_str[12:16]}-{hex_str[16:20]}-{hex_str[20:32]}"
    return None

def bytes_to_hex(value, expected_len=None):
    if isinstance(value, str):
        normalized = value if value.startswith("0x") else f"0x{value}"
        if expected_len is not None and len(normalized) != (2 + expected_len * 2):
            return None
        return normalized
    if isinstance(value, list) and all(isinstance(item, int) for item in value):
        if expected_len is not None and len(value) != expected_len:
            return None
        return "0x" + bytes(value).hex()
    return None

def require(value, label):
    if value is None:
        raise SystemExit(f"Missing {label} in zkVM input")
    return value

def require_int(value, label):
    if not isinstance(value, int):
        raise SystemExit(f"Invalid {label} in zkVM input")
    return value

def normalize_election_config(value):
    if not isinstance(value, dict):
        raise SystemExit("Invalid election_config in zkVM input")

    total_expected = get_value(value, "totalExpected", "total_expected")
    choices = get_value(value, "choices")
    version = get_value(value, "version")
    bot_count = get_value(value, "botCount", "bot_count")
    merkle_tree_depth = get_value(value, "merkleTreeDepth", "merkle_tree_depth")

    if not isinstance(total_expected, int):
        raise SystemExit("Invalid election_config.totalExpected in zkVM input")
    if not isinstance(choices, list) or not choices or not all(isinstance(choice, str) and choice for choice in choices):
        raise SystemExit("Invalid election_config.choices in zkVM input")
    if not isinstance(version, str) or not version:
        raise SystemExit("Invalid election_config.version in zkVM input")
    if not isinstance(bot_count, int) or bot_count < 0:
        raise SystemExit("Invalid election_config.botCount in zkVM input")
    if not isinstance(merkle_tree_depth, int) or merkle_tree_depth <= 0:
        raise SystemExit("Invalid election_config.merkleTreeDepth in zkVM input")

    return {
        "totalExpected": total_expected,
        "choices": choices,
        "version": version,
        "botCount": bot_count,
        "merkleTreeDepth": merkle_tree_depth,
    }

def compute_election_config_hash(config):
    hash_payload = {
        "totalExpected": config["totalExpected"],
        "choices": config["choices"],
        "version": config["version"],
        "botCount": config["botCount"],
        "merkleTreeDepth": config["merkleTreeDepth"],
    }
    return "0x" + hashlib.sha256(
        json.dumps(hash_payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()

election_id = require(
    bytes_to_uuid(get_value(payload, "election_id", "electionId")),
    "election_id",
)
election_config_hash = require(
    bytes_to_hex(get_value(payload, "election_config_hash", "electionConfigHash"), 32),
    "election_config_hash",
)
input_total_expected = require_int(get_value(payload, "total_expected", "totalExpected"), "total_expected")
raw_election_config = require(
    get_value(payload, "election_config", "electionConfig"),
    "election_config",
)
manifest_config = normalize_election_config(raw_election_config)
computed_hash = compute_election_config_hash(manifest_config)

if manifest_config["totalExpected"] != input_total_expected:
    raise SystemExit("election_config.totalExpected does not match zkVM input")

if computed_hash != election_config_hash:
    raise SystemExit("election_config hash does not match zkVM input")

manifest = {
    "electionId": election_id,
    "totalExpected": manifest_config["totalExpected"],
    "choices": manifest_config["choices"],
    "version": manifest_config["version"],
    "botCount": manifest_config["botCount"],
    "merkleTreeDepth": manifest_config["merkleTreeDepth"],
    "electionConfigHash": computed_hash,
}

with open(manifest_path, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle)
PY
}

build_close_statement() {
  local input_path="$1"
  local output_path="$2"
  local close_path="$3"

  python3 - "$input_path" "$output_path" "$close_path" <<'PY'
import hashlib
import json
import struct
import sys

input_path, output_path, close_path = sys.argv[1:4]

with open(input_path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

with open(output_path, "r", encoding="utf-8") as handle:
    output = json.load(handle)

def get_value(record, *keys):
    if not isinstance(record, dict):
        return None
    for key in keys:
        if key in record:
            return record[key]
    return None

def bytes_to_hex(value, expected_len=None):
    if isinstance(value, str):
        return value if value.startswith("0x") else f"0x{value}"
    if isinstance(value, list) and all(isinstance(item, int) for item in value):
        if expected_len is not None and len(value) != expected_len:
            return None
        return "0x" + bytes(value).hex()
    return None

def require(value, label):
    if value is None:
        raise SystemExit(f"Missing {label}")
    return value

def require_int(value, label):
    if not isinstance(value, int):
        raise SystemExit(f"Invalid {label}")
    return value

log_id = require(
    bytes_to_hex(get_value(payload, "log_id", "logId"), 32),
    "log_id in zkVM input",
)
timestamp = require_int(get_value(payload, "timestamp"), "timestamp in zkVM input")
tree_size = require_int(get_value(output, "treeSize", "tree_size"), "treeSize in zkVM output")
bulletin_root = require(
    bytes_to_hex(get_value(output, "bulletinRoot", "bulletin_root"), 32),
    "bulletinRoot in zkVM output",
)

digest = hashlib.sha256(
    bytes.fromhex(log_id[2:])
    + struct.pack("<I", tree_size)
    + struct.pack("<Q", timestamp)
    + bytes.fromhex(bulletin_root[2:])
).hexdigest()

close_statement = {
    "logId": log_id,
    "treeSize": tree_size,
    "timestamp": timestamp,
    "bulletinRoot": bulletin_root,
    "sthDigest": "0x" + digest,
}

with open(close_path, "w", encoding="utf-8") as handle:
    json.dump(close_statement, handle)
PY
}

# Keep this validator aligned with
# packages/domain/src/lib/finalize/finalization-result.ts::resolveConsistentPublicAuditArtifacts.
validate_public_audit_artifacts() {
  local journal_path="$1"
  local public_input_path="$2"
  local election_manifest_path="$3"
  local close_statement_path="$4"

  python3 - "$journal_path" "$public_input_path" "$election_manifest_path" "$close_statement_path" <<'PY'
import hashlib
import json
import struct
import sys

journal_path, public_input_path, election_manifest_path, close_statement_path = sys.argv[1:5]

with open(journal_path, "r", encoding="utf-8") as handle:
    journal = json.load(handle)

with open(public_input_path, "r", encoding="utf-8") as handle:
    public_input = json.load(handle)

with open(election_manifest_path, "r", encoding="utf-8") as handle:
    election_manifest = json.load(handle)

with open(close_statement_path, "r", encoding="utf-8") as handle:
    close_statement = json.load(handle)

def require_record(value, label):
    if not isinstance(value, dict):
        raise SystemExit(f"Invalid {label}")
    return value

def require_string(record, key, label=None):
    value = record.get(key)
    if not isinstance(value, str) or not value:
        raise SystemExit(f"Missing {label or key}")
    return value

def require_int(record, key, label=None):
    value = record.get(key)
    if not isinstance(value, int):
        raise SystemExit(f"Invalid {label or key}")
    return value

def normalize_hex(value, expected_len=None):
    if not isinstance(value, str):
        raise SystemExit("Expected hex string")
    normalized = value[2:] if value.startswith("0x") else value
    if expected_len is not None and len(normalized) != expected_len * 2:
        raise SystemExit("Unexpected hex length")
    return normalized.lower()

def uuid_to_bytes(value):
    if not isinstance(value, str):
        raise SystemExit("Expected UUID string")
    return bytes.fromhex(value.replace("-", ""))

def uint16le(value):
    return struct.pack("<H", value)

def uint32le(value):
    return struct.pack("<I", value)

def uint64le(value):
    return struct.pack("<Q", value)

def matches_hex(left, right, expected_len=None):
    return normalize_hex(left, expected_len) == normalize_hex(right, expected_len)

def compute_input_commitment(public_input_record):
    votes = public_input_record.get("votes")
    if not isinstance(votes, list):
        raise SystemExit("Invalid public-input votes")

    digest = hashlib.sha256()
    digest.update(b"stark-ballot:input|v1.0")
    digest.update(uint32le(10))
    digest.update(uuid_to_bytes(require_string(public_input_record, "electionId")))
    digest.update(bytes.fromhex(normalize_hex(require_string(public_input_record, "bulletinRoot"), 32)))
    digest.update(uint32le(require_int(public_input_record, "treeSize")))
    digest.update(uint32le(require_int(public_input_record, "totalExpected")))
    digest.update(uint32le(len(votes)))

    for vote in sorted(votes, key=lambda item: require_int(require_record(item, "vote"), "index", "vote.index")):
        vote_record = require_record(vote, "vote")
        digest.update(uint32le(require_int(vote_record, "index", "vote.index")))
        digest.update(uint16le(32))
        digest.update(bytes.fromhex(normalize_hex(require_string(vote_record, "commitment", "vote.commitment"), 32)))

        merkle_path = vote_record.get("merklePath")
        if not isinstance(merkle_path, list):
            raise SystemExit("Invalid vote.merklePath")
        digest.update(uint16le(len(merkle_path)))
        for node in merkle_path:
            if not isinstance(node, str):
                raise SystemExit("Invalid merkle path node")
            digest.update(bytes.fromhex(normalize_hex(node, 32)))

    return "0x" + digest.hexdigest()

def compute_election_manifest_hash(manifest_record):
    payload = {
        "totalExpected": require_int(manifest_record, "totalExpected", "election-manifest.totalExpected"),
        "choices": manifest_record.get("choices"),
        "version": require_string(manifest_record, "version", "election-manifest.version"),
        "botCount": require_int(manifest_record, "botCount", "election-manifest.botCount"),
        "merkleTreeDepth": require_int(manifest_record, "merkleTreeDepth", "election-manifest.merkleTreeDepth"),
    }
    if not isinstance(payload["choices"], list) or not all(isinstance(choice, str) and choice for choice in payload["choices"]):
        raise SystemExit("Invalid election-manifest.choices")
    return "0x" + hashlib.sha256(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()

def compute_sth_digest(close_statement_record):
    log_id = require_string(close_statement_record, "logId", "close-statement.logId")
    tree_size = require_int(close_statement_record, "treeSize", "close-statement.treeSize")
    timestamp = require_int(close_statement_record, "timestamp", "close-statement.timestamp")
    bulletin_root = require_string(close_statement_record, "bulletinRoot", "close-statement.bulletinRoot")
    return "0x" + hashlib.sha256(
        bytes.fromhex(normalize_hex(log_id, 32))
        + uint32le(tree_size)
        + uint64le(timestamp)
        + bytes.fromhex(normalize_hex(bulletin_root, 32))
    ).hexdigest()

require_record(journal, "journal")
require_record(public_input, "public-input")
require_record(election_manifest, "election-manifest")
require_record(close_statement, "close-statement")

if public_input.get("schema") != "stark-ballot.public_input":
    raise SystemExit("Invalid public-input schema")
if public_input.get("version") != "1.1":
    raise SystemExit("Invalid public-input version")
if not isinstance(public_input.get("contractGeneration"), str) or not public_input.get("contractGeneration"):
    raise SystemExit("Invalid public-input contractGeneration")

if require_string(public_input, "electionId", "public-input.electionId") != require_string(
    journal, "electionId", "journal.electionId"
):
    raise SystemExit("public-input.electionId drifted from journal")
if not matches_hex(require_string(public_input, "electionConfigHash"), require_string(journal, "electionConfigHash"), 32):
    raise SystemExit("public-input.electionConfigHash drifted from journal")
if not matches_hex(require_string(public_input, "bulletinRoot"), require_string(journal, "bulletinRoot"), 32):
    raise SystemExit("public-input.bulletinRoot drifted from journal")
if require_int(public_input, "treeSize") != require_int(journal, "treeSize"):
    raise SystemExit("public-input.treeSize drifted from journal")
if require_int(public_input, "totalExpected") != require_int(journal, "totalExpected"):
    raise SystemExit("public-input.totalExpected drifted from journal")
if require_int(public_input, "methodVersion") != require_int(journal, "methodVersion"):
    raise SystemExit("public-input.methodVersion drifted from journal")
if not matches_hex(compute_input_commitment(public_input), require_string(journal, "inputCommitment"), 32):
    raise SystemExit("public-input commitment drifted from journal")

manifest_hash = compute_election_manifest_hash(election_manifest)
if require_string(election_manifest, "electionId", "election-manifest.electionId") != require_string(
    journal, "electionId", "journal.electionId"
):
    raise SystemExit("election-manifest.electionId drifted from journal")
if require_string(election_manifest, "electionId", "election-manifest.electionId") != require_string(
    public_input, "electionId", "public-input.electionId"
):
    raise SystemExit("election-manifest.electionId drifted from public-input")
if require_int(election_manifest, "totalExpected", "election-manifest.totalExpected") != require_int(
    journal, "totalExpected", "journal.totalExpected"
):
    raise SystemExit("election-manifest.totalExpected drifted from journal")
if not matches_hex(require_string(election_manifest, "electionConfigHash"), manifest_hash, 32):
    raise SystemExit("election-manifest self-hash mismatch")
if not matches_hex(
    require_string(election_manifest, "electionConfigHash"),
    require_string(journal, "electionConfigHash"),
    32,
):
    raise SystemExit("election-manifest.electionConfigHash drifted from journal")
if not matches_hex(
    require_string(election_manifest, "electionConfigHash"),
    require_string(public_input, "electionConfigHash"),
    32,
):
    raise SystemExit("election-manifest.electionConfigHash drifted from public-input")

if not matches_hex(require_string(close_statement, "logId"), require_string(public_input, "logId"), 32):
    raise SystemExit("close-statement.logId drifted from public-input")
if require_int(close_statement, "timestamp", "close-statement.timestamp") != require_int(
    public_input, "timestamp", "public-input.timestamp"
):
    raise SystemExit("close-statement.timestamp drifted from public-input")
if require_int(close_statement, "treeSize", "close-statement.treeSize") != require_int(
    journal, "treeSize", "journal.treeSize"
):
    raise SystemExit("close-statement.treeSize drifted from journal")
if not matches_hex(require_string(close_statement, "bulletinRoot"), require_string(journal, "bulletinRoot"), 32):
    raise SystemExit("close-statement.bulletinRoot drifted from journal")
if not matches_hex(require_string(close_statement, "sthDigest"), compute_sth_digest(close_statement), 32):
    raise SystemExit("close-statement.sthDigest self-check failed")
if not matches_hex(require_string(close_statement, "sthDigest"), require_string(journal, "sthDigest"), 32):
    raise SystemExit("close-statement.sthDigest drifted from journal")
PY
}

create_bundle_archive() {
  local output_dir="$1"
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
  convert_output_to_journal "$output_file" "${bundle_dir}/journal.json"

  if [[ -n "${WORK_INPUT:-}" && -f "$WORK_INPUT" ]]; then
    build_public_input "$WORK_INPUT" "$output_file" "$public_input_path"
    build_election_manifest "$WORK_INPUT" "$election_manifest_path"
    build_close_statement "$WORK_INPUT" "$output_file" "$close_statement_path"
    validate_public_audit_artifacts \
      "${bundle_dir}/journal.json" \
      "$public_input_path" \
      "$election_manifest_path" \
      "$close_statement_path"
    cp "$public_input_path" "${bundle_dir}/public-input.json"
    cp "$election_manifest_path" "${bundle_dir}/election-manifest.json"
    cp "$close_statement_path" "${bundle_dir}/close-statement.json"
  else
    fatal "WORK_INPUT not available; cannot create public-input.json"
  fi

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
