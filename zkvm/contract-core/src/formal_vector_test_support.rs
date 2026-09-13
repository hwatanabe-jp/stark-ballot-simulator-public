use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const CURRENT_FORMAL_VECTOR_ENVELOPE_TYPE: &str = "stark-ballot.formal-vector.current";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormalVectorEnvelope<T> {
    pub envelope_type: String,
    pub kind: String,
    pub modeled_bounds: FormalVectorModeledBounds,
    pub payload: Vec<T>,
    pub canonical_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormalVectorModeledBounds {
    pub input_commitment: FormalInputCommitmentBounds,
    pub guest: FormalGuestBounds,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormalInputCommitmentBounds {
    pub format_version: u32,
    pub u16_max: u32,
    pub u32_max: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormalGuestBounds {
    pub method_version: u32,
    pub tree_size_max: u32,
    pub total_expected_max: u32,
    pub vote_count_max: usize,
    pub merkle_path_nodes_per_record_max: usize,
    pub total_merkle_path_nodes_max: usize,
    pub serialized_input_bytes_max: u64,
    pub tally_width: usize,
    pub tally_bucket_max: u32,
}

pub fn admit_current_formal_vector<T: DeserializeOwned>(
    source: &str,
    expected_kind: &str,
) -> Result<FormalVectorEnvelope<T>, String> {
    let envelope: FormalVectorEnvelope<T> =
        serde_json::from_str(source).map_err(|error| format!("formal vector envelope is invalid: {error}"))?;
    if envelope.envelope_type != CURRENT_FORMAL_VECTOR_ENVELOPE_TYPE {
        return Err("formal vector envelopeType is not current".to_string());
    }
    if envelope.kind != expected_kind {
        return Err(format!(
            "formal vector kind mismatch: expected {expected_kind}, received {}",
            envelope.kind
        ));
    }
    if envelope.canonical_sha256.len() != 64
        || !envelope
            .canonical_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("formal vector canonicalSha256 is not lowercase SHA-256".to_string());
    }

    let mut canonical_value: Value = serde_json::from_str(source)
        .map_err(|error| format!("formal vector canonical JSON is invalid: {error}"))?;
    let object = canonical_value
        .as_object_mut()
        .ok_or_else(|| "formal vector canonical value must be an object".to_string())?;
    object
        .remove("canonicalSha256")
        .ok_or_else(|| "formal vector canonicalSha256 is missing".to_string())?;
    let canonical_json = serde_json::to_string(&canonical_value)
        .map_err(|error| format!("formal vector canonical JSON could not serialize: {error}"))?;
    let actual_fingerprint = hex::encode(Sha256::digest(canonical_json.as_bytes()));
    if envelope.canonical_sha256 != actual_fingerprint {
        return Err("formal vector canonicalSha256 does not match canonical content".to_string());
    }

    Ok(envelope)
}
