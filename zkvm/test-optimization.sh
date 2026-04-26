#!/bin/bash

echo "====================================="
echo "zkVM Performance Optimization Test"
echo "====================================="

# Change to zkVM directory
cd "$(dirname "$0")"

# Build the project
echo ""
echo "Building zkVM project..."
cargo build --release
if [ $? -ne 0 ]; then
    echo "Build failed!"
    exit 1
fi

echo ""
echo "Testing in development mode first..."
export RISC0_DEV_MODE=1

# Run with simple test data
echo ""
echo "Running with test-simple.json..."
time ./target/release/host test-data/test-simple.json

# Run with tamper scenario S1
echo ""
echo "Running with test-tamper-s1.json..."
time ./target/release/host test-data/test-tamper-s1.json

# Now test in production mode (this is the real test)
echo ""
echo "====================================="
echo "Testing in PRODUCTION mode..."
echo "This is where we expect to see improvement!"
echo "====================================="
unset RISC0_DEV_MODE

# Run with simple test data
echo ""
echo "Running with test-simple.json in production mode..."
time timeout 120 ./target/release/host test-data/test-simple.json
RESULT=$?

if [ $RESULT -eq 124 ]; then
    echo "TIMEOUT: Production mode still exceeds 2 minutes"
    echo "Further optimization needed"
else
    echo "SUCCESS: Production mode completed within time limit!"
fi

echo ""
echo "Test complete!"