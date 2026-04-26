#!/usr/bin/env npx tsx
/**
 * Generate test vectors for Rust commitment implementation
 * This ensures TypeScript and Rust implementations produce identical results
 */

import { computeCommitment } from '../src/lib/zkvm/types';

// Test case 1: Example from final_design.md
const electionId1 = '550e8400-e29b-41d4-a716-446655440000';
const choice1 = 0; // Option A
const random1 = '0x' + 'aa'.repeat(32); // All 0xAA

const commitment1 = computeCommitment(electionId1, choice1, random1);

console.log('Test Vector 1:');
console.log('Election ID:', electionId1);
console.log('Choice:', choice1);
console.log('Random:', random1);
console.log('Commitment:', commitment1);
console.log();

// Test case 2: Different values
const electionId2 = '123e4567-e89b-12d3-a456-426614174000';
const choice2 = 3; // Option D
const random2 = '0x' + '01'.repeat(32);

const commitment2 = computeCommitment(electionId2, choice2, random2);

console.log('Test Vector 2:');
console.log('Election ID:', electionId2);
console.log('Choice:', choice2);
console.log('Random:', random2);
console.log('Commitment:', commitment2);
console.log();

// Test case 3: All zeros except choice
const electionId3 = '00000000-0000-0000-0000-000000000000';
const choice3 = 2; // Option C
const random3 = '0x' + '00'.repeat(32);

const commitment3 = computeCommitment(electionId3, choice3, random3);

console.log('Test Vector 3:');
console.log('Election ID:', electionId3);
console.log('Choice:', choice3);
console.log('Random:', random3);
console.log('Commitment:', commitment3);
