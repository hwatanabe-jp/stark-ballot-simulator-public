// Test vectors from final_design.md v1.0 Examples 1-3
// Matching the TypeScript implementation for compatibility verification
// Regenerate expected values with scripts/generate-test-vectors.ts.

use sha2::{Digest, Sha256};
use std::cmp::Ordering;

// Test vector structures matching TypeScript
#[derive(Debug)]
struct TestVote {
    commitment: [u8; 32],
    choice: u8,
    random: [u8; 32],
    index: u32,
    merkle_path: Vec<[u8; 32]>,
}

// Pack bits to bytes using LSB-first encoding
fn pack_bits_to_bytes(bits: &[bool]) -> Vec<u8> {
    let num_bytes = bits.len().div_ceil(8);
    let mut bytes = vec![0u8; num_bytes];

    for (i, &bit) in bits.iter().enumerate() {
        if bit {
            let byte_index = i / 8;
            let bit_index = i % 8;
            bytes[byte_index] |= 1 << bit_index; // LSB-first
        }
    }

    bytes
}

// Split bytes into 32-byte chunks for Merkle tree leaves
fn split_into_chunks(bytes: &[u8]) -> Vec<[u8; 32]> {
    let mut chunks = Vec::new();
    let chunk_size = 32;

    let mut i = 0;
    while i < bytes.len() {
        let mut chunk = [0u8; 32];
        let end = std::cmp::min(i + chunk_size, bytes.len());
        let len = end - i;
        chunk[..len].copy_from_slice(&bytes[i..end]);
        chunks.push(chunk);
        i += chunk_size;
    }

    // If no data, return single zero chunk
    if chunks.is_empty() {
        chunks.push([0u8; 32]);
    }

    chunks
}

// Hash a leaf chunk using CT-style with usage tag
fn hash_leaf_chunk(chunk: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update([0x00]); // Domain separator for leaf
    hasher.update(b"stark-ballot:leaf|v1"); // Usage tag
    hasher.update(chunk);

    let result = hasher.finalize();
    let mut output = [0u8; 32];
    output.copy_from_slice(&result);
    output
}

// Hash internal node using CT-style
fn hash_internal_node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update([0x01]); // Domain separator for internal node
    hasher.update(left);
    hasher.update(right);

    let result = hasher.finalize();
    let mut output = [0u8; 32];
    output.copy_from_slice(&result);
    output
}

// Build Merkle tree from leaves and return root
fn compute_merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.is_empty() {
        return [0u8; 32];
    }

    if leaves.len() == 1 {
        return leaves[0];
    }

    // Build tree level by level
    let mut current_level = leaves.to_vec();

    while current_level.len() > 1 {
        let mut next_level = Vec::new();

        let mut i = 0;
        while i < current_level.len() {
            if i + 1 < current_level.len() {
                // Hash pair
                next_level.push(hash_internal_node(&current_level[i], &current_level[i + 1]));
                i += 2;
            } else {
                // Odd node - promote to next level
                next_level.push(current_level[i]);
                i += 1;
            }
        }

        current_level = next_level;
    }

    current_level[0]
}

// Compute includedBitmapRoot from bitmap
fn compute_included_bitmap_root(bitmap: &[bool]) -> [u8; 32] {
    // Step 1: Pack bits to bytes (LSB-first)
    let bytes = pack_bits_to_bytes(bitmap);

    // Step 2: Split into 32-byte chunks
    let chunks = split_into_chunks(&bytes);

    // Step 3: Hash each chunk as a leaf
    let leaves: Vec<[u8; 32]> = chunks.iter().map(hash_leaf_chunk).collect();

    // Step 4: Build Merkle tree and get root
    compute_merkle_root(&leaves)
}

// Compute input commitment with canonical encoding
// Note: This follows the TypeScript implementation which doesn't include
// logId, timestamp, or electionConfigHash in the input commitment
fn compute_input_commitment(
    election_id: &[u8; 16],
    bulletin_root: &[u8; 32],
    tree_size: u32,
    total_expected: u32,
    votes: &mut [TestVote],
) -> [u8; 32] {
    votes.sort_by(compare_test_votes);

    let mut hasher = Sha256::new();

    // Domain tag
    hasher.update(b"stark-ballot:input|v1.0");

    // Version (10 for v1.0) - little endian
    hasher.update(10u32.to_le_bytes());

    // ElectionId (16 bytes)
    hasher.update(election_id);

    // BulletinRoot (32 bytes)
    hasher.update(bulletin_root);

    // TreeSize, TotalExpected (little endian)
    hasher.update(tree_size.to_le_bytes());
    hasher.update(total_expected.to_le_bytes());

    // VotesCount (little endian)
    hasher.update((votes.len() as u32).to_le_bytes());

    // Encode each vote (sorted)
    for vote in votes.iter() {
        // Keep parity with TypeScript vectors: some fixtures hardcode commitments
        // without matching choice/random pairs, so simply mark the fields as used.
        let _ = vote.choice;
        let _ = &vote.random;

        // Index (little endian)
        hasher.update(vote.index.to_le_bytes());

        // CommitmentLen (32 fixed, little endian)
        hasher.update(32u16.to_le_bytes());

        // Commitment (32 bytes)
        hasher.update(vote.commitment);

        // PathLen (little endian)
        hasher.update((vote.merkle_path.len() as u16).to_le_bytes());

        // Path nodes
        for node in &vote.merkle_path {
            hasher.update(node);
        }
    }

    let result = hasher.finalize();
    let mut output = [0u8; 32];
    output.copy_from_slice(&result);
    output
}

fn compare_test_votes(left: &TestVote, right: &TestVote) -> Ordering {
    match left.index.cmp(&right.index) {
        Ordering::Equal => {}
        ordering => return ordering,
    }

    match left.commitment.cmp(&right.commitment) {
        Ordering::Equal => {}
        ordering => return ordering,
    }

    compare_test_merkle_paths(&left.merkle_path, &right.merkle_path)
}

fn compare_test_merkle_paths(left: &[[u8; 32]], right: &[[u8; 32]]) -> Ordering {
    for (left_node, right_node) in left.iter().zip(right.iter()) {
        match left_node.cmp(right_node) {
            Ordering::Equal => continue,
            ordering => return ordering,
        }
    }

    left.len().cmp(&right.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_example_1_minimal_input() {
        // Test data from final_design.md lines 849-854
        let election_id: [u8; 16] = [
            0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66, 0x55, 0x44,
            0x00, 0x00,
        ];

        let bulletin_root = [
            0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78, 0x90, 0xab,
            0xcd, 0xef, 0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78,
            0x90, 0xab, 0xcd, 0xef,
        ];

        let mut votes = vec![TestVote {
            commitment: [0xde, 0xad, 0xbe, 0xef].repeat(8).try_into().unwrap(),
            choice: 0,
            random: [0xff; 32],
            index: 0,
            merkle_path: vec![],
        }];

        let commitment = compute_input_commitment(&election_id, &bulletin_root, 1, 1, &mut votes);

        // Convert to hex string for comparison with TypeScript
        let hex_commitment = hex::encode(commitment);
        println!("Example 1 inputCommitment: 0x{}", hex_commitment);

        // This should match the TypeScript output
        // Expected: 0xe674189480fd5a3c1a721639c5810c92d588b2ac5f0d608d597564ae3826dab0
        assert_eq!(
            hex_commitment,
            "e674189480fd5a3c1a721639c5810c92d588b2ac5f0d608d597564ae3826dab0"
        );
    }

    #[test]
    fn test_example_2_12_vote_case() {
        // 12 bits all set to 1 (everyone counted)
        let bitmap = vec![true; 12];
        let bitmap_root = compute_included_bitmap_root(&bitmap);

        // Verify the packed bytes
        let packed_bytes = pack_bits_to_bytes(&bitmap);
        assert_eq!(packed_bytes, vec![0xff, 0x0f]);

        // Verify the chunks
        let chunks = split_into_chunks(&packed_bytes);
        assert_eq!(chunks.len(), 1);

        let mut expected_chunk = [0u8; 32];
        expected_chunk[0] = 0xff;
        expected_chunk[1] = 0x0f;
        assert_eq!(chunks[0], expected_chunk);

        let hex_root = hex::encode(bitmap_root);
        println!("12-vote case includedBitmapRoot: 0x{}", hex_root);
    }

    #[test]
    fn test_example_2_17_vote_case() {
        // 17 bits all set to 1
        let bitmap = vec![true; 17];
        let bitmap_root = compute_included_bitmap_root(&bitmap);

        // Verify the packed bytes
        let packed_bytes = pack_bits_to_bytes(&bitmap);
        assert_eq!(packed_bytes, vec![0xff, 0xff, 0x01]);

        let hex_root = hex::encode(bitmap_root);
        println!("17-vote case includedBitmapRoot: 0x{}", hex_root);
    }

    #[test]
    fn test_example_2_257_vote_case() {
        // 257 bits: 256 bits all 1 (first chunk) + 1 bit set to 1 (second chunk)
        let bitmap = vec![true; 257];
        let bitmap_root = compute_included_bitmap_root(&bitmap);

        // Verify the packed bytes
        let packed_bytes = pack_bits_to_bytes(&bitmap);
        assert_eq!(packed_bytes.len(), 33); // 257 bits = 33 bytes
        assert_eq!(&packed_bytes[0..32], &[0xff; 32]);
        assert_eq!(packed_bytes[32], 0x01);

        // Verify the chunks
        let chunks = split_into_chunks(&packed_bytes);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0], [0xff; 32]);

        let mut expected_chunk2 = [0u8; 32];
        expected_chunk2[0] = 0x01;
        assert_eq!(chunks[1], expected_chunk2);

        let hex_root = hex::encode(bitmap_root);
        println!("257-vote case includedBitmapRoot: 0x{}", hex_root);
    }

    #[test]
    fn test_example_3_multiple_votes() {
        // Test data from final_design.md lines 936-944
        let election_id: [u8; 16] = [
            0x12, 0x3e, 0x45, 0x67, 0xe8, 0x9b, 0x12, 0xd3, 0xa4, 0x56, 0x42, 0x66, 0x14, 0x17,
            0x40, 0x00,
        ];

        // TypeScript: '0xabcd' + '00'.repeat(30) + 'ef01'
        // This means: abcd (2 bytes) + 00 * 30 (30 bytes) = 32 bytes total
        // But actually in the TypeScript, that creates a 34-byte string
        // Looking more carefully: the TypeScript creates 0xabcd + 60 zeros + ef01
        // But it's meant to be 32 bytes total, so it must be:
        // ab cd 00 00 00 00 00 00 00 00 00 00 00 00 00 00
        // 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ef 01
        let bulletin_root: [u8; 32] = [
            0xab, 0xcd, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0xef, 0x01,
        ];

        let mut votes = vec![
            TestVote {
                commitment: [0xaa; 32],
                choice: 0,
                random: [0x11; 32],
                index: 0,
                merkle_path: vec![[0xbb; 32], [0xcc; 32]],
            },
            TestVote {
                commitment: [0xdd; 32],
                choice: 1,
                random: [0x22; 32],
                index: 1,
                merkle_path: vec![[0xee; 32], [0xcc; 32]],
            },
            TestVote {
                commitment: [0xff; 32],
                choice: 2,
                random: [0x33; 32],
                index: 2,
                merkle_path: vec![[0x11; 32]],
            },
        ];

        let commitment = compute_input_commitment(&election_id, &bulletin_root, 3, 3, &mut votes);

        let hex_commitment = hex::encode(commitment);
        println!("Example 3 inputCommitment: 0x{}", hex_commitment);

        // Expected to match TypeScript (with corrected bulletinRoot)
        assert_eq!(
            hex_commitment,
            "c4b3af36f3c1a5c71c8c07e7bfbd5f29b3a6f3468133ba4d4965a9018859abaa"
        );
    }
}
