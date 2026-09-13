use contract_core::{
    compute_bitmap_merkle_root, compute_commitment, validate_guest_work_budget,
    verify_inclusion_proof_rfc6962, AggregatorInput, GuestWorkBudgetError, UnixTimestampMillis,
    VerificationOutput, VoteWithProof, CURRENT_METHOD_VERSION, HOST_INCLUDED_BITMAP_FILE_SUFFIX,
    HOST_OUTPUT_FILE_SUFFIX, HOST_RECEIPT_FILE_SUFFIX, HOST_SEEN_BITMAP_FILE_SUFFIX,
    INCLUDED_BITMAP_ARTIFACT_SCHEMA, INCLUDED_BITMAP_ARTIFACT_VERSION,
    MAX_GUEST_SERIALIZED_INPUT_BYTES, SEEN_BITMAP_ARTIFACT_SCHEMA, SEEN_BITMAP_ARTIFACT_VERSION,
};
use host::artifacts::{ElectionConfig, HostJsonOutput};
use risc0_zkvm::{default_prover, ExecutorEnv};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufReader;
use std::io::{self, Write};

use methods::{GUEST_ELF, GUEST_ID};

#[derive(Debug, PartialEq, Eq)]
enum HostCommand {
    PrintImageId { format: ImageIdOutputFormat },
    Prove { input_path: String },
}

#[derive(Debug, PartialEq, Eq)]
enum ImageIdOutputFormat {
    Plain,
    Json,
}

// JSON-friendly input structure
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JsonInput {
    pub election_id: [u8; 16],
    pub bulletin_root: [u8; 32],
    pub tree_size: u32,
    pub log_id: [u8; 32],
    /// Unix timestamp in milliseconds.
    pub timestamp: u64,
    pub total_expected: u32,
    pub election_config_hash: [u8; 32],
    pub votes: Vec<JsonVoteWithProof>,
    #[serde(default)]
    pub election_config: Option<ElectionConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JsonVoteWithProof {
    pub commitment: [u8; 32],
    pub choice: u8,
    pub random: [u8; 32],
    pub index: u32,
    pub merkle_path: Vec<[u8; 32]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonIncludedBitmapArtifact {
    schema: String,
    version: String,
    tree_size: u32,
    included_bitmap_root: String,
    included_bitmap: Vec<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonSeenBitmapArtifact {
    schema: String,
    version: String,
    tree_size: u32,
    seen_bitmap_root: String,
    seen_bitmap: Vec<bool>,
}

struct ExactBitmaps {
    seen_bitmap: Vec<bool>,
    included_bitmap: Vec<bool>,
}

fn parse_command(args: &[String]) -> Result<HostCommand, String> {
    if args.len() < 2 {
        return Err("Input file required".to_string());
    }

    let mut print_image_id = false;
    let mut format = ImageIdOutputFormat::Plain;
    let mut input_path: Option<String> = None;

    for arg in args.iter().skip(1) {
        match arg.as_str() {
            "--print-image-id" => {
                print_image_id = true;
            }
            "--json" => {
                format = ImageIdOutputFormat::Json;
            }
            value if value.starts_with('-') => {
                return Err(format!("Unknown option: {value}"));
            }
            value => {
                if input_path.is_some() {
                    return Err(format!("Unexpected argument: {value}"));
                }
                input_path = Some(value.to_string());
            }
        }
    }

    if print_image_id {
        if input_path.is_some() {
            return Err("--print-image-id does not accept an input file".to_string());
        }
        return Ok(HostCommand::PrintImageId { format });
    }

    if format == ImageIdOutputFormat::Json {
        return Err("--json requires --print-image-id".to_string());
    }

    input_path
        .map(|input_path| HostCommand::Prove { input_path })
        .ok_or_else(|| "Input file required".to_string())
}

fn current_guest_image_id() -> String {
    let guest_id_bytes: Vec<u8> = GUEST_ID
        .iter()
        .flat_map(|&word| word.to_le_bytes())
        .collect();
    format!("0x{}", hex::encode(&guest_id_bytes))
}

fn write_image_id(
    writer: &mut impl Write,
    format: ImageIdOutputFormat,
) -> Result<(), Box<dyn std::error::Error>> {
    let image_id = current_guest_image_id();

    match format {
        ImageIdOutputFormat::Plain => {
            writeln!(writer, "{image_id}")?;
        }
        ImageIdOutputFormat::Json => {
            let payload = serde_json::json!({
                "imageId": image_id,
                "methodVersion": CURRENT_METHOD_VERSION,
            });
            writeln!(writer, "{}", serde_json::to_string(&payload)?)?;
        }
    }

    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Parse command line arguments
    let args: Vec<String> = std::env::args().collect();
    let command = parse_command(&args).map_err(|message| {
        let program = args.first().map(String::as_str).unwrap_or("host");
        eprintln!("Usage: {program} <input-json-file>");
        eprintln!("       {program} --print-image-id [--json]");
        io::Error::new(io::ErrorKind::InvalidInput, message)
    })?;

    if let HostCommand::PrintImageId { format } = command {
        write_image_id(&mut io::stdout(), format)?;
        return Ok(());
    }

    let input_path = match command {
        HostCommand::Prove { input_path } => input_path,
        HostCommand::PrintImageId { .. } => unreachable!("handled above"),
    };

    println!("RISC Zero Host Program v2");
    println!("Loading input from: {}", input_path);

    let serialized_input_bytes = std::fs::metadata(&input_path)?.len();
    if serialized_input_bytes > MAX_GUEST_SERIALIZED_INPUT_BYTES {
        return Err(format!(
            "zkVM input exceeds serialized byte budget: {} > {}",
            serialized_input_bytes, MAX_GUEST_SERIALIZED_INPUT_BYTES
        )
        .into());
    }

    // Read input file and parse as JSON
    let input_file = File::open(&input_path)?;
    let reader = BufReader::new(input_file);
    let json_input: JsonInput = serde_json::from_reader(reader)?;

    // Convert JSON input to AggregatorInput format
    let aggregator_input = json_to_aggregator_input(&json_input)?;
    validate_host_work_budget(&aggregator_input, serialized_input_bytes)?;
    println!(
        "Prepared {} votes for zkVM processing",
        aggregator_input.votes.len()
    );
    println!(
        "Tree size: {}, Expected: {}",
        aggregator_input.tree_size, aggregator_input.total_expected
    );

    // Create executor environment with direct serialization
    let env = ExecutorEnv::builder().write(&aggregator_input)?.build()?;

    // Generate proof directly
    println!("Executing guest program and generating proof...");
    let prover = default_prover();
    let prove_info = prover.prove(env, GUEST_ELF)?;
    let receipt = prove_info.receipt.clone();

    // Extract and deserialize the journal
    let journal = receipt.journal.clone();

    // Deserialize output
    let output: VerificationOutput = journal.decode()?;
    println!("Output decoded successfully");

    // Display output
    println!("\n=== Guest Program Output ===");
    println!("Election ID: {:?}", output.election_id);
    println!("Method Version: {}", output.method_version);
    println!("\nVerified Tally Results:");
    println!("  Choice A: {} votes", output.verified_tally[0]);
    println!("  Choice B: {} votes", output.verified_tally[1]);
    println!("  Choice C: {} votes", output.verified_tally[2]);
    println!("  Choice D: {} votes", output.verified_tally[3]);
    println!("  Choice E: {} votes", output.verified_tally[4]);
    println!("\nStatistics:");
    println!("  Total Votes Processed: {}", output.total_votes);
    println!("  Valid Votes: {}", output.valid_votes);
    println!("  Invalid Votes: {}", output.invalid_votes);
    println!("\nSlot / Record Counts:");
    println!("  Missing Slots: {}", output.missing_slots);
    println!(
        "  Invalid Presented Slots: {}",
        output.invalid_presented_slots
    );
    println!("  Rejected Records: {}", output.rejected_records);
    println!("  Excluded Slots: {}", output.excluded_slots);

    // Check for potential issues
    if output.missing_slots > 0 {
        println!(
            "\nWARNING: {} votes were not presented to zkVM!",
            output.missing_slots
        );
    }
    if output.invalid_votes > 0 {
        println!("WARNING: {} votes failed validation!", output.invalid_votes);
    }
    if output.total_expected != output.tree_size {
        println!(
            "WARNING: Expected {} votes but tree size is {}",
            output.total_expected, output.tree_size
        );
    }

    // Get the ImageID of the guest program
    // GUEST_ID is [u32; 8], convert to bytes
    let image_id = current_guest_image_id();
    println!("\nGuest Program ImageID: {}", image_id);

    // Convert output to JSON format
    let json_output = HostJsonOutput::from_verification_output(output.clone(), image_id.clone());

    // Save output as JSON
    let output_file = input_path.replace(".json", HOST_OUTPUT_FILE_SUFFIX);
    let output_json = serde_json::to_string_pretty(&json_output)?;
    std::fs::write(&output_file, output_json)?;
    println!("\nOutput saved to: {}", output_file);

    let ExactBitmaps {
        seen_bitmap,
        included_bitmap,
    } = build_exact_bitmaps(&aggregator_input);
    let computed_seen_bitmap_root = compute_bitmap_merkle_root(&seen_bitmap);
    let computed_included_bitmap_root = compute_bitmap_merkle_root(&included_bitmap);
    let seen_bitmap_file = input_path.replace(".json", HOST_SEEN_BITMAP_FILE_SUFFIX);
    let bitmap_file = input_path.replace(".json", HOST_INCLUDED_BITMAP_FILE_SUFFIX);
    std::fs::remove_file(&seen_bitmap_file).ok();
    std::fs::remove_file(&bitmap_file).ok();
    if computed_seen_bitmap_root == output.seen_bitmap_root {
        let seen_bitmap_artifact = JsonSeenBitmapArtifact {
            schema: SEEN_BITMAP_ARTIFACT_SCHEMA.to_string(),
            version: SEEN_BITMAP_ARTIFACT_VERSION.to_string(),
            tree_size: aggregator_input.tree_size,
            seen_bitmap_root: format!("0x{}", hex::encode(computed_seen_bitmap_root)),
            seen_bitmap,
        };
        let bitmap_data = serde_json::to_string_pretty(&seen_bitmap_artifact)?;
        std::fs::write(&seen_bitmap_file, bitmap_data)?;
        println!("Seen bitmap saved to: {}", seen_bitmap_file);
    } else {
        eprintln!(
            "WARNING: exact seen bitmap root mismatch; skipping seen bitmap artifact (expected {}, computed {})",
            hex::encode(output.seen_bitmap_root),
            hex::encode(computed_seen_bitmap_root)
        );
    }
    if computed_included_bitmap_root == output.included_bitmap_root {
        let bitmap_artifact = JsonIncludedBitmapArtifact {
            schema: INCLUDED_BITMAP_ARTIFACT_SCHEMA.to_string(),
            version: INCLUDED_BITMAP_ARTIFACT_VERSION.to_string(),
            tree_size: aggregator_input.tree_size,
            included_bitmap_root: format!("0x{}", hex::encode(computed_included_bitmap_root)),
            included_bitmap,
        };
        let bitmap_data = serde_json::to_string_pretty(&bitmap_artifact)?;
        std::fs::write(&bitmap_file, bitmap_data)?;
        println!("Included bitmap saved to: {}", bitmap_file);
    } else {
        eprintln!(
            "WARNING: exact included bitmap root mismatch; skipping bitmap artifact (expected {}, computed {})",
            hex::encode(output.included_bitmap_root),
            hex::encode(computed_included_bitmap_root)
        );
    }

    // Save receipt to file with ImageID included
    let receipt_file = input_path.replace(".json", HOST_RECEIPT_FILE_SUFFIX);

    // Create a custom structure for the receipt with ImageID
    #[derive(Debug, Clone, Serialize)]
    struct ReceiptWithImageId {
        receipt: serde_json::Value, // Use JSON Value for flexibility
        image_id: String,
    }

    // Serialize the receipt to JSON value first
    let receipt_json = serde_json::to_value(&receipt)?;

    let receipt_with_id = ReceiptWithImageId {
        receipt: receipt_json,
        image_id,
    };

    let receipt_data = serde_json::to_string_pretty(&receipt_with_id)?;
    std::fs::write(&receipt_file, receipt_data)?;
    println!("Receipt saved to: {}", receipt_file);

    Ok(())
}

fn validate_host_work_budget(
    input: &AggregatorInput,
    serialized_input_bytes: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    validate_guest_work_budget(input, Some(serialized_input_bytes))
        .map(|_| ())
        .map_err(|error| format_guest_work_budget_error(error).into())
}

fn format_guest_work_budget_error(error: GuestWorkBudgetError) -> String {
    match error {
        GuestWorkBudgetError::TreeSizeOutOfBounds { actual, min, max } => {
            format!(
                "zkVM input tree_size exceeds guest contract bounds: {actual} not in {min}..{max}"
            )
        }
        GuestWorkBudgetError::TotalExpectedExceeded { actual, max } => {
            format!("zkVM input total_expected exceeds guest contract bound: {actual} > {max}")
        }
        GuestWorkBudgetError::VoteCountExceeded { actual, max } => {
            format!("zkVM input vote count exceeds guest contract bound: {actual} > {max}")
        }
        GuestWorkBudgetError::MerklePathNodesPerRecordExceeded {
            vote_position,
            actual,
            max,
        } => {
            format!("zkVM input votes[{vote_position}] Merkle path length exceeds per-record budget: {actual} > {max}")
        }
        GuestWorkBudgetError::TotalPathNodesExceeded { actual, max } => {
            format!("zkVM input exceeds total Merkle path node budget: {actual} > {max}")
        }
        GuestWorkBudgetError::SerializedInputBytesExceeded { actual, max } => {
            format!("zkVM input exceeds serialized byte budget: {actual} > {max}")
        }
        GuestWorkBudgetError::StructuralInputBytesExceeded { actual, max } => {
            format!("zkVM input exceeds structural byte budget: {actual} > {max}")
        }
        GuestWorkBudgetError::StructuralInputBytesOverflow => {
            "zkVM input structural byte budget calculation overflowed".to_string()
        }
    }
}

fn build_exact_bitmaps(input: &AggregatorInput) -> ExactBitmaps {
    let tree_size = input.tree_size as usize;
    let mut seen_bitmap = vec![false; tree_size];
    let mut included_bitmap = vec![false; tree_size];
    let mut index_seen = vec![false; tree_size];
    let mut seen_commitments: Vec<[u8; 32]> = Vec::with_capacity(input.votes.len());

    for vote in &input.votes {
        if vote.index >= input.tree_size {
            continue;
        }

        let index = vote.index as usize;
        if index_seen[index] {
            continue;
        }
        index_seen[index] = true;
        seen_bitmap[index] = true;

        if vote.choice >= 5 {
            continue;
        }

        let computed_commitment = compute_commitment(&input.election_id, vote.choice, &vote.random);
        if computed_commitment != vote.commitment {
            continue;
        }

        match seen_commitments.binary_search(&computed_commitment) {
            Ok(_) => continue,
            Err(position) => seen_commitments.insert(position, computed_commitment),
        }

        if !verify_inclusion_proof_rfc6962(
            &vote.commitment,
            vote.index,
            &vote.merkle_path,
            &input.bulletin_root,
            input.tree_size,
        ) {
            continue;
        }

        included_bitmap[index] = true;
    }

    ExactBitmaps {
        seen_bitmap,
        included_bitmap,
    }
}

/// Convert JSON input to AggregatorInput format
fn json_to_aggregator_input(
    json_input: &JsonInput,
) -> Result<AggregatorInput, Box<dyn std::error::Error>> {
    let timestamp = UnixTimestampMillis::new(json_input.timestamp)
        .map_err(|_| String::from("timestamp must be positive Unix timestamp milliseconds"))?;
    let votes = json_input
        .votes
        .iter()
        .map(|vote| VoteWithProof {
            commitment: vote.commitment,
            choice: vote.choice,
            random: vote.random,
            index: vote.index,
            merkle_path: vote.merkle_path.clone(),
        })
        .collect();

    Ok(AggregatorInput {
        election_id: json_input.election_id,
        bulletin_root: json_input.bulletin_root,
        tree_size: json_input.tree_size,
        log_id: json_input.log_id,
        timestamp: timestamp.get(),
        total_expected: json_input.total_expected,
        election_config_hash: json_input.election_config_hash,
        votes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use contract_core::{hash_internal, hash_leaf};
    use serde_json::json;
    #[cfg(feature = "production")]
    use std::sync::{Mutex, MutexGuard, OnceLock};

    #[cfg(feature = "production")]
    fn lock_env() -> MutexGuard<'static, ()> {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("env lock poisoned")
    }

    #[test]
    fn test_json_to_aggregator_input() {
        let input = JsonInput {
            election_id: [1u8; 16],
            bulletin_root: [2u8; 32],
            tree_size: 4,
            log_id: [3u8; 32],
            timestamp: 1_234_567_890_000,
            total_expected: 4,
            election_config_hash: [4u8; 32],
            election_config: None,
            votes: vec![
                JsonVoteWithProof {
                    choice: 0,
                    commitment: [100; 32],
                    random: [42; 32],
                    index: 0,
                    merkle_path: vec![],
                },
                JsonVoteWithProof {
                    choice: 1,
                    commitment: [101; 32],
                    random: [1; 32],
                    index: 1,
                    merkle_path: vec![[5u8; 32]],
                },
            ],
        };

        let aggregator_input = json_to_aggregator_input(&input).unwrap();
        assert_eq!(aggregator_input.votes.len(), 2);
        assert_eq!(aggregator_input.tree_size, 4);
        assert_eq!(aggregator_input.total_expected, 4);
    }

    #[test]
    fn test_json_to_aggregator_input_rejects_zero_timestamp() {
        let input = JsonInput {
            election_id: [1u8; 16],
            bulletin_root: [2u8; 32],
            tree_size: 4,
            log_id: [3u8; 32],
            timestamp: 0,
            total_expected: 4,
            election_config_hash: [4u8; 32],
            election_config: None,
            votes: vec![],
        };

        let error = json_to_aggregator_input(&input).unwrap_err().to_string();
        assert_eq!(
            error,
            "timestamp must be positive Unix timestamp milliseconds"
        );
    }

    #[test]
    fn exact_json_input_rejects_unknown_fields_and_admits_artifact_config() {
        let input = json!({
            "election_id": vec![1u8; 16],
            "bulletin_root": vec![2u8; 32],
            "tree_size": 1,
            "log_id": vec![3u8; 32],
            "timestamp": 1_700_000_000_000_u64,
            "total_expected": 1,
            "election_config_hash": vec![4u8; 32],
            "votes": [{
                "commitment": vec![5u8; 32],
                "choice": 0,
                "random": vec![6u8; 32],
                "index": 0,
                "merkle_path": [],
            }],
            "election_config": {
                "totalExpected": 1,
                "choices": ["A", "B", "C", "D", "E"],
                "version": "v1.0",
                "botCount": 0,
                "merkleTreeDepth": 1,
            },
        });

        serde_json::from_value::<JsonInput>(input.clone())
            .expect("the current artifact-augmented input should be admitted");

        let mut unknown_top_level = input.clone();
        unknown_top_level["compatibilityMarker"] = json!("retired");
        serde_json::from_value::<JsonInput>(unknown_top_level)
            .expect_err("unknown top-level input fields must fail closed");

        for field in [
            "election_id",
            "bulletin_root",
            "log_id",
            "election_config_hash",
        ] {
            let mut wrong_length = input.clone();
            wrong_length[field] = json!([0]);
            serde_json::from_value::<JsonInput>(wrong_length)
                .expect_err("fixed-length input bytes must be rejected during JSON admission");
        }
        for field in ["commitment", "random"] {
            let mut wrong_length = input.clone();
            wrong_length["votes"][0][field] = json!([0]);
            serde_json::from_value::<JsonInput>(wrong_length)
                .expect_err("fixed-length vote bytes must be rejected during JSON admission");
        }
        let mut wrong_path_length = input.clone();
        wrong_path_length["votes"][0]["merkle_path"] = json!([[0]]);
        serde_json::from_value::<JsonInput>(wrong_path_length)
            .expect_err("Merkle siblings must have the exact hash width");

        let mut unknown_vote_field = input;
        unknown_vote_field["votes"][0]["merklePath"] = json!([]);
        serde_json::from_value::<JsonInput>(unknown_vote_field)
            .expect_err("unknown nested vote fields must fail closed");
    }

    #[test]
    fn test_host_work_budget_accepts_max_serialized_bytes() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [2u8; 32],
            tree_size: 1,
            log_id: [3u8; 32],
            timestamp: 123,
            total_expected: 1,
            election_config_hash: [4u8; 32],
            votes: vec![],
        };

        assert!(validate_host_work_budget(&input, MAX_GUEST_SERIALIZED_INPUT_BYTES).is_ok());
    }

    #[test]
    fn test_host_work_budget_rejects_over_serialized_bytes() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [2u8; 32],
            tree_size: 1,
            log_id: [3u8; 32],
            timestamp: 123,
            total_expected: 1,
            election_config_hash: [4u8; 32],
            votes: vec![],
        };

        let error = validate_host_work_budget(&input, MAX_GUEST_SERIALIZED_INPUT_BYTES + 1)
            .unwrap_err()
            .to_string();
        assert!(error.contains("zkVM input exceeds serialized byte budget"));
    }

    #[test]
    fn test_host_work_budget_rejects_over_path_nodes() {
        let vote_count = 50_000;
        let path_len = (contract_core::MAX_GUEST_TOTAL_PATH_NODES / vote_count) + 1;
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [2u8; 32],
            tree_size: 1,
            log_id: [3u8; 32],
            timestamp: 123,
            total_expected: 1,
            election_config_hash: [4u8; 32],
            votes: vec![
                VoteWithProof {
                    commitment: [5u8; 32],
                    choice: 0,
                    random: [6u8; 32],
                    index: 0,
                    merkle_path: vec![[7u8; 32]; path_len],
                };
                vote_count
            ],
        };

        let error = validate_host_work_budget(&input, 1024)
            .unwrap_err()
            .to_string();
        assert!(error.contains("zkVM input exceeds total Merkle path node budget"));
    }

    #[test]
    fn test_host_work_budget_rejects_oversized_tree_size_before_executor() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [2u8; 32],
            tree_size: contract_core::MAX_GUEST_TREE_SIZE + 1,
            log_id: [3u8; 32],
            timestamp: 123,
            total_expected: 1,
            election_config_hash: [4u8; 32],
            votes: vec![],
        };

        let error = validate_host_work_budget(&input, 1024)
            .unwrap_err()
            .to_string();
        assert!(error.contains("zkVM input tree_size exceeds guest contract bounds"));
    }

    #[test]
    fn test_host_work_budget_rejects_oversized_total_expected_before_executor() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [2u8; 32],
            tree_size: 1,
            log_id: [3u8; 32],
            timestamp: 123,
            total_expected: contract_core::MAX_GUEST_TOTAL_EXPECTED + 1,
            election_config_hash: [4u8; 32],
            votes: vec![],
        };

        let error = validate_host_work_budget(&input, 1024)
            .unwrap_err()
            .to_string();
        assert!(error.contains("zkVM input total_expected exceeds guest contract bound"));
    }

    #[test]
    fn test_host_work_budget_rejects_oversized_per_record_path_before_executor() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [2u8; 32],
            tree_size: 1,
            log_id: [3u8; 32],
            timestamp: 123,
            total_expected: 1,
            election_config_hash: [4u8; 32],
            votes: vec![VoteWithProof {
                commitment: [5u8; 32],
                choice: 0,
                random: [6u8; 32],
                index: 0,
                merkle_path: vec![
                    [7u8; 32];
                    contract_core::MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD + 1
                ],
            }],
        };

        let error = validate_host_work_budget(&input, 1024)
            .unwrap_err()
            .to_string();
        assert!(error.contains("Merkle path length exceeds per-record budget"));
    }

    #[test]
    fn test_receipt_contains_image_id() {
        assert_eq!(GUEST_ID.len(), 8, "GUEST_ID should be [u32; 8]");

        let image_id = current_guest_image_id();

        assert!(image_id.starts_with("0x"));
        assert_eq!(image_id.len(), 66);
    }

    #[test]
    fn test_parse_image_id_only_mode() {
        let args = vec![
            String::from("host"),
            String::from("--print-image-id"),
            String::from("--json"),
        ];

        let command = parse_command(&args).expect("image ID command should parse");

        assert!(matches!(
            command,
            HostCommand::PrintImageId {
                format: ImageIdOutputFormat::Json
            }
        ));
    }

    #[test]
    #[cfg(feature = "production")]
    fn production_feature_rejects_risc0_dev_mode_env() {
        let _env_lock = lock_env();
        let original = std::env::var_os("RISC0_DEV_MODE");
        unsafe {
            std::env::set_var("RISC0_DEV_MODE", "1");
        }

        let result = std::panic::catch_unwind(|| {
            #[allow(deprecated)]
            {
                let _ = risc0_zkvm::is_dev_mode();
            }
        });

        match original {
            Some(value) => unsafe {
                std::env::set_var("RISC0_DEV_MODE", value);
            },
            None => unsafe {
                std::env::remove_var("RISC0_DEV_MODE");
            },
        }

        assert!(
            result.is_err(),
            "production host builds must reject inherited RISC0_DEV_MODE"
        );
    }

    fn current_input_sentinel() -> AggregatorInput {
        AggregatorInput {
            election_id: [0, 1, 2, 3, 4, 5, 0x46, 7, 0x88, 9, 10, 11, 12, 13, 14, 15],
            bulletin_root: [0x20; 32],
            tree_size: 5,
            log_id: [0x30; 32],
            timestamp: 1_234_567_890_000,
            total_expected: 5,
            election_config_hash: [0x40; 32],
            votes: vec![VoteWithProof {
                commitment: [0x50; 32],
                choice: 4,
                random: [0x60; 32],
                index: 3,
                merkle_path: vec![[0x70; 32], [0x80; 32]],
            }],
        }
    }

    fn assert_aggregator_input_eq(actual: &AggregatorInput, expected: &AggregatorInput) {
        assert_eq!(actual.election_id, expected.election_id);
        assert_eq!(actual.bulletin_root, expected.bulletin_root);
        assert_eq!(actual.tree_size, expected.tree_size);
        assert_eq!(actual.log_id, expected.log_id);
        assert_eq!(actual.timestamp, expected.timestamp);
        assert_eq!(actual.total_expected, expected.total_expected);
        assert_eq!(actual.election_config_hash, expected.election_config_hash);
        assert_eq!(actual.votes.len(), expected.votes.len());
        for (actual_vote, expected_vote) in actual.votes.iter().zip(&expected.votes) {
            assert_eq!(actual_vote.commitment, expected_vote.commitment);
            assert_eq!(actual_vote.choice, expected_vote.choice);
            assert_eq!(actual_vote.random, expected_vote.random);
            assert_eq!(actual_vote.index, expected_vote.index);
            assert_eq!(actual_vote.merkle_path, expected_vote.merkle_path);
        }
    }

    fn current_journal_sentinel() -> VerificationOutput {
        VerificationOutput {
            election_id: [0, 1, 2, 3, 4, 5, 0x46, 7, 0x88, 9, 10, 11, 12, 13, 14, 15],
            election_config_hash: [0x10; 32],
            bulletin_root: [0x20; 32],
            tree_size: 5,
            total_expected: 5,
            sth_digest: [0x30; 32],
            verified_tally: [1, 1, 1, 1, 1],
            total_votes: 5,
            valid_votes: 5,
            invalid_votes: 0,
            seen_indices_count: 5,
            missing_slots: 0,
            invalid_presented_slots: 0,
            rejected_records: 0,
            seen_bitmap_root: [0x40; 32],
            included_bitmap_root: [0x40; 32],
            excluded_slots: 0,
            input_commitment: [0x60; 32],
            method_version: CURRENT_METHOD_VERSION,
        }
    }

    fn assert_verification_output_eq(actual: &VerificationOutput, expected: &VerificationOutput) {
        assert_eq!(actual.election_id, expected.election_id);
        assert_eq!(actual.election_config_hash, expected.election_config_hash);
        assert_eq!(actual.bulletin_root, expected.bulletin_root);
        assert_eq!(actual.tree_size, expected.tree_size);
        assert_eq!(actual.total_expected, expected.total_expected);
        assert_eq!(actual.sth_digest, expected.sth_digest);
        assert_eq!(actual.verified_tally, expected.verified_tally);
        assert_eq!(actual.total_votes, expected.total_votes);
        assert_eq!(actual.valid_votes, expected.valid_votes);
        assert_eq!(actual.invalid_votes, expected.invalid_votes);
        assert_eq!(actual.seen_indices_count, expected.seen_indices_count);
        assert_eq!(actual.missing_slots, expected.missing_slots);
        assert_eq!(
            actual.invalid_presented_slots,
            expected.invalid_presented_slots
        );
        assert_eq!(actual.rejected_records, expected.rejected_records);
        assert_eq!(actual.seen_bitmap_root, expected.seen_bitmap_root);
        assert_eq!(actual.included_bitmap_root, expected.included_bitmap_root);
        assert_eq!(actual.excluded_slots, expected.excluded_slots);
        assert_eq!(actual.input_commitment, expected.input_commitment);
        assert_eq!(actual.method_version, expected.method_version);
    }

    #[test]
    fn current_input_round_trips_through_risc0_serde() {
        let expected = current_input_sentinel();
        let encoded_words = risc0_zkvm::serde::to_vec(&expected)
            .expect("current input sentinel should serialize through RISC Zero serde");
        let decoded: AggregatorInput = risc0_zkvm::serde::from_slice(&encoded_words)
            .expect("current input sentinel should decode through the guest input boundary");

        assert_aggregator_input_eq(&decoded, &expected);
    }

    #[test]
    fn current_journal_round_trips_through_risc0_serde() {
        let expected = current_journal_sentinel();
        let encoded_words = risc0_zkvm::serde::to_vec(&expected)
            .expect("current journal sentinel should serialize through RISC Zero serde");
        eprintln!(
            "non-normative RISC Zero serde journal sentinel length: {} bytes",
            encoded_words.len() * std::mem::size_of::<u32>()
        );
        let encoded_bytes = encoded_words
            .iter()
            .flat_map(|word| word.to_le_bytes())
            .collect();
        let decoded: VerificationOutput = risc0_zkvm::Journal::new(encoded_bytes)
            .decode()
            .expect("current journal sentinel should decode through the host journal boundary");

        assert_verification_output_eq(&decoded, &expected);
    }

    #[test]
    fn current_journal_host_json_matches_rust_owned_sentinel() {
        let output = HostJsonOutput::from_verification_output(
            current_journal_sentinel(),
            "0xabababababababababababababababababababababababababababababababab".to_string(),
        );
        let actual =
            serde_json::to_value(output).expect("host journal projection should serialize");
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../contract-core/testdata/current-journal-host-json-sentinel.json"
        ))
        .expect("current host JSON sentinel should parse");

        assert_eq!(actual, expected);
    }

    #[test]
    fn host_json_projection_matches_current_semantic_descriptor() {
        let output = HostJsonOutput::from_verification_output(
            current_journal_sentinel(),
            "0xabababababababababababababababababababababababababababababababab".to_string(),
        );
        let serialized =
            serde_json::to_string(&output).expect("host journal projection should serialize");
        let fields = contract_core::current_semantic_contract()
            .host_json_projection
            .fields;
        let positions: Vec<usize> = fields
            .iter()
            .map(|field| {
                serialized
                    .find(&format!("\"{}\":", field.name))
                    .unwrap_or_else(|| panic!("host JSON projection is missing {}", field.name))
            })
            .collect();

        assert!(
            positions.windows(2).all(|pair| pair[0] < pair[1]),
            "host JSON projection field order drifted"
        );
    }

    #[test]
    fn current_bitmap_artifacts_match_rust_owned_sentinel() {
        let included_bitmap = vec![true, false, true, true, false, false, true, false];
        let seen_bitmap = vec![
            true, false, false, true, false, false, false, false, false, false, false, true,
        ];
        let included_bitmap_root = compute_bitmap_merkle_root(&included_bitmap);
        let seen_bitmap_root = compute_bitmap_merkle_root(&seen_bitmap);
        let actual = serde_json::json!({
            "included": JsonIncludedBitmapArtifact {
                schema: INCLUDED_BITMAP_ARTIFACT_SCHEMA.to_string(),
                version: INCLUDED_BITMAP_ARTIFACT_VERSION.to_string(),
                tree_size: included_bitmap.len() as u32,
                included_bitmap_root: format!("0x{}", hex::encode(included_bitmap_root)),
                included_bitmap,
            },
            "seen": JsonSeenBitmapArtifact {
                schema: SEEN_BITMAP_ARTIFACT_SCHEMA.to_string(),
                version: SEEN_BITMAP_ARTIFACT_VERSION.to_string(),
                tree_size: seen_bitmap.len() as u32,
                seen_bitmap_root: format!("0x{}", hex::encode(seen_bitmap_root)),
                seen_bitmap,
            },
        });
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../contract-core/testdata/current-bitmap-artifacts-sentinel.json"
        ))
        .expect("current bitmap artifact sentinel should parse");

        assert_eq!(actual, expected);
    }

    #[test]
    fn test_exact_included_bitmap_preserves_non_prefix_exclusion() {
        let election_id = [9u8; 16];
        let randoms = [[1u8; 32], [2u8; 32]];
        let choices = [0u8, 1u8];

        let commitments = [
            compute_commitment(&election_id, choices[0], &randoms[0]),
            compute_commitment(&election_id, choices[1], &randoms[1]),
        ];

        let h0 = hash_leaf(&commitments[0]);
        let h1 = hash_leaf(&commitments[1]);
        let root = hash_internal(&h0, &h1);

        let input = AggregatorInput {
            election_id,
            bulletin_root: root,
            tree_size: 2,
            log_id: [7u8; 32],
            timestamp: 123,
            total_expected: 2,
            election_config_hash: [8u8; 32],
            votes: vec![
                VoteWithProof {
                    commitment: commitments[0],
                    choice: choices[0],
                    random: [9u8; 32],
                    index: 0,
                    merkle_path: vec![h1],
                },
                VoteWithProof {
                    commitment: commitments[1],
                    choice: choices[1],
                    random: randoms[1],
                    index: 1,
                    merkle_path: vec![h0],
                },
            ],
        };

        let bitmap = build_exact_bitmaps(&input).included_bitmap;
        assert_eq!(bitmap, vec![false, true]);

        let bitmap_root = compute_bitmap_merkle_root(&bitmap);
        assert_ne!(bitmap_root, [0u8; 32]);
    }

    #[test]
    fn test_exact_included_bitmap_matches_guest_output_for_same_input() {
        let election_id = [9u8; 16];
        let randoms = [[1u8; 32], [2u8; 32]];
        let choices = [0u8, 1u8];

        let commitments = [
            compute_commitment(&election_id, choices[0], &randoms[0]),
            compute_commitment(&election_id, choices[1], &randoms[1]),
        ];

        let h0 = hash_leaf(&commitments[0]);
        let h1 = hash_leaf(&commitments[1]);
        let root = hash_internal(&h0, &h1);

        let input = AggregatorInput {
            election_id,
            bulletin_root: root,
            tree_size: 2,
            log_id: [7u8; 32],
            timestamp: 123,
            total_expected: 2,
            election_config_hash: [8u8; 32],
            votes: vec![
                VoteWithProof {
                    commitment: commitments[0],
                    choice: choices[0],
                    random: [9u8; 32],
                    index: 0,
                    merkle_path: vec![h1],
                },
                VoteWithProof {
                    commitment: commitments[1],
                    choice: choices[1],
                    random: randoms[1],
                    index: 1,
                    merkle_path: vec![h0],
                },
            ],
        };

        let env = ExecutorEnv::builder()
            .write(&input)
            .expect("guest input should serialize")
            .build()
            .expect("executor environment should build");
        let receipt = default_prover()
            .prove(env, GUEST_ELF)
            .expect("guest execution should succeed")
            .receipt;
        let guest_output: VerificationOutput = receipt
            .journal
            .decode()
            .expect("guest journal should decode");

        let bitmap = build_exact_bitmaps(&input).included_bitmap;
        let bitmap_root = compute_bitmap_merkle_root(&bitmap);

        assert_eq!(bitmap, vec![false, true]);
        assert_eq!(bitmap_root, guest_output.included_bitmap_root);
        assert_eq!(guest_output.invalid_presented_slots, 1);
        assert_eq!(guest_output.rejected_records, 1);
        assert_eq!(guest_output.excluded_slots, 1);
    }

    #[test]
    fn test_guest_accepts_extra_records_beyond_tree_size_and_counts_them_as_rejected() {
        let election_id = [9u8; 16];
        let random_valid = [1u8; 32];
        let commitment_valid = compute_commitment(&election_id, 0, &random_valid);
        let root = hash_leaf(&commitment_valid);

        let input = AggregatorInput {
            election_id,
            bulletin_root: root,
            tree_size: 1,
            log_id: [7u8; 32],
            timestamp: 123,
            total_expected: 1,
            election_config_hash: [8u8; 32],
            votes: vec![
                VoteWithProof {
                    commitment: commitment_valid,
                    choice: 0,
                    random: random_valid,
                    index: 0,
                    merkle_path: vec![],
                },
                VoteWithProof {
                    commitment: [2u8; 32],
                    choice: 1,
                    random: [3u8; 32],
                    index: 9,
                    merkle_path: vec![],
                },
            ],
        };

        let env = ExecutorEnv::builder()
            .write(&input)
            .expect("guest input should serialize")
            .build()
            .expect("executor environment should build");
        let receipt = default_prover()
            .prove(env, GUEST_ELF)
            .expect("guest execution should succeed with extra rejected records")
            .receipt;
        let guest_output: VerificationOutput = receipt
            .journal
            .decode()
            .expect("guest journal should decode");

        assert_eq!(guest_output.valid_votes, 1);
        assert_eq!(guest_output.invalid_votes, 1);
        assert_eq!(guest_output.seen_indices_count, 1);
        assert_eq!(guest_output.missing_slots, 0);
        assert_eq!(guest_output.invalid_presented_slots, 0);
        assert_eq!(guest_output.rejected_records, 1);
        assert_eq!(guest_output.excluded_slots, 0);
    }
}
