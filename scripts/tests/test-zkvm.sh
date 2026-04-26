#!/bin/bash

# Test script for zkVM implementation

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ZKVM_DIR="$PROJECT_ROOT/zkvm"

echo "=================================="
echo "Testing zkVM Implementation"
echo "=================================="

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to run test
run_test() {
    local test_name=$1
    local input_file=$2
    local expected_tamper=$3
    
    echo -e "\n${YELLOW}Running test: $test_name${NC}"
    echo "Input: $input_file"
    
    # Check if input file exists
    if [ ! -f "$input_file" ]; then
        echo -e "${RED}✗ Input file not found: $input_file${NC}"
        return 1
    fi
    
    # Run the host program
    if RISC0_DEV_MODE=1 "$ZKVM_DIR/target/release/host" "$input_file" > /tmp/test-output.log 2>&1; then
        # Check output
        local output_file="${input_file%.json}-output.json"
        if [ -f "$output_file" ]; then
            local missing=$(jq -r '.missingSlots // 0' "$output_file")
            local invalid_presented=$(jq -r '.invalidPresentedSlots // 0' "$output_file")
            local rejected=$(jq -r '.rejectedRecords // 0' "$output_file")
            local excluded=$(jq -r '.excludedSlots // 0' "$output_file")
            local method_version=$(jq -r '.methodVersion // "unknown"' "$output_file")
            local total_votes=$(jq -r '.totalVotes // 0' "$output_file")
            local valid_votes=$(jq -r '.validVotes // 0' "$output_file")
            local invalid_votes=$(jq -r '.invalidVotes // 0' "$output_file")
            local tally=$(jq '.verifiedTally // []' "$output_file")

            local tamper_detected_flag="false"
            if [ "$excluded" -ne 0 ] || [ "$rejected" -ne 0 ]; then
                tamper_detected_flag="true"
            fi

            if [ "$tamper_detected_flag" = "$expected_tamper" ]; then
                echo -e "${GREEN}✓ Test passed${NC}"
            else
                echo -e "${RED}✗ Test failed: expected tamper=$expected_tamper, got $tamper_detected_flag${NC}"
                return 1
            fi

            echo "  Method Version : $method_version"
            echo "  Total Votes    : $total_votes"
            echo "  Valid / Invalid: $valid_votes / $invalid_votes"
            echo "  Missing Slots  : $missing"
            echo "  Invalid Slots  : $invalid_presented"
            echo "  Rejected Recs  : $rejected"
            echo "  Excluded Slots : $excluded"
            echo "  Verified Tally : $tally"

            return 0
        else
            echo -e "${RED}✗ Output file not found: $output_file${NC}"
            cat /tmp/test-output.log
            return 1
        fi
    else
        echo -e "${RED}✗ Host execution failed${NC}"
        cat /tmp/test-output.log
        return 1
    fi
}

# Build zkVM if not exists
echo "Checking zkVM binary..."
if [ ! -f "$ZKVM_DIR/target/release/host" ]; then
    echo "Building zkVM..."
    cd "$ZKVM_DIR"
    cargo build --release --bin host || {
        echo -e "${RED}✗ Failed to build zkVM${NC}"
        exit 1
    }
fi

# Run tests
TESTS_PASSED=0
TESTS_FAILED=0

# Test 1: Valid fixture (no tampering)
if run_test "Valid fixture (8 votes)" "$ZKVM_DIR/test-data/test-fixture-valid.json" "false"; then
    ((TESTS_PASSED+=1))
else
    ((TESTS_FAILED+=1))
fi

# Test 2: Tampered fixture (corrupted Merkle path)
if run_test "Tampered fixture (8 votes)" "$ZKVM_DIR/test-data/test-fixture-tampered.json" "true"; then
    ((TESTS_PASSED+=1))
else
    ((TESTS_FAILED+=1))
fi

# Add more tests here if needed

# Summary
echo -e "\n=================================="
echo "Test Summary"
echo "=================================="
echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "${RED}Failed: $TESTS_FAILED${NC}"

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "\n${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "\n${RED}Some tests failed!${NC}"
    exit 1
fi
