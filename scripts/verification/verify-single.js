#!/usr/bin/env node
/**
 * Legacy command-line inspection of a single STARK proof receipt fixture.
 *
 * Usage: node scripts/verification/verify-single.js <scenario>
 * Example: node scripts/verification/verify-single.js s0-notamper
 *
 * This helper only inspects fixture shape and journal-derived counts. It does
 * not perform cryptographic receipt verification.
 */

const fs = require('fs');
const path = require('path');

const scenarioId = process.argv[2] || 's0-notamper';
const receiptPath = path.join(__dirname, '..', '..', 'zkvm', 'test-data', `test-${scenarioId}-receipt.json`);

console.log(`\n=== Inspecting STARK Receipt Fixture: ${scenarioId} ===\n`);

try {
  // Load receipt
  const receiptData = JSON.parse(fs.readFileSync(receiptPath, 'utf-8'));

  // Extract key data
  const seal = receiptData.inner?.Composite?.segments?.[0]?.seal;
  const journal = receiptData.journal?.bytes;

  if (!seal || !journal) {
    throw new Error('Invalid receipt format');
  }

  console.log(`Receipt loaded successfully:`);
  console.log(`- Seal size: ${(seal.length / 1024).toFixed(2)} KB`);
  console.log(`- Journal size: ${journal.length} bytes`);

  // Parse journal to show vote counts
  const buffer = Buffer.from(journal);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const arrayLen = view.getUint32(0, true);
  if (arrayLen === 5) {
    const votes = [];
    for (let i = 0; i < 5; i++) {
      votes.push(view.getUint32(4 + i * 4, true));
    }

    // Skip merkle root
    const merkleLen = view.getUint32(24, true);
    const offset = 28 + merkleLen * 4;

    const totalVotes = view.getUint32(offset, true);
    const tamperedCount = view.getUint32(offset + 4, true);

    console.log(`\nVote Results:`);
    console.log(`- A: ${votes[0]}, B: ${votes[1]}, C: ${votes[2]}, D: ${votes[3]}, E: ${votes[4]}`);
    console.log(`- Total votes: ${totalVotes}`);
    console.log(`- Tampered votes: ${tamperedCount}`);
  }

  console.log(`\nReceipt structure loaded`);
  console.log(`\nNote: This legacy helper does not verify STARK proof validity.`);
  console.log(`Use verifier-service verify for Receipt::verify(expected_image_id).`);
} catch (error) {
  console.error(`\n❌ Error: ${error.message}`);
  process.exit(1);
}
