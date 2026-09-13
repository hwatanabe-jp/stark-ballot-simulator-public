use serde::Serialize;

use crate::encoding::{INPUT_COMMITMENT_DOMAIN_TAG, INPUT_COMMITMENT_FORMAT_VERSION};
use crate::sha256::VOTE_COMMITMENT_DOMAIN_TAG;
use crate::types::{CURRENT_METHOD_VERSION, VERIFIED_TALLY_WIDTH};
use crate::work_budget::{
    MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD, MAX_GUEST_SERIALIZED_INPUT_BYTES,
    MAX_GUEST_TOTAL_EXPECTED, MAX_GUEST_TOTAL_PATH_NODES, MAX_GUEST_TREE_SIZE,
    MAX_GUEST_VOTE_COUNT,
};

pub const CURRENT_SEMANTIC_CONTRACT_DISCRIMINATOR: &str =
    "stark-ballot.zkvm-semantic-contract.current";

pub const HOST_OUTPUT_FILE_SUFFIX: &str = "-output.json";
pub const HOST_RECEIPT_FILE_SUFFIX: &str = "-receipt.json";
pub const HOST_INCLUDED_BITMAP_FILE_SUFFIX: &str = "-bitmap.json";
pub const HOST_SEEN_BITMAP_FILE_SUFFIX: &str = "-seen-bitmap.json";
pub const RECEIPT_CANONICAL_FILE_NAME: &str = "receipt.json";
pub const PUBLIC_INPUT_CANONICAL_FILE_NAME: &str = "public-input.json";
pub const PUBLIC_INPUT_ARTIFACT_SCHEMA: &str = "stark-ballot.public_input";
pub const PUBLIC_INPUT_ARTIFACT_VERSION: &str = "1.1";
pub const INCLUDED_BITMAP_CANONICAL_FILE_NAME: &str = "included-bitmap.json";
pub const SEEN_BITMAP_CANONICAL_FILE_NAME: &str = "seen-bitmap.json";
pub const INCLUDED_BITMAP_ARTIFACT_SCHEMA: &str = "stark-ballot.included_bitmap";
pub const INCLUDED_BITMAP_ARTIFACT_VERSION: &str = "1.0";
pub const SEEN_BITMAP_ARTIFACT_SCHEMA: &str = "stark-ballot.seen_bitmap";
pub const SEEN_BITMAP_ARTIFACT_VERSION: &str = "1.0";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticField {
    pub name: &'static str,
    #[serde(rename = "type")]
    pub field_type: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticMethod {
    pub method_version: u32,
    pub input_commitment_format_version: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticDomainTags {
    pub vote_commitment: &'static str,
    pub input_commitment: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticWorkBounds {
    pub tree_size_min: u32,
    pub tree_size_max: u32,
    pub total_expected_max: u32,
    pub vote_count_max: usize,
    pub merkle_path_nodes_per_record_max: usize,
    pub total_merkle_path_nodes_max: usize,
    pub serialized_input_bytes_max: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticHostInputJson {
    pub fields: &'static [SemanticField],
    pub vote_fields: &'static [SemanticField],
    pub election_config_fields: &'static [SemanticField],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticLogicalJournal {
    pub fields: &'static [SemanticField],
    pub tally_width: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticHostJsonProjection {
    pub fields: &'static [SemanticField],
    pub output_file_suffix: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticOpaqueReceiptArtifact {
    pub host_file_suffix: &'static str,
    pub canonical_file_name: &'static str,
    pub fields: &'static [SemanticField],
    pub receipt_payload: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticBitmapArtifact {
    pub host_file_suffix: &'static str,
    pub canonical_file_name: &'static str,
    pub schema: &'static str,
    pub version: &'static str,
    pub fields: &'static [SemanticField],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticPublicInputArtifact {
    pub canonical_file_name: &'static str,
    pub schema: &'static str,
    pub version: &'static str,
    pub fields: &'static [SemanticField],
    pub vote_fields: &'static [SemanticField],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticArtifacts {
    pub receipt: SemanticOpaqueReceiptArtifact,
    pub public_input: SemanticPublicInputArtifact,
    pub included_bitmap: SemanticBitmapArtifact,
    pub seen_bitmap: SemanticBitmapArtifact,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentSemanticContract {
    pub descriptor_type: &'static str,
    pub method: SemanticMethod,
    pub domain_tags: SemanticDomainTags,
    pub work_bounds: SemanticWorkBounds,
    pub host_input_json: SemanticHostInputJson,
    pub logical_journal: SemanticLogicalJournal,
    pub host_json_projection: SemanticHostJsonProjection,
    pub artifacts: SemanticArtifacts,
}

const HOST_INPUT_FIELDS: &[SemanticField] = &[
    SemanticField {
        name: "election_id",
        field_type: "bytes[16]",
    },
    SemanticField {
        name: "bulletin_root",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "tree_size",
        field_type: "u32",
    },
    SemanticField {
        name: "log_id",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "timestamp",
        field_type: "u64",
    },
    SemanticField {
        name: "total_expected",
        field_type: "u32",
    },
    SemanticField {
        name: "election_config_hash",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "votes",
        field_type: "vote[]",
    },
    SemanticField {
        name: "election_config",
        field_type: "electionConfig?",
    },
];

const HOST_INPUT_VOTE_FIELDS: &[SemanticField] = &[
    SemanticField {
        name: "commitment",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "choice",
        field_type: "u8",
    },
    SemanticField {
        name: "random",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "index",
        field_type: "u32",
    },
    SemanticField {
        name: "merkle_path",
        field_type: "bytes[32][]",
    },
];

const HOST_INPUT_ELECTION_CONFIG_FIELDS: &[SemanticField] = &[
    SemanticField {
        name: "totalExpected",
        field_type: "u32",
    },
    SemanticField {
        name: "choices",
        field_type: "string[]",
    },
    SemanticField {
        name: "version",
        field_type: "string",
    },
    SemanticField {
        name: "botCount",
        field_type: "u32",
    },
    SemanticField {
        name: "merkleTreeDepth",
        field_type: "u32",
    },
];

const LOGICAL_JOURNAL_FIELDS: &[SemanticField] = &[
    SemanticField {
        name: "election_id",
        field_type: "bytes[16]",
    },
    SemanticField {
        name: "election_config_hash",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "bulletin_root",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "tree_size",
        field_type: "u32",
    },
    SemanticField {
        name: "total_expected",
        field_type: "u32",
    },
    SemanticField {
        name: "sth_digest",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "verified_tally",
        field_type: "u32[tallyWidth]",
    },
    SemanticField {
        name: "total_votes",
        field_type: "u32",
    },
    SemanticField {
        name: "valid_votes",
        field_type: "u32",
    },
    SemanticField {
        name: "invalid_votes",
        field_type: "u32",
    },
    SemanticField {
        name: "seen_indices_count",
        field_type: "u32",
    },
    SemanticField {
        name: "missing_slots",
        field_type: "u32",
    },
    SemanticField {
        name: "invalid_presented_slots",
        field_type: "u32",
    },
    SemanticField {
        name: "rejected_records",
        field_type: "u32",
    },
    SemanticField {
        name: "seen_bitmap_root",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "included_bitmap_root",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "excluded_slots",
        field_type: "u32",
    },
    SemanticField {
        name: "input_commitment",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "method_version",
        field_type: "u32",
    },
];

const HOST_JSON_PROJECTION_FIELDS: &[SemanticField] = &[
    SemanticField {
        name: "electionId",
        field_type: "bytes[16]",
    },
    SemanticField {
        name: "electionConfigHash",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "bulletinRoot",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "treeSize",
        field_type: "u32",
    },
    SemanticField {
        name: "totalExpected",
        field_type: "u32",
    },
    SemanticField {
        name: "sthDigest",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "verifiedTally",
        field_type: "u32[tallyWidth]",
    },
    SemanticField {
        name: "totalVotes",
        field_type: "u32",
    },
    SemanticField {
        name: "validVotes",
        field_type: "u32",
    },
    SemanticField {
        name: "invalidVotes",
        field_type: "u32",
    },
    SemanticField {
        name: "seenIndicesCount",
        field_type: "u32",
    },
    SemanticField {
        name: "missingSlots",
        field_type: "u32",
    },
    SemanticField {
        name: "invalidPresentedSlots",
        field_type: "u32",
    },
    SemanticField {
        name: "rejectedRecords",
        field_type: "u32",
    },
    SemanticField {
        name: "seenBitmapRoot",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "includedBitmapRoot",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "excludedSlots",
        field_type: "u32",
    },
    SemanticField {
        name: "inputCommitment",
        field_type: "bytes[32]",
    },
    SemanticField {
        name: "methodVersion",
        field_type: "u32",
    },
    SemanticField {
        name: "imageId",
        field_type: "hex[32]",
    },
];

const RECEIPT_FIELDS: &[SemanticField] = &[
    SemanticField {
        name: "receipt",
        field_type: "opaque-risc0-serde",
    },
    SemanticField {
        name: "image_id",
        field_type: "hex[32]",
    },
];

const PUBLIC_INPUT_FIELDS: &[SemanticField] = &[
    SemanticField {
        name: "schema",
        field_type: "literal",
    },
    SemanticField {
        name: "version",
        field_type: "literal",
    },
    SemanticField {
        name: "electionId",
        field_type: "uuid",
    },
    SemanticField {
        name: "electionConfigHash",
        field_type: "hex[32]",
    },
    SemanticField {
        name: "bulletinRoot",
        field_type: "hex[32]",
    },
    SemanticField {
        name: "treeSize",
        field_type: "u32",
    },
    SemanticField {
        name: "totalExpected",
        field_type: "u32",
    },
    SemanticField {
        name: "logId",
        field_type: "hex[32]",
    },
    SemanticField {
        name: "timestamp",
        field_type: "u64",
    },
    SemanticField {
        name: "methodVersion",
        field_type: "u32",
    },
    SemanticField {
        name: "votes",
        field_type: "publicInputVote[]",
    },
];

const PUBLIC_INPUT_VOTE_FIELDS: &[SemanticField] = &[
    SemanticField {
        name: "index",
        field_type: "u32",
    },
    SemanticField {
        name: "commitment",
        field_type: "hex[32]",
    },
    SemanticField {
        name: "merklePath",
        field_type: "hex[32][]",
    },
];

const INCLUDED_BITMAP_FIELDS: &[SemanticField] = &[
    SemanticField {
        name: "schema",
        field_type: "literal",
    },
    SemanticField {
        name: "version",
        field_type: "literal",
    },
    SemanticField {
        name: "treeSize",
        field_type: "u32",
    },
    SemanticField {
        name: "includedBitmapRoot",
        field_type: "hex[32]",
    },
    SemanticField {
        name: "includedBitmap",
        field_type: "boolean[]",
    },
];

const SEEN_BITMAP_FIELDS: &[SemanticField] = &[
    SemanticField {
        name: "schema",
        field_type: "literal",
    },
    SemanticField {
        name: "version",
        field_type: "literal",
    },
    SemanticField {
        name: "treeSize",
        field_type: "u32",
    },
    SemanticField {
        name: "seenBitmapRoot",
        field_type: "hex[32]",
    },
    SemanticField {
        name: "seenBitmap",
        field_type: "boolean[]",
    },
];

pub fn current_semantic_contract() -> CurrentSemanticContract {
    CurrentSemanticContract {
        descriptor_type: CURRENT_SEMANTIC_CONTRACT_DISCRIMINATOR,
        method: SemanticMethod {
            method_version: CURRENT_METHOD_VERSION,
            input_commitment_format_version: INPUT_COMMITMENT_FORMAT_VERSION,
        },
        domain_tags: SemanticDomainTags {
            vote_commitment: core::str::from_utf8(VOTE_COMMITMENT_DOMAIN_TAG)
                .expect("vote commitment domain tag is UTF-8"),
            input_commitment: core::str::from_utf8(INPUT_COMMITMENT_DOMAIN_TAG)
                .expect("input commitment domain tag is UTF-8"),
        },
        work_bounds: SemanticWorkBounds {
            tree_size_min: 1,
            tree_size_max: MAX_GUEST_TREE_SIZE,
            total_expected_max: MAX_GUEST_TOTAL_EXPECTED,
            vote_count_max: MAX_GUEST_VOTE_COUNT,
            merkle_path_nodes_per_record_max: MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD,
            total_merkle_path_nodes_max: MAX_GUEST_TOTAL_PATH_NODES,
            serialized_input_bytes_max: MAX_GUEST_SERIALIZED_INPUT_BYTES,
        },
        host_input_json: SemanticHostInputJson {
            fields: HOST_INPUT_FIELDS,
            vote_fields: HOST_INPUT_VOTE_FIELDS,
            election_config_fields: HOST_INPUT_ELECTION_CONFIG_FIELDS,
        },
        logical_journal: SemanticLogicalJournal {
            fields: LOGICAL_JOURNAL_FIELDS,
            tally_width: VERIFIED_TALLY_WIDTH,
        },
        host_json_projection: SemanticHostJsonProjection {
            fields: HOST_JSON_PROJECTION_FIELDS,
            output_file_suffix: HOST_OUTPUT_FILE_SUFFIX,
        },
        artifacts: SemanticArtifacts {
            receipt: SemanticOpaqueReceiptArtifact {
                host_file_suffix: HOST_RECEIPT_FILE_SUFFIX,
                canonical_file_name: RECEIPT_CANONICAL_FILE_NAME,
                fields: RECEIPT_FIELDS,
                receipt_payload: "opaque",
            },
            public_input: SemanticPublicInputArtifact {
                canonical_file_name: PUBLIC_INPUT_CANONICAL_FILE_NAME,
                schema: PUBLIC_INPUT_ARTIFACT_SCHEMA,
                version: PUBLIC_INPUT_ARTIFACT_VERSION,
                fields: PUBLIC_INPUT_FIELDS,
                vote_fields: PUBLIC_INPUT_VOTE_FIELDS,
            },
            included_bitmap: SemanticBitmapArtifact {
                host_file_suffix: HOST_INCLUDED_BITMAP_FILE_SUFFIX,
                canonical_file_name: INCLUDED_BITMAP_CANONICAL_FILE_NAME,
                schema: INCLUDED_BITMAP_ARTIFACT_SCHEMA,
                version: INCLUDED_BITMAP_ARTIFACT_VERSION,
                fields: INCLUDED_BITMAP_FIELDS,
            },
            seen_bitmap: SemanticBitmapArtifact {
                host_file_suffix: HOST_SEEN_BITMAP_FILE_SUFFIX,
                canonical_file_name: SEEN_BITMAP_CANONICAL_FILE_NAME,
                schema: SEEN_BITMAP_ARTIFACT_SCHEMA,
                version: SEEN_BITMAP_ARTIFACT_VERSION,
                fields: SEEN_BITMAP_FIELDS,
            },
        },
    }
}
