#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

usage() {
  cat <<'EOF'
Usage:
  scripts/docs/regenerate-license-metadata.sh

Regenerates tracked third-party license metadata under docs/current/licenses/.
Absolute local paths are replaced with <REPO_ROOT> and <CARGO_HOME> before the
files are written.
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "$#" -gt 0 ]; then
  echo "Unknown argument: $1" >&2
  usage >&2
  exit 2
fi

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Required command not found: $name" >&2
    exit 2
  fi
}

sanitize_json() {
  local input="$1"
  local output="$2"

  REPO_ROOT_ABS="$repo_root" CARGO_HOME_ABS="$cargo_home" perl -0pe '
    my $repo = quotemeta($ENV{REPO_ROOT_ABS});
    my $cargo = quotemeta($ENV{CARGO_HOME_ABS});
    s/$repo/<REPO_ROOT>/g;
    s/$cargo/<CARGO_HOME>/g;
    s{(?<![A-Za-z0-9_])(?:file://)?/(?:home|Users)/[^/\s"`]+}{<HOME>}g;
  ' "$input" | jq . > "$output"
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

cargo_home="${CARGO_HOME:-$HOME/.cargo}"
license_dir="docs/current/licenses"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

require_command cargo
require_command jq
require_command perl
require_command pnpm

mkdir -p "$license_dir"

echo "Regenerating pnpm license metadata..."
pnpm licenses list --json --prod > "$tmp_dir/pnpm-licenses-prod.raw.json"
pnpm licenses list --json > "$tmp_dir/pnpm-licenses-all.raw.json"
sanitize_json "$tmp_dir/pnpm-licenses-prod.raw.json" "$license_dir/pnpm-licenses-prod.json"
sanitize_json "$tmp_dir/pnpm-licenses-all.raw.json" "$license_dir/pnpm-licenses-all.json"

jq -r '(["name","versions","license"] | @csv), (to_entries[] | .key as $license | .value[] | [.name, (.versions | join(",")), $license] | @csv)' \
  "$license_dir/pnpm-licenses-prod.json" > "$license_dir/pnpm-licenses-prod.csv"
jq -r '(["name","versions","license"] | @csv), (to_entries[] | .key as $license | .value[] | [.name, (.versions | join(",")), $license] | @csv)' \
  "$license_dir/pnpm-licenses-all.json" > "$license_dir/pnpm-licenses-all.csv"

echo "Regenerating Cargo metadata..."
cargo metadata --manifest-path zkvm/Cargo.toml --format-version 1 > "$tmp_dir/cargo-metadata-zkvm.raw.json"
cargo metadata --manifest-path verifier-service/Cargo.toml --format-version 1 > "$tmp_dir/cargo-metadata-verifier.raw.json"
sanitize_json "$tmp_dir/cargo-metadata-zkvm.raw.json" "$license_dir/cargo-metadata-zkvm.json"
sanitize_json "$tmp_dir/cargo-metadata-verifier.raw.json" "$license_dir/cargo-metadata-verifier.json"

jq -r '(["name","version","license"] | @csv), (.packages[] | [.name,.version,(.license // "UNKNOWN")] | @csv)' \
  "$license_dir/cargo-metadata-zkvm.json" > "$license_dir/cargo-licenses-zkvm.csv"
jq -r '(["name","version","license"] | @csv), (.packages[] | [.name,.version,(.license // "UNKNOWN")] | @csv)' \
  "$license_dir/cargo-metadata-verifier.json" > "$license_dir/cargo-licenses-verifier.csv"

echo "Formatting JSON metadata..."
pnpm exec prettier --write "$license_dir"/*.json >/dev/null

echo "Checking regenerated files for publishable-repo leaks..."
pnpm public-safety:scan

echo "License metadata regenerated."
