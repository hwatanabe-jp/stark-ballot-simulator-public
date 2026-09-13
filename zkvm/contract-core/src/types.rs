use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

/// Current zkVM journal contract method version.
pub const CURRENT_METHOD_VERSION: u32 = 14;
pub const VERIFIED_TALLY_WIDTH: usize = 5;

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
    /// Unix timestamp in milliseconds
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
    pub verified_tally: [u32; VERIFIED_TALLY_WIDTH],
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
    /// Current zkVM journal contract method version.
    pub method_version: u32,
}
