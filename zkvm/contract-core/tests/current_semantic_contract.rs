use contract_core::{
    current_semantic_contract, AggregatorInput, VerificationOutput, VoteWithProof,
    CURRENT_SEMANTIC_CONTRACT_DISCRIMINATOR,
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const CHECKED_IN_DESCRIPTOR: &str = include_str!("../src/current-zkvm-semantic-contract.json");
const CHECKED_IN_CRYPTO_PROJECTION: &str =
    include_str!("../../../packages/crypto-primitives/src/vote-commitment-domain.generated.ts");
const CHECKED_IN_OPERATIONAL_HASH_PROJECTION: &str = include_str!(
    "../../../infra/terraform/bootstrap/app-pipeline-scripts/current-zkvm-semantic-interface.generated.mjs"
);

fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn serialized_key_positions<T: Serialize>(value: &T, keys: &[&str]) -> Vec<usize> {
    let serialized = serde_json::to_string(value).expect("contract value should serialize");
    keys.iter()
        .map(|key| {
            serialized
                .find(&format!("\"{key}\":"))
                .unwrap_or_else(|| panic!("serialized contract is missing key {key}"))
        })
        .collect()
}

fn assert_strictly_increasing(values: &[usize], label: &str) {
    assert!(
        values.windows(2).all(|pair| pair[0] < pair[1]),
        "{label} field order drifted: {values:?}"
    );
}

fn sample_input() -> AggregatorInput {
    AggregatorInput {
        election_id: [0; 16],
        bulletin_root: [1; 32],
        tree_size: 1,
        log_id: [2; 32],
        timestamp: 1,
        total_expected: 1,
        election_config_hash: [3; 32],
        votes: vec![VoteWithProof {
            commitment: [4; 32],
            choice: 0,
            random: [5; 32],
            index: 0,
            merkle_path: vec![[6; 32]],
        }],
    }
}

fn sample_output() -> VerificationOutput {
    VerificationOutput {
        election_id: [0; 16],
        election_config_hash: [1; 32],
        bulletin_root: [2; 32],
        tree_size: 1,
        total_expected: 1,
        sth_digest: [3; 32],
        verified_tally: [1, 0, 0, 0, 0],
        total_votes: 1,
        valid_votes: 1,
        invalid_votes: 0,
        seen_indices_count: 1,
        missing_slots: 0,
        invalid_presented_slots: 0,
        rejected_records: 0,
        seen_bitmap_root: [4; 32],
        included_bitmap_root: [5; 32],
        excluded_slots: 0,
        input_commitment: [6; 32],
        method_version: 14,
    }
}

#[test]
fn checked_in_descriptor_is_the_canonical_rust_contract() {
    let mut checked: Value =
        serde_json::from_str(CHECKED_IN_DESCRIPTOR).expect("checked descriptor should parse");
    let semantic_sha256 = checked
        .as_object_mut()
        .and_then(|record| record.remove("semanticSha256"))
        .and_then(|value| value.as_str().map(str::to_owned))
        .expect("checked descriptor should have semanticSha256");
    let expected = serde_json::to_value(current_semantic_contract())
        .expect("Rust-owned semantic contract should serialize");

    assert_eq!(checked, expected);
    assert_eq!(
        checked["descriptorType"],
        CURRENT_SEMANTIC_CONTRACT_DISCRIMINATOR
    );
    assert_eq!(
        semantic_sha256,
        sha256_hex(&serde_json::to_string(&checked).expect("contract should canonicalize"))
    );
    assert!(!CHECKED_IN_DESCRIPTOR.contains("schemaVersion"));
    assert!(!CHECKED_IN_DESCRIPTOR.contains("byteOffset"));
    assert!(!CHECKED_IN_DESCRIPTOR.contains("272"));
}

#[test]
fn operational_semantic_hash_projection_is_deterministic_and_fresh() {
    let canonical_value = serde_json::to_value(current_semantic_contract())
        .expect("Rust-owned semantic contract should serialize");
    let canonical = serde_json::to_string(&canonical_value)
        .expect("Rust-owned semantic contract should canonicalize");
    let semantic_sha256 = sha256_hex(&canonical);
    let expected = format!(
        concat!(
            "// Generated from the Rust-owned exact-current zkVM semantic descriptor.\n",
            "// Freshness is enforced by contract-core and deployment boundary tests; ",
            "do not edit independently.\n",
            "export const CURRENT_ZKVM_SEMANTIC_INTERFACE_SHA256 =\n",
            "  '{}';\n"
        ),
        semantic_sha256
    );

    assert_eq!(CHECKED_IN_OPERATIONAL_HASH_PROJECTION, expected);
}

#[test]
fn descriptor_field_order_matches_rust_serde_contracts() {
    let contract = current_semantic_contract();
    let input_fields: Vec<&str> = contract
        .host_input_json
        .fields
        .iter()
        .map(|field| field.name)
        .collect();
    let vote_fields: Vec<&str> = contract
        .host_input_json
        .vote_fields
        .iter()
        .map(|field| field.name)
        .collect();
    let journal_fields: Vec<&str> = contract
        .logical_journal
        .fields
        .iter()
        .map(|field| field.name)
        .collect();

    assert_eq!(
        input_fields,
        [
            "election_id",
            "bulletin_root",
            "tree_size",
            "log_id",
            "timestamp",
            "total_expected",
            "election_config_hash",
            "votes",
            "election_config",
        ]
    );
    assert_eq!(
        contract
            .host_input_json
            .election_config_fields
            .iter()
            .map(|field| (field.name, field.field_type))
            .collect::<Vec<_>>(),
        [
            ("totalExpected", "u32"),
            ("choices", "string[]"),
            ("version", "string"),
            ("botCount", "u32"),
            ("merkleTreeDepth", "u32"),
        ]
    );

    assert_strictly_increasing(
        &serialized_key_positions(&sample_input(), &input_fields[..input_fields.len() - 1]),
        "guest proof-core input",
    );
    assert_strictly_increasing(
        &serialized_key_positions(&sample_input().votes[0], &vote_fields),
        "host input vote",
    );
    assert_strictly_increasing(
        &serialized_key_positions(&sample_output(), &journal_fields),
        "logical journal",
    );
}

#[test]
fn descriptor_owns_the_exact_public_input_artifact_contract() {
    let public_input = current_semantic_contract().artifacts.public_input;

    assert_eq!(public_input.canonical_file_name, "public-input.json");
    assert_eq!(public_input.schema, "stark-ballot.public_input");
    assert_eq!(public_input.version, "1.1");
    assert_eq!(
        public_input
            .fields
            .iter()
            .map(|field| (field.name, field.field_type))
            .collect::<Vec<_>>(),
        [
            ("schema", "literal"),
            ("version", "literal"),
            ("electionId", "uuid"),
            ("electionConfigHash", "hex[32]"),
            ("bulletinRoot", "hex[32]"),
            ("treeSize", "u32"),
            ("totalExpected", "u32"),
            ("logId", "hex[32]"),
            ("timestamp", "u64"),
            ("methodVersion", "u32"),
            ("votes", "publicInputVote[]"),
        ]
    );
    assert_eq!(
        public_input
            .vote_fields
            .iter()
            .map(|field| (field.name, field.field_type))
            .collect::<Vec<_>>(),
        [
            ("index", "u32"),
            ("commitment", "hex[32]"),
            ("merklePath", "hex[32][]"),
        ]
    );
}

#[test]
fn vote_commitment_domain_projection_is_deterministic_and_fresh() {
    let tag = current_semantic_contract().domain_tags.vote_commitment;
    let expected = format!(
        "// Generated from the Rust-owned exact-current zkVM semantic descriptor.\n\
// Freshness is enforced by contract-core and crypto-primitives tests; do not edit independently.\n\
export const VOTE_COMMITMENT_DOMAIN_TAG = '{tag}' as const;\n"
    );

    assert_eq!(CHECKED_IN_CRYPTO_PROJECTION, expected);
}
