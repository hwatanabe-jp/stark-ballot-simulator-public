#!/bin/bash
# Generate test data with valid Poseidon commitments
set -e

echo "=== Generating Test Data with Valid Commitments ==="
echo "Time: $(date)"
echo ""

# Create test data directory if it doesn't exist
mkdir -p zkvm/test-data

# Use Node.js to generate valid Poseidon commitments
cat << 'EOF_JS' > /tmp/generate_valid_test_data.js
const crypto = require('crypto');
const fs = require('fs');

// Generate deterministic 32-byte hex string
function generateDeterministicHex(seed) {
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return '0x' + hash;
}

// Create test data for S3 scenario
async function generateS3TestData() {
  const BOT_COUNT = 63;
  const VOTE_CHOICES = 5; // A-E (0-4)
  
  // User vote (choice A)
  const userChoice = 0;
  const userRandom = generateDeterministicHex('user-random');
  
  // Generate bot votes
  const botVotes = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    const choice = i % VOTE_CHOICES;
    const random = generateDeterministicHex(`bot-${i}-random`);
    botVotes.push({
      choice,
      commitment: generateDeterministicHex(`bot-${i}-commitment`), // Placeholder
      random
    });
  }
  
  // Create zkVM input
  const zkVMInput = {
    userVote: {
      choice: userChoice,
      commitment: generateDeterministicHex('user-commitment'), // Placeholder
      random: userRandom
    },
    botVotes,
    merkleRoot: '0x' + '0'.repeat(64), // Will be computed by zkVM
    scenarios: ['S3'] // Test S3 scenario
  };
  
  // Write to file
  fs.writeFileSync(
    'zkvm/test-data/test-s3-valid.json',
    JSON.stringify(zkVMInput, null, 2)
  );
  
  console.log('Generated test-s3-valid.json');
  console.log('Note: This uses the TypeScript executor format');
}

generateS3TestData().catch(console.error);
EOF_JS

# Run the Node.js script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
node /tmp/generate_valid_test_data.js

# Clean up
rm /tmp/generate_valid_test_data.js

echo ""
echo "Test data created: zkvm/test-data/test-s3-valid.json"
echo ""
echo "Now we can test with the TypeScript executor which will:"
echo "1. Generate valid Poseidon commitments"
echo "2. Convert to binary format for zkVM"
echo "3. Apply S3 scenario (ignore one random bot)"
