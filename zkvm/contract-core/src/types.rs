use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

/// Vote plus its RFC 6962 audit path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoteWithProof {
    /// Public commitment (SHA256("stark-ballot:commit|v1.0" || electionId || choice || random))
    pub commitment: [u8; 32],
    /// Private choice (0-4 for options A-E) - witness data
    pub choice: u8,
    /// Private random value - witness data
    pub random: [u8; 32],
    /// Index in the bulletin board
    pub index: u32,
    /// Merkle proof path (CT-style audit path)
    pub merkle_path: Vec<[u8; 32]>,
}

/// zkVM input structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregatorInput {
    /// Election identifier (UUID v4 - 16 bytes)
    pub election_id: [u8; 16],
    /// Public bulletin board root
    pub bulletin_root: [u8; 32],
    /// Tree size corresponding to bulletin_root
    pub tree_size: u32,
    /// Bulletin board identifier
    pub log_id: [u8; 32],
    /// Unix timestamp
    pub timestamp: u64,
    /// Expected total votes (fixed N for this experiment)
    pub total_expected: u32,
    /// Hash of election configuration including total_expected
    pub election_config_hash: [u8; 32],
    /// Vote data with proofs
    pub votes: Vec<VoteWithProof>,
}

/// zkVM journal structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationOutput {
    /// Election scope identification
    pub election_id: [u8; 16],
    pub election_config_hash: [u8; 32],
    /// Bulletin board root (echo from input)
    pub bulletin_root: [u8; 32],
    pub tree_size: u32,
    pub total_expected: u32,
    /// SHA256(logId || treeSize || timestamp || bulletinRoot)
    pub sth_digest: [u8; 32],
    /// [A, B, C, D, E]
    pub verified_tally: [u32; 5],
    /// Total votes processed
    pub total_votes: u32,
    /// Successfully verified votes
    pub valid_votes: u32,
    /// Failed verification
    pub invalid_votes: u32,
    /// Unique in-range indices presented at least once
    pub seen_indices_count: u32,
    /// In-range bulletin slots never seen by the guest
    pub missing_slots: u32,
    /// Seen in-range slots that were still not counted
    pub invalid_presented_slots: u32,
    /// Rejected records, including duplicate/out-of-range records
    pub rejected_records: u32,
    /// Merkle root of presented-index bitmap
    pub seen_bitmap_root: [u8; 32],
    /// Merkle root of inclusion bitmap
    pub included_bitmap_root: [u8; 32],
    /// Slot-based exclusions = missing_slots + invalid_presented_slots
    pub excluded_slots: u32,
    /// Domain-separated hash of input
    pub input_commitment: [u8; 32],
    /// 12 for v1.2
    pub method_version: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    #[test]
    fn test_vote_with_proof_structure() {
        let vote = VoteWithProof {
            commitment: [1u8; 32],
            choice: 0,
            random: [2u8; 32],
            index: 0,
            merkle_path: vec![[3u8; 32], [4u8; 32]],
        };

        assert_eq!(vote.index, 0);
        assert_eq!(vote.merkle_path.len(), 2);
    }

    #[test]
    fn test_aggregator_input_no_claimed_tally() {
        let input = AggregatorInput {
            election_id: [0u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: 64,
            log_id: [2u8; 32],
            timestamp: 1234567890,
            total_expected: 64,
            election_config_hash: [3u8; 32],
            votes: vec![],
        };

        assert_eq!(input.election_id.len(), 16);
        assert_eq!(input.tree_size, 64);
        assert_eq!(input.total_expected, 64);
    }

    #[test]
    fn test_verification_output_no_tamper_detected() {
        let output = VerificationOutput {
            election_id: [0u8; 16],
            election_config_hash: [1u8; 32],
            bulletin_root: [2u8; 32],
            tree_size: 64,
            total_expected: 64,
            sth_digest: [3u8; 32],
            verified_tally: [15, 12, 18, 10, 9],
            total_votes: 64,
            valid_votes: 63,
            invalid_votes: 1,
            seen_indices_count: 64,
            missing_slots: 0,
            invalid_presented_slots: 1,
            rejected_records: 1,
            seen_bitmap_root: [4u8; 32],
            included_bitmap_root: [4u8; 32],
            excluded_slots: 1,
            input_commitment: [5u8; 32],
            method_version: 12,
        };

        assert_eq!(
            output.missing_slots + output.invalid_presented_slots + output.valid_votes,
            64
        );
        assert_eq!(
            output.excluded_slots,
            output.missing_slots + output.invalid_presented_slots
        );
        assert_eq!(output.rejected_records, output.invalid_votes);
    }

    #[test]
    fn test_sth_parameters() {
        let input = AggregatorInput {
            election_id: [0u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: 64,
            log_id: [2u8; 32],
            timestamp: 1234567890,
            total_expected: 64,
            election_config_hash: [3u8; 32],
            votes: vec![],
        };

        assert_eq!(input.log_id.len(), 32);
        assert_eq!(input.timestamp, 1234567890);
    }
}
