#![no_std]

extern crate alloc;

pub mod bitmap;
pub mod domain;
pub mod encoding;
pub mod inclusion_proof;
pub mod sha256;
pub mod types;
pub mod work_budget;

pub use bitmap::{
    compute_bitmap_merkle_root, generate_bitmap_merkle_proof, BitmapAuditPathNode,
    BitmapAuditPathPosition, BitmapMerkleProof,
};
pub use domain::{
    BitmapBitIndex, BitmapBitOffset, BitmapLeafIndex, BulletinIndex, BulletinRoot,
    DomainValidationError, ElectionConfigHash, ElectionId16, IncludedBitmapRoot, InputCommitment,
    LogId, MerkleNodeHash, PackedBitmap, Randomness32, SeenBitmapRoot, SthDigest, TotalExpected,
    TreeSize, UnixTimestampMillis, ValidatedAuditPath, VoteCommitment, VoteCount,
};
pub use encoding::compute_input_commitment_v4;
pub use inclusion_proof::{
    compute_merkle_root, compute_root_from_proof, fold_inclusion_proof, hash_internal, hash_leaf,
    verify_inclusion_proof_rfc6962,
};
pub use sha256::{compute_commitment, verify_commitment};
pub use types::{AggregatorInput, VerificationOutput, VoteWithProof, CURRENT_METHOD_VERSION};
pub use work_budget::{
    validate_guest_work_budget, GuestWorkBudget, GuestWorkBudgetError,
    MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD, MAX_GUEST_SERIALIZED_INPUT_BYTES,
    MAX_GUEST_TOTAL_EXPECTED, MAX_GUEST_TOTAL_PATH_NODES, MAX_GUEST_TREE_SIZE,
    MAX_GUEST_VOTE_COUNT,
};
