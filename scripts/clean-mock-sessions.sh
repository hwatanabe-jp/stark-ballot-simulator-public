#!/usr/bin/env bash
set -euo pipefail

# Clean up file-based mock session storage before E2E tests
# This ensures tests start with a clean slate

STORAGE_DIR=".tmp/mock-sessions"

if [ -d "$STORAGE_DIR" ]; then
  echo "[Cleanup] Removing old mock session files from $STORAGE_DIR"
  rm -rf "$STORAGE_DIR"
  echo "[Cleanup] Cleanup complete"
else
  echo "[Cleanup] No mock session files to clean"
fi
