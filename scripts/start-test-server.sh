#!/usr/bin/env bash
set -euo pipefail

# Export environment variables BEFORE Vite builds and the Hono server starts.
# These override .env.local values (OS env vars take precedence)
export USE_MOCK_ZKVM=true
export USE_MOCK_STORE=true
export NODE_ENV=production

# Allow mock/dev zkVM in production-mode CI builds (safe for tests only).
if [ -z "${ALLOW_INSECURE_ZKVM:-}" ]; then
  export ALLOW_INSECURE_ZKVM=true
fi

# Provide safe defaults for CI/local mock tests when not explicitly configured.
if [ -z "${EXPECTED_IMAGE_ID_VARIANT:-}" ]; then
  export EXPECTED_IMAGE_ID_VARIANT=x86_64
fi
if [ -z "${VERIFIER_PUBLIC_BASE_URL:-}" ]; then
  export VERIFIER_PUBLIC_BASE_URL="http://localhost:3000"
fi
if [ -z "${TURNSTILE_BYPASS:-}" ]; then
  export TURNSTILE_BYPASS=1
fi
if [ -z "${VITE_TURNSTILE_BYPASS:-}" ]; then
  export VITE_TURNSTILE_BYPASS=1
fi
if [ -z "${VITE_STH_SOURCES:-}" ]; then
  export VITE_STH_SOURCES="/api/sth,/api/sth?auditor=b"
fi
if [ -z "${RUNTIME_DEPLOYMENT_ENV:-}" ] && [ -z "${ENV_NAME:-}" ] && [ -z "${AWS_LAMBDA_FUNCTION_NAME:-}" ]; then
  export RUNTIME_DEPLOYMENT_ENV=develop
fi
if [ -z "${LOG_LEVEL:-}" ]; then
  export LOG_LEVEL=error
fi

# Enable file-based persistence for mock store in production-mode local Hono.
export PERSIST_MOCK_STORE=1

# Mock mode: STH verification is configured through VITE_STH_SOURCES for the
# local mock artifact only. Target production artifacts are built without it.

# Mock mode: Async finalization disabled
export FINALIZE_ASYNC_MODE=false

load_env_defaults() {
  local env_file="$1"

  if [ ! -f "$env_file" ]; then
    return
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*)
        continue
        ;;
    esac

    local key="${line%%=*}"
    local value="${line#*=}"

    if [ -z "$key" ] || [ "$key" = "$line" ]; then
      continue
    fi

    if [ -z "${!key:-}" ]; then
      export "$key=$value"
    fi
  done < "$env_file"
}

load_env_defaults "./scripts/tests/.env.test.defaults"

echo "[Test Server] Starting with Mock zkVM"
echo "  USE_MOCK_ZKVM=${USE_MOCK_ZKVM}"
echo "  USE_MOCK_STORE=${USE_MOCK_STORE}"
echo "  PERSIST_MOCK_STORE=${PERSIST_MOCK_STORE}"
echo "  NODE_ENV=${NODE_ENV}"
echo "  EXPECTED_IMAGE_ID_VARIANT=${EXPECTED_IMAGE_ID_VARIANT}"
echo "  SESSION_CAPABILITY_SECRET=${SESSION_CAPABILITY_SECRET:+[set]}"
echo "  ALLOW_INSECURE_ZKVM=${ALLOW_INSECURE_ZKVM:-}"
echo "  FINALIZE_ASYNC_MODE=${FINALIZE_ASYNC_MODE}"
echo "  VITE_STH_SOURCES=${VITE_STH_SOURCES:+[set]}"

# Clean up old mock session files before starting
bash ./scripts/clean-mock-sessions.sh

# Build and start production static frontend plus local Hono API.
if [ "${SKIP_VITE_BUILD:-}" = "1" ]; then
  if [ -f "dist/index.html" ]; then
    echo "[Test Server] SKIP_VITE_BUILD=1 detected. Reusing existing Vite build."
  else
    echo "[Test Server] SKIP_VITE_BUILD=1 set but dist/index.html is missing. Running build."
    pnpm run build:local-mock
  fi
else
  pnpm run build:local-mock
fi
pnpm start
