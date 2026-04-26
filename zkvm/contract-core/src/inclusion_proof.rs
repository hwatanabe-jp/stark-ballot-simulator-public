use alloc::vec::Vec;
use risc0_zkvm::sha::{Impl, Sha256};

/// Verify inclusion proof following RFC 6962 / CT semantics.
pub fn verify_inclusion_proof_rfc6962(
    leaf_data: &[u8; 32],
    leaf_index: u32,
    audit_path: &[[u8; 32]],
    tree_root: &[u8; 32],
    tree_size: u32,
) -> bool {
    match fold_inclusion_proof(leaf_data, leaf_index, audit_path, tree_size) {
        Some(computed_root) => computed_root == *tree_root,
        None => false,
    }
}

/// Hash a leaf node with CT-style domain separation.
pub fn hash_leaf(data: &[u8; 32]) -> [u8; 32] {
    const DOMAIN_TAG: &[u8] = b"stark-ballot:leaf|v1";

    let mut input = [0u8; 53];
    input[0] = 0x00;
    input[1..21].copy_from_slice(DOMAIN_TAG);
    input[21..53].copy_from_slice(data);

    let digest = Impl::hash_bytes(&input);
    let mut result = [0u8; 32];
    result.copy_from_slice(digest.as_bytes());
    result
}

/// Hash an internal node with CT-style domain separation.
pub fn hash_internal(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut input = [0u8; 65];
    input[0] = 0x01;
    input[1..33].copy_from_slice(left);
    input[33..65].copy_from_slice(right);

    let digest = Impl::hash_bytes(&input);
    let mut result = [0u8; 32];
    result.copy_from_slice(digest.as_bytes());
    result
}

/// Fold an inclusion proof to the computed root.
pub fn fold_inclusion_proof(
    leaf_data: &[u8; 32],
    leaf_index: u32,
    audit_path: &[[u8; 32]],
    tree_size: u32,
) -> Option<[u8; 32]> {
    if tree_size == 0 || leaf_index >= tree_size {
        return None;
    }

    let mut current_hash = hash_leaf(leaf_data);
    let mut index = leaf_index;
    let mut level_size = tree_size;
    let mut path_iter = audit_path.iter();

    while level_size > 1 {
        if index % 2 == 1 {
            let sibling = path_iter.next()?;
            current_hash = hash_internal(sibling, &current_hash);
        } else if index + 1 == level_size {
            // No sibling on this level; promote current hash unchanged.
        } else {
            let sibling = path_iter.next()?;
            current_hash = hash_internal(&current_hash, sibling);
        }

        index /= 2;
        level_size = level_size.div_ceil(2);
    }

    if path_iter.next().is_some() {
        return None;
    }

    Some(current_hash)
}

/// Compute the root from a leaf and its audit path.
pub fn compute_root_from_proof(
    leaf_data: &[u8; 32],
    leaf_index: u32,
    audit_path: &[[u8; 32]],
    tree_size: u32,
) -> [u8; 32] {
    fold_inclusion_proof(leaf_data, leaf_index, audit_path, tree_size)
        .expect("Invalid inclusion proof")
}

/// Compute a CT Merkle root from already-hashed leaves.
pub fn compute_merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.is_empty() {
        return [0u8; 32];
    }

    if leaves.len() == 1 {
        return leaves[0];
    }

    let mut current_level = leaves.to_vec();

    while current_level.len() > 1 {
        let mut next_level = Vec::with_capacity(current_level.len().div_ceil(2));
        let mut iter = current_level.chunks_exact(2);
        for pair in &mut iter {
            next_level.push(hash_internal(&pair[0], &pair[1]));
        }

        if let Some(rem) = iter.remainder().first() {
            next_level.push(*rem);
        }

        current_level = next_level;
    }

    current_level[0]
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::String;
    use alloc::vec;
    use alloc::vec::Vec;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TsGoldenVectors {
        schema: String,
        cases: Vec<TsGoldenCase>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TsGoldenCase {
        tree_size: u32,
        leaves: Vec<String>,
        root: String,
        proofs: Vec<TsGoldenProof>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TsGoldenProof {
        leaf_index: u32,
        audit_path: Vec<String>,
    }

    fn parse_ts_golden_vectors() -> TsGoldenVectors {
        serde_json::from_str(include_str!("../testdata/rfc6962-ts-golden-vectors.json"))
            .expect("TS RFC6962 golden vectors should parse")
    }

    fn decode_hex_32(value: &str) -> [u8; 32] {
        let bytes = hex::decode(value).expect("fixture hex should decode");
        assert_eq!(bytes.len(), 32, "fixture hex should be 32 bytes");

        let mut result = [0u8; 32];
        result.copy_from_slice(&bytes);
        result
    }

    fn flip_first_bit(mut value: [u8; 32]) -> [u8; 32] {
        value[0] ^= 0x01;
        value
    }

    #[test]
    fn test_leaf_hash_domain_separation() {
        let commitment = [0xAA; 32];
        let leaf_hash = hash_leaf(&commitment);

        let direct_hash = {
            let digest = Impl::hash_bytes(&commitment);
            let mut result = [0u8; 32];
            result.copy_from_slice(digest.as_bytes());
            result
        };

        assert_ne!(leaf_hash, direct_hash);
    }

    #[test]
    fn test_single_element_tree() {
        let leaf_data = [0x11; 32];
        let tree_root = hash_leaf(&leaf_data);

        let valid = verify_inclusion_proof_rfc6962(&leaf_data, 0, &[], &tree_root, 1);
        assert!(valid);
    }

    #[test]
    fn test_two_element_tree() {
        let leaf1 = [0x11; 32];
        let leaf2 = [0x22; 32];

        let hash1 = hash_leaf(&leaf1);
        let hash2 = hash_leaf(&leaf2);
        let root = hash_internal(&hash1, &hash2);

        assert!(verify_inclusion_proof_rfc6962(
            &leaf1,
            0,
            &[hash2],
            &root,
            2
        ));
        assert!(verify_inclusion_proof_rfc6962(
            &leaf2,
            1,
            &[hash1],
            &root,
            2
        ));
    }

    #[test]
    fn test_invalid_proof() {
        let leaf_data = [0x55; 32];
        let wrong_root = [0xFF; 32];
        let audit_path = vec![[0x66; 32]];

        let valid = verify_inclusion_proof_rfc6962(&leaf_data, 0, &audit_path, &wrong_root, 2);
        assert!(!valid);
    }

    #[test]
    fn test_three_element_tree_inclusion_paths() {
        let leaves = [[0x11; 32], [0x22; 32], [0x33; 32]];

        let h0 = hash_leaf(&leaves[0]);
        let h1 = hash_leaf(&leaves[1]);
        let h2 = hash_leaf(&leaves[2]);

        let left_subtree = hash_internal(&h0, &h1);
        let root = hash_internal(&left_subtree, &h2);

        let audit_path_leaf2 = [left_subtree];
        let recomputed_leaf2 = compute_root_from_proof(&leaves[2], 2, &audit_path_leaf2, 3);
        assert_eq!(recomputed_leaf2, root);
        assert!(verify_inclusion_proof_rfc6962(
            &leaves[2],
            2,
            &audit_path_leaf2,
            &root,
            3
        ));
    }

    #[test]
    fn ts_generated_rfc6962_golden_vectors_round_trip_in_rust() {
        let vectors = parse_ts_golden_vectors();
        assert_eq!(vectors.schema, "stark-ballot:rfc6962-ts-golden-vectors|v1");

        let covered_sizes: Vec<u32> = vectors.cases.iter().map(|case| case.tree_size).collect();
        assert_eq!(covered_sizes, vec![1, 2, 3, 5, 7, 8, 9, 64]);

        for case in &vectors.cases {
            assert_eq!(case.leaves.len(), case.tree_size as usize);
            assert_eq!(case.proofs.len(), case.tree_size as usize);

            let leaves: Vec<[u8; 32]> =
                case.leaves.iter().map(|leaf| decode_hex_32(leaf)).collect();
            let hashed_leaves: Vec<[u8; 32]> = leaves.iter().map(hash_leaf).collect();
            let expected_root = decode_hex_32(&case.root);

            assert_eq!(compute_merkle_root(&hashed_leaves), expected_root);

            for proof in &case.proofs {
                let audit_path: Vec<[u8; 32]> = proof
                    .audit_path
                    .iter()
                    .map(|node| decode_hex_32(node))
                    .collect();

                assert!(proof.leaf_index < case.tree_size);
                assert!(verify_inclusion_proof_rfc6962(
                    &leaves[proof.leaf_index as usize],
                    proof.leaf_index,
                    &audit_path,
                    &expected_root,
                    case.tree_size,
                ));
            }
        }
    }

    #[test]
    fn ts_generated_rfc6962_golden_vectors_reject_tampering_in_rust() {
        let vectors = parse_ts_golden_vectors();

        for case in &vectors.cases {
            let leaves: Vec<[u8; 32]> =
                case.leaves.iter().map(|leaf| decode_hex_32(leaf)).collect();
            let expected_root = decode_hex_32(&case.root);

            for proof in &case.proofs {
                let leaf = leaves[proof.leaf_index as usize];
                let audit_path: Vec<[u8; 32]> = proof
                    .audit_path
                    .iter()
                    .map(|node| decode_hex_32(node))
                    .collect();

                assert!(!verify_inclusion_proof_rfc6962(
                    &flip_first_bit(leaf),
                    proof.leaf_index,
                    &audit_path,
                    &expected_root,
                    case.tree_size,
                ));

                assert!(!verify_inclusion_proof_rfc6962(
                    &leaf,
                    proof.leaf_index,
                    &audit_path,
                    &flip_first_bit(expected_root),
                    case.tree_size,
                ));

                if let Some(first_node) = audit_path.first() {
                    let mut tampered_path = audit_path.clone();
                    tampered_path[0] = flip_first_bit(*first_node);

                    assert!(!verify_inclusion_proof_rfc6962(
                        &leaf,
                        proof.leaf_index,
                        &tampered_path,
                        &expected_root,
                        case.tree_size,
                    ));
                }

                if case.tree_size > 1 {
                    let tampered_index = (proof.leaf_index + 1) % case.tree_size;

                    assert!(!verify_inclusion_proof_rfc6962(
                        &leaf,
                        tampered_index,
                        &audit_path,
                        &expected_root,
                        case.tree_size,
                    ));
                }
            }
        }
    }
}
