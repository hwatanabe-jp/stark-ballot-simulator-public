//! TypeScript-Rust compatibility tests for v2 implementation
//! These tests verify that Rust implementations produce identical results
//! to TypeScript for STHDigest, inputCommitment, and includedBitmapRoot.
//! Regenerate expected values with scripts/generate-test-vectors.ts.

#[cfg(test)]
mod tests {
    use crate::sth::compute_sth_digest;
    use contract_core::{
        compute_bitmap_merkle_root, compute_commitment, compute_input_commitment_v4, VoteWithProof,
    };

    #[test]
    fn test_sth_digest_typescript_compatibility() {
        // Test Vector 1 from TypeScript
        let log_id = [0x01u8; 32];
        let tree_size = 64u32;
        let timestamp = 1234567890u64;
        let bulletin_root = [0xAAu8; 32];

        let sth_digest = compute_sth_digest(&log_id, tree_size, timestamp, &bulletin_root);

        // Expected from TypeScript: 0x1a17180975ad39b6eac807cd6a619677d4401b72248dd2fb240873c5f089254d
        let expected: [u8; 32] = [
            0x1a, 0x17, 0x18, 0x09, 0x75, 0xad, 0x39, 0xb6, 0xea, 0xc8, 0x07, 0xcd, 0x6a, 0x61,
            0x96, 0x77, 0xd4, 0x40, 0x1b, 0x72, 0x24, 0x8d, 0xd2, 0xfb, 0x24, 0x08, 0x73, 0xc5,
            0xf0, 0x89, 0x25, 0x4d,
        ];

        assert_eq!(
            sth_digest, expected,
            "STH Digest should match TypeScript implementation"
        );
    }

    #[test]
    fn test_input_commitment_minimal_typescript_compatibility() {
        // Test Vector 2 from TypeScript
        // electionId: "550e8400-e29b-41d4-a716-446655440000"
        let election_id: [u8; 16] = [
            0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66, 0x55, 0x44,
            0x00, 0x00,
        ];
        let bulletin_root = [0x11u8; 32];
        let tree_size = 1u32;
        let total_expected = 1u32;

        // Create vote with commitment
        let random = [0xFFu8; 32];
        let choice = 0u8;
        let commitment = compute_commitment(&election_id, choice, &random);

        let vote = VoteWithProof {
            commitment,
            choice,
            random,
            index: 0,
            merkle_path: vec![],
        };

        let input_commitment = compute_input_commitment_v4(
            &election_id,
            &bulletin_root,
            tree_size,
            total_expected,
            &[vote],
        );

        // Expected from TypeScript: 0xbeaa8d53c5c49f3bf66ed3910a96e0c382b5efbb2fc5d37e0f87c9b5b708a100
        let expected: [u8; 32] = [
            0xbe, 0xaa, 0x8d, 0x53, 0xc5, 0xc4, 0x9f, 0x3b, 0xf6, 0x6e, 0xd3, 0x91, 0x0a, 0x96,
            0xe0, 0xc3, 0x82, 0xb5, 0xef, 0xbb, 0x2f, 0xc5, 0xd3, 0x7e, 0x0f, 0x87, 0xc9, 0xb5,
            0xb7, 0x08, 0xa1, 0x00,
        ];

        assert_eq!(
            input_commitment, expected,
            "Input Commitment should match TypeScript implementation"
        );
    }

    #[test]
    fn test_input_commitment_canonical_ordering_typescript_compatibility() {
        // Test Vector 3 from TypeScript
        // electionId: "123e4567-e89b-12d3-a456-426614174000"
        let election_id: [u8; 16] = [
            0x12, 0x3e, 0x45, 0x67, 0xe8, 0x9b, 0x12, 0xd3, 0xa4, 0x56, 0x42, 0x66, 0x14, 0x17,
            0x40, 0x00,
        ];
        let bulletin_root = [0x44u8; 32];
        let tree_size = 10u32;
        let total_expected = 10u32;

        // Create votes in non-sorted order (indices: 5, 2, 8)
        let vote1 = VoteWithProof {
            commitment: compute_commitment(&election_id, 1, &[0x01u8; 32]),
            choice: 1,
            random: [0x01u8; 32],
            index: 5,
            merkle_path: vec![],
        };

        let vote2 = VoteWithProof {
            commitment: compute_commitment(&election_id, 2, &[0x02u8; 32]),
            choice: 2,
            random: [0x02u8; 32],
            index: 2,
            merkle_path: vec![],
        };

        let vote3 = VoteWithProof {
            commitment: compute_commitment(&election_id, 0, &[0x03u8; 32]),
            choice: 0,
            random: [0x03u8; 32],
            index: 8,
            merkle_path: vec![],
        };

        let votes = vec![vote1, vote2, vote3]; // Unsorted order

        let input_commitment = compute_input_commitment_v4(
            &election_id,
            &bulletin_root,
            tree_size,
            total_expected,
            &votes,
        );

        // Expected from TypeScript: 0x41b500cbc58e121a4b0b03ee386073b739293f9397b1cd75b0bdf555c1afb32d
        let expected: [u8; 32] = [
            0x41, 0xb5, 0x00, 0xcb, 0xc5, 0x8e, 0x12, 0x1a, 0x4b, 0x0b, 0x03, 0xee, 0x38, 0x60,
            0x73, 0xb7, 0x39, 0x29, 0x3f, 0x93, 0x97, 0xb1, 0xcd, 0x75, 0xb0, 0xbd, 0xf5, 0x55,
            0xc1, 0xaf, 0xb3, 0x2d,
        ];

        assert_eq!(
            input_commitment, expected,
            "Input Commitment with canonical ordering should match TypeScript implementation"
        );
    }

    #[test]
    fn test_input_commitment_duplicate_index_tie_break_typescript_compatibility() {
        let election_id: [u8; 16] = [
            0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66, 0x55, 0x44,
            0x00, 0x00,
        ];
        let bulletin_root = [0x11u8; 32];
        let tree_size = 8u32;
        let total_expected = 3u32;

        let vote_a = VoteWithProof {
            commitment: [0x22u8; 32],
            choice: 0,
            random: [0xAAu8; 32],
            index: 3,
            merkle_path: vec![[0x44u8; 32]],
        };

        let vote_b = VoteWithProof {
            commitment: [0x11u8; 32],
            choice: 1,
            random: [0xBBu8; 32],
            index: 3,
            merkle_path: vec![[0x55u8; 32]],
        };

        let vote_c = VoteWithProof {
            commitment: [0x11u8; 32],
            choice: 2,
            random: [0xCCu8; 32],
            index: 3,
            merkle_path: vec![[0x33u8; 32]],
        };

        let input_commitment = compute_input_commitment_v4(
            &election_id,
            &bulletin_root,
            tree_size,
            total_expected,
            &[vote_a, vote_b, vote_c],
        );

        let expected: [u8; 32] = [
            0xd0, 0x97, 0xe1, 0x51, 0xb6, 0xe9, 0xe8, 0x61, 0x46, 0xbe, 0x5a, 0xf1, 0xa0, 0xd0,
            0xdf, 0x53, 0x51, 0x28, 0x98, 0xf6, 0x75, 0xa3, 0x3b, 0xc2, 0x8e, 0x88, 0xe9, 0x06,
            0x12, 0x18, 0x1f, 0x60,
        ];

        assert_eq!(
            input_commitment, expected,
            "Input commitment duplicate-index tie-break should match TypeScript implementation"
        );
    }

    #[test]
    fn test_bitmap_root_8bits_typescript_compatibility() {
        // Test Vector 4 from TypeScript
        // bitmap: 10110010 (LSB first) -> 0x4D
        let bitmap = [true, false, true, true, false, false, true, false];

        let bitmap_root = compute_bitmap_merkle_root(&bitmap);

        // Expected from TypeScript: 0xe4018e05fd184227db0b71514ec035dbe036ebdea6360eb572ac801aff35e753
        let expected: [u8; 32] = [
            0xe4, 0x01, 0x8e, 0x05, 0xfd, 0x18, 0x42, 0x27, 0xdb, 0x0b, 0x71, 0x51, 0x4e, 0xc0,
            0x35, 0xdb, 0xe0, 0x36, 0xeb, 0xde, 0xa6, 0x36, 0x0e, 0xb5, 0x72, 0xac, 0x80, 0x1a,
            0xff, 0x35, 0xe7, 0x53,
        ];

        assert_eq!(
            bitmap_root, expected,
            "Bitmap root (8 bits) should match TypeScript implementation"
        );
    }

    #[test]
    fn test_bitmap_root_12bits_typescript_compatibility() {
        // Test Vector 5 from TypeScript
        // bitmap: 100100000001 (LSB first) -> 0x0908
        let bitmap = [
            true, false, false, true, false, false, false, false, false, false, false, true,
        ];

        let bitmap_root = compute_bitmap_merkle_root(&bitmap);

        // Expected from TypeScript: 0x6e1d0752358a72b5be5fa226f517f005b7b5b785965ac1f1ca67902478b6fc10
        let expected: [u8; 32] = [
            0x6e, 0x1d, 0x07, 0x52, 0x35, 0x8a, 0x72, 0xb5, 0xbe, 0x5f, 0xa2, 0x26, 0xf5, 0x17,
            0xf0, 0x05, 0xb7, 0xb5, 0xb7, 0x85, 0x96, 0x5a, 0xc1, 0xf1, 0xca, 0x67, 0x90, 0x24,
            0x78, 0xb6, 0xfc, 0x10,
        ];

        assert_eq!(
            bitmap_root, expected,
            "Bitmap root (12 bits) should match TypeScript implementation"
        );
    }

    #[test]
    fn test_commitment_typescript_compatibility() {
        // Additional test to ensure SHA-256 commitment domain separation works
        // Using values from sha256.rs test vectors that were verified against TypeScript

        // Test Vector 1
        let election_id: [u8; 16] = [
            0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66, 0x55, 0x44,
            0x00, 0x00,
        ];
        let choice = 0u8;
        let random = [0xAAu8; 32];

        let commitment = compute_commitment(&election_id, choice, &random);

        // Expected from TypeScript (verified in sha256.rs)
        let expected: [u8; 32] = [
            0x56, 0x1b, 0x8d, 0x0f, 0xd2, 0x96, 0xc8, 0xb0, 0xae, 0xd2, 0xaa, 0x6f, 0x65, 0x5d,
            0x33, 0x02, 0x82, 0xf4, 0x55, 0x78, 0x0f, 0xc8, 0x28, 0xe7, 0xb6, 0xbb, 0x66, 0x07,
            0x44, 0x59, 0x8e, 0x88,
        ];

        assert_eq!(
            commitment, expected,
            "Commitment v2 should match TypeScript implementation"
        );
    }
}
