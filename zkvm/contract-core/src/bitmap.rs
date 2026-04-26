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
    use risc0_zkvm::sha::{Impl, Sha256};

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
}
