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
    let data = encode_input_commitment_preimage(
        election_id,
        bulletin_root,
        tree_size,
        total_expected,
        votes,
    );
    let digest = Impl::hash_bytes(&data);
    let mut result = [0u8; 32];
    result.copy_from_slice(digest.as_bytes());
    result
}

fn encode_input_commitment_preimage(
    election_id: &[u8; 16],
    bulletin_root: &[u8; 32],
    tree_size: u32,
    total_expected: u32,
    votes: &[VoteWithProof],
) -> Vec<u8> {
    let mut data = Vec::with_capacity(encoded_prefix_len() + encoded_votes_len(votes));

    data.extend_from_slice(INPUT_DOMAIN_TAG);
    data.extend_from_slice(&10u32.to_le_bytes());
    data.extend_from_slice(election_id);
    data.extend_from_slice(bulletin_root);
    data.extend_from_slice(&tree_size.to_le_bytes());
    data.extend_from_slice(&total_expected.to_le_bytes());
    data.extend_from_slice(&checked_vote_count(votes.len()).to_le_bytes());

    let mut sorted_indices: Vec<usize> = (0..votes.len()).collect();
    sorted_indices.sort_by(|&a, &b| compare_votes(&votes[a], &votes[b]));

    for index in sorted_indices {
        let vote = &votes[index];
        encode_vote(&mut data, vote);
    }

    data
}

fn encode_vote(data: &mut Vec<u8>, vote: &VoteWithProof) {
    data.extend_from_slice(&vote.index.to_le_bytes());
    data.extend_from_slice(&32u16.to_le_bytes());
    data.extend_from_slice(&vote.commitment);
    data.extend_from_slice(&checked_merkle_path_len(vote.merkle_path.len()).to_le_bytes());

    for node in &vote.merkle_path {
        data.extend_from_slice(node);
    }
}

fn checked_vote_count(len: usize) -> u32 {
    u32::try_from(len).expect("input commitment vote count exceeds u32 encoding")
}

fn checked_merkle_path_len(len: usize) -> u16 {
    u16::try_from(len).expect("input commitment merkle path length exceeds u16 encoding")
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
    use alloc::string::String;
    use alloc::vec;
    use alloc::vec::Vec;
    use serde::Deserialize;
    use sha2::{Digest, Sha256};

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

    #[test]
    #[should_panic(expected = "input commitment merkle path length exceeds u16 encoding")]
    fn test_input_commitment_rejects_u16_path_length_overflow() {
        checked_merkle_path_len(usize::from(u16::MAX) + 1);
    }

    #[test]
    #[cfg(target_pointer_width = "64")]
    #[should_panic(expected = "input commitment vote count exceeds u32 encoding")]
    fn test_input_commitment_rejects_u32_vote_count_overflow() {
        checked_vote_count(u32::MAX as usize + 1);
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FormalInputCommitmentCase {
        election_id: String,
        bulletin_root: String,
        tree_size: u32,
        total_expected: u32,
        votes: Vec<FormalVote>,
        expected_canonical_order: Vec<String>,
        expected_encoded_bytes_hex: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FormalVote {
        id: String,
        index: u32,
        commitment: String,
        merkle_path: Vec<String>,
    }

    fn parse_hex<const N: usize>(value: &str) -> [u8; N] {
        let normalized = value.strip_prefix("0x").unwrap_or(value);
        let bytes = hex::decode(normalized).expect("formal vector hex should decode");
        bytes
            .try_into()
            .unwrap_or_else(|_| panic!("formal vector hex should be {N} bytes"))
    }

    fn parse_uuid_bytes(value: &str) -> [u8; 16] {
        parse_hex(&value.replace('-', ""))
    }

    fn parse_vote(value: &FormalVote) -> VoteWithProof {
        VoteWithProof {
            commitment: parse_hex(&value.commitment),
            choice: 0,
            random: [0u8; 32],
            index: value.index,
            merkle_path: value
                .merkle_path
                .iter()
                .map(|node| parse_hex(node))
                .collect(),
        }
    }

    fn vote_key(vote: &VoteWithProof) -> (u32, [u8; 32], Vec<[u8; 32]>) {
        (vote.index, vote.commitment, vote.merkle_path.clone())
    }

    #[test]
    fn test_formal_input_commitment_vectors() {
        let cases: Vec<FormalInputCommitmentCase> = serde_json::from_str(include_str!(
            "../../../docs/current/formal/generated-vectors/input-commitment-cases.json"
        ))
        .expect("formal input commitment vectors should parse");

        for case in cases {
            let election_id = parse_uuid_bytes(&case.election_id);
            let bulletin_root = parse_hex(&case.bulletin_root);
            let votes: Vec<VoteWithProof> = case.votes.iter().map(parse_vote).collect();
            let expected_encoded_bytes = hex::decode(&case.expected_encoded_bytes_hex)
                .expect("expected preimage hex should decode");

            let mut sorted_votes = votes.clone();
            sorted_votes.sort_by(compare_votes);
            let canonical_ids: Vec<String> = sorted_votes
                .iter()
                .map(|sorted_vote| {
                    case.votes
                        .iter()
                        .find(|formal_vote| {
                            vote_key(&parse_vote(formal_vote)) == vote_key(sorted_vote)
                        })
                        .expect("sorted vote should have formal id")
                        .id
                        .clone()
                })
                .collect();

            let encoded = encode_input_commitment_preimage(
                &election_id,
                &bulletin_root,
                case.tree_size,
                case.total_expected,
                &votes,
            );
            let commitment = compute_input_commitment_v4(
                &election_id,
                &bulletin_root,
                case.tree_size,
                case.total_expected,
                &votes,
            );
            let expected_digest: [u8; 32] = Sha256::digest(&expected_encoded_bytes).into();

            assert_eq!(canonical_ids, case.expected_canonical_order);
            assert_eq!(encoded, expected_encoded_bytes);
            assert_eq!(commitment, expected_digest);
        }
    }
}
