//! Independent TypeScript-to-Rust contract vectors for algorithms that are not
//! owned by the generated formal-vector suite.

#[cfg(test)]
mod tests {
    use crate::sth::compute_sth_digest;
    use contract_core::compute_commitment;

    #[test]
    fn sth_digest_matches_typescript_vector() {
        let log_id = [0x01u8; 32];
        let tree_size = 64u32;
        let timestamp = 1_234_567_890_000u64;
        let bulletin_root = [0xAAu8; 32];

        let actual = compute_sth_digest(&log_id, tree_size, timestamp, &bulletin_root);
        let expected: [u8; 32] = [
            0xae, 0xdb, 0xec, 0xef, 0xc2, 0xc4, 0xae, 0xc2, 0xf8, 0xb7, 0x3a, 0x44, 0xaf, 0x53,
            0xa4, 0xd8, 0x7f, 0xc2, 0x05, 0x67, 0xd7, 0x48, 0x02, 0xc6, 0x08, 0xb5, 0x06, 0x9d,
            0x26, 0xf1, 0x9e, 0x18,
        ];

        assert_eq!(
            actual, expected,
            "STH digest must match the TypeScript implementation"
        );
    }

    #[test]
    fn vote_commitment_matches_typescript_vector() {
        let election_id: [u8; 16] = [
            0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66, 0x55, 0x44,
            0x00, 0x00,
        ];
        let choice = 0u8;
        let random = [0xAAu8; 32];

        let actual = compute_commitment(&election_id, choice, &random);
        let expected: [u8; 32] = [
            0x56, 0x1b, 0x8d, 0x0f, 0xd2, 0x96, 0xc8, 0xb0, 0xae, 0xd2, 0xaa, 0x6f, 0x65, 0x5d,
            0x33, 0x02, 0x82, 0xf4, 0x55, 0x78, 0x0f, 0xc8, 0x28, 0xe7, 0xb6, 0xbb, 0x66, 0x07,
            0x44, 0x59, 0x8e, 0x88,
        ];

        assert_eq!(
            actual, expected,
            "Vote commitment must match the TypeScript implementation"
        );
    }
}
