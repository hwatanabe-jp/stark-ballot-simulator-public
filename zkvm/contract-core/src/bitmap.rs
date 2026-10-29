use alloc::vec;
use alloc::vec::Vec;

use crate::domain::{BitmapBitIndex, BitmapLeafIndex, PackedBitmap};
use crate::inclusion_proof::{compute_merkle_root, hash_leaf};

pub const BITMAP_CHUNK_BYTES: usize = 32;
pub const BITMAP_CHUNK_BITS: usize = BITMAP_CHUNK_BYTES * 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BitmapAuditPathPosition {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BitmapAuditPathNode {
    pub hash: [u8; 32],
    pub position: BitmapAuditPathPosition,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BitmapMerkleProof {
    pub leaf_chunk: [u8; 32],
    pub audit_path: Vec<BitmapAuditPathNode>,
    pub leaf_index: usize,
    pub bit_index: usize,
}

/// Compute the CT Merkle root of a bitmap packed into 32-byte leaves.
pub fn compute_bitmap_merkle_root(bitmap: &[bool]) -> [u8; 32] {
    let leaves = bitmap_leaf_hashes(bitmap);

    compute_merkle_root(&leaves)
}

pub fn generate_bitmap_merkle_proof(
    bitmap: &[bool],
    bit_index: usize,
) -> Option<BitmapMerkleProof> {
    if bitmap.is_empty() {
        return None;
    }

    let bit_index = BitmapBitIndex::new(bit_index, bitmap.len()).ok()?;
    let leaf_index = BitmapLeafIndex::from_bit_index(bit_index).get();
    let leaf_chunk = bitmap_leaf_chunk(bitmap, leaf_index);
    let levels = bitmap_merkle_tree_levels(bitmap);
    let mut audit_path = Vec::new();
    let mut current_index = leaf_index;

    for level in levels.iter().take_while(|level| level.len() > 1) {
        let sibling_index = if current_index.is_multiple_of(2) {
            current_index + 1
        } else {
            current_index - 1
        };
        if let Some(sibling) = level.get(sibling_index) {
            audit_path.push(BitmapAuditPathNode {
                hash: *sibling,
                position: if current_index.is_multiple_of(2) {
                    BitmapAuditPathPosition::Right
                } else {
                    BitmapAuditPathPosition::Left
                },
            });
        }
        current_index /= 2;
    }

    Some(BitmapMerkleProof {
        leaf_chunk,
        audit_path,
        leaf_index,
        bit_index: bit_index.get(),
    })
}

fn bitmap_leaf_hashes(bitmap: &[bool]) -> Vec<[u8; 32]> {
    let packed_bytes = pack_bits_to_bytes(bitmap);
    let leaf_count = bitmap_leaf_count(bitmap.len());
    let mut leaves: Vec<[u8; 32]> = Vec::with_capacity(leaf_count);
    for leaf_index in 0..leaf_count {
        leaves.push(hash_leaf(&bitmap_leaf_chunk_from_packed(
            &packed_bytes,
            leaf_index,
        )));
    }

    leaves
}

fn bitmap_merkle_tree_levels(bitmap: &[bool]) -> Vec<Vec<[u8; 32]>> {
    let mut levels = vec![bitmap_leaf_hashes(bitmap)];
    while levels.last().map(|level| level.len()).unwrap_or(0) > 1 {
        let current = levels.last().expect("level exists");
        let mut next = Vec::with_capacity(current.len().div_ceil(2));
        let (pairs, remainder) = current.as_chunks::<2>();
        for pair in pairs {
            next.push(crate::inclusion_proof::hash_internal(&pair[0], &pair[1]));
        }
        if let Some(rem) = remainder.first() {
            next.push(*rem);
        }
        levels.push(next);
    }
    levels
}

fn bitmap_leaf_chunk(bitmap: &[bool], leaf_index: usize) -> [u8; 32] {
    bitmap_leaf_chunk_from_packed(&pack_bits_to_bytes(bitmap), leaf_index)
}

fn bitmap_leaf_chunk_from_packed(packed_bytes: &[u8], leaf_index: usize) -> [u8; 32] {
    let start = leaf_index * BITMAP_CHUNK_BYTES;
    let end = core::cmp::min(start + BITMAP_CHUNK_BYTES, packed_bytes.len());
    let mut leaf = [0u8; BITMAP_CHUNK_BYTES];
    if start < packed_bytes.len() {
        leaf[..end - start].copy_from_slice(&packed_bytes[start..end]);
    }
    leaf
}

fn bitmap_leaf_count(bit_len: usize) -> usize {
    core::cmp::max(1, bit_len.div_ceil(BITMAP_CHUNK_BITS))
}

fn pack_bits_to_bytes(bits: &[bool]) -> Vec<u8> {
    PackedBitmap::from_bits(bits).bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CURRENT_METHOD_VERSION, INPUT_COMMITMENT_FORMAT_VERSION,
        MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD, MAX_GUEST_SERIALIZED_INPUT_BYTES,
        MAX_GUEST_TOTAL_EXPECTED, MAX_GUEST_TOTAL_PATH_NODES, MAX_GUEST_TREE_SIZE,
        MAX_GUEST_VOTE_COUNT, VERIFIED_TALLY_WIDTH,
    };
    use alloc::string::String;
    use alloc::vec::Vec;
    use risc0_zkvm::sha::{Impl, Sha256};
    use serde::Deserialize;

    mod formal_vector_test_support {
        include!("formal_vector_test_support.rs");
    }
    use formal_vector_test_support::{
        admit_current_formal_vector, FormalVectorEnvelope, FormalVectorModeledBounds,
    };

    #[test]
    fn test_pack_bits_to_bytes_lsb_first() {
        let bits = vec![true, false, true, false, false, false, false, false];
        let bytes = pack_bits_to_bytes(&bits);
        assert_eq!(bytes, vec![0x05]);

        let bits = vec![
            true, true, true, true, true, true, true, true, true, true, true, true, false, false,
            false, false,
        ];
        let bytes = pack_bits_to_bytes(&bits);
        assert_eq!(bytes, vec![0xFF, 0x0F]);
    }

    #[test]
    fn test_bitmap_single_vote() {
        let mut bitmap = vec![false; 8];
        bitmap[0] = true;

        let root = compute_bitmap_merkle_root(&bitmap);
        let mut bitmap2 = vec![false; 8];
        bitmap2[3] = true;

        let root2 = compute_bitmap_merkle_root(&bitmap2);
        assert_ne!(root, root2);
    }

    #[test]
    fn test_ct_style_hashing() {
        let data = [0xAAu8; 32];
        let leaf_hash = hash_leaf(&data);

        let direct_hash = {
            let digest = Impl::hash_bytes(&data);
            let mut result = [0u8; 32];
            result.copy_from_slice(digest.as_bytes());
            result
        };

        assert_ne!(leaf_hash, direct_hash);
    }

    #[test]
    fn test_merkle_tree_construction() {
        let leaves = vec![[1u8; 32], [2u8; 32], [3u8; 32], [4u8; 32]];

        let root = compute_merkle_root(&leaves);
        let mut leaves2 = leaves.clone();
        leaves2[2] = [5u8; 32];
        let root2 = compute_merkle_root(&leaves2);
        assert_ne!(root, root2);
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct FormalBitmapCase {
        #[serde(rename = "name")]
        _name: String,
        bit_length: usize,
        true_indices: Vec<usize>,
        expected_packed_byte_length: usize,
        expected_packed_bytes_hex: String,
        probes: Vec<FormalBitmapProbe>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct FormalBitmapProbe {
        bit_index: usize,
        byte_index: usize,
        bit_index_in_byte: usize,
        expected_value: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct BitmapTsGoldenVectors {
        envelope_type: String,
        generated_by: String,
        cases: Vec<BitmapTsGoldenCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct BitmapTsGoldenCase {
        name: String,
        bit_length: usize,
        true_indices: Vec<usize>,
        probes: Vec<usize>,
        root: String,
        proofs: Vec<BitmapTsGoldenProof>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct BitmapTsGoldenProof {
        leaf_chunk: String,
        audit_path: Vec<BitmapTsGoldenAuditNode>,
        leaf_index: usize,
        bit_index: usize,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct BitmapTsGoldenAuditNode {
        hash: String,
        position: String,
    }

    fn formal_bitmap(case: &FormalBitmapCase) -> Vec<bool> {
        let mut bitmap = vec![false; case.bit_length];
        for index in &case.true_indices {
            bitmap[*index] = true;
        }
        bitmap
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

    fn ts_golden_bitmap(case: &BitmapTsGoldenCase) -> Vec<bool> {
        let mut bitmap = vec![false; case.bit_length];
        for index in &case.true_indices {
            bitmap[*index] = true;
        }
        bitmap
    }

    fn decode_hex_32(value: &str) -> [u8; 32] {
        let normalized = value.strip_prefix("0x").unwrap_or(value);
        let bytes = hex::decode(normalized).expect("fixture hex should decode");
        assert_eq!(bytes.len(), 32, "fixture hex should be 32 bytes");
        let mut result = [0u8; 32];
        result.copy_from_slice(&bytes);
        result
    }

    fn expected_position(value: &str) -> BitmapAuditPathPosition {
        match value {
            "left" => BitmapAuditPathPosition::Left,
            "right" => BitmapAuditPathPosition::Right,
            other => panic!("unexpected bitmap proof position: {other}"),
        }
    }

    #[test]
    fn test_formal_bitmap_vectors_lsb_first() {
        let envelope: FormalVectorEnvelope<FormalBitmapCase> = admit_current_formal_vector(
            include_str!("../../../docs/formal/generated-vectors/bitmap-cases.json"),
            "bitmap-cases",
        )
        .expect("formal bitmap vectors should admit");
        assert_formal_vector_bounds(&envelope.modeled_bounds);

        for case in envelope.payload {
            let bitmap = formal_bitmap(&case);
            let packed = pack_bits_to_bytes(&bitmap);
            let expected_packed = hex::decode(&case.expected_packed_bytes_hex)
                .expect("expected packed bitmap hex should decode");

            assert_eq!(packed.len(), case.expected_packed_byte_length);
            assert_eq!(packed, expected_packed);

            for probe in &case.probes {
                assert_eq!(probe.byte_index, probe.bit_index / 8);
                assert_eq!(probe.bit_index_in_byte, probe.bit_index % 8);
                assert_eq!(
                    (packed[probe.byte_index] & (1 << probe.bit_index_in_byte)) != 0,
                    probe.expected_value
                );
            }

            compute_bitmap_merkle_root(&bitmap);
        }
    }

    #[test]
    fn test_typescript_bitmap_root_and_proof_golden_vectors() {
        let vectors: BitmapTsGoldenVectors =
            serde_json::from_str(include_str!("../testdata/bitmap-ts-golden-vectors.json"))
                .expect("TS bitmap golden vectors should parse");

        assert_eq!(
            vectors.envelope_type,
            "stark-ballot.bitmap-proof-parity.current"
        );
        assert_eq!(
            vectors.generated_by,
            "scripts/tests/generate-bitmap-golden-vectors.ts"
        );

        for case in vectors.cases {
            assert!(
                !case.name.is_empty(),
                "bitmap golden case name must be present"
            );
            let bitmap = ts_golden_bitmap(&case);
            assert_eq!(
                compute_bitmap_merkle_root(&bitmap),
                decode_hex_32(&case.root)
            );
            assert_eq!(
                case.probes,
                case.proofs
                    .iter()
                    .map(|proof| proof.bit_index)
                    .collect::<Vec<_>>()
            );

            for expected in case.proofs {
                let proof = generate_bitmap_merkle_proof(&bitmap, expected.bit_index)
                    .expect("proof should generate for fixture bit");
                assert_eq!(proof.leaf_chunk, decode_hex_32(&expected.leaf_chunk));
                assert_eq!(proof.leaf_index, expected.leaf_index);
                assert_eq!(proof.bit_index, expected.bit_index);
                assert_eq!(proof.audit_path.len(), expected.audit_path.len());

                for (actual_node, expected_node) in
                    proof.audit_path.iter().zip(expected.audit_path.iter())
                {
                    assert_eq!(actual_node.hash, decode_hex_32(&expected_node.hash));
                    assert_eq!(
                        actual_node.position,
                        expected_position(&expected_node.position)
                    );
                }
            }
        }
    }

    #[test]
    fn typescript_bitmap_golden_vectors_reject_unknown_keys_at_every_level() {
        let source = include_str!("../testdata/bitmap-ts-golden-vectors.json");
        for pointer in [
            "",
            "/cases/0",
            "/cases/0/proofs/0",
            "/cases/3/proofs/0/auditPath/0",
        ] {
            let mut value: serde_json::Value =
                serde_json::from_str(source).expect("bitmap fixture should parse as JSON");
            value
                .pointer_mut(pointer)
                .and_then(serde_json::Value::as_object_mut)
                .expect("reviewed bitmap fixture pointer should identify an object")
                .insert(String::from("retired"), serde_json::Value::Bool(true));

            assert!(
                serde_json::from_value::<BitmapTsGoldenVectors>(value).is_err(),
                "unknown key at {pointer} must fail closed"
            );
        }
    }
}
