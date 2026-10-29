#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

if (( $# != 1 )); then
  echo "Usage: scripts/tests/fargate-prover-container-smoke.sh <image-uri>" >&2
  exit 2
fi

image_uri="$1"
if [[ ! "$image_uri" =~ ^[A-Za-z0-9._:/@-]+$ ]]; then
  echo "The prover image URI is empty or malformed." >&2
  exit 2
fi

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_dir="${root_dir}/zkvm/test-data"
failure_marker_contract_path="${root_dir}/infra/docker/prover-failure-marker-contract.json"
if [[ ! -f "${fixture_dir}/test-fixture-valid.json" ]]; then
  echo "The prover container smoke fixture is missing." >&2
  exit 1
fi
if [[ ! -f "$failure_marker_contract_path" ]]; then
  echo "The canonical prover failure-marker contract is missing." >&2
  exit 1
fi

container_posture=(
  --rm
  --read-only
  --cap-drop ALL
  --init
  --network none
)

docker run "${container_posture[@]}" \
  --entrypoint /bin/bash \
  "$image_uri" \
  -euo pipefail -c '
    prover_home=/home/prover
    test "$(id -u)" = 10001
    test "$(id -g)" = 10001
    setpriv --no-new-privs --inh-caps=-all --ambient-caps=-all /bin/sh -c \
      "grep -Eq \"^NoNewPrivs:[[:space:]]+1$\" /proc/self/status"
    test "$HOME" = "$prover_home"
    test "$RISC0_HOME" = /opt/risc0
    test "$RISC0_SERVER_PATH" = /opt/risc0/bin/r0vm
    test "$PROVER_ARTIFACT_TOOL_BIN" = /opt/zkvm/bin/prover-artifacts
    test -x /opt/risc0/bin/r0vm
    test -x "$PROVER_ARTIFACT_TOOL_BIN"
    /opt/risc0/bin/r0vm --version >/dev/null
    test -r /opt/risc0/settings.toml
    touch /tmp/probe /var/task/output/probe
    for path in "$prover_home/probe" /var/task/probe /opt/risc0/probe /etc/probe; do
      if touch "$path" 2>/dev/null; then
        echo "unexpected writable path: $path" >&2
        exit 1
      fi
    done
  '

success_probe_output=""
if ! success_probe_output="$(
  docker run "${container_posture[@]}" \
    --mount type=bind,src="$fixture_dir",dst=/input,readonly \
    --env HOST_BIN=/bin/true \
    --env INPUT_PATH=/input/test-fixture-valid.json \
    --env RUNTIME_PROFILE=local-proof-production \
    "$image_uri" 2>&1
)"; then
  echo "The prover successful stub-host probe failed." >&2
  printf '%s\n' "$success_probe_output" >&2
  exit 1
fi

expected_no_artifact_warning='[WARN] No output artifacts detected'
expected_warning_count="$(printf '%s\n' "$success_probe_output" | grep -Fc "$expected_no_artifact_warning" || true)"
warning_count="$(printf '%s\n' "$success_probe_output" | grep -Fc '[WARN]' || true)"
if [[ "$expected_warning_count" != "1" ]]; then
  echo "The prover successful stub-host probe expected exactly one no-artifact warning." >&2
  printf '%s\n' "$success_probe_output" >&2
  exit 1
fi
if [[ "$warning_count" != "$expected_warning_count" ]]; then
  echo "The prover successful stub-host probe emitted unexpected warning output." >&2
  printf '%s\n' "$success_probe_output" >&2
  exit 1
fi

sanitized_success_probe_output="$(
  printf '%s\n' "$success_probe_output" | grep -Fv "$expected_no_artifact_warning" || true
)"
if [[ -n "$sanitized_success_probe_output" ]]; then
  printf '%s\n' "$sanitized_success_probe_output"
fi

failure_output_dir="$(mktemp -d /tmp/fargate-prover-container-smoke.XXXXXX)"
cleanup() {
  case "$failure_output_dir" in
    /tmp/fargate-prover-container-smoke.*)
      rm -rf -- "$failure_output_dir"
      ;;
    *)
      echo "Refusing to clean an unexpected prover smoke directory: ${failure_output_dir}" >&2
      ;;
  esac
}
trap cleanup EXIT

# The candidate runs as UID 10001, while CodeBuild creates the host bind as root.
chmod 0733 "$failure_output_dir"

failure_probe_output=""
set +e
failure_probe_output="$(
  docker run "${container_posture[@]}" \
    --mount type=bind,src="$fixture_dir",dst=/input,readonly \
    --mount type=bind,src="$failure_output_dir",dst=/var/task/output \
    --env HOST_BIN=/bin/false \
    --env INPUT_PATH=/input/test-fixture-valid.json \
    --env OUTPUT_DIR=/var/task/output \
    --env RUNTIME_PROFILE=local-proof-production \
    "$image_uri" 2>&1
)"
failure_probe_status="$?"
set -e
if (( failure_probe_status == 0 )); then
  echo "The prover failure-marker probe unexpectedly succeeded." >&2
  printf '%s\n' "$failure_probe_output" >&2
  exit 1
fi

expected_prover_error='[ERROR] zkVM execution failed with exit code 1'
expected_error_count="$(printf '%s\n' "$failure_probe_output" | grep -Fc "$expected_prover_error" || true)"
error_count="$(printf '%s\n' "$failure_probe_output" | grep -Fc '[ERROR]' || true)"
warning_count="$(printf '%s\n' "$failure_probe_output" | grep -Fc '[WARN]' || true)"
structured_error_count="$(printf '%s\n' "$failure_probe_output" | grep -Fc '"level":"error"' || true)"
structured_prover_error_count="$(
  printf '%s\n' "$failure_probe_output" | grep -Fc '"result":"error","category":"prover_execution"' || true
)"
structured_warning_count="$(printf '%s\n' "$failure_probe_output" | grep -Fc '"level":"warn"' || true)"
if [[ "$expected_error_count" != "1" ]]; then
  echo "The prover failure-marker probe expected exactly one prover execution error." >&2
  printf '%s\n' "$failure_probe_output" >&2
  exit 1
fi
if [[ "$structured_error_count" != "1" || "$structured_prover_error_count" != "1" ]]; then
  echo "The prover failure-marker probe expected exactly one structured prover error summary." >&2
  printf '%s\n' "$failure_probe_output" >&2
  exit 1
fi
if [[ "$error_count" != "$expected_error_count" || "$warning_count" != "0" || "$structured_warning_count" != "0" ]]; then
  echo "The prover failure-marker probe emitted unexpected warning or error output." >&2
  printf '%s\n' "$failure_probe_output" >&2
  exit 1
fi
echo "Prover failure-marker probe produced the expected diagnostics and marker."

failure_marker_path="${failure_output_dir}/failure-marker.json"
if [[ ! -f "$failure_marker_path" ]]; then
  echo "The prover candidate did not emit failure-marker.json." >&2
  exit 1
fi

python3 - "$failure_marker_path" "$failure_marker_contract_path" <<'PY'
import json
import os
import sys

marker_path = sys.argv[1]
contract_path = sys.argv[2]
try:
    with open(marker_path, "r", encoding="utf-8") as handle:
        marker = json.load(handle)
    with open(contract_path, "r", encoding="utf-8") as handle:
        contract = json.load(handle)
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"failure-marker contract input is not readable valid JSON: {error}") from error

if not isinstance(contract, dict) or set(contract) != {"markerFilename", "exactKeys", "categories"}:
    raise SystemExit("canonical failure-marker contract has an unexpected shape")
exact_keys = contract["exactKeys"]
categories = contract["categories"]
if (
    contract["markerFilename"] != os.path.basename(marker_path)
    or not isinstance(exact_keys, list)
    or not exact_keys
    or any(not isinstance(key, str) or not key for key in exact_keys)
    or len(set(exact_keys)) != len(exact_keys)
    or "category" not in exact_keys
    or not isinstance(categories, list)
    or not categories
    or any(not isinstance(category, str) or not category for category in categories)
    or len(set(categories)) != len(categories)
):
    raise SystemExit("canonical failure-marker contract is invalid")
if not isinstance(marker, dict) or sorted(marker) != sorted(exact_keys):
    raise SystemExit(f"failure-marker.json must contain exactly the contract keys: {exact_keys!r}")
if marker["category"] not in categories:
    raise SystemExit("failure-marker.json category is not declared by the canonical contract")
if marker["category"] != "prover_execution":
    raise SystemExit("failure-marker.json category must be exactly 'prover_execution'")
PY
