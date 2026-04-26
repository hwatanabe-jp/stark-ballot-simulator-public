#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

scenario="S3"
user_choice="A"
extra_args=()
show_help=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario|-s)
      scenario="${2:?missing value for $1}"
      shift 2
      ;;
    --user-choice|-u)
      user_choice="${2:?missing value for $1}"
      shift 2
      ;;
    --help|-h)
      show_help=true
      shift
      ;;
    *)
      extra_args+=("$1")
      shift
      ;;
  esac
done

cd "$PROJECT_ROOT"

if [[ "$show_help" == "true" ]]; then
  exec pnpm test:cli -- --help
fi

echo "=== Running maintained real-zkVM CLI flow for scenario ${scenario} ==="
echo "Time: $(date)"
echo ""
echo "Legacy scenario fixture generation has been removed from this wrapper."
echo "Delegating to scripts/tests/cli-e2e-voting-flow.ts instead."
echo ""

exec env \
  USE_MOCK_STORE=true \
  USE_MOCK_ZKVM=false \
  pnpm test:cli -- \
    --user-choice "$user_choice" \
    --real-zkvm \
    --zkvm-mode prod \
    --scenario "$scenario" \
    "${extra_args[@]}"
