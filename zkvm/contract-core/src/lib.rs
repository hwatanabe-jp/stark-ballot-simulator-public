#![no_std]

extern crate alloc;

pub mod bitmap;
pub mod domain;
pub mod encoding;
pub mod inclusion_proof;
pub mod semantic_contract;
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
pub use encoding::{compute_input_commitment_v4, INPUT_COMMITMENT_FORMAT_VERSION};
pub use inclusion_proof::{
    compute_merkle_root, compute_root_from_proof, fold_inclusion_proof, hash_internal, hash_leaf,
    verify_inclusion_proof_rfc6962,
};
pub use semantic_contract::{
    current_semantic_contract, CurrentSemanticContract, CURRENT_SEMANTIC_CONTRACT_DISCRIMINATOR,
    HOST_INCLUDED_BITMAP_FILE_SUFFIX, HOST_OUTPUT_FILE_SUFFIX, HOST_RECEIPT_FILE_SUFFIX,
    HOST_SEEN_BITMAP_FILE_SUFFIX, INCLUDED_BITMAP_ARTIFACT_SCHEMA,
    INCLUDED_BITMAP_ARTIFACT_VERSION, PUBLIC_INPUT_ARTIFACT_SCHEMA, PUBLIC_INPUT_ARTIFACT_VERSION,
    PUBLIC_INPUT_CANONICAL_FILE_NAME, SEEN_BITMAP_ARTIFACT_SCHEMA, SEEN_BITMAP_ARTIFACT_VERSION,
};
pub use sha256::compute_commitment;
pub use types::{
    AggregatorInput, VerificationOutput, VoteWithProof, CURRENT_METHOD_VERSION,
    VERIFIED_TALLY_WIDTH,
};
pub use work_budget::{
    validate_guest_work_budget, GuestWorkBudget, GuestWorkBudgetError,
    MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD, MAX_GUEST_SERIALIZED_INPUT_BYTES,
    MAX_GUEST_TOTAL_EXPECTED, MAX_GUEST_TOTAL_PATH_NODES, MAX_GUEST_TREE_SIZE,
    MAX_GUEST_VOTE_COUNT,
};
