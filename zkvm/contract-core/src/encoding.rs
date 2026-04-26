use alloc::vec::Vec;
use core::cmp::Ordering;
use risc0_zkvm::sha::{Impl, Sha256};

use crate::types::VoteWithProof;

const INPUT_DOMAIN_TAG: &[u8] = b"stark-ballot:input|v1.0";

/// Compute input commitment with canonical encoding.
pub fn compute_input_commitment_v4(
    election_id: &[u8; 16],
    bulletin_root: &[u8; 32],
    tree_size: u32,
    total_expected: u32,
    votes: &[VoteWithProof],
) -> [u8; 32] {
    let mut data = Vec::with_capacity(encoded_prefix_len() + encoded_votes_len(votes));

    data.extend_from_slice(INPUT_DOMAIN_TAG);
    data.extend_from_slice(&10u32.to_le_bytes());
    data.extend_from_slice(election_id);
    data.extend_from_slice(bulletin_root);
    data.extend_from_slice(&tree_size.to_le_bytes());
    data.extend_from_slice(&total_expected.to_le_bytes());
    data.extend_from_slice(&(votes.len() as u32).to_le_bytes());

    let mut sorted_indices: Vec<usize> = (0..votes.len()).collect();
    sorted_indices.sort_by(|&a, &b| compare_votes(&votes[a], &votes[b]));

    for index in sorted_indices {
        let vote = &votes[index];
        encode_vote(&mut data, vote);
    }

    let digest = Impl::hash_bytes(&data);
    let mut result = [0u8; 32];
    result.copy_from_slice(digest.as_bytes());
    result
}

fn encode_vote(data: &mut Vec<u8>, vote: &VoteWithProof) {
    data.extend_from_slice(&vote.index.to_le_bytes());
    data.extend_from_slice(&32u16.to_le_bytes());
    data.extend_from_slice(&vote.commitment);
    data.extend_from_slice(&(vote.merkle_path.len() as u16).to_le_bytes());

    for node in &vote.merkle_path {
        data.extend_from_slice(node);
    }
}

#[cfg(test)]
fn is_sorted_by_canonical_ordering(votes: &[VoteWithProof]) -> bool {
    votes
        .windows(2)
        .all(|pair| compare_votes(&pair[0], &pair[1]) != Ordering::Greater)
}

fn compare_votes(left: &VoteWithProof, right: &VoteWithProof) -> Ordering {
    match left.index.cmp(&right.index) {
        Ordering::Equal => {}
        ordering => return ordering,
    }

    match left.commitment.cmp(&right.commitment) {
        Ordering::Equal => {}
        ordering => return ordering,
    }

    compare_merkle_paths(&left.merkle_path, &right.merkle_path)
}

fn compare_merkle_paths(left: &[[u8; 32]], right: &[[u8; 32]]) -> Ordering {
    for (left_node, right_node) in left.iter().zip(right.iter()) {
        match left_node.cmp(right_node) {
            Ordering::Equal => continue,
            ordering => return ordering,
        }
    }

    left.len().cmp(&right.len())
}

fn encoded_prefix_len() -> usize {
    INPUT_DOMAIN_TAG.len() + 4 + 16 + 32 + 4 + 4 + 4
}

fn encoded_votes_len(votes: &[VoteWithProof]) -> usize {
    votes
        .iter()
        .map(|vote| 4 + 2 + 32 + 2 + (vote.merkle_path.len() * 32))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn create_test_vote(index: u32, choice: u8) -> VoteWithProof {
        VoteWithProof {
            commitment: [choice; 32],
            choice,
            random: [0xAA; 32],
            index,
            merkle_path: vec![],
        }
    }

    #[test]
    fn test_input_commitment_canonical_ordering() {
        let election_id = [1u8; 16];
        let bulletin_root = [2u8; 32];
        let tree_size = 10;
        let total_expected = 3;

        let votes_unsorted = vec![
            create_test_vote(5, 0),
            create_test_vote(1, 1),
            create_test_vote(3, 2),
        ];

        let votes_sorted = vec![
            create_test_vote(1, 1),
            create_test_vote(3, 2),
            create_test_vote(5, 0),
        ];

        let commitment1 = compute_input_commitment_v4(
            &election_id,
            &bulletin_root,
            tree_size,
            total_expected,
            &votes_unsorted,
        );

        let commitment2 = compute_input_commitment_v4(
            &election_id,
            &bulletin_root,
            tree_size,
            total_expected,
            &votes_sorted,
        );

        assert_eq!(commitment1, commitment2);
    }

    #[test]
    fn test_input_commitment_duplicate_indices_deterministic() {
        let election_id = [7u8; 16];
        let bulletin_root = [8u8; 32];
        let tree_size = 5;
        let total_expected = 2;

        let mut vote_a = create_test_vote(1, 1);
        vote_a.commitment = [1u8; 32];

        let mut vote_b = create_test_vote(1, 2);
        vote_b.commitment = [2u8; 32];

        let votes_first = vec![vote_a.clone(), vote_b.clone()];
        let votes_second = vec![vote_b, vote_a];

        let commitment1 = compute_input_commitment_v4(
            &election_id,
            &bulletin_root,
            tree_size,
            total_expected,
            &votes_first,
        );

        let commitment2 = compute_input_commitment_v4(
            &election_id,
            &bulletin_root,
            tree_size,
            total_expected,
            &votes_second,
        );

        assert_eq!(commitment1, commitment2);
    }

    #[test]
    fn test_is_sorted_by_canonical_ordering() {
        let mut duplicate_index_first = create_test_vote(1, 1);
        duplicate_index_first.commitment = [1u8; 32];

        let mut duplicate_index_second = create_test_vote(1, 2);
        duplicate_index_second.commitment = [2u8; 32];

        let sorted_votes = vec![
            duplicate_index_first.clone(),
            duplicate_index_second.clone(),
        ];
        assert!(is_sorted_by_canonical_ordering(&sorted_votes));

        let unsorted_votes = vec![duplicate_index_second, duplicate_index_first];
        assert!(!is_sorted_by_canonical_ordering(&unsorted_votes));
    }
}
