extern crate alloc;

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;
use contract_core::{
    compute_bitmap_merkle_root, compute_commitment, compute_input_commitment_v4,
    verify_inclusion_proof_rfc6962, AggregatorInput, VerificationOutput, CURRENT_METHOD_VERSION,
};

use crate::sth::compute_sth_digest;

/// Maximum tree size accepted by the Phase 4 guest correspondence contract.
pub const MAX_FORMAL_GUEST_TREE_SIZE: u32 = 1_000_000;
/// Maximum presented record count accepted by the Phase 4 guest correspondence contract.
pub const MAX_FORMAL_GUEST_VOTE_COUNT: usize = MAX_FORMAL_GUEST_TREE_SIZE as usize;
/// Maximum value any candidate tally bucket may reach under accepted Phase 4 inputs.
pub const MAX_FORMAL_GUEST_TALLY_BUCKET: u32 = MAX_FORMAL_GUEST_TREE_SIZE;
const MAX_INPUT_COMMITMENT_MERKLE_PATH_LEN: usize = u16::MAX as usize;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RejectionReason {
    OutOfRangeIndex,
    DuplicateIndex,
    InvalidChoice,
    InvalidCommitment,
    DuplicateCommitment,
    InvalidInclusionProof,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GuestVoteInspection {
    Accepted,
    Rejected {
        reason: RejectionReason,
        slot_seen: bool,
        commitment_reserved: bool,
    },
}

#[derive(Clone, Debug)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct GuestTallyInspection {
    pub output: VerificationOutput,
    pub vote_outcomes: Vec<GuestVoteInspection>,
    pub included_bitmap: Vec<bool>,
}

/// Validate input structure and Phase 4 bounded-counter assumptions.
pub fn validate_input(input: &AggregatorInput) -> Result<(), String> {
    if input.bulletin_root.iter().all(|&b| b == 0) {
        return Err("Invalid bulletin root".to_string());
    }

    if input.tree_size == 0 {
        return Err("Tree size cannot be zero".to_string());
    }

    if input.tree_size > MAX_FORMAL_GUEST_TREE_SIZE {
        return Err(format!(
            "Tree size exceeds Phase 4 guest bound of {}",
            MAX_FORMAL_GUEST_TREE_SIZE
        ));
    }

    if input.total_expected > MAX_FORMAL_GUEST_TREE_SIZE {
        return Err(format!(
            "Total expected exceeds Phase 4 guest bound of {}",
            MAX_FORMAL_GUEST_TREE_SIZE
        ));
    }

    if input.votes.len() > MAX_FORMAL_GUEST_VOTE_COUNT {
        return Err(format!(
            "Vote count exceeds Phase 4 guest bound of {}",
            MAX_FORMAL_GUEST_VOTE_COUNT
        ));
    }

    if u32::try_from(input.votes.len()).is_err() {
        return Err("Vote count exceeds u32 journal encoding".to_string());
    }

    if input
        .votes
        .iter()
        .any(|vote| vote.merkle_path.len() > MAX_INPUT_COMMITMENT_MERKLE_PATH_LEN)
    {
        return Err("Merkle path length exceeds u16 input commitment encoding".to_string());
    }

    Ok(())
}

pub fn verify_and_tally_checked(input: &AggregatorInput) -> Result<GuestTallyInspection, String> {
    validate_input(input)?;
    verify_and_tally_inspection(input)
}

#[cfg(test)]
pub fn verify_and_tally_output(input: &AggregatorInput) -> VerificationOutput {
    verify_and_tally_checked(input)
        .expect("checked guest tally should accept valid test input")
        .output
}

fn verify_and_tally_inspection(input: &AggregatorInput) -> Result<GuestTallyInspection, String> {
    let mut verified_tally = [0u32; 5];
    let tree_size_usize = input.tree_size as usize;
    let mut included_bitmap = vec![false; tree_size_usize];
    let mut index_seen = vec![false; tree_size_usize];
    let mut seen_commitments: Vec<[u8; 32]> = Vec::with_capacity(input.votes.len());
    let mut vote_outcomes = Vec::with_capacity(input.votes.len());
    let mut valid_count = 0u32;
    let mut invalid_count = 0u32;
    let mut seen_indices_count = 0u32;

    let _expected_actual_mismatch = input.total_expected != input.tree_size;

    for vote in &input.votes {
        if vote.index >= input.tree_size {
            invalid_count = checked_increment(invalid_count, "invalid vote count")?;
            vote_outcomes.push(GuestVoteInspection::Rejected {
                reason: RejectionReason::OutOfRangeIndex,
                slot_seen: false,
                commitment_reserved: false,
            });
            continue;
        }

        let index = vote.index as usize;
        if index_seen[index] {
            invalid_count = checked_increment(invalid_count, "invalid vote count")?;
            vote_outcomes.push(GuestVoteInspection::Rejected {
                reason: RejectionReason::DuplicateIndex,
                slot_seen: false,
                commitment_reserved: false,
            });
            continue;
        }
        index_seen[index] = true;
        seen_indices_count = checked_increment(seen_indices_count, "seen index count")?;

        if vote.choice >= 5 {
            invalid_count = checked_increment(invalid_count, "invalid vote count")?;
            vote_outcomes.push(GuestVoteInspection::Rejected {
                reason: RejectionReason::InvalidChoice,
                slot_seen: true,
                commitment_reserved: false,
            });
            continue;
        }

        let computed_commitment = compute_commitment(&input.election_id, vote.choice, &vote.random);
        if computed_commitment != vote.commitment {
            invalid_count = checked_increment(invalid_count, "invalid vote count")?;
            vote_outcomes.push(GuestVoteInspection::Rejected {
                reason: RejectionReason::InvalidCommitment,
                slot_seen: true,
                commitment_reserved: false,
            });
            continue;
        }

        match seen_commitments.binary_search(&computed_commitment) {
            Ok(_) => {
                invalid_count = checked_increment(invalid_count, "invalid vote count")?;
                vote_outcomes.push(GuestVoteInspection::Rejected {
                    reason: RejectionReason::DuplicateCommitment,
                    slot_seen: true,
                    commitment_reserved: false,
                });
                continue;
            }
            Err(pos) => seen_commitments.insert(pos, computed_commitment),
        };

        if !verify_inclusion_proof_rfc6962(
            &vote.commitment,
            vote.index,
            &vote.merkle_path,
            &input.bulletin_root,
            input.tree_size,
        ) {
            invalid_count = checked_increment(invalid_count, "invalid vote count")?;
            vote_outcomes.push(GuestVoteInspection::Rejected {
                reason: RejectionReason::InvalidInclusionProof,
                slot_seen: true,
                commitment_reserved: true,
            });
            continue;
        }

        verified_tally[vote.choice as usize] =
            checked_increment(verified_tally[vote.choice as usize], "candidate tally")?;
        if verified_tally[vote.choice as usize] > MAX_FORMAL_GUEST_TALLY_BUCKET {
            return Err(format!(
                "Candidate tally bucket exceeds Phase 4 guest bound of {}",
                MAX_FORMAL_GUEST_TALLY_BUCKET
            ));
        }
        included_bitmap[index] = true;
        valid_count = checked_increment(valid_count, "valid vote count")?;
        vote_outcomes.push(GuestVoteInspection::Accepted);
    }

    let seen_bitmap_root = compute_bitmap_merkle_root(&index_seen);
    let included_bitmap_root = compute_bitmap_merkle_root(&included_bitmap);
    let missing_slots = input
        .tree_size
        .checked_sub(seen_indices_count)
        .ok_or_else(|| "seen index count exceeds tree size".to_string())?;
    let invalid_presented_slots = seen_indices_count
        .checked_sub(valid_count)
        .ok_or_else(|| "valid vote count exceeds seen index count".to_string())?;
    let rejected_records = invalid_count;
    let excluded_slots = missing_slots
        .checked_add(invalid_presented_slots)
        .ok_or_else(|| "excluded slot count overflow".to_string())?;

    let input_commitment = compute_input_commitment_v4(
        &input.election_id,
        &input.bulletin_root,
        input.tree_size,
        input.total_expected,
        &input.votes,
    );
    let sth_digest = compute_sth_digest(
        &input.log_id,
        input.tree_size,
        input.timestamp,
        &input.bulletin_root,
    );

    let output = VerificationOutput {
        election_id: input.election_id,
        election_config_hash: input.election_config_hash,
        bulletin_root: input.bulletin_root,
        tree_size: input.tree_size,
        total_expected: input.total_expected,
        sth_digest,
        verified_tally,
        total_votes: u32::try_from(input.votes.len())
            .map_err(|_| "Vote count exceeds u32 journal encoding".to_string())?,
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
        method_version: CURRENT_METHOD_VERSION,
    };

    Ok(GuestTallyInspection {
        output,
        vote_outcomes,
        included_bitmap,
    })
}

fn checked_increment(value: u32, label: &str) -> Result<u32, String> {
    value
        .checked_add(1)
        .ok_or_else(|| format!("{label} exceeds u32 journal encoding"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::{String, ToString};
    use contract_core::{compute_merkle_root, hash_internal, hash_leaf, VoteWithProof};
    use serde::Deserialize;

    #[test]
    fn test_verify_and_tally_empty_votes() {
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

        let output = verify_and_tally_output(&input);

        assert_eq!(output.total_votes, 0);
        assert_eq!(output.valid_votes, 0);
        assert_eq!(output.invalid_votes, 0);
        assert_eq!(output.verified_tally, [0, 0, 0, 0, 0]);
        assert_eq!(output.missing_slots, 10);
    }

    #[test]
    fn test_verify_and_tally_single_valid_vote() {
        let election_id = [1u8; 16];
        let commitment = compute_commitment(&election_id, 0, &[42u8; 32]);
        let votes = vec![VoteWithProof {
            commitment,
            choice: 0,
            random: [42u8; 32],
            index: 0,
            merkle_path: vec![],
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

        let output = verify_and_tally_output(&input);

        assert_eq!(output.total_votes, 1);
        assert_eq!(output.valid_votes, 1);
        assert_eq!(output.invalid_votes, 0);
        assert_eq!(output.verified_tally, [1, 0, 0, 0, 0]);
        assert_eq!(output.missing_slots, 0);
        assert_eq!(output.invalid_presented_slots, 0);
        assert_eq!(output.rejected_records, 0);
    }

    #[test]
    fn test_validate_input_zero_bulletin_root() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [0u8; 32],
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
            tree_size: 0,
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

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FormalGuestCase {
        name: String,
        tree_size: u32,
        votes: Vec<FormalGuestVote>,
        expected_outcomes: Vec<FormalGuestOutcome>,
        expected_seen_indices_count: u32,
        expected_missing_slots: u32,
        expected_invalid_presented_slots: u32,
        expected_rejected_records: u32,
        expected_rejection_reasons: Vec<String>,
        expected_excluded_slots: u32,
        expected_valid_votes: u32,
        expected_tally: [u32; 5],
        expected_included_bitmap_true_indices: Vec<usize>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FormalGuestVote {
        index: u32,
        choice: u8,
        random_byte: u8,
        commitment: u8,
        commitment_ok: bool,
        inclusion_ok: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FormalGuestOutcome {
        accepted: bool,
        reason: Option<String>,
        slot_seen: bool,
        commitment_reserved: bool,
    }

    // Fixture-local deterministic election ID; every vector commitment and
    // Merkle proof in this test is built from the same value.
    const FORMAL_GUEST_VECTOR_ELECTION_ID: [u8; 16] = [0x42u8; 16];

    fn formal_guest_cases() -> Vec<FormalGuestCase> {
        serde_json::from_str(include_str!(
            "../../../../docs/current/formal/generated-vectors/guest-model-cases.json"
        ))
        .expect("formal guest model vectors should parse")
    }

    fn reason_name(reason: RejectionReason) -> &'static str {
        match reason {
            RejectionReason::OutOfRangeIndex => "out_of_range_index",
            RejectionReason::DuplicateIndex => "duplicate_index",
            RejectionReason::InvalidChoice => "invalid_choice",
            RejectionReason::InvalidCommitment => "invalid_commitment",
            RejectionReason::DuplicateCommitment => "duplicate_commitment",
            RejectionReason::InvalidInclusionProof => "invalid_inclusion_proof",
        }
    }

    fn outcome_matches(actual: &GuestVoteInspection, expected: &FormalGuestOutcome) {
        match actual {
            GuestVoteInspection::Accepted => {
                assert!(expected.accepted);
                assert_eq!(expected.reason, None);
                assert!(expected.slot_seen);
                assert!(expected.commitment_reserved);
            }
            GuestVoteInspection::Rejected {
                reason,
                slot_seen,
                commitment_reserved,
            } => {
                assert!(!expected.accepted);
                assert_eq!(expected.reason.as_deref(), Some(reason_name(*reason)));
                assert_eq!(*slot_seen, expected.slot_seen);
                assert_eq!(*commitment_reserved, expected.commitment_reserved);
            }
        }
    }

    fn commitment_for_vector_vote(election_id: &[u8; 16], vote: &FormalGuestVote) -> [u8; 32] {
        if vote.commitment_ok {
            compute_commitment(election_id, vote.choice, &[vote.random_byte; 32])
        } else {
            [vote.commitment; 32]
        }
    }

    fn merkle_proof_for_index(leaves: &[[u8; 32]], leaf_index: usize) -> Vec<[u8; 32]> {
        let mut path = Vec::new();
        let mut index = leaf_index;
        let mut level: Vec<[u8; 32]> = leaves.iter().map(hash_leaf).collect();

        while level.len() > 1 {
            if index % 2 == 1 {
                path.push(level[index - 1]);
            } else if index + 1 < level.len() {
                path.push(level[index + 1]);
            }

            let mut next_level = Vec::with_capacity(level.len().div_ceil(2));
            let mut iter = level.chunks_exact(2);
            for pair in &mut iter {
                next_level.push(hash_internal(&pair[0], &pair[1]));
            }
            if let Some(rem) = iter.remainder().first() {
                next_level.push(*rem);
            }

            index /= 2;
            level = next_level;
        }

        path
    }

    fn build_formal_guest_input(case: &FormalGuestCase) -> AggregatorInput {
        let election_id = FORMAL_GUEST_VECTOR_ELECTION_ID;
        let mut leaves: Vec<[u8; 32]> = (0..case.tree_size)
            .map(|index| {
                let mut leaf = [0xA0; 32];
                leaf[0] = index as u8;
                leaf
            })
            .collect();
        let mut assigned_leaf = vec![false; case.tree_size as usize];

        for vote in &case.votes {
            if vote.inclusion_ok
                && vote.index < case.tree_size
                && !assigned_leaf[vote.index as usize]
            {
                leaves[vote.index as usize] = commitment_for_vector_vote(&election_id, vote);
                assigned_leaf[vote.index as usize] = true;
            }
        }

        let hashed_leaves: Vec<[u8; 32]> = leaves.iter().map(hash_leaf).collect();
        let bulletin_root = compute_merkle_root(&hashed_leaves);
        let votes = case
            .votes
            .iter()
            .map(|vote| {
                let merkle_path = if vote.inclusion_ok && vote.index < case.tree_size {
                    merkle_proof_for_index(&leaves, vote.index as usize)
                } else {
                    Vec::new()
                };
                VoteWithProof {
                    commitment: commitment_for_vector_vote(&election_id, vote),
                    choice: vote.choice,
                    random: [vote.random_byte; 32],
                    index: vote.index,
                    merkle_path,
                }
            })
            .collect();

        AggregatorInput {
            election_id,
            bulletin_root,
            tree_size: case.tree_size,
            log_id: [2u8; 32],
            timestamp: 1234567890,
            total_expected: case.tree_size,
            election_config_hash: [3u8; 32],
            votes,
        }
    }

    #[test]
    fn test_formal_guest_model_vectors() {
        for case in formal_guest_cases() {
            let input = build_formal_guest_input(&case);
            let inspection = verify_and_tally_checked(&input).unwrap_or_else(|error| {
                panic!("{} should pass guest bounds: {}", case.name, error)
            });
            let output = inspection.output;

            assert_eq!(
                inspection.vote_outcomes.len(),
                case.expected_outcomes.len(),
                "{}",
                case.name
            );
            for (actual, expected) in inspection
                .vote_outcomes
                .iter()
                .zip(case.expected_outcomes.iter())
            {
                outcome_matches(actual, expected);
            }

            let rejection_reasons: Vec<String> = inspection
                .vote_outcomes
                .iter()
                .filter_map(|outcome| match outcome {
                    GuestVoteInspection::Accepted => None,
                    GuestVoteInspection::Rejected { reason, .. } => {
                        Some(reason_name(*reason).to_string())
                    }
                })
                .collect();
            let included_true_indices: Vec<usize> = inspection
                .included_bitmap
                .iter()
                .enumerate()
                .filter_map(|(index, included)| if *included { Some(index) } else { None })
                .collect();

            assert_eq!(
                output.seen_indices_count, case.expected_seen_indices_count,
                "{}",
                case.name
            );
            assert_eq!(
                output.missing_slots, case.expected_missing_slots,
                "{}",
                case.name
            );
            assert_eq!(
                output.invalid_presented_slots, case.expected_invalid_presented_slots,
                "{}",
                case.name
            );
            assert_eq!(
                output.rejected_records, case.expected_rejected_records,
                "{}",
                case.name
            );
            assert_eq!(
                rejection_reasons, case.expected_rejection_reasons,
                "{}",
                case.name
            );
            assert_eq!(
                output.excluded_slots, case.expected_excluded_slots,
                "{}",
                case.name
            );
            assert_eq!(
                output.valid_votes, case.expected_valid_votes,
                "{}",
                case.name
            );
            assert_eq!(output.verified_tally, case.expected_tally, "{}", case.name);
            assert_eq!(
                included_true_indices, case.expected_included_bitmap_true_indices,
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn test_guest_bounds_reject_oversized_tree_size() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: MAX_FORMAL_GUEST_TREE_SIZE + 1,
            log_id: [2u8; 32],
            timestamp: 1234567890,
            total_expected: 1,
            election_config_hash: [3u8; 32],
            votes: vec![],
        };

        let result = verify_and_tally_checked(&input);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("Tree size exceeds Phase 4 guest bound"));
    }

    #[test]
    fn test_guest_bounds_reject_oversized_total_expected() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: 1,
            log_id: [2u8; 32],
            timestamp: 1234567890,
            total_expected: MAX_FORMAL_GUEST_TREE_SIZE + 1,
            election_config_hash: [3u8; 32],
            votes: vec![],
        };

        let result = verify_and_tally_checked(&input);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("Total expected exceeds Phase 4 guest bound"));
    }

    #[test]
    fn test_guest_bounds_reject_oversized_vote_count() {
        let vote = VoteWithProof {
            commitment: [4u8; 32],
            choice: 0,
            random: [5u8; 32],
            index: 0,
            merkle_path: vec![],
        };
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: 1,
            log_id: [2u8; 32],
            timestamp: 1234567890,
            total_expected: 1,
            election_config_hash: [3u8; 32],
            votes: vec![vote; MAX_FORMAL_GUEST_VOTE_COUNT + 1],
        };

        let result = verify_and_tally_checked(&input);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("Vote count exceeds Phase 4 guest bound"));
    }

    #[test]
    fn test_guest_bounds_reject_oversized_merkle_path_length() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: 1,
            log_id: [2u8; 32],
            timestamp: 1234567890,
            total_expected: 1,
            election_config_hash: [3u8; 32],
            votes: vec![VoteWithProof {
                commitment: [4u8; 32],
                choice: 0,
                random: [5u8; 32],
                index: 0,
                merkle_path: vec![[6u8; 32]; usize::from(u16::MAX) + 1],
            }],
        };

        let result = verify_and_tally_checked(&input);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("Merkle path length exceeds u16 input commitment encoding"));
    }
}
