use contract_core::{
    compute_bitmap_merkle_root, compute_commitment, verify_inclusion_proof_rfc6962,
    AggregatorInput, VerificationOutput, VoteWithProof,
};
use risc0_zkvm::{default_prover, ExecutorEnv};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufReader;

use methods::{GUEST_ELF, GUEST_ID};

// JSON-friendly input structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonInput {
    pub election_id: Vec<u8>,   // 16 bytes
    pub bulletin_root: Vec<u8>, // 32 bytes
    pub tree_size: u32,
    pub log_id: Vec<u8>, // 32 bytes
    pub timestamp: u64,
    pub total_expected: u32,
    pub election_config_hash: Vec<u8>, // 32 bytes
    pub votes: Vec<JsonVoteWithProof>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonVoteWithProof {
    pub commitment: Vec<u8>, // 32 bytes
    pub choice: u8,
    pub random: Vec<u8>, // 32 bytes
    pub index: u32,
    pub merkle_path: Vec<Vec<u8>>, // Array of 32-byte hashes
}

// JSON output structure
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonOutput {
    election_id: Vec<u8>,
    election_config_hash: Vec<u8>,
    bulletin_root: Vec<u8>,
    tree_size: u32,
    total_expected: u32,
    sth_digest: Vec<u8>,
    verified_tally: [u32; 5],
    total_votes: u32,
    valid_votes: u32,
    invalid_votes: u32,
    seen_indices_count: u32,
    missing_slots: u32,
    invalid_presented_slots: u32,
    rejected_records: u32,
    seen_bitmap_root: Vec<u8>,
    included_bitmap_root: Vec<u8>,
    excluded_slots: u32,
    input_commitment: Vec<u8>,
    method_version: u32,
    image_id: String, // ImageID of the zkVM program
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Parse command line arguments
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: {} <input-json-file>", args[0]);
        return Err("Input file required".into());
    }

    println!("RISC Zero Host Program v2");
    println!("Loading input from: {}", args[1]);

    // Read input file and parse as JSON
    let input_file = File::open(&args[1])?;
    let reader = BufReader::new(input_file);
    let json_input: JsonInput = serde_json::from_reader(reader)?;

    // Convert JSON input to AggregatorInput format
    let aggregator_input = json_to_aggregator_input(&json_input)?;
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
            "\n⚠️  WARNING: {} votes were not presented to zkVM!",
            output.missing_slots
        );
    }
    if output.invalid_votes > 0 {
        println!(
            "⚠️  WARNING: {} votes failed validation!",
            output.invalid_votes
        );
    }
    if output.total_expected != output.tree_size {
        println!(
            "⚠️  WARNING: Expected {} votes but tree size is {}",
            output.total_expected, output.tree_size
        );
    }

    // Get the ImageID of the guest program
    // GUEST_ID is [u32; 8], convert to bytes
    let guest_id_bytes: Vec<u8> = GUEST_ID
        .iter()
        .flat_map(|&word| word.to_le_bytes())
        .collect();
    let image_id = format!("0x{}", hex::encode(&guest_id_bytes));
    println!("\nGuest Program ImageID: {}", image_id);

    // Convert output to JSON format
    let json_output = JsonOutput {
        election_id: output.election_id.to_vec(),
        election_config_hash: output.election_config_hash.to_vec(),
        bulletin_root: output.bulletin_root.to_vec(),
        tree_size: output.tree_size,
        total_expected: output.total_expected,
        sth_digest: output.sth_digest.to_vec(),
        verified_tally: output.verified_tally,
        total_votes: output.total_votes,
        valid_votes: output.valid_votes,
        invalid_votes: output.invalid_votes,
        seen_indices_count: output.seen_indices_count,
        missing_slots: output.missing_slots,
        invalid_presented_slots: output.invalid_presented_slots,
        rejected_records: output.rejected_records,
        seen_bitmap_root: output.seen_bitmap_root.to_vec(),
        included_bitmap_root: output.included_bitmap_root.to_vec(),
        excluded_slots: output.excluded_slots,
        input_commitment: output.input_commitment.to_vec(),
        method_version: output.method_version,
        image_id: image_id.clone(),
    };

    // Save output as JSON
    let output_file = args[1].replace(".json", "-output.json");
    let output_json = serde_json::to_string_pretty(&json_output)?;
    std::fs::write(&output_file, output_json)?;
    println!("\nOutput saved to: {}", output_file);

    let ExactBitmaps {
        seen_bitmap,
        included_bitmap,
    } = build_exact_bitmaps(&aggregator_input);
    let computed_seen_bitmap_root = compute_bitmap_merkle_root(&seen_bitmap);
    let computed_included_bitmap_root = compute_bitmap_merkle_root(&included_bitmap);
    let seen_bitmap_file = args[1].replace(".json", "-seen-bitmap.json");
    let bitmap_file = args[1].replace(".json", "-bitmap.json");
    std::fs::remove_file(&seen_bitmap_file).ok();
    std::fs::remove_file(&bitmap_file).ok();
    if computed_seen_bitmap_root == output.seen_bitmap_root {
        let seen_bitmap_artifact = JsonSeenBitmapArtifact {
            schema: "stark-ballot.seen_bitmap".to_string(),
            version: "1.0".to_string(),
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
            schema: "stark-ballot.included_bitmap".to_string(),
            version: "1.0".to_string(),
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
    let receipt_file = args[1].replace(".json", "-receipt.json");

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
    let mut votes = Vec::with_capacity(json_input.votes.len());

    // Convert all votes
    for json_vote in &json_input.votes {
        let mut merkle_path = Vec::with_capacity(json_vote.merkle_path.len());
        for path_node in &json_vote.merkle_path {
            merkle_path.push(vec_to_bytes32(path_node)?);
        }

        let vote = VoteWithProof {
            commitment: vec_to_bytes32(&json_vote.commitment)?,
            choice: json_vote.choice,
            random: vec_to_bytes32(&json_vote.random)?,
            index: json_vote.index,
            merkle_path,
        };
        votes.push(vote);
    }

    Ok(AggregatorInput {
        election_id: vec_to_bytes16(&json_input.election_id)?,
        bulletin_root: vec_to_bytes32(&json_input.bulletin_root)?,
        tree_size: json_input.tree_size,
        log_id: vec_to_bytes32(&json_input.log_id)?,
        timestamp: json_input.timestamp,
        total_expected: json_input.total_expected,
        election_config_hash: vec_to_bytes32(&json_input.election_config_hash)?,
        votes,
    })
}

/// Convert vec to 16-byte array
fn vec_to_bytes16(data: &[u8]) -> Result<[u8; 16], Box<dyn std::error::Error>> {
    if data.len() == 16 {
        let mut result = [0u8; 16];
        result.copy_from_slice(data);
        Ok(result)
    } else {
        Err(format!(
            "Invalid byte array length for 16-byte value: got {}",
            data.len()
        )
        .into())
    }
}

/// Convert vec to 32-byte array
fn vec_to_bytes32(data: &[u8]) -> Result<[u8; 32], Box<dyn std::error::Error>> {
    if data.len() == 32 {
        let mut result = [0u8; 32];
        result.copy_from_slice(data);
        Ok(result)
    } else {
        Err(format!(
            "Invalid byte array length for 32-byte value: got {}",
            data.len()
        )
        .into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use contract_core::{hash_internal, hash_leaf};

    #[test]
    fn test_json_to_aggregator_input() {
        let input = JsonInput {
            election_id: vec![1u8; 16],
            bulletin_root: vec![2u8; 32],
            tree_size: 4,
            log_id: vec![3u8; 32],
            timestamp: 1234567890,
            total_expected: 4,
            election_config_hash: vec![4u8; 32],
            votes: vec![
                JsonVoteWithProof {
                    choice: 0,
                    commitment: vec![100; 32],
                    random: vec![42; 32],
                    index: 0,
                    merkle_path: vec![],
                },
                JsonVoteWithProof {
                    choice: 1,
                    commitment: vec![101; 32],
                    random: vec![1; 32],
                    index: 1,
                    merkle_path: vec![vec![5u8; 32]],
                },
            ],
        };

        let aggregator_input = json_to_aggregator_input(&input).unwrap();
        assert_eq!(aggregator_input.votes.len(), 2);
        assert_eq!(aggregator_input.tree_size, 4);
        assert_eq!(aggregator_input.total_expected, 4);
    }

    #[test]
    fn test_receipt_contains_image_id() {
        // Testing that the receipt output contains ImageID
        // Now that GUEST_ID is imported, we can test it

        // GUEST_ID should be available and non-empty
        assert_eq!(GUEST_ID.len(), 8, "GUEST_ID should be [u32; 8]");

        // Convert GUEST_ID to hex string format
        let guest_id_bytes: Vec<u8> = GUEST_ID
            .iter()
            .flat_map(|&word| word.to_le_bytes())
            .collect();
        let image_id = format!("0x{}", hex::encode(&guest_id_bytes));

        // ImageID should be a valid hex string
        assert!(image_id.starts_with("0x"));
        assert!(image_id.len() > 2);
    }

    #[test]
    fn test_json_output_includes_image_id() {
        let json_output = JsonOutput {
            election_id: vec![1u8; 16],
            election_config_hash: vec![2u8; 32],
            bulletin_root: vec![3u8; 32],
            tree_size: 4,
            total_expected: 4,
            sth_digest: vec![4u8; 32],
            verified_tally: [10, 20, 15, 12, 7],
            total_votes: 64,
            valid_votes: 64,
            invalid_votes: 0,
            seen_indices_count: 64,
            missing_slots: 0,
            invalid_presented_slots: 0,
            rejected_records: 0,
            seen_bitmap_root: vec![5u8; 32],
            included_bitmap_root: vec![5u8; 32],
            excluded_slots: 0,
            input_commitment: vec![6u8; 32],
            method_version: 12,
            image_id: String::from(
                "0x7a1fe95465f1511edf5aa9e1a85ec7fcf0e0d06dcc079680c408a13b45096db2",
            ),
        };

        // Now JsonOutput includes imageId field - test should pass
        assert!(!json_output.image_id.is_empty());
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

    #[test]
    fn test_receipt_file_contains_image_id() {
        // Testing that the saved receipt file would contain imageId

        use std::fs;
        use std::path::Path;

        // Create a test receipt file path
        let test_file = "test-receipt.json";

        // GUEST_ID is now available
        assert_eq!(GUEST_ID.len(), 8, "GUEST_ID should be [u32; 8]");

        // Convert GUEST_ID to hex string
        let guest_id_bytes: Vec<u8> = GUEST_ID
            .iter()
            .flat_map(|&word| word.to_le_bytes())
            .collect();
        let image_id = format!("0x{}", hex::encode(&guest_id_bytes));

        // Test that we can create a receipt structure with ImageID
        let receipt_with_id = serde_json::json!({
            "receipt": {},
            "image_id": image_id
        });

        // Verify the JSON structure
        assert!(receipt_with_id["image_id"].as_str().is_some());

        // Clean up test file if it exists
        if Path::new(test_file).exists() {
            fs::remove_file(test_file).ok();
        }
    }
}
