#![no_main]

extern crate alloc;

use alloc::vec;
use alloc::vec::Vec;
use contract_core::{
    compute_bitmap_merkle_root, compute_commitment, compute_input_commitment_v4,
    verify_inclusion_proof_rfc6962, AggregatorInput, VerificationOutput,
};
use risc0_zkvm::guest::env;

#[cfg(feature = "profiling")]
mod profiling;
mod sth;

use sth::compute_sth_digest;

#[cfg(feature = "profiling")]
use profiling::Profiler;

#[cfg(not(feature = "profiling"))]
struct Profiler;

#[cfg(not(feature = "profiling"))]
impl Profiler {
    #[inline(always)]
    fn new() -> Self {
        Self
    }

    #[inline(always)]
    fn checkpoint(&mut self, _label: &'static str) {}

    #[inline(always)]
    fn report(&self) {}
}

#[cfg(feature = "profiling")]
fn log_message(message: &str) {
    eprintln!("{}", message);
}

#[cfg(not(feature = "profiling"))]
fn log_message(_message: &str) {}

#[cfg(not(test))]
risc0_zkvm::guest::entry!(guest_main);

#[cfg(test)]
#[no_mangle]
pub extern "C" fn main() -> i32 {
    0
}

/// Main entry point for the zkVM implementation
/// This version has no knowledge of tamper scenarios and only verifies votes
pub fn guest_main() {
    // Host-side unit tests execute this binary without zkVM syscalls,
    // so bail out early to avoid invoking unsupported cycle counters.
    if cfg!(test) {
        return;
    }

    let mut profiler = Profiler::new();

    // Read aggregator input directly from the host
    let input: AggregatorInput = env::read();
    profiler.checkpoint("read input");
    log_message(&format!("Processing {} votes", input.votes.len()));

    // Validate input
    if let Err(e) = validate_input(&input) {
        panic!("Input validation failed: {}", e);
    }

    // Process votes and verify tally
    let output = verify_and_tally(&input);
    profiler.checkpoint("process and verify");

    // Commit the output to the journal
    env::commit(&output);
    profiler.checkpoint("commit output");
    profiler.report();
}

/// Validate input structure
fn validate_input(input: &AggregatorInput) -> Result<(), String> {
    // Validate bulletin root is not zero
    if input.bulletin_root.iter().all(|&b| b == 0) {
        return Err("Invalid bulletin root".to_string());
    }

    // Validate tree_size is reasonable
    if input.tree_size == 0 {
        return Err("Tree size cannot be zero".to_string());
    }

    Ok(())
}

/// Verify commitments and calculate the correct tally
/// Following final_design.md §2.4 - Counted-as-Recorded verification
fn verify_and_tally(input: &AggregatorInput) -> VerificationOutput {
    // Initialize accumulators
    let mut verified_tally = [0u32; 5];
    let tree_size_usize = input.tree_size as usize;
    let mut included_bitmap = vec![false; tree_size_usize];
    let mut index_seen = vec![false; tree_size_usize];
    let mut seen_commitments: Vec<[u8; 32]> = Vec::with_capacity(input.votes.len());
    let mut valid_count = 0u32;
    let mut invalid_count = 0u32;
    let mut seen_indices_count = 0u32;

    // Step 0: Record totalExpected vs treeSize mismatch (don't assert)
    // This allows detection of "silent exclusion" attacks
    let _expected_actual_mismatch = input.total_expected != input.tree_size;

    // Process all votes
    for vote in &input.votes {
        // Step 1: Index boundary check
        if vote.index >= input.tree_size {
            invalid_count += 1;
            continue; // Index out of range
        }

        let index = vote.index as usize;

        // Check for duplicate index
        if index_seen[index] {
            invalid_count += 1;
            continue; // Duplicate index
        }
        index_seen[index] = true;
        seen_indices_count = seen_indices_count.saturating_add(1);

        // Step 2: Choice boundary check (must be 0-4)
        if vote.choice >= 5 {
            invalid_count += 1;
            continue; // Invalid choice value
        }

        // Step 3: Verify commitment with domain separation
        let computed_commitment = compute_commitment(&input.election_id, vote.choice, &vote.random);

        if computed_commitment != vote.commitment {
            invalid_count += 1;
            continue; // Invalid commitment
        }

        // Step 3.5: Check for duplicate commitment
        match seen_commitments.binary_search(&computed_commitment) {
            Ok(_) => {
                invalid_count += 1;
                continue; // Duplicate commitment
            }
            Err(pos) => seen_commitments.insert(pos, computed_commitment),
        };

        // Step 4: Verify inclusion proof (RFC 6962 compliant)
        if !verify_inclusion_proof_rfc6962(
            &vote.commitment,
            vote.index,
            &vote.merkle_path,
            &input.bulletin_root,
            input.tree_size,
        ) {
            invalid_count += 1;
            continue; // Failed inclusion proof
        }

        // Step 5: Valid vote - add to tally
        verified_tally[vote.choice as usize] =
            verified_tally[vote.choice as usize].saturating_add(1);
        included_bitmap[index] = true;
        valid_count = valid_count.saturating_add(1);
    }

    // Step 6: Compute bitmap Merkle root
    let seen_bitmap_root = compute_bitmap_merkle_root(&index_seen);
    let included_bitmap_root = compute_bitmap_merkle_root(&included_bitmap);

    // Step 7: Calculate slot/record exclusion statistics.
    let missing_slots = input.tree_size.saturating_sub(seen_indices_count);
    let invalid_presented_slots = seen_indices_count.saturating_sub(valid_count);
    let rejected_records = invalid_count;
    let excluded_slots = missing_slots.saturating_add(invalid_presented_slots);

    // Step 8: Compute input commitment (MUST apply canonical vote ordering)
    let input_commitment = compute_input_commitment_v4(
        &input.election_id,
        &input.bulletin_root,
        input.tree_size,
        input.total_expected,
        &input.votes,
    );

    // Step 9: Compute STH digest for split-view attack prevention
    let sth_digest = compute_sth_digest(
        &input.log_id,
        input.tree_size,
        input.timestamp,
        &input.bulletin_root,
    );

    // Return comprehensive verification output
    VerificationOutput {
        election_id: input.election_id,
        election_config_hash: input.election_config_hash,
        bulletin_root: input.bulletin_root,
        tree_size: input.tree_size,
        total_expected: input.total_expected,
        sth_digest,
        verified_tally,
        total_votes: input.votes.len() as u32,
        valid_votes: valid_count,
        invalid_votes: invalid_count,
        seen_indices_count,
        missing_slots,
        invalid_presented_slots,
        rejected_records,
        seen_bitmap_root,
        included_bitmap_root,
        excluded_slots,
        input_commitment,
        method_version: 12, // v1.2
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use contract_core::{hash_leaf, VoteWithProof};

    #[test]
    fn test_verify_and_tally_empty_votes() {
        // Create test input with no votes
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: 10,
            log_id: [2u8; 32],
            timestamp: 1234567890,
            total_expected: 0,
            election_config_hash: [3u8; 32],
            votes: vec![],
        };

        // Process
        let output = verify_and_tally(&input);

        // Verify output
        assert_eq!(output.total_votes, 0);
        assert_eq!(output.valid_votes, 0);
        assert_eq!(output.invalid_votes, 0);
        assert_eq!(output.verified_tally, [0, 0, 0, 0, 0]);
        assert_eq!(output.missing_slots, 10); // tree_size - seen_indices_count
    }

    #[test]
    fn test_verify_and_tally_single_valid_vote() {
        // Create single valid vote
        let election_id = [1u8; 16];
        let commitment = compute_commitment(&election_id, 0, &[42u8; 32]);

        let votes = vec![VoteWithProof {
            commitment,
            choice: 0,
            random: [42u8; 32],
            index: 0,
            merkle_path: vec![], // Empty path for single element tree
        }];

        let input = AggregatorInput {
            election_id,
            bulletin_root: hash_leaf(&commitment),
            tree_size: 1,
            log_id: [2u8; 32],
            timestamp: 1234567890,
            total_expected: 1,
            election_config_hash: [3u8; 32],
            votes,
        };

        // Process
        let output = verify_and_tally(&input);

        // Verify output
        assert_eq!(output.total_votes, 1);
        assert_eq!(output.valid_votes, 1);
        assert_eq!(output.invalid_votes, 0);
        assert_eq!(output.verified_tally, [1, 0, 0, 0, 0]);
        assert_eq!(output.missing_slots, 0);
        assert_eq!(output.invalid_presented_slots, 0);
        assert_eq!(output.rejected_records, 0);
    }

    #[test]
    fn test_verify_and_tally_duplicate_and_out_of_range_do_not_inflate_slot_failures() {
        let election_id = [1u8; 16];
        let valid_commitment = compute_commitment(&election_id, 0, &[42u8; 32]);

        let votes = vec![
            VoteWithProof {
                commitment: valid_commitment,
                choice: 0,
                random: [42u8; 32],
                index: 0,
                merkle_path: vec![],
            },
            VoteWithProof {
                commitment: [7u8; 32],
                choice: 1,
                random: [9u8; 32],
                index: 0,
                merkle_path: vec![],
            },
            VoteWithProof {
                commitment: [8u8; 32],
                choice: 2,
                random: [10u8; 32],
                index: 9,
                merkle_path: vec![],
            },
        ];

        let input = AggregatorInput {
            election_id,
            bulletin_root: hash_leaf(&valid_commitment),
            tree_size: 1,
            log_id: [2u8; 32],
            timestamp: 1234567890,
            total_expected: 1,
            election_config_hash: [3u8; 32],
            votes,
        };

        let output = verify_and_tally(&input);

        assert_eq!(output.total_votes, 3);
        assert_eq!(output.valid_votes, 1);
        assert_eq!(output.invalid_votes, 2);
        assert_eq!(output.seen_indices_count, 1);
        assert_eq!(output.missing_slots, 0);
        assert_eq!(output.invalid_presented_slots, 0);
        assert_eq!(output.rejected_records, 2);
        assert_eq!(output.excluded_slots, 0);
    }

    #[test]
    fn test_verify_and_tally_invalid_choice() {
        // Create vote with invalid choice (>= 5)
        let election_id = [1u8; 16];
        let commitment = [99u8; 32]; // Dummy commitment

        let votes = vec![VoteWithProof {
            commitment,
            choice: 5, // Invalid choice
            random: [42u8; 32],
            index: 0,
            merkle_path: vec![],
        }];

        let input = AggregatorInput {
            election_id,
            bulletin_root: [1u8; 32],
            tree_size: 1,
            log_id: [2u8; 32],
            timestamp: 1234567890,
            total_expected: 1,
            election_config_hash: [3u8; 32],
            votes,
        };

        // Process
        let output = verify_and_tally(&input);

        // Verify output
        assert_eq!(output.total_votes, 1);
        assert_eq!(output.valid_votes, 0);
        assert_eq!(output.invalid_votes, 1);
        assert_eq!(output.verified_tally, [0, 0, 0, 0, 0]);
        assert_eq!(output.invalid_presented_slots, 1);
        assert_eq!(output.rejected_records, 1);
        assert_eq!(output.excluded_slots, 1);
    }

    #[test]
    fn test_validate_input_zero_bulletin_root() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [0u8; 32], // Zero bulletin root
            tree_size: 1,
            log_id: [2u8; 32],
            timestamp: 1234567890,
            total_expected: 1,
            election_config_hash: [3u8; 32],
            votes: vec![],
        };

        let result = validate_input(&input);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Invalid bulletin root");
    }

    #[test]
    fn test_validate_input_zero_tree_size() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: 0, // Zero tree size
            log_id: [2u8; 32],
            timestamp: 1234567890,
            total_expected: 0,
            election_config_hash: [3u8; 32],
            votes: vec![],
        };

        let result = validate_input(&input);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Tree size cannot be zero");
    }
}
