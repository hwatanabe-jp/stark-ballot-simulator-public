#!/bin/bash

# Simplified setup script for CLI E2E testing.
# Starts the Next.js dev server under tmux with mock store defaults.

set -euo pipefail

print_usage() {
    cat <<'EOF'
Usage: setup-cli-test.sh [--mock | --real] [--image-id <HEX>]

Options:
  --mock           Run CLI tests against mock zkVM (default)
  --real           Run CLI tests against real zkVM (requires built host binary)
  --image-id HEX   Override EXPECTED_IMAGE_ID value for the session
EOF
}

MODE="mock"
OVERRIDE_IMAGE_ID=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mock)
            MODE="mock"
            shift
            ;;
        --real)
            MODE="real"
            shift
            ;;
        --image-id)
            if [[ -n "${2:-}" ]]; then
                OVERRIDE_IMAGE_ID="$2"
                shift 2
            else
                echo "Error: --image-id requires a value" >&2
                exit 1
            fi
            ;;
        --help|-h)
            print_usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            print_usage
            exit 1
            ;;
    esac
done

if ! command -v tmux >/dev/null 2>&1; then
    echo "tmux is required. Install with: sudo apt-get install tmux" >&2
    exit 1
fi

session_exists() {
    tmux has-session -t "$1" 2>/dev/null
}

wait_for_port() {
    local host_port=$1
    local service=$2
    local retries=60

    echo -n "Waiting for $service"
    for _ in $(seq 1 "$retries"); do
        if nc -z $host_port >/dev/null 2>&1; then
            echo " - ready"
            return 0
        fi
        echo -n "."
        sleep 1
    done
    echo ""
    echo "$service failed to start" >&2
    return 1
}

if session_exists "nextjs"; then
    tmux kill-session -t nextjs
fi

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"

export USE_MOCK_STORE=true

if [[ "$MODE" == "real" ]]; then
    export USE_MOCK_ZKVM=false
    unset RISC0_DEV_MODE
else
    export USE_MOCK_ZKVM=true
    export RISC0_DEV_MODE=1
fi

if [[ -n "$OVERRIDE_IMAGE_ID" ]]; then
    export EXPECTED_IMAGE_ID="$OVERRIDE_IMAGE_ID"
fi

tmux new-session -d -s nextjs "cd '$PROJECT_ROOT' && pnpm dev"

wait_for_port 127.0.0.1:3000 "Next.js"

echo "Next.js dev server running in tmux session 'nextjs'"
