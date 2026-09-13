#!/usr/bin/env bash
set -euo pipefail

# Export environment variables before Vite builds and the Hono server starts.
# The test server is launched directly so developer-local env files cannot
# reintroduce retired selectors into this deterministic profile.
export RUNTIME_PROFILE=static-mock-e2e
export VITE_RUNTIME_PROFILE=static-mock-e2e
export NODE_ENV=production

# Provide safe defaults for CI/local mock tests when not explicitly configured.
if [ -z "${EXPECTED_IMAGE_ID_VARIANT:-}" ]; then
  export EXPECTED_IMAGE_ID_VARIANT=x86_64
fi
if [ -z "${VERIFIER_PUBLIC_BASE_URL:-}" ]; then
  export VERIFIER_PUBLIC_BASE_URL="http://localhost:${PORT:-3000}"
fi
if [ -z "${VITE_STH_SOURCES:-}" ]; then
  export VITE_STH_SOURCES="/api/sessions/:sessionId/bulletin/sth,/api/sessions/:sessionId/bulletin/sth?auditorId=b"
fi
if [ -z "${RUNTIME_DEPLOYMENT_ENV:-}" ] && [ -z "${ENV_NAME:-}" ] && [ -z "${AWS_LAMBDA_FUNCTION_NAME:-}" ]; then
  export RUNTIME_DEPLOYMENT_ENV=develop
fi
if [ -z "${LOG_LEVEL:-}" ]; then
  export LOG_LEVEL=error
fi

# Mock mode: STH verification is configured through VITE_STH_SOURCES for the
# local mock artifact only. Target production artifacts are built without it.

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
echo "  RUNTIME_PROFILE=${RUNTIME_PROFILE}"
echo "  VITE_RUNTIME_PROFILE=${VITE_RUNTIME_PROFILE}"
echo "  NODE_ENV=${NODE_ENV}"
echo "  EXPECTED_IMAGE_ID_VARIANT=${EXPECTED_IMAGE_ID_VARIANT}"
echo "  SESSION_CAPABILITY_SECRET=${SESSION_CAPABILITY_SECRET:+[set]}"
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
pnpm tsx scripts/dev/static-hono-server.ts
