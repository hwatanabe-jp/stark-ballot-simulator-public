import { executeZkVM } from '../../src/lib/zkvm/executor';
import type { ZkVMInput, VoteWithProof } from '../../src/lib/zkvm/types';
import { BOT_COUNT } from '../../src/shared/constants';
import { createHash } from 'crypto';

async function testTamperDetection() {
  console.log('=== Testing zkVM Tamper Detection ===');
  console.log('Creating test data with SHA256 commitments...');

  // Create votes with SHA256 commitments
  const votes: VoteWithProof[] = [];

  // Add user vote
  const userChoice = 0; // A
  const userRandom = '1'.repeat(64);
  const userCommitment = createHash('sha256')
    .update(Buffer.from([userChoice]))
    .update(Buffer.from(userRandom, 'hex'))
    .digest('hex');

  votes.push({
    choice: userChoice,
    commitment: userCommitment,
    random: '0x' + userRandom,
    index: 0,
    merklePath: [],
  });

  // Add bot votes
  for (let i = 0; i < BOT_COUNT; i++) {
    const choice = i % 5; // Distribute among A-E
    const random = (i + 1).toString(16).padStart(64, '0');
    const commitment = createHash('sha256')
      .update(Buffer.from([choice]))
      .update(Buffer.from(random, 'hex'))
      .digest('hex');

    votes.push({
      choice,
      commitment,
      random: '0x' + random,
      index: i + 1,
      merklePath: [],
    });
  }

  // Create merkle root from all commitments
  const allCommitments = votes.map((v) => v.commitment).join('');
  const merkleRoot = createHash('sha256').update(allCommitments).digest('hex');

  // Create zkVM input
  const input: ZkVMInput = {
    votes,
    bulletinRoot: merkleRoot,
    treeSize: votes.length,
    totalExpected: votes.length,
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    electionConfigHash: '0x' + '00'.repeat(32),
    logId: '0x' + '00'.repeat(32),
    timestamp: Date.now(),
  };

  console.log('\nExecuting zkVM...');
  console.log('Tamper scenario: vote removed from tally (missing indices expected)');
  console.log('');

  // Set dev mode for faster execution
  process.env.RISC0_DEV_MODE = '1';

  try {
    const result = await executeZkVM(input);

    console.log('=== Results ===');
    console.log(`Total votes: ${result.totalVotes}`);
    console.log(`Excluded count: ${result.excludedSlots}`);
    console.log(`Missing indices: ${result.missingSlots}`);
    console.log(`Invalid indices: ${result.invalidPresentedSlots}`);
    console.log('');

    // Show vote distribution
    console.log('Verified tally:');
    const choices = ['A', 'B', 'C', 'D', 'E'] as const;
    const realTally = choices.map((_, index) => votes.filter((vote) => vote.choice === index).length);
    choices.forEach((choice, i) => {
      console.log(`  ${choice}: ${result.verifiedTally[i]} votes`);
    });

    // Expected results
    console.log('\n=== Verification ===');
    const expectedTotal = 64; // 1 user + 63 bots
    const totalOk = result.totalVotes === expectedTotal;
    console.log(`Expected total votes: ${expectedTotal}`);
    console.log(`Actual total votes: ${result.totalVotes}`);
    console.log(`Total votes correct: ${totalOk ? '✅' : '❌'}`);

    const tamperDetected = result.excludedSlots > 0;
    const tamperOk = tamperDetected === true;
    console.log(`\nExpected missing indices: > 0`);
    console.log(`Actual missing indices: ${result.missingSlots}`);
    console.log(`Expected invalid indices: 0`);
    console.log(`Actual invalid indices: ${result.invalidPresentedSlots}`);
    console.log(`Excluded (missing + invalid): ${result.excludedSlots}`);
    console.log(`Tamper detection correct: ${tamperOk ? '✅' : '❌'}`);

    // Check if verified tally matches real tally
    const tallyCorrect = JSON.stringify(result.verifiedTally) === JSON.stringify(realTally);
    console.log(`\nVerified tally matches real: ${tallyCorrect ? '✅' : '❌'}`);

    if (totalOk && tamperOk && tallyCorrect) {
      console.log('\n✅ zkVM tamper detection working correctly!');
    } else {
      console.log('\n❌ zkVM tamper detection has issues');
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

testTamperDetection().catch(console.error);
