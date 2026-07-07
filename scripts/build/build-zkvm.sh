#!/bin/bash
set -e

echo "Building zkVM..."

# Navigate to project root
cd "$(dirname "$0")/../.."
cd zkvm

# Build in release mode (incremental build enabled)
echo "Building zkVM host program..."
cargo build --release -p host --features production

if [ -f target/release/host ]; then
    echo "[OK] zkVM build completed successfully"
    echo "Binary location: zkvm/target/release/host"
else
    echo "[FAIL] zkVM build failed"
    exit 1
fi
