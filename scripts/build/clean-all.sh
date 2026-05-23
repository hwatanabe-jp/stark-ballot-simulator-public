#!/usr/bin/env bash

# Clean all generated files and directories
# This script removes all build artifacts, test outputs, and temporary files

set -euo pipefail
IFS=$'\n\t'

echo "🧹 Cleaning all generated files..."

# Navigate to project root
cd "$(dirname "$0")/../.."

# Remove Next.js build artifacts
echo "Removing Next.js build artifacts..."
rm -rf .next out

# Remove TypeScript build info
echo "Removing TypeScript build info..."
rm -f tsconfig.tsbuildinfo

# Remove test coverage
echo "Removing test coverage..."
rm -rf coverage .nyc_output

# Remove zkVM temporary files
echo "Removing zkVM temporary files..."
rm -rf .zkvm-temp

# Remove zkVM output files
echo "Removing zkVM output files..."
find zkvm -name "*-output.json" -delete 2>/dev/null || true
find zkvm -name "*-receipt.json" -delete 2>/dev/null || true

# Remove package manager logs
echo "Removing package manager logs..."
rm -f npm-debug.log* yarn-debug.log* yarn-error.log* .pnpm-debug.log* pnpm-debug.log*

# Remove temporary files
echo "Removing temporary files..."
find . -name "*.tmp" -delete 2>/dev/null || true
find . -name "*.temp" -delete 2>/dev/null || true
rm -rf .tmp .temp terraform/.tmp

# Remove editor swap files
echo "Removing editor swap files..."
find . -name "*.swp" -delete 2>/dev/null || true
find . -name "*.swo" -delete 2>/dev/null || true
find . -name "*~" -delete 2>/dev/null || true

# Remove OS specific files
echo "Removing OS specific files..."
find . -name ".DS_Store" -delete 2>/dev/null || true
find . -name "Thumbs.db" -delete 2>/dev/null || true

# Optional: Clear pnpm store cache (uncomment if needed)
# echo "Clearing pnpm cache..."
# pnpm store prune

echo "✅ Cleanup complete!"
echo ""
echo "To clean specific areas:"
echo "  pnpm clean       - Remove Next.js artifacts only"
echo "  pnpm clean:cache - Clear package manager cache"
echo "  cargo clean      - Clean Rust build artifacts (in zkvm/)"
