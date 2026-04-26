#!/bin/bash

# Test production mode proof generation

echo "Building zkVM project..."
cargo build --release

echo ""
echo "Testing development mode first..."
export RISC0_DEV_MODE=1
time ./target/release/host test-data/test-tamper-s1.json

echo ""
echo "Testing production mode (this may take longer)..."
unset RISC0_DEV_MODE
time ./target/release/host test-data/test-tamper-s1.json

echo ""
echo "Production mode test complete!"