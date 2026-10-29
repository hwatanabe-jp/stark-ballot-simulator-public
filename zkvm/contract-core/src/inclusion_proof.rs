use alloc::vec::Vec;
use risc0_zkvm::sha::{Impl, Sha256};

use crate::domain::{BulletinIndex, TreeSize, ValidatedAuditPath};

/// Verify inclusion proof following RFC 6962 / CT semantics.
pub fn verify_inclusion_proof_rfc6962(
    leaf_data: &[u8; 32],
    leaf_index: u32,
    audit_path: &[[u8; 32]],
    tree_root: &[u8; 32],
    tree_size: u32,
) -> bool {
    let Ok(tree_size) = TreeSize::new(tree_size) else {
        return false;
    };
    let Ok(leaf_index) = BulletinIndex::new(leaf_index, tree_size) else {
        return false;
    };
    let Ok(validated_path) = ValidatedAuditPath::validate(tree_size, leaf_index, audit_path) else {
        return false;
    };

    verify_validated_inclusion_proof_rfc6962(leaf_data, validated_path, tree_root)
}

/// Verify an inclusion proof after tree size, leaf index, and path shape have
/// already been validated together.
pub fn verify_validated_inclusion_proof_rfc6962(
    leaf_data: &[u8; 32],
    audit_path: ValidatedAuditPath<'_>,
    tree_root: &[u8; 32],
) -> bool {
    fold_validated_inclusion_proof(leaf_data, audit_path) == *tree_root
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
    let tree_size = TreeSize::new(tree_size).ok()?;
    let leaf_index = BulletinIndex::new(leaf_index, tree_size).ok()?;
    let audit_path = ValidatedAuditPath::validate(tree_size, leaf_index, audit_path).ok()?;

    Some(fold_validated_inclusion_proof(leaf_data, audit_path))
}

fn fold_validated_inclusion_proof(
    leaf_data: &[u8; 32],
    audit_path: ValidatedAuditPath<'_>,
) -> [u8; 32] {
    let mut current_hash = hash_leaf(leaf_data);
    let mut index = audit_path.leaf_index().get();
    let mut level_size = audit_path.tree_size().get();
    let mut path_iter = audit_path.nodes().iter();

    while level_size > 1 {
        if index % 2 == 1 {
            let sibling = path_iter
                .next()
                .expect("validated RFC6962 audit path should contain left sibling");
            current_hash = hash_internal(sibling, &current_hash);
        } else if index + 1 == level_size {
            // No sibling on this level; promote current hash unchanged.
        } else {
            let sibling = path_iter
                .next()
                .expect("validated RFC6962 audit path should contain right sibling");
            current_hash = hash_internal(&current_hash, sibling);
        }

        index /= 2;
        level_size = level_size.div_ceil(2);
    }

    current_hash
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
        let (pairs, remainder) = current_level.as_chunks::<2>();
        for pair in pairs {
            next_level.push(hash_internal(&pair[0], &pair[1]));
        }

        if let Some(rem) = remainder.first() {
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
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct TsGoldenVectors {
        schema: String,
        #[serde(rename = "generatedBy")]
        _generated_by: String,
        cases: Vec<TsGoldenCase>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct TsGoldenCase {
        tree_size: u32,
        leaves: Vec<String>,
        root: String,
        proofs: Vec<TsGoldenProof>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    fn reviewed_fixed_root_vectors_cover_empty_power_of_two_and_odd_trees() {
        let leaves: Vec<[u8; 32]> = [
            "4d5a9584d985e8fb44015a8affa9b76f1ff16f65e61df7156d8e8159e1448978",
            "d103cfb5e499c566904787533afbdec56f95492d67fc00e2c0d0161ba99653f1",
            "5038da95330ba16edb486954197e37eb777c3047327ca54df4199c35c5edc17a",
            "f2764fd79fdab5132fc349ba555c9c56ff0c935c889c17ebe3d61315d780934e",
            "565fb0e0cefe32cf4000e4a67ddec8820111a733aa8ba010d242a5fe477e04c4",
        ]
        .iter()
        .map(|leaf| decode_hex_32(leaf))
        .collect();
        let hashed_leaves: Vec<[u8; 32]> = leaves.iter().map(hash_leaf).collect();
        let empty_root = Impl::hash_bytes(&[]);

        let actual_roots = vec![
            hex::encode(empty_root.as_bytes()),
            hex::encode(compute_merkle_root(&hashed_leaves[..1])),
            hex::encode(compute_merkle_root(&hashed_leaves[..2])),
            hex::encode(compute_merkle_root(&hashed_leaves[..4])),
            hex::encode(compute_merkle_root(&hashed_leaves[..5])),
        ];
        let expected_roots = vec![
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "b089dd645b2222877852a1873580e50a66fb463fee184dbc734224c4ee1e5d06",
            "33e32ea1ae0ad2fb4349df42021702b680127fff927526fb41ff3770d7f8dd41",
            "77eacf9bc18b97c9e11f7131cda0593c707f7d73c77afad01ee83eb708e9105c",
            "2a278fbb796b135a154966d522a0cd90424cc4cd014c8acc6d9b8a7293a4d365",
        ];

        assert_eq!(actual_roots, expected_roots);
    }

    #[test]
    fn ts_generated_rfc6962_golden_vectors_round_trip_in_rust() {
        let vectors = parse_ts_golden_vectors();
        assert_eq!(vectors.schema, "stark-ballot:rfc6962-ts-golden-vectors|v1");
        assert_eq!(
            vectors._generated_by,
            "scripts/tests/generate-rfc6962-golden-vectors.ts"
        );

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
    fn ts_generated_rfc6962_golden_vectors_reject_unknown_keys_at_every_level() {
        let source = include_str!("../testdata/rfc6962-ts-golden-vectors.json");
        for pointer in ["", "/cases/0", "/cases/0/proofs/0"] {
            let mut value: serde_json::Value =
                serde_json::from_str(source).expect("RFC6962 fixture should parse as JSON");
            value
                .pointer_mut(pointer)
                .and_then(serde_json::Value::as_object_mut)
                .expect("reviewed RFC6962 fixture pointer should identify an object")
                .insert(String::from("retired"), serde_json::Value::Bool(true));

            assert!(
                serde_json::from_value::<TsGoldenVectors>(value).is_err(),
                "unknown key at {pointer} must fail closed"
            );
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
