#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
LAYER_DIR="$ROOT_DIR/lambda-layer"
BIN_DIR="$LAYER_DIR/bin"
TARGET="x86_64-unknown-linux-gnu"
BINARY_NAME="verifier-service"

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo is required" >&2
  exit 1
fi

rustup target add "$TARGET" >/dev/null 2>&1 || true

pushd "$ROOT_DIR" >/dev/null
cargo build --release --target "$TARGET"
popd >/dev/null

mkdir -p "$BIN_DIR"
cp "$ROOT_DIR/target/$TARGET/release/$BINARY_NAME" "$BIN_DIR/$BINARY_NAME"
chmod 755 "$BIN_DIR/$BINARY_NAME"

echo "Lambda layer contents staged in $LAYER_DIR"
