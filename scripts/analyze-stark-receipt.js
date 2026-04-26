#!/usr/bin/env node

/**
 * Analyze STARK receipt structure
 * This script provides detailed analysis of a zkVM receipt file
 */

const fs = require('fs');
const path = require('path');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function analyzeReceipt(receiptPath) {
  console.log(`${colors.bright}${colors.blue}=== STARK Receipt Analysis ===${colors.reset}\n`);

  if (!fs.existsSync(receiptPath)) {
    console.error(`${colors.red}Error: Receipt file not found: ${receiptPath}${colors.reset}`);
    process.exit(1);
  }

  const receiptData = fs.readFileSync(receiptPath, 'utf8');
  const receipt = JSON.parse(receiptData);

  console.log(`File: ${colors.cyan}${receiptPath}${colors.reset}`);
  console.log(`Size: ${colors.bright}${formatBytes(receiptData.length)}${colors.reset}\n`);

  // Analyze inner structure
  console.log(`${colors.yellow}Receipt Structure:${colors.reset}`);

  if (receipt.inner?.Composite) {
    console.log(`  Type: ${colors.green}Composite (Real STARK Proof)${colors.reset}`);
    const composite = receipt.inner.Composite;
    console.log(`  Segments: ${composite.segments.length}`);

    composite.segments.forEach((segment, idx) => {
      console.log(`\n  ${colors.cyan}Segment ${idx}:${colors.reset}`);

      // Seal analysis
      if (segment.seal) {
        const sealBytes = segment.seal.length * 4; // 32-bit integers
        console.log(`    Seal:`);
        console.log(`      Elements: ${colors.bright}${segment.seal.length.toLocaleString()}${colors.reset}`);
        console.log(`      Size: ${colors.bright}${formatBytes(sealBytes)}${colors.reset}`);
        console.log(`      First 5: [${segment.seal.slice(0, 5).join(', ')}...]`);
        console.log(`      Last 5: [...${segment.seal.slice(-5).join(', ')}]`);

        // Statistical analysis
        const min = Math.min(...segment.seal);
        const max = Math.max(...segment.seal);
        console.log(`      Range: ${min} to ${max}`);
      }

      // Other fields
      if (segment.index !== undefined) {
        console.log(`    Index: ${segment.index}`);
      }
      if (segment.hashfn) {
        console.log(`    Hash Function: ${segment.hashfn}`);
      }
      if (segment.verifier_parameters) {
        console.log(`    Verifier Parameters: ${JSON.stringify(segment.verifier_parameters).substring(0, 60)}...`);
      }
      if (segment.claim) {
        console.log(`    Claim: ${JSON.stringify(segment.claim).substring(0, 60)}...`);
      }
    });
  } else if (receipt.inner?.Fake) {
    console.log(`  Type: ${colors.yellow}Fake (Development Mode)${colors.reset}`);
    console.log(`  ${colors.dim}This is not a real STARK proof!${colors.reset}`);

    const fake = receipt.inner.Fake;
    if (fake.claim) {
      console.log(`  Claim: ${JSON.stringify(fake.claim).substring(0, 100)}...`);
    }
  } else if (receipt.inner?.Succinct) {
    console.log(`  Type: ${colors.cyan}Succinct${colors.reset}`);
  } else {
    console.log(`  Type: ${colors.red}Unknown${colors.reset}`);
  }

  // Journal analysis
  console.log(`\n${colors.yellow}Journal (Public Output):${colors.reset}`);

  if (receipt.journal?.bytes) {
    const journal = receipt.journal.bytes;
    console.log(`  Size: ${colors.bright}${journal.length} bytes${colors.reset}`);

    // Parse journal according to VerificationOutput structure
    if (journal.length >= 57) {
      // Merkle root (32 bytes)
      const merkleRoot = journal.slice(0, 32);
      console.log(`  Merkle Root: 0x${merkleRoot.map((b) => b.toString(16).padStart(2, '0')).join('')}`);

      // Verified tally (5 x u32 = 20 bytes)
      const tally = [];
      for (let i = 0; i < 5; i++) {
        const offset = 32 + i * 4;
        const value =
          journal[offset] | (journal[offset + 1] << 8) | (journal[offset + 2] << 16) | (journal[offset + 3] << 24);
        tally.push(value);
      }
      console.log(
        `  Verified Tally: [${tally.join(', ')}] (Choices: A=${tally[0]}, B=${tally[1]}, C=${tally[2]}, D=${tally[3]}, E=${tally[4]})`,
      );

      // Total votes (u32 = 4 bytes)
      const totalVotes = journal[52] | (journal[53] << 8) | (journal[54] << 16) | (journal[55] << 24);
      console.log(`  Total Votes: ${totalVotes}`);

      // Tamper detected (bool = 1 byte)
      const tamperDetected = journal[56] === 1;
      console.log(`  Tamper Detected: ${tamperDetected ? colors.red + 'Yes' : colors.green + 'No'}${colors.reset}`);
    } else {
      console.log(`  ${colors.yellow}Warning: Journal too small to parse (expected 57 bytes)${colors.reset}`);
      console.log(`  Raw: [${journal.slice(0, 10).join(', ')}...]`);
    }
  }

  // Performance estimation
  console.log(`\n${colors.yellow}Performance Characteristics:${colors.reset}`);

  if (receipt.inner?.Composite) {
    console.log(`  Proof Type: ${colors.bright}STARK (Scalable Transparent ARK)${colors.reset}`);
    console.log(`  Generation Time: ~57-115 seconds (production mode)`);
    console.log(`  Verification Time: ~1-5 seconds`);
    console.log(`  Security Level: 128-bit`);
  } else if (receipt.inner?.Fake) {
    console.log(`  Proof Type: ${colors.yellow}Fake (No cryptographic security)${colors.reset}`);
    console.log(`  Generation Time: <1 second`);
    console.log(`  Verification Time: Instant`);
    console.log(`  ${colors.red}⚠️  DO NOT USE IN PRODUCTION${colors.reset}`);
  }

  // Summary
  console.log(`\n${colors.bright}${colors.green}Summary:${colors.reset}`);
  const receiptType = receipt.inner?.Composite
    ? 'real STARK proof'
    : receipt.inner?.Fake
      ? 'fake development proof'
      : 'unknown proof type';
  console.log(`This receipt contains a ${colors.bright}${receiptType}${colors.reset}.`);

  if (receipt.inner?.Composite) {
    const sealSize = receipt.inner.Composite.segments[0]?.seal?.length || 0;
    console.log(
      `The STARK proof consists of ${colors.bright}${sealSize.toLocaleString()}${colors.reset} 32-bit field elements.`,
    );
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(`Usage: ${path.basename(process.argv[1])} <receipt-file>`);
  console.log(`\nExample:`);
  console.log(`  node ${path.basename(process.argv[1])} zkvm/test-data/test-fixture-tampered-receipt.json`);
  process.exit(1);
}

// Analyze the receipt
analyzeReceipt(args[0]);
