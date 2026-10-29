#!/usr/bin/env bash
# Audit the public bundle using the same parsers as the application.
set -euo pipefail

usage() {
  echo 'Usage: bash scripts/docs/audit-bundle.sh BUNDLE_ZIP [default|x86_64]'
  echo 'Build verifier-service with --features production before running.'
}
if [[ "${1:-}" == --help && $# == 1 ]]; then
  usage
  exit 0
fi
if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage >&2
  exit 2
fi
export EXPECTED_IMAGE_ID_VARIANT="${2:-default}"
case "$EXPECTED_IMAGE_ID_VARIANT" in
  default|x86_64) ;;
  *) echo 'Image ID variant must be default or x86_64' >&2; exit 2 ;;
esac
if [[ ! -f "$1" ]]; then
  echo 'Bundle ZIP must be an existing regular file' >&2
  exit 2
fi
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_ROOT
for audit_tool in node pnpm; do
  if ! command -v "$audit_tool" >/dev/null; then
    echo "Required tool is missing: $audit_tool" >&2
    exit 2
  fi
done
if [[ ! -x "$REPO_ROOT/verifier-service/target/release/verifier-service" ]]; then
  echo 'Build verifier-service with --features production before running' >&2
  exit 2
fi
AUDIT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/stark-ballot-audit.XXXXXX")"
export AUDIT_ROOT
# Retain the exact archive and diagnostic output even if a check fails.
trap 'echo "Audit files: $AUDIT_ROOT" >&2' EXIT
cp -- "$1" "$AUDIT_ROOT/bundle.zip"

cd "$REPO_ROOT"
pnpm tsx scripts/docs/audit-bundle.ts "$AUDIT_ROOT"
