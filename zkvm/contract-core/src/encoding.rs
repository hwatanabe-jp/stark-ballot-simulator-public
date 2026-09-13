use alloc::string::{String, ToString};
use alloc::vec::Vec;
use core::cmp::Ordering;
use risc0_zkvm::sha::{Impl, Sha256};

use crate::types::VoteWithProof;

pub const INPUT_COMMITMENT_DOMAIN_TAG: &[u8] = b"stark-ballot:input|v1.0";
pub const INPUT_COMMITMENT_FORMAT_VERSION: u32 = 10;

/// Compute input commitment with canonical encoding.
pub fn compute_input_commitment_v4(
    election_id: &[u8; 16],
    bulletin_root: &[u8; 32],
    tree_size: u32,
    total_expected: u32,
    votes: &[VoteWithProof],
) -> Result<[u8; 32], String> {
    let data = encode_input_commitment_preimage(
        election_id,
        bulletin_root,
        tree_size,
        total_expected,
        votes,
    )?;
    let digest = Impl::hash_bytes(&data);
    let mut result = [0u8; 32];
    result.copy_from_slice(digest.as_bytes());
    Ok(result)
}

fn encode_input_commitment_preimage(
    election_id: &[u8; 16],
    bulletin_root: &[u8; 32],
    tree_size: u32,
    total_expected: u32,
    votes: &[VoteWithProof],
) -> Result<Vec<u8>, String> {
    let mut data = Vec::with_capacity(encoded_prefix_len() + encoded_votes_len(votes));

    data.extend_from_slice(INPUT_COMMITMENT_DOMAIN_TAG);
    data.extend_from_slice(&INPUT_COMMITMENT_FORMAT_VERSION.to_le_bytes());
    data.extend_from_slice(election_id);
    data.extend_from_slice(bulletin_root);
    data.extend_from_slice(&tree_size.to_le_bytes());
    data.extend_from_slice(&total_expected.to_le_bytes());
    data.extend_from_slice(&checked_vote_count(votes.len())?.to_le_bytes());

    if is_sorted_by_canonical_ordering(votes) {
        for vote in votes {
            encode_vote(&mut data, vote)?;
        }
    } else {
        let mut sorted_indices: Vec<usize> = (0..votes.len()).collect();
        sorted_indices.sort_by(|&a, &b| compare_votes(&votes[a], &votes[b]));

        for index in sorted_indices {
            let vote = &votes[index];
            encode_vote(&mut data, vote)?;
        }
    }

    Ok(data)
}

fn encode_vote(data: &mut Vec<u8>, vote: &VoteWithProof) -> Result<(), String> {
    data.extend_from_slice(&vote.index.to_le_bytes());
    data.extend_from_slice(&32u16.to_le_bytes());
    data.extend_from_slice(&vote.commitment);
    data.extend_from_slice(&checked_merkle_path_len(vote.merkle_path.len())?.to_le_bytes());

    for node in &vote.merkle_path {
        data.extend_from_slice(node);
    }

    Ok(())
}

fn checked_vote_count(len: usize) -> Result<u32, String> {
    u32::try_from(len).map_err(|_| "input commitment vote count exceeds u32 encoding".to_string())
}

fn checked_merkle_path_len(len: usize) -> Result<u16, String> {
    u16::try_from(len)
        .map_err(|_| "input commitment merkle path length exceeds u16 encoding".to_string())
}

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
    INPUT_COMMITMENT_DOMAIN_TAG.len() + 4 + 16 + 32 + 4 + 4 + 4
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
    use crate::{
        CURRENT_METHOD_VERSION, MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD,
        MAX_GUEST_SERIALIZED_INPUT_BYTES, MAX_GUEST_TOTAL_EXPECTED, MAX_GUEST_TOTAL_PATH_NODES,
        MAX_GUEST_TREE_SIZE, MAX_GUEST_VOTE_COUNT, VERIFIED_TALLY_WIDTH,
    };
    use alloc::string::String;
    use alloc::vec;
    use alloc::vec::Vec;
    use serde::Deserialize;
    use sha2::{Digest, Sha256};

    mod formal_vector_test_support {
        include!("formal_vector_test_support.rs");
    }
    use formal_vector_test_support::{
        admit_current_formal_vector, FormalVectorEnvelope, FormalVectorModeledBounds,
    };

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
        )
        .expect("input commitment should encode");

        let commitment2 = compute_input_commitment_v4(
            &election_id,
            &bulletin_root,
            tree_size,
            total_expected,
            &votes_sorted,
        )
        .expect("input commitment should encode");

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
        )
        .expect("input commitment should encode");

        let commitment2 = compute_input_commitment_v4(
            &election_id,
            &bulletin_root,
            tree_size,
            total_expected,
            &votes_second,
        )
        .expect("input commitment should encode");

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
    fn test_input_commitment_rejects_u16_path_length_overflow() {
        assert_eq!(
            checked_merkle_path_len(usize::from(u16::MAX) + 1),
            Err("input commitment merkle path length exceeds u16 encoding".to_string())
        );
    }

    #[test]
    #[cfg(target_pointer_width = "64")]
    fn test_input_commitment_rejects_u32_vote_count_overflow() {
        assert_eq!(
            checked_vote_count(u32::MAX as usize + 1),
            Err("input commitment vote count exceeds u32 encoding".to_string())
        );
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct FormalInputCommitmentCase {
        #[serde(rename = "name")]
        _name: String,
        election_id: String,
        bulletin_root: String,
        tree_size: u32,
        total_expected: u32,
        votes: Vec<FormalVote>,
        expected_canonical_order: Vec<String>,
        expected_encoded_bytes_hex: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
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

    fn assert_formal_vector_bounds(bounds: &FormalVectorModeledBounds) {
        assert_eq!(
            bounds.input_commitment.format_version,
            INPUT_COMMITMENT_FORMAT_VERSION
        );
        assert_eq!(bounds.input_commitment.u16_max, u32::from(u16::MAX));
        assert_eq!(bounds.input_commitment.u32_max, u64::from(u32::MAX));
        assert_eq!(bounds.guest.method_version, CURRENT_METHOD_VERSION);
        assert_eq!(bounds.guest.tree_size_max, MAX_GUEST_TREE_SIZE);
        assert_eq!(bounds.guest.total_expected_max, MAX_GUEST_TOTAL_EXPECTED);
        assert_eq!(bounds.guest.vote_count_max, MAX_GUEST_VOTE_COUNT);
        assert_eq!(
            bounds.guest.merkle_path_nodes_per_record_max,
            MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD
        );
        assert_eq!(
            bounds.guest.total_merkle_path_nodes_max,
            MAX_GUEST_TOTAL_PATH_NODES
        );
        assert_eq!(
            bounds.guest.serialized_input_bytes_max,
            MAX_GUEST_SERIALIZED_INPUT_BYTES
        );
        assert_eq!(bounds.guest.tally_width, VERIFIED_TALLY_WIDTH);
        assert_eq!(bounds.guest.tally_bucket_max, MAX_GUEST_TREE_SIZE);
    }

    #[test]
    fn test_formal_input_commitment_vectors() {
        let envelope: FormalVectorEnvelope<FormalInputCommitmentCase> =
            admit_current_formal_vector(
                include_str!("../../../docs/formal/generated-vectors/input-commitment-cases.json"),
                "input-commitment-cases",
            )
            .expect("formal input commitment vectors should admit");
        assert_formal_vector_bounds(&envelope.modeled_bounds);

        for case in envelope.payload {
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
            )
            .expect("formal input commitment preimage should encode");
            let commitment = compute_input_commitment_v4(
                &election_id,
                &bulletin_root,
                case.tree_size,
                case.total_expected,
                &votes,
            )
            .expect("formal input commitment should encode");
            let expected_digest: [u8; 32] = Sha256::digest(&expected_encoded_bytes).into();

            assert_eq!(canonical_ids, case.expected_canonical_order);
            assert_eq!(encoded, expected_encoded_bytes);
            assert_eq!(commitment, expected_digest);
        }
    }

    #[test]
    fn test_formal_input_commitment_envelope_rejects_unknown_keys() {
        let source =
            include_str!("../../../docs/formal/generated-vectors/input-commitment-cases.json");
        let unknown_envelope = source.replacen('{', "{\"schemaVersion\":1,", 1);
        let result = admit_current_formal_vector::<FormalInputCommitmentCase>(
            &unknown_envelope,
            "input-commitment-cases",
        );
        assert!(result.is_err());

        let unknown_case = source.replacen(
            "\"name\": \"minimal-one-vote\"",
            "\"unexpected\": true, \"name\": \"minimal-one-vote\"",
            1,
        );
        let result = admit_current_formal_vector::<FormalInputCommitmentCase>(
            &unknown_case,
            "input-commitment-cases",
        );
        assert!(result.is_err());

        let fingerprint_drift = source.replacen("minimal-one-vote", "drifted-one-vote", 1);
        let result = admit_current_formal_vector::<FormalInputCommitmentCase>(
            &fingerprint_drift,
            "input-commitment-cases",
        );
        assert!(result.is_err());
    }
}
