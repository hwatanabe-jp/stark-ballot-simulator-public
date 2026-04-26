#!/bin/bash

# Teardown script for CLI E2E testing
# Stops services started by setup-cli-test.sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== STARK Ballot Simulator CLI Test Teardown ===${NC}"

# Function to kill a tmux session
kill_session() {
    local session=$1
    if tmux has-session -t "$session" 2>/dev/null; then
        echo "Stopping $session..."
        tmux kill-session -t "$session"
        echo -e "${GREEN}✓${NC} $session stopped"
    else
        echo "$session not running"
    fi
}

kill_session "nextjs"

# Clean up temporary files
echo "Cleaning up temporary files..."
if [ -d ".zkvm-temp" ]; then
    rm -rf .zkvm-temp
    echo -e "${GREEN}✓${NC} Removed .zkvm-temp directory"
fi

if [ -d "zkvm/test-data" ]; then
    # Remove only output and receipt files, keep test input files
    find zkvm/test-data -name "*-output.json" -o -name "*-receipt.json" | xargs rm -f 2>/dev/null || true
    echo -e "${GREEN}✓${NC} Cleaned zkVM test outputs"
fi

echo ""
echo -e "${GREEN}=== Teardown Complete ===${NC}"
echo ""
