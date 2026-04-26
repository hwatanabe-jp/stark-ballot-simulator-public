use risc0_zkvm::sha::{Impl, Sha256};

/// Compute vote commitment with domain separation (v1.0).
pub fn compute_commitment(election_id: &[u8; 16], choice: u8, random: &[u8; 32]) -> [u8; 32] {
    const DOMAIN_TAG: &[u8] = b"stark-ballot:commit|v1.0";

    let mut data = [0u8; 73];
    data[0..24].copy_from_slice(DOMAIN_TAG);
    data[24..40].copy_from_slice(election_id);
    data[40] = choice;
    data[41..73].copy_from_slice(random);

    let digest = Impl::hash_bytes(&data);
    let mut result = [0u8; 32];
    result.copy_from_slice(digest.as_bytes());
    result
}

/// Recompute a commitment and compare it with the provided value.
pub fn verify_commitment(
    election_id: &[u8; 16],
    choice: u8,
    random: &[u8; 32],
    commitment: &[u8; 32],
) -> bool {
    let computed = compute_commitment(election_id, choice, random);
    computed == *commitment
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_commitment_with_domain_separation() {
        let election_id = [0u8; 16];
        let choice = 2u8;
        let random = [1u8; 32];

        let commitment = compute_commitment(&election_id, choice, &random);

        let simple_commitment = {
            let mut data = [0u8; 33];
            data[0] = choice;
            data[1..33].copy_from_slice(&random);
            let digest = Impl::hash_bytes(&data);
            let mut result = [0u8; 32];
            result.copy_from_slice(digest.as_bytes());
            result
        };

        assert_ne!(
            commitment, simple_commitment,
            "Commitment should include domain separation"
        );
    }

    #[test]
    fn test_commitment_deterministic() {
        let election_id = [
            0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66, 0x55, 0x44,
            0x00, 0x00,
        ];
        let choice = 3u8;
        let random = [2u8; 32];

        let commitment1 = compute_commitment(&election_id, choice, &random);
        let commitment2 = compute_commitment(&election_id, choice, &random);

        assert_eq!(commitment1, commitment2);
    }

    #[test]
    fn test_commitment_different_elections() {
        let election_id1 = [1u8; 16];
        let election_id2 = [2u8; 16];
        let choice = 1u8;
        let random = [3u8; 32];

        let commitment1 = compute_commitment(&election_id1, choice, &random);
        let commitment2 = compute_commitment(&election_id2, choice, &random);

        assert_ne!(commitment1, commitment2);
    }

    #[test]
    fn test_commitment_compatibility() {
        let election_id: [u8; 16] = [
            0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66, 0x55, 0x44,
            0x00, 0x00,
        ];
        let choice = 0u8;
        let random = [0xAAu8; 32];

        let commitment = compute_commitment(&election_id, choice, &random);
        let expected: [u8; 32] = [
            0x56, 0x1b, 0x8d, 0x0f, 0xd2, 0x96, 0xc8, 0xb0, 0xae, 0xd2, 0xaa, 0x6f, 0x65, 0x5d,
            0x33, 0x02, 0x82, 0xf4, 0x55, 0x78, 0x0f, 0xc8, 0x28, 0xe7, 0xb6, 0xbb, 0x66, 0x07,
            0x44, 0x59, 0x8e, 0x88,
        ];

        assert_eq!(commitment, expected);
    }

    #[test]
    fn test_verify_commitment_valid() {
        let election_id = [4u8; 16];
        let choice = 4u8;
        let random = [5u8; 32];

        let commitment = compute_commitment(&election_id, choice, &random);

        assert!(verify_commitment(
            &election_id,
            choice,
            &random,
            &commitment
        ));
    }
}
