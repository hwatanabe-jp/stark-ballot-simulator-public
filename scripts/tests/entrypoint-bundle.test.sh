#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

if ! timeout --version | grep -q '^timeout (GNU coreutils) '; then
  echo "The prover entrypoint harness requires GNU Coreutils timeout, as in the Amazon Linux prover image." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENTRYPOINT_PATH="${ROOT_DIR}/infra/docker/entrypoint.sh"
SEMANTIC_CONTRACT_PATH="${ROOT_DIR}/zkvm/contract-core/src/current-zkvm-semantic-contract.json"
CURRENT_METHOD_VERSION="$(jq -er '.method.methodVersion | select(type == "number" and floor == .)' "$SEMANTIC_CONTRACT_PATH")"

if [[ -z "$CURRENT_METHOD_VERSION" ]]; then
  echo "Failed to resolve current method version"
  exit 1
fi

export CURRENT_METHOD_VERSION
export PUBLIC_BUNDLE_MANIFEST_PATH="${ROOT_DIR}/packages/verification/src/verification/public-bundle-manifest.json"
export PROVER_ARTIFACT_TOOL_BIN="${ROOT_DIR}/zkvm/target/debug/prover-artifacts"

RISC0_SKIP_BUILD=1 cargo build --quiet --manifest-path "${ROOT_DIR}/zkvm/Cargo.toml" -p host --bin prover-artifacts

export ENTRYPOINT_SKIP_MAIN=1

# shellcheck source=/dev/null
source "$ENTRYPOINT_PATH"

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

summary_log="${tmp_dir}/prover-summary.log"
RUNTIME_PROFILE=target-aws-async \
  RUNTIME_DEPLOYMENT_ENV=develop \
  DEPLOYMENT_ID=dep_0123456789abcdef0123456789abcdef \
  APP_SOURCE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  DEPLOY_MODE=normal \
  FINALIZATION_ID=01J00000000000000000000000 \
  LOG_IP_HASH_SALT=private-summary-salt \
  OUTPUT_S3_PREFIX=private/session/finalization \
  emit_prover_summary start started none 0 >"$summary_log"
python3 - "$summary_log" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    record = json.load(handle)

assert record["event"] == "prover_summary"
assert record["phase"] == "start"
assert record["result"] == "started"
assert record["category"] == "none"
assert record["duration_ms"] == 0
assert record["finalization_id"] == "01J00000000000000000000000"
assert record["deployment_id"] == "dep_0123456789abcdef0123456789abcdef"
assert record["app_source_sha"] == "a" * 40
assert record["deploy_mode"] == "normal"
assert record["key_prefix"].startswith("key_")
assert "private-summary-salt" not in open(sys.argv[1], encoding="utf-8").read()
assert "private/session/execution" not in open(sys.argv[1], encoding="utf-8").read()
PY

invalid_observability_log="${tmp_dir}/invalid-prover-observability.log"
if (
  RUNTIME_PROFILE=target-aws-async \
    DEPLOYMENT_ID=dep_invalid \
    APP_SOURCE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    DEPLOY_MODE=normal \
    FINALIZATION_ID=01J00000000000000000000000 \
    LOG_IP_HASH_SALT=private-summary-salt \
    validate_prover_observability
) >"$invalid_observability_log" 2>&1; then
  echo "target prover observability should reject an invalid deployment ID"
  exit 1
fi
if grep -q 'private-summary-salt' "$invalid_observability_log"; then
  echo "prover observability validation must not expose the log hash salt"
  exit 1
fi

missing_host_log="${tmp_dir}/missing-host.log"
if (HOST_BIN="${tmp_dir}/private-host-binary" ensure_host_binary) >"$missing_host_log" 2>&1; then
  echo "ensure_host_binary should reject a missing host binary"
  exit 1
fi
if grep -Eq "${tmp_dir}|private-host-binary" "$missing_host_log"; then
  echo "missing host errors must not expose local paths"
  cat "$missing_host_log"
  exit 1
fi

missing_input_log="${tmp_dir}/missing-input.log"
if (
  INPUT_PATH="${tmp_dir}/private-input-canary.json" \
    INPUT_S3_BUCKET='' \
    INPUT_S3_KEY='' \
    resolve_input_file
) >"$missing_input_log" 2>&1; then
  echo "resolve_input_file should reject a missing configured local input"
  exit 1
fi
if grep -Eq "${tmp_dir}|private-input-canary" "$missing_input_log"; then
  echo "missing local input errors must not expose local paths"
  cat "$missing_input_log"
  exit 1
fi

camel_case_input="${tmp_dir}/camel-case-input.json"
cat >"$camel_case_input" <<'JSON'
{
  "electionId": [],
  "electionConfigHash": [],
  "bulletinRoot": [],
  "treeSize": 1,
  "logId": [],
  "timestamp": 1,
  "totalExpected": 1,
  "votes": []
}
JSON
camel_case_input_log="${tmp_dir}/camel-case-input.log"
if (WORK_INPUT="$camel_case_input" validate_input_json) >"$camel_case_input_log" 2>&1; then
  echo "entrypoint input admission should reject non-current camelCase fields"
  exit 1
fi
grep -q 'Missing required field: election_id' "$camel_case_input_log"

owner_error="${tmp_dir}/owner-error.txt"
if (RUNTIME_PROFILE=target-aws-async INPUT_S3_BUCKET=proof-inputs AWS_ACCOUNT_ID='' validate_expected_bucket_owner) >"$owner_error" 2>&1; then
  echo "target S3 mode should reject a missing AWS_ACCOUNT_ID"
  exit 1
fi
grep -q "AWS_ACCOUNT_ID must be a 12-digit account ID" "$owner_error"

if (RUNTIME_PROFILE=target-aws-async OUTPUT_S3_BUCKET=proof-outputs AWS_ACCOUNT_ID=not-an-account validate_expected_bucket_owner) >"$owner_error" 2>&1; then
  echo "target S3 mode should reject a malformed AWS_ACCOUNT_ID"
  exit 1
fi
grep -q "AWS_ACCOUNT_ID must be a 12-digit account ID" "$owner_error"

profile_error="${tmp_dir}/profile-error.txt"
if (RUNTIME_PROFILE=local-proof-production INPUT_S3_BUCKET=proof-inputs validate_production_proof_mode) >"$profile_error" 2>&1; then
  echo "S3-backed async prover mode should reject a non-target runtime profile"
  exit 1
fi
grep -q "target-aws-async is required for S3-backed async prover execution" "$profile_error"

RUNTIME_PROFILE=local-proof-production validate_production_proof_mode

# Batch start admission must follow queue wait and precede all proof/data work.
(
  export INPUT_S3_BUCKET=private-input-canary
  export AWS_REGION=ap-northeast-1 AWS_BATCH_JOB_ID=job-fixture
  export PROVER_START_ADMISSION_FUNCTION=fixture-finalizer
  export FINALIZATION_ID=01J00000000000000000000000
  export PROVER_EXECUTION_ARN=arn:aws:states:ap-northeast-1:123456789012:execution:fixture:01J00000000000000000000000
  export PROVER_START_PAYLOAD='{"sessionId":"private-session-canary","finalizationId":"01J00000000000000000000000","queuedAtMs":1720000000000}'
  admission_calls="${tmp_dir}/admission-calls"
  admission_request="${tmp_dir}/admission-request.json"
  mock_response='{"status":"success","sessionId":"private-session-canary","state":{"finalizationId":"01J00000000000000000000000","status":"running"}}'
  mock_metadata='{"StatusCode":200}'
  mock_exit=0
  aws() {
    [[ "$1 $2" == 'lambda invoke' ]] || { echo 'Unexpected AWS data operation' >&2; return 90; }
    printf 'invoke\n' >>"$admission_calls"
    local args=("$@") request_path=''
    for arg in "${args[@]}"; do
      if [[ "$arg" == fileb://* ]]; then request_path="${arg#fileb://}"; fi
    done
    cp "$request_path" "$admission_request"
    printf '%s' "$mock_response" >"${args[${#args[@]}-1]}"
    printf '%s' "$mock_metadata"
    return "$mock_exit"
  }
  admit_batch_prover_start
  jq -e '.status == "RUNNING" and .payload.sessionId == "private-session-canary" and .payload.queuedAtMs == 1720000000000 and (.startedAtIso | endswith("Z"))' "$admission_request" >/dev/null
  for scenario in cancelled superseded missing malformed function_error transport_error invalid_payload missing_config; do
    (
      case "$scenario" in
        cancelled) mock_response="$(printf '%s' "$mock_response" | jq '.state.status = "failed"')" ;;
        superseded) mock_response="$(printf '%s' "$mock_response" | jq '.state.finalizationId = "another-finalization"')" ;;
        missing) mock_response='{"status":"success","sessionId":"private-session-canary"}' ;;
        malformed) mock_response='not-json-private-canary' ;;
        function_error) mock_metadata='{"StatusCode":200,"FunctionError":"Unhandled"}' ;;
        transport_error) mock_exit=1 ;;
        invalid_payload) PROVER_START_PAYLOAD='{}' ;;
        missing_config) unset PROVER_START_ADMISSION_FUNCTION ;;
      esac
      # Invoke the real main so rejection is checked before any later hooks.
      main
    ) >"${tmp_dir}/admission-${scenario}.log" 2>&1 && {
      echo "Batch start must reject $scenario" >&2
      exit 1
    }
    grep -q 'Batch prover start' "${tmp_dir}/admission-${scenario}.log"
    if grep -Eq 'private-.*canary|Unexpected AWS data operation|prover_summary|failure-marker' "${tmp_dir}/admission-${scenario}.log"; then
      echo "Rejected Batch start leaked input or proceeded to proof/data work: $scenario" >&2
      exit 1
    fi
  done
  before_local="$(wc -l <"$admission_calls")"
  INPUT_S3_BUCKET='' admit_batch_prover_start
  [[ "$(wc -l <"$admission_calls")" == "$before_local" ]]
)

aws_log="${tmp_dir}/aws-args.txt"
aws() {
  printf '%s ' "$@" >>"$aws_log"
  printf '\n' >>"$aws_log"
}

AWS_ACCOUNT_ID=123456789012 aws_s3_cp "s3://proof-inputs/session/input.json" "${tmp_dir}/input.json"
grep -q -- "s3api get-object --bucket proof-inputs --key session/input.json --expected-bucket-owner 123456789012 ${tmp_dir}/input.json" "$aws_log"

printf '{}\n' >"${tmp_dir}/upload.json"
AWS_ACCOUNT_ID=123456789012 aws_s3_cp "${tmp_dir}/upload.json" "s3://proof-outputs/session/output.json"
grep -q -- "s3api put-object --bucket proof-outputs --key session/output.json --body ${tmp_dir}/upload.json --expected-bucket-owner 123456789012" "$aws_log"

malformed_source_log="${tmp_dir}/malformed-source.log"
if (
  AWS_ACCOUNT_ID=123456789012 aws_s3_cp \
    's3://malformed-source-private-canary' \
    "${tmp_dir}/malformed-source.json"
) >"$malformed_source_log" 2>&1; then
  echo "target-account S3 download should reject a source URI without an object key"
  exit 1
fi
grep -q 'Invalid S3 source URI' "$malformed_source_log"
if grep -Eq 'malformed-source-private-canary|s3://' "$malformed_source_log"; then
  echo "malformed source errors must not expose the S3 URI"
  cat "$malformed_source_log"
  exit 1
fi

malformed_destination_log="${tmp_dir}/malformed-destination.log"
if (
  AWS_ACCOUNT_ID=123456789012 aws_s3_cp \
    "${tmp_dir}/upload.json" \
    's3://malformed-destination-private-canary'
) >"$malformed_destination_log" 2>&1; then
  echo "target-account S3 upload should reject a destination URI without an object key"
  exit 1
fi
grep -q 'Invalid S3 destination URI' "$malformed_destination_log"
if grep -Eq 'malformed-destination-private-canary|s3://' "$malformed_destination_log"; then
  echo "malformed destination errors must not expose the S3 URI"
  cat "$malformed_destination_log"
  exit 1
fi

input_log="${tmp_dir}/input-download.log"
INPUT_S3_BUCKET=private-input-canary \
  INPUT_S3_KEY=raw-session-canary/private-input.json \
  WORK_INPUT="${tmp_dir}/downloaded-input.json" \
  AWS_ACCOUNT_ID='' \
  resolve_input_file >"$input_log" 2>&1
grep -q -- "s3 cp s3://private-input-canary/raw-session-canary/private-input.json ${tmp_dir}/downloaded-input.json" "$aws_log"
if grep -Eq 'private-input-canary|raw-session-canary|s3://' "$input_log"; then
  echo "resolve_input_file logs must not expose the S3 input URI"
  cat "$input_log"
  exit 1
fi

upload_output_dir="${tmp_dir}/private-upload-output"
mkdir -p "$upload_output_dir"
printf '{}\n' >"${upload_output_dir}/receipt.json"
upload_log="${tmp_dir}/output-upload.log"
PROVER_DURABLE_ARTIFACTS_COMPLETE=0
# upload_outputs reads these as globals from the sourced entrypoint.
# shellcheck disable=SC2034
OUTPUT_DIR="$upload_output_dir"
# shellcheck disable=SC2034
OUTPUT_S3_BUCKET=''
OUTPUT_S3_PREFIX=''
# shellcheck disable=SC2034
AWS_ACCOUNT_ID=''
upload_outputs >"$upload_log" 2>&1
if [[ "$PROVER_DURABLE_ARTIFACTS_COMPLETE" != "0" ]]; then
  echo "local output staging must not be treated as durable publication"
  exit 1
fi

# shellcheck disable=SC2034
OUTPUT_S3_BUCKET=private-output-canary
# shellcheck disable=SC2034
OUTPUT_S3_PREFIX=raw-session-canary/execution-canary
upload_outputs >"$upload_log" 2>&1
if [[ "$PROVER_DURABLE_ARTIFACTS_COMPLETE" != "1" ]]; then
  echo "successful S3 output publication must set the durable completion marker"
  exit 1
fi
grep -q -- "s3 cp ${upload_output_dir}/receipt.json s3://private-output-canary/raw-session-canary/execution-canary/receipt.json" "$aws_log"
if grep -Eq 'private-output-canary|raw-session-canary|execution-canary|s3://' "$upload_log"; then
  echo "upload_outputs logs must not expose the S3 output URI"
  cat "$upload_log"
  exit 1
fi

durable_signal_output_dir="${tmp_dir}/durable-signal-output"
mkdir -p "$durable_signal_output_dir"
printf '{}\n' >"${durable_signal_output_dir}/receipt.json"
if ! (
  PROVER_DURABLE_ARTIFACTS_COMPLETE=0
  # upload_outputs reads these as globals from the sourced entrypoint.
  # shellcheck disable=SC2034
  PROVER_SIGNAL_HANDLING_ACTIVE=1
  # shellcheck disable=SC2034
  PROVER_PENDING_SIGNAL=''
  trap 'handle_prover_signal TERM' TERM
  trap 'handle_prover_signal INT' INT
  # The sourced entrypoint invokes this test double indirectly.
  # shellcheck disable=SC2317
  upload_with_retry() {
    kill -s TERM "$BASHPID"
    return 0
  }
  # shellcheck disable=SC2034
  OUTPUT_DIR="$durable_signal_output_dir"
  # shellcheck disable=SC2034
  OUTPUT_S3_BUCKET=private-output-canary
  # shellcheck disable=SC2034
  OUTPUT_S3_PREFIX=raw-session-canary/execution-canary
  upload_outputs
); then
  echo "a signal concurrent with the final successful upload must preserve durable success"
  exit 1
fi

failed_upload_log="${tmp_dir}/failed-upload.log"
if (
  # The sourced entrypoint invokes this test double indirectly.
  # shellcheck disable=SC2317
  aws_s3_cp() { return 1; }
  UPLOAD_MAX_ATTEMPTS=1 upload_with_retry \
    "${tmp_dir}/private-artifact-canary.json" \
    's3://private-output-canary/raw-session-canary/private-artifact-canary.json'
) >"$failed_upload_log" 2>&1; then
  echo "upload_with_retry should fail after exhausting retries"
  exit 1
fi
if grep -Eq "${tmp_dir}|private-output-canary|raw-session-canary|s3://" "$failed_upload_log"; then
  echo "upload_with_retry failure logs must not expose local paths or S3 destinations"
  cat "$failed_upload_log"
  exit 1
fi

failure_marker_dir="${tmp_dir}/private-failure-marker"
mkdir -p "$failure_marker_dir"
mapfile -t failure_marker_categories < <(
  python3 - "${ROOT_DIR}/infra/docker/prover-failure-marker-contract.json" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    contract = json.load(handle)

for category in contract["categories"]:
    print(category)
PY
)
for failure_category in "${failure_marker_categories[@]}"; do
  OUTPUT_DIR="$failure_marker_dir" write_failure_marker "$failure_category"
  python3 - "${failure_marker_dir}/failure-marker.json" "$failure_category" <<'PY'
import json
import sys

marker_path, expected_category = sys.argv[1:3]
with open(marker_path, "r", encoding="utf-8") as handle:
    marker = json.load(handle)

assert marker == {"category": expected_category}
PY
done

if OUTPUT_DIR="$failure_marker_dir" write_failure_marker 'private-arbitrary-failure'; then
  echo "failure markers must reject categories outside the closed registry"
  exit 1
fi

failure_marker_aws_log="${tmp_dir}/failure-marker-aws.log"
(
  # The sourced entrypoint invokes this test double indirectly.
  # shellcheck disable=SC2317
  aws() {
    printf '%s ' "$@" >>"$failure_marker_aws_log"
    printf '\n' >>"$failure_marker_aws_log"
    if [[ "$*" == *s3api*put-object* ]]; then
      printf '{"VersionId":"failure-marker-version-1"}\n'
    fi
  }
  OUTPUT_DIR="$failure_marker_dir" \
    OUTPUT_S3_BUCKET=private-output-canary \
    OUTPUT_S3_PREFIX=raw-session-canary/execution-canary \
    AWS_ACCOUNT_ID=123456789012 \
    upload_failure_marker_best_effort
)
grep -q -- 's3api put-object' "$failure_marker_aws_log"
grep -q -- '--key raw-session-canary/execution-canary/failure-marker.json' "$failure_marker_aws_log"
grep -q -- '--expected-bucket-owner 123456789012' "$failure_marker_aws_log"
grep -q -- '--cli-connect-timeout' "$failure_marker_aws_log"
grep -q -- '--cli-read-timeout' "$failure_marker_aws_log"
grep -q -- '--if-none-match \*' "$failure_marker_aws_log"

failure_marker_retry_log="${tmp_dir}/failure-marker-retry.log"
failure_marker_retry_count="${tmp_dir}/failure-marker-retry-count"
printf '0\n' >"$failure_marker_retry_count"
(
  # The sourced entrypoint invokes this test double indirectly.
  # shellcheck disable=SC2317
  aws() {
    local count
    count="$(<"$failure_marker_retry_count")"
    count=$(( count + 1 ))
    printf '%s\n' "$count" >"$failure_marker_retry_count"
    printf '%s ' "$@" >>"$failure_marker_retry_log"
    printf '\n' >>"$failure_marker_retry_log"
    if (( count < 3 )); then
      printf '%s\n' 'ServiceUnavailable' >&2
      return 1
    fi
    printf '{"VersionId":"failure-marker-version-after-retry"}\n'
  }
  OUTPUT_DIR="$failure_marker_dir" \
    OUTPUT_S3_BUCKET=private-output-canary \
    OUTPUT_S3_PREFIX=raw-session-canary/execution-canary \
    FAILURE_MARKER_UPLOAD_MAX_ATTEMPTS=3 \
    FAILURE_MARKER_UPLOAD_RETRY_DELAY_SECONDS=0 \
    upload_failure_marker_best_effort
)
if [[ "$(<"$failure_marker_retry_count")" != "3" ]]; then
  echo "failure-marker upload must retry transient publication failures within its configured bound"
  exit 1
fi

failure_marker_existing_same="${tmp_dir}/failure-marker-existing-same.json"
cp "${failure_marker_dir}/failure-marker.json" "$failure_marker_existing_same"
failure_marker_idempotent_log="${tmp_dir}/failure-marker-idempotent.log"
(
  # The sourced entrypoint invokes this test double indirectly.
  # shellcheck disable=SC2317
  aws() {
    printf '%s ' "$@" >>"$failure_marker_idempotent_log"
    printf '\n' >>"$failure_marker_idempotent_log"
    case "$*" in
      *s3api*put-object*)
        printf '%s\n' 'PreconditionFailed: object already exists' >&2
        return 1
        ;;
      *s3api*head-object*)
        printf '{"ETag":"\\"failure-marker-existing-etag\\"","VersionId":"failure-marker-existing-version"}\n'
        ;;
      *s3api*get-object*)
        local candidate
        for candidate in "$@"; do
          if [[ "$candidate" == */existing-failure-marker.json ]]; then
            cp "$failure_marker_existing_same" "$candidate"
          fi
        done
        printf '{"ETag":"\\"failure-marker-existing-etag\\"","VersionId":"failure-marker-existing-version"}\n'
        ;;
    esac
  }
  OUTPUT_DIR="$failure_marker_dir" \
    OUTPUT_S3_BUCKET=private-output-canary \
    OUTPUT_S3_PREFIX=raw-session-canary/execution-canary \
    AWS_ACCOUNT_ID=123456789012 \
    FAILURE_MARKER_UPLOAD_MAX_ATTEMPTS=3 \
    FAILURE_MARKER_UPLOAD_RETRY_DELAY_SECONDS=0 \
    upload_failure_marker_best_effort
)
grep -q -- 's3api head-object' "$failure_marker_idempotent_log"
grep -q -- 's3api get-object' "$failure_marker_idempotent_log"
grep -q -- '--version-id failure-marker-existing-version' "$failure_marker_idempotent_log"
if [[ "$(grep -c -- 's3api put-object' "$failure_marker_idempotent_log")" != "1" ]]; then
  echo "an exact existing failure marker must be accepted without another write"
  exit 1
fi

failure_marker_etag_mismatch_log="${tmp_dir}/failure-marker-etag-mismatch.log"
failure_marker_etag_mismatch_output="${tmp_dir}/failure-marker-etag-mismatch-output.log"
(
  # The sourced entrypoint invokes this test double indirectly.
  # shellcheck disable=SC2317
  aws() {
    printf '%s ' "$@" >>"$failure_marker_etag_mismatch_log"
    printf '\n' >>"$failure_marker_etag_mismatch_log"
    case "$*" in
      *s3api*put-object*)
        printf '%s\n' 'PreconditionFailed: object already exists' >&2
        return 1
        ;;
      *s3api*head-object*)
        printf '{"ETag":"\\"failure-marker-head-etag\\"","VersionId":"failure-marker-etag-version"}\n'
        ;;
      *s3api*get-object*)
        local candidate
        for candidate in "$@"; do
          if [[ "$candidate" == */existing-failure-marker.json ]]; then
            cp "$failure_marker_existing_same" "$candidate"
          fi
        done
        printf '{"ETag":"\\"failure-marker-get-etag\\"","VersionId":"failure-marker-etag-version"}\n'
        ;;
    esac
  }
  OUTPUT_DIR="$failure_marker_dir" \
    OUTPUT_S3_BUCKET=private-output-canary \
    OUTPUT_S3_PREFIX=raw-session-canary/execution-canary \
    AWS_ACCOUNT_ID=123456789012 \
    FAILURE_MARKER_UPLOAD_MAX_ATTEMPTS=1 \
    FAILURE_MARKER_UPLOAD_RETRY_DELAY_SECONDS=0 \
    upload_failure_marker_best_effort
) >"$failure_marker_etag_mismatch_output" 2>&1
grep -q -- 'Failure marker publication could not be confirmed after bounded retries' \
  "$failure_marker_etag_mismatch_output"

failure_marker_existing_different="${tmp_dir}/failure-marker-existing-different.json"
printf '{"category":"artifact"}\n' >"$failure_marker_existing_different"
OUTPUT_DIR="$failure_marker_dir" write_failure_marker upload
failure_marker_conflict_log="${tmp_dir}/failure-marker-conflict.log"
failure_marker_conflict_output="${tmp_dir}/failure-marker-conflict-output.log"
(
  # The sourced entrypoint invokes this test double indirectly.
  # shellcheck disable=SC2317
  aws() {
    printf '%s ' "$@" >>"$failure_marker_conflict_log"
    printf '\n' >>"$failure_marker_conflict_log"
    case "$*" in
      *s3api*put-object*)
        printf '%s\n' 'PreconditionFailed: object already exists' >&2
        return 1
        ;;
      *s3api*head-object*)
        printf '{"ETag":"\\"failure-marker-conflict-etag\\"","VersionId":"failure-marker-conflict-version"}\n'
        ;;
      *s3api*get-object*)
        local candidate
        for candidate in "$@"; do
          if [[ "$candidate" == */existing-failure-marker.json ]]; then
            cp "$failure_marker_existing_different" "$candidate"
          fi
        done
        printf '{"ETag":"\\"failure-marker-conflict-etag\\"","VersionId":"failure-marker-conflict-version"}\n'
        ;;
    esac
  }
  OUTPUT_DIR="$failure_marker_dir" \
    OUTPUT_S3_BUCKET=private-output-canary \
    OUTPUT_S3_PREFIX=raw-session-canary/execution-canary \
    AWS_ACCOUNT_ID=123456789012 \
    FAILURE_MARKER_UPLOAD_MAX_ATTEMPTS=3 \
    FAILURE_MARKER_UPLOAD_RETRY_DELAY_SECONDS=0 \
    upload_failure_marker_best_effort
) >"$failure_marker_conflict_output" 2>&1
if [[ "$(grep -c -- 's3api put-object' "$failure_marker_conflict_log")" != "1" ]]; then
  echo "a conflicting failure marker category must not be overwritten or retried"
  exit 1
fi
grep -q -- 'Failure marker publication conflict; existing marker retained' "$failure_marker_conflict_output"
if grep -Eq 'private-output-canary|raw-session-canary|execution-canary|artifact|upload' "$failure_marker_conflict_output"; then
  echo "failure-marker conflict warnings must not disclose destinations or categories"
  cat "$failure_marker_conflict_output"
  exit 1
fi

failure_marker_exhausted_output="${tmp_dir}/failure-marker-exhausted-output.log"
if ! (
  # The sourced entrypoint invokes this test double indirectly.
  # shellcheck disable=SC2317
  aws() { return 1; }
  OUTPUT_DIR="$failure_marker_dir" \
    OUTPUT_S3_BUCKET=private-output-canary \
    OUTPUT_S3_PREFIX=raw-session-canary/execution-canary \
    FAILURE_MARKER_UPLOAD_MAX_ATTEMPTS=2 \
    FAILURE_MARKER_UPLOAD_RETRY_DELAY_SECONDS=0 \
    upload_failure_marker_best_effort
) >"$failure_marker_exhausted_output" 2>&1; then
  echo "failure-marker upload exhaustion must remain best-effort"
  exit 1
fi
grep -q -- 'Failure marker publication could not be confirmed after bounded retries' "$failure_marker_exhausted_output"
if grep -Eq 'private-output-canary|raw-session-canary|execution-canary' "$failure_marker_exhausted_output"; then
  echo "failure-marker exhaustion warnings must not disclose destinations"
  cat "$failure_marker_exhausted_output"
  exit 1
fi

fatal_host="${tmp_dir}/fatal-marker-host"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$fatal_host"
chmod +x "$fatal_host"
fatal_output_dir="${tmp_dir}/fatal-marker-output"
fatal_marker_main_aws_log="${tmp_dir}/fatal-marker-main-aws.log"
fatal_marker_main_log="${tmp_dir}/fatal-marker-main.log"
if (
  # The sourced entrypoint invokes this test double indirectly.
  # shellcheck disable=SC2317
  aws() {
    printf '%s ' "$@" >>"$fatal_marker_main_aws_log"
    printf '\n' >>"$fatal_marker_main_aws_log"
  }
  RUNTIME_PROFILE=target-aws-async \
    RUNTIME_DEPLOYMENT_ENV=develop \
    DEPLOYMENT_ID=dep_0123456789abcdef0123456789abcdef \
    APP_SOURCE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    DEPLOY_MODE=normal \
    FINALIZATION_ID=01J00000000000000000000000 \
    LOG_IP_HASH_SALT=private-summary-salt \
    AWS_ACCOUNT_ID=123456789012 \
    HOST_BIN="$fatal_host" \
    INPUT_PATH='' \
    INPUT_S3_BUCKET='' \
    INPUT_S3_KEY='' \
    OUTPUT_DIR="$fatal_output_dir" \
    OUTPUT_S3_BUCKET=private-output-canary \
    OUTPUT_S3_PREFIX=raw-session-canary/execution-canary \
    main
) >"$fatal_marker_main_log" 2>&1; then
  echo "a fatal prover path should exit nonzero"
  exit 1
fi
python3 - "${fatal_output_dir}/failure-marker.json" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    assert json.load(handle) == {"category": "input"}
PY
grep -q -- 'raw-session-canary/execution-canary/failure-marker.json' "$fatal_marker_main_aws_log"
if grep -Eq 'private-output-canary|raw-session-canary|execution-canary' "$fatal_marker_main_log"; then
  echo "fatal prover logs must not expose the failure-marker destination"
  cat "$fatal_marker_main_log"
  exit 1
fi

exact_stage_dir="${tmp_dir}/exact-stage"
exact_stage_output="${tmp_dir}/exact-stage-output"
mkdir -p "$exact_stage_dir" "$exact_stage_output"
printf '{}\n' >"${exact_stage_dir}/input.json"
printf '{"schema":"stark-ballot.included_bitmap"}\n' >"${exact_stage_dir}/included-bitmap.json"
printf '{"schema":"stark-ballot.seen_bitmap"}\n' >"${exact_stage_dir}/seen-bitmap.json"
WORK_INPUT="${exact_stage_dir}/input.json" OUTPUT_DIR="$exact_stage_output" stage_outputs
test -f "${exact_stage_output}/included-bitmap.json"
test -f "${exact_stage_output}/seen-bitmap.json"

empty_stage_dir="${tmp_dir}/private-empty-stage"
empty_stage_output="${tmp_dir}/private-empty-stage-output"
mkdir -p "$empty_stage_dir" "$empty_stage_output"
empty_stage_log="${tmp_dir}/empty-stage.log"
WORK_INPUT="${empty_stage_dir}/private-input.json" OUTPUT_DIR="$empty_stage_output" stage_outputs >"$empty_stage_log" 2>&1
if grep -Eq "${tmp_dir}|private-input|private-empty-stage" "$empty_stage_log"; then
  echo "empty stage logs must not expose local paths"
  cat "$empty_stage_log"
  exit 1
fi

empty_upload_log="${tmp_dir}/empty-upload.log"
OUTPUT_DIR="$empty_stage_output" OUTPUT_S3_BUCKET=proof-outputs OUTPUT_S3_PREFIX='' upload_outputs >"$empty_upload_log" 2>&1
if grep -Eq "${tmp_dir}|private-empty-stage" "$empty_upload_log"; then
  echo "empty upload logs must not expose local paths"
  cat "$empty_upload_log"
  exit 1
fi

output_dir="${tmp_dir}/output"
mkdir -p "$output_dir"

output_json="${output_dir}/sample-output.json"
receipt_json="${output_dir}/sample-receipt.json"
bitmap_json="${output_dir}/sample-bitmap.json"
seen_bitmap_json="${output_dir}/sample-seen-bitmap.json"
input_json="${tmp_dir}/input.json"

python3 - "$output_json" "$receipt_json" "$bitmap_json" "$seen_bitmap_json" "$input_json" <<'PY'
import hashlib
import json
import os
import sys

output_path, receipt_path, bitmap_path, seen_bitmap_path, input_path = sys.argv[1:6]
current_method_version = int(os.environ["CURRENT_METHOD_VERSION"])

def hex_bytes(hex_str):
    return list(bytes.fromhex(hex_str))

def uint32le(value):
    return value.to_bytes(4, byteorder="little", signed=False)

def uint64le(value):
    return value.to_bytes(8, byteorder="little", signed=False)

def compute_sth_digest(log_id_hex, tree_size, timestamp, bulletin_root_hex):
    payload = (
        bytes.fromhex(log_id_hex)
        + uint32le(tree_size)
        + uint64le(timestamp)
        + bytes.fromhex(bulletin_root_hex)
    )
    return "0x" + hashlib.sha256(payload).hexdigest()

def uint16le(value):
    return value.to_bytes(2, byteorder="little", signed=False)

def compute_input_commitment(election_id_hex, bulletin_root_hex, tree_size, total_expected, votes):
    payload = hashlib.sha256()
    payload.update(b"stark-ballot:input|v1.0")
    payload.update(uint32le(10))
    payload.update(bytes.fromhex(election_id_hex))
    payload.update(bytes.fromhex(bulletin_root_hex))
    payload.update(uint32le(tree_size))
    payload.update(uint32le(total_expected))
    payload.update(uint32le(len(votes)))

    for vote in sorted(votes, key=lambda item: item["index"]):
        payload.update(uint32le(vote["index"]))
        payload.update(uint16le(32))
        payload.update(bytes.fromhex(vote["commitment"]))
        payload.update(uint16le(len(vote["merkle_path"])))
        for node in vote["merkle_path"]:
            payload.update(bytes.fromhex(node))

    return "0x" + payload.hexdigest()

def pack_bits(bits):
    num_bytes = (len(bits) + 7) // 8
    payload = bytearray(num_bytes)
    for index, bit in enumerate(bits):
        if bit:
            payload[index // 8] |= 1 << (index % 8)
    return bytes(payload)

def hash_leaf(chunk):
    return hashlib.sha256(b"\x00" + b"stark-ballot:leaf|v1" + chunk).digest()

def hash_node(left, right):
    return hashlib.sha256(b"\x01" + left + right).digest()

def compute_bitmap_root(bits):
    packed = pack_bits(bits)
    chunks = []
    for start in range(0, len(packed), 32):
        chunk = packed[start : start + 32]
        chunks.append(chunk.ljust(32, b"\x00"))
    if not chunks:
        chunks = [bytes(32)]

    level = [hash_leaf(chunk) for chunk in chunks]
    while len(level) > 1:
        next_level = []
        for start in range(0, len(level), 2):
            if start + 1 < len(level):
                next_level.append(hash_node(level[start], level[start + 1]))
            else:
                next_level.append(level[start])
        level = next_level
    return "0x" + level[0].hex()

election_config = {
    "totalExpected": 64,
    "choices": ["A", "B", "C", "D", "Legacy"],
    "version": "legacy-v0",
    "botCount": 63,
    "merkleTreeDepth": 6,
}
election_config_hash = hashlib.sha256(
    json.dumps(election_config, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
).hexdigest()
log_id = "66" * 32
bulletin_root = "22" * 32
timestamp = 1700000000
tree_size = 64
included_bitmap = [True] * tree_size
seen_bitmap = [True] * tree_size
included_bitmap_root = compute_bitmap_root(included_bitmap)
seen_bitmap_root = compute_bitmap_root(seen_bitmap)
sth_digest = compute_sth_digest(log_id, tree_size, timestamp, bulletin_root)
votes = [
    {
        "commitment": "aa" * 32,
        "choice": 2,
        "random": "bb" * 32,
        "index": 0,
        "merkle_path": ["cc" * 32, "dd" * 32],
    }
]
input_commitment = compute_input_commitment(
    "550e8400e29b41d4a716446655440000",
    bulletin_root,
    tree_size,
    tree_size,
    votes,
)

output = {
    "electionId": hex_bytes("550e8400e29b41d4a716446655440000"),
    "electionConfigHash": hex_bytes(election_config_hash),
    "bulletinRoot": hex_bytes(bulletin_root),
    "treeSize": tree_size,
    "totalExpected": tree_size,
    "sthDigest": hex_bytes(sth_digest[2:]),
    "verifiedTally": [1, 2, 3, 4, 5],
    "totalVotes": tree_size,
    "validVotes": tree_size,
    "invalidVotes": 0,
    "seenIndicesCount": tree_size,
    "missingSlots": 0,
    "invalidPresentedSlots": 0,
    "rejectedRecords": 0,
    "seenBitmapRoot": hex_bytes(seen_bitmap_root[2:]),
    "includedBitmapRoot": hex_bytes(included_bitmap_root[2:]),
    "excludedSlots": 0,
    "inputCommitment": hex_bytes(input_commitment[2:]),
    "methodVersion": current_method_version,
    "imageId": "0x" + "ab" * 32,
}

with open(output_path, "w", encoding="utf-8") as handle:
    json.dump(output, handle)

with open(receipt_path, "w", encoding="utf-8") as handle:
    json.dump({"receipt": {"seal": "dummy"}, "image_id": "0x" + "ab" * 32}, handle)

with open(bitmap_path, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "schema": "stark-ballot.included_bitmap",
            "version": "1.0",
            "treeSize": tree_size,
            "includedBitmapRoot": included_bitmap_root,
            "includedBitmap": included_bitmap,
        },
        handle,
    )

with open(seen_bitmap_path, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "schema": "stark-ballot.seen_bitmap",
            "version": "1.0",
            "treeSize": tree_size,
            "seenBitmapRoot": seen_bitmap_root,
            "seenBitmap": seen_bitmap,
        },
        handle,
    )

with open(input_path, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "election_id": hex_bytes("550e8400e29b41d4a716446655440000"),
            "election_config_hash": hex_bytes(election_config_hash),
            "election_config": election_config,
            "bulletin_root": hex_bytes(bulletin_root),
            "tree_size": tree_size,
            "log_id": hex_bytes(log_id),
            "timestamp": timestamp,
            "total_expected": tree_size,
            "votes": [
                {
                    "commitment": hex_bytes(votes[0]["commitment"]),
                    "choice": votes[0]["choice"],
                    "random": hex_bytes(votes[0]["random"]),
                    "index": votes[0]["index"],
                    "merkle_path": [hex_bytes(node) for node in votes[0]["merkle_path"]],
                }
            ],
        },
        handle,
    )
PY

signal_probe="${tmp_dir}/signal-probe.sh"
# Preserve expansions for the generated probe's runtime.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'trap '\''printf "TERM\n" >"$PROBE_SIGNAL_PATH"; if [[ "${PROBE_IGNORE_SIGNAL:-0}" != "1" ]]; then exit 143; fi'\'' TERM' \
  'trap '\''printf "INT\n" >"$PROBE_SIGNAL_PATH"; exit 130'\'' INT' \
  'printf "%s\n" "$$" >"$PROBE_STARTED_PATH"' \
  'while :; do sleep 0.1; done' \
  >"$signal_probe"
chmod +x "$signal_probe"

for signal_case in TERM INT TERM_IGNORED; do
  signal_name="${signal_case%%_*}"
  signal_ignore=0
  if [[ "$signal_case" == "TERM_IGNORED" ]]; then
    signal_ignore=1
  fi
  signal_case_dir="${tmp_dir}/signal-${signal_case}"
  signal_output_dir="${signal_case_dir}/output"
  signal_started_path="${signal_case_dir}/started"
  signal_observed_path="${signal_case_dir}/observed"
  signal_log="${signal_case_dir}/entrypoint.log"
  mkdir -p "$signal_output_dir"

  PROBE_STARTED_PATH="$signal_started_path" \
    PROBE_SIGNAL_PATH="$signal_observed_path" \
    PROBE_IGNORE_SIGNAL="$signal_ignore" \
    python3 - \
    "$ENTRYPOINT_PATH" \
    "$signal_probe" \
    "$input_json" \
    "$signal_output_dir" \
    "$signal_name" \
    "$signal_started_path" \
    "$signal_observed_path" \
    "$signal_log" <<'PY'
import json
import os
import signal
import subprocess
import sys
import time

entrypoint, host, input_path, output_dir, signal_name, started_path, observed_path, log_path = sys.argv[1:]
environment = os.environ.copy()
environment.update(
    {
        "ENTRYPOINT_SKIP_MAIN": "0",
        "HOST_BIN": host,
        "INPUT_PATH": input_path,
        "INPUT_S3_BUCKET": "",
        "INPUT_S3_KEY": "",
        "OUTPUT_DIR": output_dir,
        "OUTPUT_S3_BUCKET": "",
        "OUTPUT_S3_PREFIX": "",
        "RUNTIME_PROFILE": "local-proof-production",
        "ZKVM_TIMEOUT_SECONDS": "30",
        "ZKVM_TERMINATION_GRACE_SECONDS": "1" if os.environ["PROBE_IGNORE_SIGNAL"] == "1" else "10",
    }
)

with open(log_path, "w", encoding="utf-8") as log_handle:
    # CI launchers may ignore INT. Deliberately inherit that disposition here;
    # the isolated probe must restore it before Bash installs its traps.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    process = subprocess.Popen(
        ["env", "--default-signal=INT,QUIT,TERM", "bash", entrypoint],
        env=environment,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    deadline = time.monotonic() + 5
    while not os.path.exists(started_path) and process.poll() is None and time.monotonic() < deadline:
        time.sleep(0.05)
    if not os.path.exists(started_path):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        raise AssertionError(f"{signal_name} probe host did not start")

    os.kill(process.pid, getattr(signal, f"SIG{signal_name}"))
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)
        raise AssertionError(f"entrypoint did not exit after {signal_name}")
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

if process.returncode == 0:
    raise AssertionError(f"interrupted entrypoint must fail before durable publication ({signal_name})")
expected_return_code = {"TERM": 143, "INT": 130}[signal_name]
if process.returncode != expected_return_code:
    raise AssertionError(
        f"interrupted entrypoint returned {process.returncode}; expected {expected_return_code} ({signal_name})"
    )

with open(observed_path, "r", encoding="utf-8") as handle:
    assert handle.read().strip() == signal_name

with open(os.path.join(output_dir, "failure-marker.json"), "r", encoding="utf-8") as handle:
    marker = json.load(handle)
assert marker == {"category": "infrastructure_interruption"}

with open(log_path, "r", encoding="utf-8") as handle:
    summaries = []
    for line in handle:
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if record.get("event") == "prover_summary" and record.get("phase") == "end":
            summaries.append(record)
assert summaries
assert summaries[-1]["result"] == "error"
assert summaries[-1]["category"] == "infrastructure_interruption"
PY
done

# create_bundle_archive reads WORK_INPUT as a sourced-entrypoint global.
# shellcheck disable=SC2034
WORK_INPUT="$input_json"
printf '{"status":"private-report-canary"}\n' >"${output_dir}/verification.json"
printf '{"category":"artifact"}\n' >"${output_dir}/failure-marker.json"
bundle_log="${tmp_dir}/bundle.log"
create_bundle_archive "$output_dir" >"$bundle_log" 2>&1
if grep -Eq "${tmp_dir}|bundle\.zip" "$bundle_log"; then
  echo "bundle creation logs must not expose local paths"
  cat "$bundle_log"
  exit 1
fi

bundle_zip="${output_dir}/bundle.zip"
test -f "$bundle_zip"
test -f "${output_dir}/included-bitmap.json"
test -f "${output_dir}/seen-bitmap.json"
test -f "${output_dir}/verification.json"
test -f "${output_dir}/failure-marker.json"

bundle_retry_log="${tmp_dir}/bundle-retry.log"
create_bundle_archive "$output_dir" >"$bundle_retry_log" 2>&1
if grep -Eq "${tmp_dir}|bundle\.zip" "$bundle_retry_log"; then
  echo "idempotent bundle creation logs must not expose local paths"
  cat "$bundle_retry_log"
  exit 1
fi

entries="$(unzip -Z1 "$bundle_zip")"
echo "$entries" | grep -q "^receipt.json$"
echo "$entries" | grep -q "^journal.json$"
echo "$entries" | grep -q "^public-input.json$"
echo "$entries" | grep -q "^election-manifest.json$"
echo "$entries" | grep -q "^close-statement.json$"
if echo "$entries" | grep -q "^input.json$"; then
  echo "input.json should not be in the public bundle"
  exit 1
fi
if echo "$entries" | grep -q "^verification.json$"; then
  echo "verification.json should not be in the public bundle"
  exit 1
fi
if echo "$entries" | grep -q "^included-bitmap.json$"; then
  echo "included-bitmap.json should not be in the public bundle"
  exit 1
fi
if echo "$entries" | grep -q "^seen-bitmap.json$"; then
  echo "seen-bitmap.json should not be in the public bundle"
  exit 1
fi
if echo "$entries" | grep -q "^failure-marker.json$"; then
  echo "failure-marker.json should not be in the public bundle"
  exit 1
fi

python3 - "$bundle_zip" <<'PY'
import sys
import zipfile

expected = sorted([
    "public-input.json",
    "election-manifest.json",
    "close-statement.json",
    "receipt.json",
    "journal.json",
])
with zipfile.ZipFile(sys.argv[1], "r") as archive:
    actual = sorted(info.filename for info in archive.infolist())
assert actual == expected, (actual, expected)
PY

inspect_public_bundle_archive "$bundle_zip" async

invalid_bundle_dir="${tmp_dir}/invalid-public-bundles"
mkdir -p "$invalid_bundle_dir"
python3 - "$invalid_bundle_dir" <<'PY'
import os
import sys
import warnings
import zipfile

output_dir = sys.argv[1]
common = [
    "public-input.json",
    "election-manifest.json",
    "close-statement.json",
    "receipt.json",
    "journal.json",
]

def write(name, members):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(os.path.join(output_dir, name), "w") as archive:
            for member in members:
                archive.writestr(member, "{}")

write("missing.zip", common[:-1])
write("private.zip", common + ["input.json"])
write("mode-inconsistent.zip", common + ["metadata.json"])
write("unknown.zip", common + ["failure-marker.json"])
write("duplicate.zip", common + ["journal.json"])
write("case-conflict.zip", common + ["JOURNAL.JSON"])
write("nested.zip", common[:-1] + ["nested/journal.json"])
write("traversal.zip", common + ["../input.json"])
write("absolute.zip", common + ["/input.json"])
with open(os.path.join(output_dir, "malformed.zip"), "wb") as handle:
    handle.write(b"not-a-zip")
PY

for invalid_bundle in "$invalid_bundle_dir"/*.zip; do
  if inspect_public_bundle_archive "$invalid_bundle" async >/dev/null 2>&1; then
    echo "public bundle inspector should reject $(basename "$invalid_bundle")"
    exit 1
  fi
done

python3 - "$bundle_zip" "${output_dir}/included-bitmap.json" "${output_dir}/seen-bitmap.json" <<'PY'
import hashlib
import json
import os
import subprocess
import sys

bundle_zip, bitmap_path, seen_bitmap_path = sys.argv[1:4]
current_method_version = int(os.environ["CURRENT_METHOD_VERSION"])

def uint32le(value):
    return value.to_bytes(4, byteorder="little", signed=False)

def uint64le(value):
    return value.to_bytes(8, byteorder="little", signed=False)

def compute_sth_digest(log_id_hex, tree_size, timestamp, bulletin_root_hex):
    payload = (
        bytes.fromhex(log_id_hex)
        + uint32le(tree_size)
        + uint64le(timestamp)
        + bytes.fromhex(bulletin_root_hex)
    )
    return "0x" + hashlib.sha256(payload).hexdigest()

def uint16le(value):
    return value.to_bytes(2, byteorder="little", signed=False)

def normalize_hex(value):
    return value[2:] if value.startswith("0x") else value

def compute_input_commitment(public_input):
    payload = hashlib.sha256()
    payload.update(b"stark-ballot:input|v1.0")
    payload.update(uint32le(10))
    payload.update(bytes.fromhex(public_input["electionId"].replace("-", "")))
    payload.update(bytes.fromhex(normalize_hex(public_input["bulletinRoot"])))
    payload.update(uint32le(public_input["treeSize"]))
    payload.update(uint32le(public_input["totalExpected"]))
    payload.update(uint32le(len(public_input["votes"])))

    for vote in sorted(public_input["votes"], key=lambda item: item["index"]):
        payload.update(uint32le(vote["index"]))
        payload.update(uint16le(32))
        payload.update(bytes.fromhex(normalize_hex(vote["commitment"])))
        payload.update(uint16le(len(vote["merklePath"])))
        for node in vote["merklePath"]:
            payload.update(bytes.fromhex(normalize_hex(node)))

    return "0x" + payload.hexdigest()

def pack_bits(bits):
    num_bytes = (len(bits) + 7) // 8
    payload = bytearray(num_bytes)
    for index, bit in enumerate(bits):
        if bit:
            payload[index // 8] |= 1 << (index % 8)
    return bytes(payload)

def hash_leaf(chunk):
    return hashlib.sha256(b"\x00" + b"stark-ballot:leaf|v1" + chunk).digest()

def hash_node(left, right):
    return hashlib.sha256(b"\x01" + left + right).digest()

def compute_bitmap_root(bits):
    packed = pack_bits(bits)
    chunks = []
    for start in range(0, len(packed), 32):
        chunk = packed[start : start + 32]
        chunks.append(chunk.ljust(32, b"\x00"))
    if not chunks:
        chunks = [bytes(32)]

    level = [hash_leaf(chunk) for chunk in chunks]
    while len(level) > 1:
        next_level = []
        for start in range(0, len(level), 2):
            if start + 1 < len(level):
                next_level.append(hash_node(level[start], level[start + 1]))
            else:
                next_level.append(level[start])
        level = next_level
    return "0x" + level[0].hex()

expected_bitmap_root = compute_bitmap_root([True] * 64)
expected_sth_digest = compute_sth_digest("66" * 32, 64, 1700000000, "22" * 32)
journal_raw = subprocess.check_output(["unzip", "-p", bundle_zip, "journal.json"])
journal = json.loads(journal_raw)
public_raw = subprocess.check_output(["unzip", "-p", bundle_zip, "public-input.json"])
public_input = json.loads(public_raw)
input_commitment = compute_input_commitment(public_input)

assert journal["electionId"] == "550e8400-e29b-41d4-a716-446655440000"
assert journal["electionConfigHash"] == "0x" + hashlib.sha256(
    json.dumps(
        {
            "totalExpected": 64,
            "choices": ["A", "B", "C", "D", "Legacy"],
            "version": "legacy-v0",
            "botCount": 63,
            "merkleTreeDepth": 6,
        },
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
).hexdigest()
assert journal["bulletinRoot"] == "0x" + "22" * 32
assert journal["sthDigest"] == expected_sth_digest
assert journal["includedBitmapRoot"] == expected_bitmap_root
assert journal["seenBitmapRoot"] == expected_bitmap_root
assert journal["inputCommitment"] == input_commitment
assert journal["verifiedTally"] == [1, 2, 3, 4, 5]
assert journal["imageId"] == "0x" + "ab" * 32

assert public_input["schema"] == "stark-ballot.public_input"
assert public_input["version"] == "1.1"
assert "contractGeneration" not in public_input
assert public_input["electionId"] == "550e8400-e29b-41d4-a716-446655440000"
assert public_input["electionConfigHash"] == journal["electionConfigHash"]
assert public_input["bulletinRoot"] == "0x" + "22" * 32
assert public_input["treeSize"] == 64
assert public_input["totalExpected"] == 64
assert public_input["logId"] == "0x" + "66" * 32
assert public_input["timestamp"] == 1700000000
assert public_input["methodVersion"] == current_method_version
assert public_input["votes"] == [
    {
        "index": 0,
        "commitment": "0x" + "aa" * 32,
        "merklePath": ["0x" + "cc" * 32, "0x" + "dd" * 32],
    }
]

assert "choice" not in public_input["votes"][0]
assert "random" not in public_input["votes"][0]

manifest_raw = subprocess.check_output(["unzip", "-p", bundle_zip, "election-manifest.json"])
manifest = json.loads(manifest_raw)

assert manifest == {
    "electionId": "550e8400-e29b-41d4-a716-446655440000",
    "totalExpected": 64,
    "choices": ["A", "B", "C", "D", "Legacy"],
    "version": "legacy-v0",
    "botCount": 63,
    "merkleTreeDepth": 6,
    "electionConfigHash": journal["electionConfigHash"],
}

close_statement_raw = subprocess.check_output(["unzip", "-p", bundle_zip, "close-statement.json"])
close_statement = json.loads(close_statement_raw)

assert close_statement == {
    "logId": "0x" + "66" * 32,
    "treeSize": 64,
    "timestamp": 1700000000,
    "bulletinRoot": "0x" + "22" * 32,
    "sthDigest": journal["sthDigest"],
}

with open(bitmap_path, "r", encoding="utf-8") as handle:
    bitmap = json.load(handle)

assert bitmap["schema"] == "stark-ballot.included_bitmap"
assert bitmap["version"] == "1.0"
assert bitmap["treeSize"] == 64
assert bitmap["includedBitmapRoot"] == journal["includedBitmapRoot"]
assert all(bitmap["includedBitmap"])

with open(seen_bitmap_path, "r", encoding="utf-8") as handle:
    seen_bitmap = json.load(handle)

assert seen_bitmap["schema"] == "stark-ballot.seen_bitmap"
assert seen_bitmap["version"] == "1.0"
assert seen_bitmap["treeSize"] == 64
assert seen_bitmap["seenBitmapRoot"] == journal["seenBitmapRoot"]
assert all(seen_bitmap["seenBitmap"])
PY

journal_path="${tmp_dir}/journal.json"
close_statement_path="${tmp_dir}/close-statement.json"
drifted_close_statement_path="${tmp_dir}/close-statement-drifted.json"

unzip -p "$bundle_zip" journal.json >"$journal_path"
unzip -p "$bundle_zip" close-statement.json >"$close_statement_path"
cp "$close_statement_path" "$drifted_close_statement_path"

python3 - "$drifted_close_statement_path" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

payload["timestamp"] += 1

with open(path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
PY

drifted_close_statement_log="${tmp_dir}/drifted-close-statement.log"
if validate_public_audit_artifacts \
  "$journal_path" \
  "${output_dir}/public-input.json" \
  "${output_dir}/election-manifest.json" \
  "$drifted_close_statement_path" >"$drifted_close_statement_log" 2>&1; then
  echo "validate_public_audit_artifacts should fail on drifted close statement"
  exit 1
fi
grep -q "close-statement drifted from proof authority" "$drifted_close_statement_log"

duplicate_index_journal_path="${tmp_dir}/duplicate-index-journal.json"
duplicate_index_public_input_path="${tmp_dir}/duplicate-index-public-input.json"
pnpm tsx "${ROOT_DIR}/scripts/tests/entrypoint-duplicate-index-fixture.ts" \
  "$journal_path" \
  "${output_dir}/public-input.json" \
  "$duplicate_index_journal_path" \
  "$duplicate_index_public_input_path"

duplicate_index_log="${tmp_dir}/duplicate-index.log"
if validate_public_audit_artifacts \
  "$duplicate_index_journal_path" \
  "$duplicate_index_public_input_path" \
  "${output_dir}/election-manifest.json" \
  "$close_statement_path" >"$duplicate_index_log" 2>&1; then
  echo "validate_public_audit_artifacts should reject duplicate vote indices"
  exit 1
fi
grep -q "duplicate vote index" "$duplicate_index_log"

echo "ok"

legacy_output_json="${output_dir}/legacy-output.json"
unsupported_version_output_json="${output_dir}/unsupported-version-output.json"
missing_seen_bitmap_output_json="${output_dir}/missing-seen-bitmap-output.json"

python3 - "$output_json" "$legacy_output_json" "$unsupported_version_output_json" "$missing_seen_bitmap_output_json" <<'PY'
import json
import os
import sys

source_path, legacy_path, unsupported_path, missing_seen_path = sys.argv[1:5]
current_method_version = int(os.environ["CURRENT_METHOD_VERSION"])

with open(source_path, "r", encoding="utf-8") as handle:
    source = json.load(handle)

legacy = {
    "election_id": source["electionId"],
    "election_config_hash": source["electionConfigHash"],
    "bulletin_root": source["bulletinRoot"],
    "tree_size": source["treeSize"],
    "total_expected": source["totalExpected"],
    "sth_digest": source["sthDigest"],
    "verified_tally": source["verifiedTally"],
    "total_votes": source["totalVotes"],
    "valid_votes": source["validVotes"],
    "invalid_votes": source["invalidVotes"],
    "seen_indices_count": source["seenIndicesCount"],
    "missing_slots": source["missingSlots"],
    "invalid_presented_slots": source["invalidPresentedSlots"],
    "rejected_records": source["rejectedRecords"],
    "seen_bitmap_root": source["seenBitmapRoot"],
    "included_bitmap_root": source["includedBitmapRoot"],
    "excluded_slots": source["excludedSlots"],
    "input_commitment": source["inputCommitment"],
    "method_version": source["methodVersion"],
    "image_id": source["imageId"],
}
with open(legacy_path, "w", encoding="utf-8") as handle:
    json.dump(legacy, handle)

unsupported = dict(source)
unsupported["methodVersion"] = current_method_version - 1
with open(unsupported_path, "w", encoding="utf-8") as handle:
    json.dump(unsupported, handle)

missing_seen = dict(source)
missing_seen.pop("seenBitmapRoot")
with open(missing_seen_path, "w", encoding="utf-8") as handle:
    json.dump(missing_seen, handle)
PY

invalid_output_log="${tmp_dir}/invalid-output.log"
if convert_output_to_journal "$input_json" "$legacy_output_json" "${tmp_dir}/legacy-journal.json" >"$invalid_output_log" 2>&1; then
  echo "convert_output_to_journal should reject legacy snake_case output"
  exit 1
fi
grep -q 'unknown field `election_id`' "$invalid_output_log"

if convert_output_to_journal \
  "$input_json" \
  "$unsupported_version_output_json" \
  "${tmp_dir}/unsupported-journal.json" >"$invalid_output_log" 2>&1; then
  echo "convert_output_to_journal should reject unsupported methodVersion output"
  exit 1
fi
grep -q "unsupported methodVersion" "$invalid_output_log"

if convert_output_to_journal \
  "$input_json" \
  "$missing_seen_bitmap_output_json" \
  "${tmp_dir}/missing-seen-journal.json" >"$invalid_output_log" 2>&1; then
  echo "convert_output_to_journal should reject output without seenBitmapRoot"
  exit 1
fi
grep -q 'missing field `seenBitmapRoot`' "$invalid_output_log"

if build_public_input "$input_json" "$legacy_output_json" "${tmp_dir}/legacy-public-input.json" >"$invalid_output_log" 2>&1; then
  echo "build_public_input should reject legacy snake_case output"
  exit 1
fi
grep -q 'unknown field `election_id`' "$invalid_output_log"

timeout_probe="${tmp_dir}/timeout-probe.sh"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'sleep 2' \
  >"$timeout_probe"
chmod +x "$timeout_probe"

uncooperative_timeout_probe="${tmp_dir}/uncooperative-timeout-probe.sh"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'trap "" TERM' \
  'while :; do sleep 0.1; done' \
  >"$uncooperative_timeout_probe"
chmod +x "$uncooperative_timeout_probe"

killed_probe="${tmp_dir}/killed-probe.sh"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'exit 137' \
  >"$killed_probe"
chmod +x "$killed_probe"

noisy_success_probe="${tmp_dir}/noisy-success-probe.sh"
# Preserve expansions for the generated probe's runtime.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "private host stdout path: %s\\n" "$1"' \
  'printf "private host stderr path: %s\\n" "$1" >&2' \
  >"$noisy_success_probe"
chmod +x "$noisy_success_probe"

success_output="$({ HOST_BIN="$noisy_success_probe" WORK_INPUT="$input_json" run_host_with_timeout; } 2>&1)"
if grep -Fq "$input_json" <<<"$success_output"; then
  echo "successful host output must not expose the private input path"
  echo "$success_output"
  exit 1
fi

if timeout_output="$(HOST_BIN="$timeout_probe" WORK_INPUT="$input_json" ZKVM_TIMEOUT_SECONDS=1 run_host_with_timeout 2>&1)"; then
  echo "run_host_with_timeout should fail on timeout"
  exit 1
fi

if ! grep -q "zkVM execution timed out after 1s" <<<"$timeout_output"; then
  echo "run_host_with_timeout should report timeout distinctly"
  echo "$timeout_output"
  exit 1
fi

if grep -Fq "$(basename "$input_json")" <<<"$timeout_output"; then
  echo "host execution logs must not expose the private input filename"
  echo "$timeout_output"
  exit 1
fi

if uncooperative_timeout_output="$({
  HOST_BIN="$uncooperative_timeout_probe" \
    WORK_INPUT="$input_json" \
    ZKVM_TIMEOUT_SECONDS=1 \
    ZKVM_TERMINATION_GRACE_SECONDS=1 \
    run_host_with_timeout
} 2>&1)"; then
  echo "run_host_with_timeout should fail when timeout must force-kill the host"
  exit 1
fi

if ! grep -q "zkVM execution timed out after 1s" <<<"$uncooperative_timeout_output"; then
  echo "a timeout force-kill must remain classified as timeout"
  echo "$uncooperative_timeout_output"
  exit 1
fi

if killed_output="$(HOST_BIN="$killed_probe" WORK_INPUT="$input_json" run_host_with_timeout 2>&1)"; then
  echo "run_host_with_timeout should fail when the host exits 137"
  exit 1
fi

if ! grep -q "zkVM execution failed with exit code 137" <<<"$killed_output"; then
  echo "an immediate host exit 137 must remain a prover execution failure"
  echo "$killed_output"
  exit 1
fi

if grep -q "timed out" <<<"$killed_output"; then
  echo "an immediate host exit 137 must not be misclassified as a timeout"
  echo "$killed_output"
  exit 1
fi
