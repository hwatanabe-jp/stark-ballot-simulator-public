use alloc::vec;
use alloc::vec::Vec;

use crate::inclusion_proof::{compute_merkle_root, hash_leaf};

/// Compute the CT Merkle root of a bitmap packed into 32-byte leaves.
pub fn compute_bitmap_merkle_root(bitmap: &[bool]) -> [u8; 32] {
    let packed_bytes = pack_bits_to_bytes(bitmap);

    if packed_bytes.len() <= 32 {
        let mut padded = [0u8; 32];
        padded[..packed_bytes.len()].copy_from_slice(&packed_bytes);
        return hash_leaf(&padded);
    }

    let chunk_capacity = packed_bytes.len().div_ceil(32);
    let mut leaves: Vec<[u8; 32]> = Vec::with_capacity(chunk_capacity);
    for chunk in packed_bytes.chunks(32) {
        let mut leaf = [0u8; 32];
        leaf[..chunk.len()].copy_from_slice(chunk);
        leaves.push(hash_leaf(&leaf));
    }

    compute_merkle_root(&leaves)
}

fn pack_bits_to_bytes(bits: &[bool]) -> Vec<u8> {
    let byte_len = bits.len().div_ceil(8);
    let mut bytes = vec![0u8; byte_len];

    for (chunk_index, chunk) in bits.chunks(8).enumerate() {
        let mut byte = 0u8;
        for (bit_index, bit) in chunk.iter().enumerate() {
            if *bit {
                byte |= 1 << bit_index;
            }
        }
        bytes[chunk_index] = byte;
    }

    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::String;
    use alloc::vec::Vec;
    use risc0_zkvm::sha::{Impl, Sha256};
    use serde::Deserialize;

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
        assert_eq!(root.len(), 32);

        let mut bitmap2 = vec![false; 8];
        bitmap2[3] = true;

        let root2 = compute_bitmap_merkle_root(&bitmap2);
        assert_ne!(root, root2);
    }

    #[test]
    fn test_bitmap_boundary_cases() {
        let bitmap = vec![true; 12];
        let root = compute_bitmap_merkle_root(&bitmap);
        assert_eq!(root.len(), 32);

        let mut bitmap = vec![false; 257];
        for bit in bitmap.iter_mut().take(10) {
            *bit = true;
        }
        bitmap[256] = true;

        let root = compute_bitmap_merkle_root(&bitmap);
        assert_eq!(root.len(), 32);
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
        assert_eq!(root.len(), 32);

        let mut leaves2 = leaves.clone();
        leaves2[2] = [5u8; 32];
        let root2 = compute_merkle_root(&leaves2);
        assert_ne!(root, root2);
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FormalBitmapCase {
        bit_length: usize,
        true_indices: Vec<usize>,
        expected_packed_byte_length: usize,
        expected_packed_bytes_hex: String,
        probes: Vec<FormalBitmapProbe>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FormalBitmapProbe {
        bit_index: usize,
        byte_index: usize,
        bit_index_in_byte: usize,
        expected_value: bool,
    }

    fn formal_bitmap(case: &FormalBitmapCase) -> Vec<bool> {
        let mut bitmap = vec![false; case.bit_length];
        for index in &case.true_indices {
            bitmap[*index] = true;
        }
        bitmap
    }

    #[test]
    fn test_formal_bitmap_vectors_lsb_first() {
        let cases: Vec<FormalBitmapCase> = serde_json::from_str(include_str!(
            "../../../docs/current/formal/generated-vectors/bitmap-cases.json"
        ))
        .expect("formal bitmap vectors should parse");

        for case in cases {
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

            let root = compute_bitmap_merkle_root(&bitmap);
            assert_eq!(root.len(), 32);
        }
    }
}
