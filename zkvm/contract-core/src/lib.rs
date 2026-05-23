#![no_std]

extern crate alloc;

pub mod bitmap;
pub mod encoding;
pub mod inclusion_proof;
pub mod sha256;
pub mod types;

pub use bitmap::compute_bitmap_merkle_root;
pub use encoding::compute_input_commitment_v4;
pub use inclusion_proof::{
    compute_merkle_root, compute_root_from_proof, fold_inclusion_proof, hash_internal, hash_leaf,
    verify_inclusion_proof_rfc6962,
};
pub use sha256::{compute_commitment, verify_commitment};
pub use types::{AggregatorInput, VerificationOutput, VoteWithProof, CURRENT_METHOD_VERSION};
