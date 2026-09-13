use std::collections::HashSet;

use contract_core::{
    compute_input_commitment_v4, VerificationOutput, VoteWithProof, CURRENT_METHOD_VERSION,
    PUBLIC_INPUT_ARTIFACT_SCHEMA, PUBLIC_INPUT_ARTIFACT_VERSION, VERIFIED_TALLY_WIDTH,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const HASH_BYTES: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostJsonOutput {
    pub election_id: [u8; 16],
    pub election_config_hash: [u8; HASH_BYTES],
    pub bulletin_root: [u8; HASH_BYTES],
    pub tree_size: u32,
    pub total_expected: u32,
    pub sth_digest: [u8; HASH_BYTES],
    pub verified_tally: [u32; VERIFIED_TALLY_WIDTH],
    pub total_votes: u32,
    pub valid_votes: u32,
    pub invalid_votes: u32,
    pub seen_indices_count: u32,
    pub missing_slots: u32,
    pub invalid_presented_slots: u32,
    pub rejected_records: u32,
    pub seen_bitmap_root: [u8; HASH_BYTES],
    pub included_bitmap_root: [u8; HASH_BYTES],
    pub excluded_slots: u32,
    pub input_commitment: [u8; HASH_BYTES],
    pub method_version: u32,
    pub image_id: String,
}

impl HostJsonOutput {
    pub fn from_verification_output(output: VerificationOutput, image_id: String) -> Self {
        Self {
            election_id: output.election_id,
            election_config_hash: output.election_config_hash,
            bulletin_root: output.bulletin_root,
            tree_size: output.tree_size,
            total_expected: output.total_expected,
            sth_digest: output.sth_digest,
            verified_tally: output.verified_tally,
            total_votes: output.total_votes,
            valid_votes: output.valid_votes,
            invalid_votes: output.invalid_votes,
            seen_indices_count: output.seen_indices_count,
            missing_slots: output.missing_slots,
            invalid_presented_slots: output.invalid_presented_slots,
            rejected_records: output.rejected_records,
            seen_bitmap_root: output.seen_bitmap_root,
            included_bitmap_root: output.included_bitmap_root,
            excluded_slots: output.excluded_slots,
            input_commitment: output.input_commitment,
            method_version: output.method_version,
            image_id,
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ProverInput {
    election_id: [u8; 16],
    bulletin_root: [u8; HASH_BYTES],
    tree_size: u32,
    log_id: [u8; HASH_BYTES],
    timestamp: u64,
    total_expected: u32,
    election_config_hash: [u8; HASH_BYTES],
    votes: Vec<ProverVote>,
    election_config: ElectionConfig,
}

impl ProverInput {
    fn commitment_votes(&self) -> Result<Vec<VoteWithProof>, String> {
        let mut seen = HashSet::with_capacity(self.votes.len());
        let mut votes = Vec::with_capacity(self.votes.len());
        for vote in &self.votes {
            if !seen.insert(vote.index) {
                return Err("public-input contains duplicate vote index".to_string());
            }
            votes.push(VoteWithProof {
                commitment: vote.commitment,
                choice: vote.choice,
                random: vote.random,
                index: vote.index,
                merkle_path: vote.merkle_path.clone(),
            });
        }
        Ok(votes)
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ProverVote {
    commitment: [u8; HASH_BYTES],
    choice: u8,
    random: [u8; HASH_BYTES],
    index: u32,
    merkle_path: Vec<[u8; HASH_BYTES]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElectionConfig {
    total_expected: u32,
    choices: Vec<String>,
    version: String,
    bot_count: u32,
    merkle_tree_depth: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicJournal {
    election_id: String,
    election_config_hash: String,
    bulletin_root: String,
    tree_size: u32,
    total_expected: u32,
    sth_digest: String,
    verified_tally: [u32; VERIFIED_TALLY_WIDTH],
    total_votes: u32,
    valid_votes: u32,
    invalid_votes: u32,
    seen_indices_count: u32,
    missing_slots: u32,
    invalid_presented_slots: u32,
    rejected_records: u32,
    seen_bitmap_root: String,
    included_bitmap_root: String,
    excluded_slots: u32,
    input_commitment: String,
    method_version: u32,
    image_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicInputVote {
    index: u32,
    commitment: String,
    merkle_path: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicInput {
    schema: String,
    version: String,
    election_id: String,
    election_config_hash: String,
    bulletin_root: String,
    tree_size: u32,
    total_expected: u32,
    log_id: String,
    timestamp: u64,
    method_version: u32,
    votes: Vec<PublicInputVote>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElectionManifest {
    election_id: String,
    total_expected: u32,
    choices: Vec<String>,
    version: String,
    bot_count: u32,
    merkle_tree_depth: u32,
    election_config_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseStatement {
    log_id: String,
    tree_size: u32,
    timestamp: u64,
    bulletin_root: String,
    sth_digest: String,
}

#[derive(Debug)]
pub struct PublicAuditArtifacts {
    pub journal: PublicJournal,
    pub public_input: PublicInput,
    pub election_manifest: ElectionManifest,
    pub close_statement: CloseStatement,
}

pub fn build_public_audit_artifacts(
    input_json: &str,
    output_json: &str,
) -> Result<PublicAuditArtifacts, String> {
    let input: ProverInput = serde_json::from_str(input_json)
        .map_err(|error| format!("invalid prover input: {error}"))?;
    let output: HostJsonOutput = serde_json::from_str(output_json)
        .map_err(|error| format!("invalid host output: {error}"))?;
    validate_current_output(&output)?;

    let config = &input.election_config;
    validate_election_config(config)?;
    let computed_config_hash = sha256_json(config)?;
    if computed_config_hash != input.election_config_hash {
        return Err("election_config hash does not match prover input".to_string());
    }
    if config.total_expected != input.total_expected {
        return Err("election_config.totalExpected does not match prover input".to_string());
    }

    let votes = input.commitment_votes()?;
    let input_commitment = compute_input_commitment_v4(
        &input.election_id,
        &input.bulletin_root,
        input.tree_size,
        input.total_expected,
        &votes,
    )?;
    let sth_digest = compute_sth_digest(
        &input.log_id,
        output.tree_size,
        input.timestamp,
        &output.bulletin_root,
    );

    let journal = public_journal(&output)?;
    let public_input = PublicInput {
        schema: PUBLIC_INPUT_ARTIFACT_SCHEMA.to_string(),
        version: PUBLIC_INPUT_ARTIFACT_VERSION.to_string(),
        election_id: uuid_string(&input.election_id),
        election_config_hash: hex_string(&input.election_config_hash),
        bulletin_root: hex_string(&input.bulletin_root),
        tree_size: input.tree_size,
        total_expected: input.total_expected,
        log_id: hex_string(&input.log_id),
        timestamp: input.timestamp,
        method_version: output.method_version,
        votes: input
            .votes
            .iter()
            .map(|vote| PublicInputVote {
                index: vote.index,
                commitment: hex_string(&vote.commitment),
                merkle_path: vote
                    .merkle_path
                    .iter()
                    .map(|node| hex_string(node))
                    .collect(),
            })
            .collect(),
    };
    let election_manifest = ElectionManifest {
        election_id: uuid_string(&input.election_id),
        total_expected: config.total_expected,
        choices: config.choices.clone(),
        version: config.version.clone(),
        bot_count: config.bot_count,
        merkle_tree_depth: config.merkle_tree_depth,
        election_config_hash: hex_string(&computed_config_hash),
    };
    let close_statement = CloseStatement {
        log_id: hex_string(&input.log_id),
        tree_size: output.tree_size,
        timestamp: input.timestamp,
        bulletin_root: hex_string(&output.bulletin_root),
        sth_digest: hex_string(&sth_digest),
    };

    let artifacts = PublicAuditArtifacts {
        journal,
        public_input,
        election_manifest,
        close_statement,
    };
    validate_public_audit_artifacts(&artifacts, &input_commitment, &sth_digest)?;
    Ok(artifacts)
}

fn validate_current_output(output: &HostJsonOutput) -> Result<(), String> {
    if output.method_version != CURRENT_METHOD_VERSION {
        return Err(format!(
            "unsupported methodVersion: expected {CURRENT_METHOD_VERSION}, got {}",
            output.method_version
        ));
    }
    if output.tree_size == 0 {
        return Err("host output treeSize must be positive".to_string());
    }
    normalize_image_id(&output.image_id)?;
    Ok(())
}

fn validate_election_config(config: &ElectionConfig) -> Result<(), String> {
    if config.choices.is_empty() || config.choices.iter().any(String::is_empty) {
        return Err("election_config.choices must contain nonempty choices".to_string());
    }
    if config.version.is_empty() {
        return Err("election_config.version must be nonempty".to_string());
    }
    if config.merkle_tree_depth == 0 {
        return Err("election_config.merkleTreeDepth must be positive".to_string());
    }
    Ok(())
}

fn public_journal(output: &HostJsonOutput) -> Result<PublicJournal, String> {
    Ok(PublicJournal {
        election_id: uuid_string(&output.election_id),
        election_config_hash: hex_string(&output.election_config_hash),
        bulletin_root: hex_string(&output.bulletin_root),
        tree_size: output.tree_size,
        total_expected: output.total_expected,
        sth_digest: hex_string(&output.sth_digest),
        verified_tally: output.verified_tally,
        total_votes: output.total_votes,
        valid_votes: output.valid_votes,
        invalid_votes: output.invalid_votes,
        seen_indices_count: output.seen_indices_count,
        missing_slots: output.missing_slots,
        invalid_presented_slots: output.invalid_presented_slots,
        rejected_records: output.rejected_records,
        seen_bitmap_root: hex_string(&output.seen_bitmap_root),
        included_bitmap_root: hex_string(&output.included_bitmap_root),
        excluded_slots: output.excluded_slots,
        input_commitment: hex_string(&output.input_commitment),
        method_version: output.method_version,
        image_id: normalize_image_id(&output.image_id)?,
    })
}

fn validate_public_audit_artifacts(
    artifacts: &PublicAuditArtifacts,
    computed_input_commitment: &[u8; HASH_BYTES],
    computed_sth_digest: &[u8; HASH_BYTES],
) -> Result<(), String> {
    let journal = &artifacts.journal;
    let public_input = &artifacts.public_input;
    let manifest = &artifacts.election_manifest;
    let close = &artifacts.close_statement;

    if public_input.schema != PUBLIC_INPUT_ARTIFACT_SCHEMA
        || public_input.version != PUBLIC_INPUT_ARTIFACT_VERSION
    {
        return Err("public-input schema or version is invalid".to_string());
    }
    if public_input.method_version != CURRENT_METHOD_VERSION
        || journal.method_version != CURRENT_METHOD_VERSION
    {
        return Err("public audit artifacts use an unsupported methodVersion".to_string());
    }
    if public_input.election_id != journal.election_id
        || public_input.election_config_hash != journal.election_config_hash
        || public_input.bulletin_root != journal.bulletin_root
        || public_input.tree_size != journal.tree_size
        || public_input.total_expected != journal.total_expected
    {
        return Err("public-input drifted from journal".to_string());
    }
    if journal.input_commitment != hex_string(computed_input_commitment) {
        return Err("public-input commitment drifted from journal".to_string());
    }
    if manifest.election_id != journal.election_id
        || manifest.election_id != public_input.election_id
        || manifest.total_expected != journal.total_expected
        || manifest.election_config_hash != journal.election_config_hash
        || manifest.election_config_hash != public_input.election_config_hash
    {
        return Err("election-manifest drifted from proof authority".to_string());
    }
    if close.log_id != public_input.log_id
        || close.timestamp != public_input.timestamp
        || close.tree_size != journal.tree_size
        || close.bulletin_root != journal.bulletin_root
        || close.sth_digest != journal.sth_digest
        || close.sth_digest != hex_string(computed_sth_digest)
    {
        return Err("close-statement drifted from proof authority".to_string());
    }
    Ok(())
}

pub fn validate_serialized_public_audit_artifacts(
    journal_json: &str,
    public_input_json: &str,
    election_manifest_json: &str,
    close_statement_json: &str,
) -> Result<(), String> {
    let artifacts = PublicAuditArtifacts {
        journal: serde_json::from_str(journal_json)
            .map_err(|error| format!("invalid journal artifact: {error}"))?,
        public_input: serde_json::from_str(public_input_json)
            .map_err(|error| format!("invalid public-input artifact: {error}"))?,
        election_manifest: serde_json::from_str(election_manifest_json)
            .map_err(|error| format!("invalid election-manifest artifact: {error}"))?,
        close_statement: serde_json::from_str(close_statement_json)
            .map_err(|error| format!("invalid close-statement artifact: {error}"))?,
    };
    if artifacts.journal.tree_size == 0 {
        return Err("journal treeSize must be positive".to_string());
    }
    normalize_image_id(&artifacts.journal.image_id)?;

    let mut seen = HashSet::with_capacity(artifacts.public_input.votes.len());
    let votes = artifacts
        .public_input
        .votes
        .iter()
        .map(|vote| {
            if !seen.insert(vote.index) {
                return Err("public-input contains duplicate vote index".to_string());
            }
            Ok(VoteWithProof {
                commitment: parse_hex(&vote.commitment, "vote.commitment")?,
                choice: 0,
                random: [0; HASH_BYTES],
                index: vote.index,
                merkle_path: vote
                    .merkle_path
                    .iter()
                    .map(|node| parse_hex(node, "vote.merklePath"))
                    .collect::<Result<Vec<_>, _>>()?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let computed_input_commitment = compute_input_commitment_v4(
        &parse_uuid(&artifacts.public_input.election_id)?,
        &parse_hex(
            &artifacts.public_input.bulletin_root,
            "public-input.bulletinRoot",
        )?,
        artifacts.public_input.tree_size,
        artifacts.public_input.total_expected,
        &votes,
    )?;
    let computed_sth_digest = compute_sth_digest(
        &parse_hex(&artifacts.close_statement.log_id, "close-statement.logId")?,
        artifacts.close_statement.tree_size,
        artifacts.close_statement.timestamp,
        &parse_hex(
            &artifacts.close_statement.bulletin_root,
            "close-statement.bulletinRoot",
        )?,
    );
    let manifest_config = ElectionConfig {
        total_expected: artifacts.election_manifest.total_expected,
        choices: artifacts.election_manifest.choices.clone(),
        version: artifacts.election_manifest.version.clone(),
        bot_count: artifacts.election_manifest.bot_count,
        merkle_tree_depth: artifacts.election_manifest.merkle_tree_depth,
    };
    validate_election_config(&manifest_config)?;
    if artifacts.election_manifest.election_config_hash
        != hex_string(&sha256_json(&manifest_config)?)
    {
        return Err("election-manifest self-hash mismatch".to_string());
    }

    validate_public_audit_artifacts(&artifacts, &computed_input_commitment, &computed_sth_digest)
}

fn sha256_json<T: Serialize>(value: &T) -> Result<[u8; HASH_BYTES], String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("failed to serialize canonical JSON: {error}"))?;
    Ok(Sha256::digest(bytes).into())
}

fn compute_sth_digest(
    log_id: &[u8; HASH_BYTES],
    tree_size: u32,
    timestamp: u64,
    bulletin_root: &[u8; HASH_BYTES],
) -> [u8; HASH_BYTES] {
    let mut digest = Sha256::new();
    digest.update(log_id);
    digest.update(tree_size.to_le_bytes());
    digest.update(timestamp.to_le_bytes());
    digest.update(bulletin_root);
    digest.finalize().into()
}

fn hex_string(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn uuid_string(bytes: &[u8; 16]) -> String {
    let compact = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &compact[0..8],
        &compact[8..12],
        &compact[12..16],
        &compact[16..20],
        &compact[20..32]
    )
}

fn normalize_image_id(value: &str) -> Result<String, String> {
    let compact = value.strip_prefix("0x").unwrap_or(value);
    if compact.len() != HASH_BYTES * 2
        || !compact
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("host output imageId must contain exactly 32 hex bytes".to_string());
    }
    Ok(format!("0x{}", compact.to_ascii_lowercase()))
}

fn parse_hex<const N: usize>(value: &str, label: &str) -> Result<[u8; N], String> {
    let compact = value.strip_prefix("0x").unwrap_or(value);
    if compact.len() != N * 2 {
        return Err(format!("{label} must contain exactly {N} bytes"));
    }
    let decoded = hex::decode(compact).map_err(|_| format!("{label} must be hexadecimal"))?;
    decoded
        .try_into()
        .map_err(|_| format!("{label} must contain exactly {N} bytes"))
}

fn parse_uuid(value: &str) -> Result<[u8; 16], String> {
    let compact = value.replace('-', "");
    parse_hex(&compact, "public-input.electionId")
}

pub fn to_pretty_json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string_pretty(value)
        .map_err(|error| format!("failed to serialize artifact: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use contract_core::current_semantic_contract;
    use serde_json::json;

    fn assert_serialized_field_order(
        serialized: &str,
        fields: &[contract_core::semantic_contract::SemanticField],
    ) {
        let positions: Vec<_> = fields
            .iter()
            .map(|field| {
                serialized
                    .find(&format!("\"{}\":", field.name))
                    .unwrap_or_else(|| panic!("serialized artifact is missing {}", field.name))
            })
            .collect();
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
    }

    fn fixture_json(duplicate_index: bool) -> (String, String) {
        let config = ElectionConfig {
            total_expected: 1,
            choices: vec!["A".to_string(), "B".to_string()],
            version: "current".to_string(),
            bot_count: 0,
            merkle_tree_depth: 1,
        };
        let config_hash = sha256_json(&config).expect("config should hash");
        let vote = VoteWithProof {
            commitment: [0xaa; HASH_BYTES],
            choice: 0,
            random: [0xbb; HASH_BYTES],
            index: 0,
            merkle_path: vec![],
        };
        let mut votes = vec![vote.clone()];
        if duplicate_index {
            votes.push(vote);
        }
        let commitment = compute_input_commitment_v4(&[1; 16], &[2; HASH_BYTES], 1, 1, &votes)
            .expect("commitment should compute");
        let sth = compute_sth_digest(&[3; HASH_BYTES], 1, 1_700_000_000, &[2; HASH_BYTES]);
        let input_votes: Vec<_> = votes
            .iter()
            .map(|entry| {
                json!({
                    "commitment": entry.commitment,
                    "choice": entry.choice,
                    "random": entry.random,
                    "index": entry.index,
                    "merkle_path": entry.merkle_path,
                })
            })
            .collect();
        let input = json!({
            "election_id": vec![1; 16],
            "bulletin_root": vec![2; HASH_BYTES],
            "tree_size": 1,
            "log_id": vec![3; HASH_BYTES],
            "timestamp": 1_700_000_000_u64,
            "total_expected": 1,
            "election_config_hash": config_hash.to_vec(),
            "votes": input_votes,
            "election_config": config,
        });
        let output = HostJsonOutput {
            election_id: [1; 16],
            election_config_hash: config_hash,
            bulletin_root: [2; HASH_BYTES],
            tree_size: 1,
            total_expected: 1,
            sth_digest: sth,
            verified_tally: [1, 0, 0, 0, 0],
            total_votes: 1,
            valid_votes: 1,
            invalid_votes: 0,
            seen_indices_count: 1,
            missing_slots: 0,
            invalid_presented_slots: 0,
            rejected_records: 0,
            seen_bitmap_root: [4; HASH_BYTES],
            included_bitmap_root: [5; HASH_BYTES],
            excluded_slots: 0,
            input_commitment: commitment,
            method_version: CURRENT_METHOD_VERSION,
            image_id: format!("0x{}", "ab".repeat(HASH_BYTES)),
        };
        (
            serde_json::to_string(&input).expect("input should serialize"),
            serde_json::to_string(&output).expect("output should serialize"),
        )
    }

    #[test]
    fn builds_current_public_artifacts_from_exact_host_json() {
        let (input, output) = fixture_json(false);
        let artifacts =
            build_public_audit_artifacts(&input, &output).expect("current artifacts should build");

        assert_eq!(artifacts.journal.method_version, CURRENT_METHOD_VERSION);
        assert_eq!(
            artifacts.journal.election_id,
            "01010101-0101-0101-0101-010101010101"
        );
        assert_eq!(artifacts.public_input.votes.len(), 1);
        let serialized_public_input =
            serde_json::to_string(&artifacts.public_input).expect("public input should serialize");
        let public_input_contract = current_semantic_contract().artifacts.public_input;
        assert_serialized_field_order(&serialized_public_input, public_input_contract.fields);
        assert_serialized_field_order(&serialized_public_input, public_input_contract.vote_fields);
        assert_eq!(
            artifacts.election_manifest.election_config_hash,
            artifacts.journal.election_config_hash
        );
        assert_eq!(
            artifacts.close_statement.sth_digest,
            artifacts.journal.sth_digest
        );
    }

    #[test]
    fn rejects_duplicate_vote_indices_before_canonical_hashing() {
        let (input, output) = fixture_json(true);
        let error =
            build_public_audit_artifacts(&input, &output).expect_err("duplicates must fail closed");

        assert!(error.contains("duplicate vote index"));
    }

    #[test]
    fn rejects_non_current_camel_case_input_fields() {
        let (input, output) = fixture_json(false);
        let input_value: serde_json::Value =
            serde_json::from_str(&input).expect("fixture input should parse");
        let renames = [
            ("election_id", "electionId"),
            ("election_config", "electionConfig"),
        ];

        for (current, non_current) in renames {
            let mut candidate = input_value.clone();
            candidate[non_current] = candidate[current].take();

            build_public_audit_artifacts(&candidate.to_string(), &output)
                .expect_err("non-current camelCase input must fail closed");
        }

        let mut candidate = input_value;
        candidate["votes"][0]["merklePath"] = candidate["votes"][0]["merkle_path"].take();
        build_public_audit_artifacts(&candidate.to_string(), &output)
            .expect_err("non-current nested camelCase input must fail closed");
    }

    #[test]
    fn rejects_a_non_current_host_output() {
        let (input, output) = fixture_json(false);
        let mut output_value: serde_json::Value =
            serde_json::from_str(&output).expect("fixture output should parse");
        output_value["methodVersion"] = json!(CURRENT_METHOD_VERSION - 1);

        let error = build_public_audit_artifacts(&input, &output_value.to_string())
            .expect_err("old method must fail closed");

        assert!(error.contains("unsupported methodVersion"));
    }

    #[test]
    fn serialized_artifacts_are_re_admitted_before_publication() {
        let (input, output) = fixture_json(false);
        let artifacts =
            build_public_audit_artifacts(&input, &output).expect("current artifacts should build");
        let journal = serde_json::to_string(&artifacts.journal).expect("journal should serialize");
        let public_input =
            serde_json::to_string(&artifacts.public_input).expect("public input should serialize");
        let manifest =
            serde_json::to_string(&artifacts.election_manifest).expect("manifest should serialize");
        let close = serde_json::to_string(&artifacts.close_statement)
            .expect("close statement should serialize");

        validate_serialized_public_audit_artifacts(&journal, &public_input, &manifest, &close)
            .expect("serialized current artifacts should be admitted");

        let mut drifted_close: serde_json::Value =
            serde_json::from_str(&close).expect("close statement should parse");
        drifted_close["timestamp"] = json!(1_700_000_001_u64);
        let error = validate_serialized_public_audit_artifacts(
            &journal,
            &public_input,
            &manifest,
            &drifted_close.to_string(),
        )
        .expect_err("cross-artifact drift must fail closed");

        assert!(error.contains("close-statement drifted"));
    }
}
