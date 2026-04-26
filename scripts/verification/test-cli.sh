#!/usr/bin/env bash
# Legacy wrapper for an older receipt-structure inspection flow.

set -euo pipefail
IFS=$'\n\t'

cat >&2 <<'EOF'
scripts/verification/test-cli.sh is intentionally disabled.

It used to call a removed Node.js structure checker and must not be used as
STARK proof-verification evidence. Use one of the maintained flows instead:

  pnpm test:cli:mock
  pnpm test:cli:real-dev
  pnpm test:cli:real-prod:s0
  pnpm test:stark-tamper

For manual cryptographic receipt verification, build and run:

  pnpm build:verifier-service
  ./verifier-service/target/release/verifier-service verify /path/to/bundle-or-receipt --image-id 0x...
EOF

exit 1
