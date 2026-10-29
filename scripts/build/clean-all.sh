#!/usr/bin/env bash

# Clean all generated files and directories
# This script removes all build artifacts, test outputs, and temporary files

set -euo pipefail
IFS=$'\n\t'

echo "Cleaning all generated files..."

# Navigate to project root
cd "$(dirname "$0")/../.."

# Remove frontend build artifacts, including retired Next.js output
echo "Removing frontend build artifacts..."
rm -rf dist .next out

# Remove TypeScript build info
echo "Removing TypeScript build info..."
rm -f tsconfig.tsbuildinfo

# Remove test coverage
echo "Removing test coverage..."
rm -rf coverage .nyc_output playwright-report test-results

# Remove zkVM temporary files
echo "Removing zkVM temporary files..."
rm -rf .zkvm-temp .verifier-bundles zkvm/test-results

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
find infra/terraform -path "*/.terraform" -prune -o -type f \( -name "*.local.hcl" -o -name "*.local.tfvars" -o -name "*.local.json" -o -name "*.tfplan" -o -path "infra/terraform/app/tfplan*" \) -exec rm -f {} + 2>/dev/null || true
rm -rf .tmp .temp

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

echo "[OK] Cleanup complete!"
echo ""
echo "To clean specific areas:"
echo "  pnpm clean       - Remove frontend artifacts and local caches"
echo "  pnpm clean:cache - Clear package manager cache"
echo "  cargo clean      - Clean Rust build artifacts (in zkvm/)"
