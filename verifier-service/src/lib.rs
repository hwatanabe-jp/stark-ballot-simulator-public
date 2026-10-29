use std::{
    fs,
    fs::File,
    io::{self, BufReader, Read, Write},
    path::{Path, PathBuf},
    time::Instant,
};

use contract_core::{VerificationOutput, CURRENT_METHOD_VERSION};
use hex::FromHex;
use risc0_zkp::{core::digest::Digest, verify::VerificationError as Risc0VerificationError};
use risc0_zkvm::{InnerReceipt, Receipt};
use serde::{ser::SerializeStruct, Serialize, Serializer};
use serde_json::Value;
use thiserror::Error;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use zip::ZipArchive;

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, PartialEq, Eq)]
/// An expected ImageID whose text and digest are constructed together.
///
/// ```compile_fail
/// let mut image_id = verifier_service::ImageId::parse(&"0".repeat(64)).unwrap();
/// image_id.normalized = "different image".to_owned();
/// ```
pub struct ImageId {
    normalized: String,
    digest: Digest,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Verify(VerifyCommand),
    DecodeJournal(DecodeJournalCommand),
}

#[derive(Debug, PartialEq, Eq)]
pub struct VerifyCommand {
    pub bundle_path: PathBuf,
    pub image_id: ImageId,
    pub output_path: Option<PathBuf>,
    pub quiet: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct DecodeJournalCommand {
    pub bundle_path: PathBuf,
    pub image_id: ImageId,
    pub output_path: Option<PathBuf>,
    pub quiet: bool,
}

#[derive(Debug, Error)]
pub enum ProofVerificationError {
    #[error("invalid image ID: {0}")]
    InvalidImageId(String),
    #[error("receipt verification failed: {0}")]
    ReceiptVerificationFailed(#[from] Risc0VerificationError),
}

#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("bundle not found: {0}")]
    BundleNotFound(PathBuf),
    #[error("receipt file not found in bundle: {0}")]
    ReceiptFileNotFound(PathBuf),
    #[error("receipt payload missing in {0}")]
    ReceiptMissing(PathBuf),
    #[error("failed to parse receipt JSON at {path}: {source}")]
    ReceiptParse {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("failed to read bundle archive {path}: {source}")]
    BundleArchive {
        path: PathBuf,
        source: zip::result::ZipError,
    },
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Proof(#[from] ProofVerificationError),
    #[error("verification did not succeed: {0:?}")]
    VerificationDidNotSucceed(Box<VerificationReport>),
    #[error("failed to serialize verification report: {0}")]
    ReportSerialize(serde_json::Error),
    #[error("invalid verification report: {0}")]
    ReportInvariant(&'static str),
    #[error("failed to serialize decoded journal: {0}")]
    JournalSerialize(serde_json::Error),
    #[error("receipt metadata is missing the image_id required by host JSON admission")]
    ReceiptImageIdMissing,
    #[error("failed to decode the RISC Zero receipt journal: {0}")]
    JournalDecode(String),
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    Success,
    Failed,
    DevMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VerificationReportCommon {
    verifier_version: String,
    verified_at: String,
    duration_ms: u128,
    expected_image_id: String,
    bundle_path: String,
    receipt_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum VerificationReportOutcome {
    Success {
        receipt_image_id: String,
    },
    DevMode {
        receipt_image_id: Option<String>,
        errors: Vec<String>,
    },
    Failed {
        receipt_image_id: Option<String>,
        dev_mode_receipt: bool,
        errors: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerificationReport {
    common: VerificationReportCommon,
    outcome: VerificationReportOutcome,
}

impl VerificationReport {
    fn success(
        common: VerificationReportCommon,
        receipt_image_id: String,
    ) -> Result<Self, ServiceError> {
        if receipt_image_id != common.expected_image_id {
            return Err(ServiceError::ReportInvariant(
                "success receipt_image_id must match expected_image_id",
            ));
        }
        Ok(Self {
            common,
            outcome: VerificationReportOutcome::Success { receipt_image_id },
        })
    }

    fn dev_mode(
        common: VerificationReportCommon,
        receipt_image_id: Option<String>,
        errors: Vec<String>,
    ) -> Result<Self, ServiceError> {
        if receipt_image_id
            .as_ref()
            .is_some_and(|receipt_image_id| receipt_image_id != &common.expected_image_id)
        {
            return Err(ServiceError::ReportInvariant(
                "dev_mode receipt_image_id must match expected_image_id when present",
            ));
        }
        validate_report_errors(&errors, true)?;
        Ok(Self {
            common,
            outcome: VerificationReportOutcome::DevMode {
                receipt_image_id,
                errors,
            },
        })
    }

    fn failed(
        common: VerificationReportCommon,
        receipt_image_id: Option<String>,
        dev_mode_receipt: bool,
        errors: Vec<String>,
    ) -> Result<Self, ServiceError> {
        validate_report_errors(&errors, false)?;
        Ok(Self {
            common,
            outcome: VerificationReportOutcome::Failed {
                receipt_image_id,
                dev_mode_receipt,
                errors,
            },
        })
    }

    pub fn status(&self) -> VerificationStatus {
        match &self.outcome {
            VerificationReportOutcome::Success { .. } => VerificationStatus::Success,
            VerificationReportOutcome::DevMode { .. } => VerificationStatus::DevMode,
            VerificationReportOutcome::Failed { .. } => VerificationStatus::Failed,
        }
    }

    pub fn errors(&self) -> &[String] {
        match &self.outcome {
            VerificationReportOutcome::Success { .. } => &[],
            VerificationReportOutcome::DevMode { errors, .. }
            | VerificationReportOutcome::Failed { errors, .. } => errors,
        }
    }

    pub fn expected_image_id(&self) -> &str {
        &self.common.expected_image_id
    }

    pub fn receipt_image_id(&self) -> Option<&str> {
        match &self.outcome {
            VerificationReportOutcome::Success { receipt_image_id } => Some(receipt_image_id),
            VerificationReportOutcome::DevMode {
                receipt_image_id, ..
            }
            | VerificationReportOutcome::Failed {
                receipt_image_id, ..
            } => receipt_image_id.as_deref(),
        }
    }

    pub fn bundle_path(&self) -> &str {
        &self.common.bundle_path
    }

    pub fn receipt_path(&self) -> &str {
        &self.common.receipt_path
    }

    pub fn dev_mode_receipt(&self) -> bool {
        match &self.outcome {
            VerificationReportOutcome::Success { .. } => false,
            VerificationReportOutcome::DevMode { .. } => true,
            VerificationReportOutcome::Failed {
                dev_mode_receipt, ..
            } => *dev_mode_receipt,
        }
    }
}

impl Serialize for VerificationReport {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let errors = self.errors();
        let mut report = serializer
            .serialize_struct("VerificationReport", if errors.is_empty() { 9 } else { 10 })?;
        report.serialize_field("status", &self.status())?;
        report.serialize_field("verifier_version", &self.common.verifier_version)?;
        report.serialize_field("verified_at", &self.common.verified_at)?;
        report.serialize_field("duration_ms", &self.common.duration_ms)?;
        report.serialize_field("expected_image_id", &self.common.expected_image_id)?;
        report.serialize_field("receipt_image_id", &self.receipt_image_id())?;
        report.serialize_field("bundle_path", &self.common.bundle_path)?;
        report.serialize_field("receipt_path", &self.common.receipt_path)?;
        report.serialize_field("dev_mode_receipt", &self.dev_mode_receipt())?;
        if !errors.is_empty() {
            report.serialize_field("errors", errors)?;
        }
        report.end()
    }
}

fn validate_report_errors(errors: &[String], allow_empty: bool) -> Result<(), ServiceError> {
    if (!allow_empty && errors.is_empty()) || errors.iter().any(String::is_empty) {
        return Err(ServiceError::ReportInvariant(
            "errors must contain one or more nonempty strings for failed reports",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DecodedJournal {
    pub election_id: [u8; 16],
    pub election_config_hash: [u8; 32],
    pub bulletin_root: [u8; 32],
    pub tree_size: u32,
    pub total_expected: u32,
    pub sth_digest: [u8; 32],
    pub verified_tally: [u32; 5],
    pub total_votes: u32,
    pub valid_votes: u32,
    pub invalid_votes: u32,
    pub seen_indices_count: u32,
    pub missing_slots: u32,
    pub invalid_presented_slots: u32,
    pub rejected_records: u32,
    pub seen_bitmap_root: [u8; 32],
    pub included_bitmap_root: [u8; 32],
    pub excluded_slots: u32,
    pub input_commitment: [u8; 32],
    pub method_version: u32,
    pub image_id: String,
}

impl DecodedJournal {
    fn from_verification_output(output: VerificationOutput, image_id: String) -> Self {
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

pub fn parse_args(args: &[&str]) -> Result<Command, String> {
    let mut iter = args.iter().copied();

    // Skip binary name if present.
    iter.next();

    let command = iter.next().ok_or_else(|| {
        "no command provided; supported commands: verify, decode-journal".to_string()
    })?;

    match command {
        "verify" => parse_verify_command(iter),
        "decode-journal" => parse_decode_journal_command(iter),
        other => Err(format!(
            "unknown command `{other}`; supported commands: verify, decode-journal"
        )),
    }
}

fn print_help() {
    println!(
        r#"verifier-service - RISC Zero Receipt Verification Tool

USAGE:
    verifier-service verify [OPTIONS] <BUNDLE_PATH> [IMAGE_ID]
    verifier-service decode-journal [OPTIONS] <BUNDLE_PATH>

ARGS:
    <BUNDLE_PATH>    Path to receipt bundle (file, directory, or zip archive)
    [IMAGE_ID]       Expected ImageID (hex string with 0x prefix)

OPTIONS:
    -b, --bundle <PATH>      Path to receipt bundle (alternative to positional arg)
    -i, --image-id <ID>      Expected ImageID (alternative to positional arg)
    -o, --output <PATH>      Write the command's JSON result to file
    -q, --quiet              Suppress stdout output
    -h, --help               Print this help message

ENVIRONMENT VARIABLES:
    EXPECTED_IMAGE_ID        Default ImageID if not provided positionally or via --image-id

EXAMPLES:
    # Verify with explicit ImageID
    verifier-service verify /path/to/receipt.json 0x5042...4108

    # Verify using flags
    verifier-service verify --bundle /path/to/bundle.zip --image-id 0x5042...4108

    # Verify with output file
    verifier-service verify /path/to/receipt-dir 0x5042...4108 -o report.json

    # Verify using environment variable
    export EXPECTED_IMAGE_ID=0x5042...4108
    verifier-service verify /path/to/receipt.json

    # Decode the verified receipt journal through RISC Zero serde
    verifier-service decode-journal --bundle /path/to/bundle.zip --image-id 0x5042...4108 --output journal.json

EXIT CODES:
    0    Verification succeeded
    1    General error (invalid arguments, I/O error, etc.)
    2    Verification completed in dev mode (fake receipt detected)
    3    Verification failed (proof invalid or ImageID mismatch)
"#
    );
}

fn parse_decode_journal_command<'a, I>(mut iter: I) -> Result<Command, String>
where
    I: Iterator<Item = &'a str>,
{
    let mut bundle: Option<PathBuf> = None;
    let mut image_id: Option<ImageId> = None;
    let mut output: Option<PathBuf> = None;
    let mut quiet = false;

    while let Some(token) = iter.next() {
        match token {
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            "--bundle" | "-b" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--bundle requires a path argument".to_string())?;
                bundle = Some(PathBuf::from(value));
            }
            "--image-id" | "-i" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--image-id requires a value".to_string())?;
                image_id = Some(
                    ImageId::parse(value)
                        .map_err(|message| format!("invalid --image-id: {message}"))?,
                );
            }
            "--output" | "-o" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--output requires a path argument".to_string())?;
                output = Some(PathBuf::from(value));
            }
            "--quiet" | "-q" => quiet = true,
            value if value.starts_with('-') => {
                return Err(format!("unknown decode-journal option `{value}`"));
            }
            value => {
                if bundle.is_none() {
                    bundle = Some(PathBuf::from(value));
                } else if image_id.is_none() {
                    image_id = Some(
                        ImageId::parse(value)
                            .map_err(|message| format!("invalid image ID: {message}"))?,
                    );
                } else {
                    return Err(format!("unexpected decode-journal argument `{value}`"));
                }
            }
        }
    }

    Ok(Command::DecodeJournal(DecodeJournalCommand {
        bundle_path: bundle.ok_or_else(|| {
            "missing bundle path; pass --bundle <path> or provide it positionally".to_string()
        })?,
        image_id: resolve_expected_image_id(image_id)?,
        output_path: output,
        quiet,
    }))
}

fn resolve_expected_image_id(image_id: Option<ImageId>) -> Result<ImageId, String> {
    match image_id {
        Some(image_id) => Ok(image_id),
        None => {
            let environment_value = std::env::var("EXPECTED_IMAGE_ID").map_err(|_| {
                "missing expected image ID; pass --image-id or set EXPECTED_IMAGE_ID".to_string()
            })?;
            ImageId::parse(&environment_value)
                .map_err(|message| format!("invalid expected image ID from environment: {message}"))
        }
    }
}

fn parse_verify_command<'a, I>(mut iter: I) -> Result<Command, String>
where
    I: Iterator<Item = &'a str>,
{
    let mut bundle: Option<PathBuf> = None;
    let mut image_id: Option<ImageId> = None;
    let mut output: Option<PathBuf> = None;
    let mut quiet = false;

    while let Some(token) = iter.next() {
        match token {
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            "--bundle" | "-b" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--bundle requires a path argument".to_string())?;
                bundle = Some(PathBuf::from(value));
            }
            "--image-id" | "-i" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--image-id requires a value".to_string())?;
                image_id = Some(
                    ImageId::parse(value).map_err(|msg| format!("invalid --image-id: {msg}"))?,
                );
            }
            "--output" | "-o" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--output requires a path argument".to_string())?;
                output = Some(PathBuf::from(value));
            }
            "--quiet" | "-q" => {
                quiet = true;
            }
            value if value.starts_with("--") => {
                return Err(format!("unknown option `{value}`"));
            }
            value => {
                if bundle.is_none() {
                    bundle = Some(PathBuf::from(value));
                } else if image_id.is_none() {
                    image_id = Some(
                        ImageId::parse(value).map_err(|msg| format!("invalid image ID: {msg}"))?,
                    );
                } else {
                    return Err(format!("unexpected argument `{value}`"));
                }
            }
        }
    }

    let bundle_path = bundle.ok_or_else(|| {
        "missing bundle path; pass --bundle <path> or provide it as the first positional argument"
            .to_string()
    })?;

    let image_id = resolve_expected_image_id(image_id)?;

    Ok(Command::Verify(VerifyCommand {
        bundle_path,
        image_id,
        output_path: output,
        quiet,
    }))
}

pub fn verify_receipt(receipt: &Receipt, image_id: &ImageId) -> Result<(), ProofVerificationError> {
    receipt
        .verify(image_id.digest())
        .map_err(ProofVerificationError::from)
}

pub fn verify_bundle(command: &VerifyCommand) -> Result<VerificationReport, ServiceError> {
    let receipt_path = resolve_receipt_path(&command.bundle_path)?;
    let loaded = load_receipt_from_file(&receipt_path)?;

    verify_loaded_receipt(command, &loaded)
}

fn verify_loaded_receipt(
    command: &VerifyCommand,
    loaded: &LoadedReceipt,
) -> Result<VerificationReport, ServiceError> {
    let dev_mode = matches!(loaded.receipt.inner, InnerReceipt::Fake(_));
    let started = Instant::now();

    let mut status = VerificationStatus::Success;
    let mut errors: Vec<String> = Vec::new();

    // Check if receipt JSON's image_id matches expected (Priority 1 fix)
    if let Some(ref receipt_image_id) = loaded.image_id {
        if receipt_image_id != &command.image_id.normalized {
            status = VerificationStatus::Failed;
            errors.push(format!(
                "receipt metadata image_id mismatch: expected {}, got {}",
                command.image_id.normalized, receipt_image_id
            ));
        }
    } else {
        errors.push("receipt metadata missing image_id field".to_string());
        if !dev_mode {
            // Missing image_id is a hard failure in non-dev mode
            status = VerificationStatus::Failed;
        }
    }

    // Only proceed with STARK verification if metadata check passed
    if status == VerificationStatus::Success {
        match verify_receipt(&loaded.receipt, &command.image_id) {
            Ok(_) => {
                if dev_mode {
                    status = VerificationStatus::DevMode;
                }
            }
            Err(ProofVerificationError::ReceiptVerificationFailed(err)) => {
                errors.push(err.to_string());
                if dev_mode && matches!(err, Risc0VerificationError::InvalidProof) {
                    status = VerificationStatus::DevMode;
                } else {
                    status = VerificationStatus::Failed;
                }
            }
            Err(ProofVerificationError::InvalidImageId(msg)) => {
                status = VerificationStatus::Failed;
                errors.push(msg);
            }
        }
    }

    let timestamp = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());
    let duration_ms = started.elapsed().as_millis();

    let common = VerificationReportCommon {
        verifier_version: VERSION.to_string(),
        verified_at: timestamp,
        duration_ms,
        expected_image_id: command.image_id.normalized.clone(),
        // Use filename only to avoid leaking internal paths (Priority 2 security fix)
        bundle_path: command
            .bundle_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string(),
        receipt_path: loaded
            .source_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string(),
    };

    match status {
        VerificationStatus::Success => {
            let receipt_image_id = loaded
                .image_id
                .clone()
                .ok_or(ServiceError::ReportInvariant(
                    "success reports require receipt_image_id",
                ))?;
            VerificationReport::success(common, receipt_image_id)
        }
        VerificationStatus::DevMode => {
            VerificationReport::dev_mode(common, loaded.image_id.clone(), errors)
        }
        VerificationStatus::Failed => {
            VerificationReport::failed(common, loaded.image_id.clone(), dev_mode, errors)
        }
    }
}

pub fn decode_bundle_journal(
    command: &DecodeJournalCommand,
) -> Result<DecodedJournal, ServiceError> {
    let receipt_path = resolve_receipt_path(&command.bundle_path)?;
    let loaded = load_receipt_from_file(&receipt_path)?;
    let report = verify_loaded_receipt(
        &VerifyCommand {
            bundle_path: command.bundle_path.clone(),
            image_id: command.image_id.clone(),
            output_path: None,
            quiet: true,
        },
        &loaded,
    )?;
    if report.status() != VerificationStatus::Success {
        return Err(ServiceError::VerificationDidNotSucceed(Box::new(report)));
    }

    decode_loaded_journal(&loaded)
}

fn decode_loaded_journal(loaded: &LoadedReceipt) -> Result<DecodedJournal, ServiceError> {
    let image_id = loaded
        .image_id
        .clone()
        .ok_or(ServiceError::ReceiptImageIdMissing)?;
    let output: VerificationOutput = loaded
        .receipt
        .journal
        .decode()
        .map_err(|error| ServiceError::JournalDecode(error.to_string()))?;
    if output.method_version != CURRENT_METHOD_VERSION {
        return Err(ServiceError::JournalDecode(format!(
            "unsupported method version: expected {CURRENT_METHOD_VERSION}, got {}",
            output.method_version
        )));
    }
    Ok(DecodedJournal::from_verification_output(output, image_id))
}

pub fn serialize_decoded_journal(journal: &DecodedJournal) -> Result<String, ServiceError> {
    serde_json::to_string_pretty(journal).map_err(ServiceError::JournalSerialize)
}

pub fn write_decoded_journal(path: &Path, journal: &DecodedJournal) -> Result<(), ServiceError> {
    let mut file = File::create(path)?;
    let json = serialize_decoded_journal(journal)?;
    file.write_all(json.as_bytes())?;
    file.write_all(b"\n")?;
    Ok(())
}

pub fn write_report(path: &Path, report: &VerificationReport) -> Result<(), ServiceError> {
    let mut file = File::create(path)?;
    let json = serde_json::to_string_pretty(report).map_err(ServiceError::ReportSerialize)?;
    file.write_all(json.as_bytes())?;
    file.write_all(b"\n")?;
    Ok(())
}

pub fn serialize_report(report: &VerificationReport) -> Result<String, ServiceError> {
    serde_json::to_string_pretty(report).map_err(ServiceError::ReportSerialize)
}

fn resolve_receipt_path(bundle_path: &Path) -> Result<PathBuf, ServiceError> {
    let metadata = match fs::metadata(bundle_path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Err(ServiceError::BundleNotFound(bundle_path.to_path_buf()))
        }
        Err(err) => return Err(ServiceError::Io(err)),
    };

    if metadata.is_file() {
        return Ok(bundle_path.to_path_buf());
    }

    if metadata.is_dir() {
        let mut candidates: Vec<PathBuf> = fs::read_dir(bundle_path)?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.is_file())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| {
                        let lower = name.to_lowercase();
                        lower.ends_with("-receipt.json") || lower == "receipt.json"
                    })
                    .unwrap_or(false)
            })
            .collect();

        candidates.sort();

        if let Some(first) = candidates.into_iter().next() {
            return Ok(first);
        }

        return Err(ServiceError::ReceiptFileNotFound(bundle_path.to_path_buf()));
    }

    Err(ServiceError::ReceiptFileNotFound(bundle_path.to_path_buf()))
}

struct LoadedReceipt {
    receipt: Receipt,
    image_id: Option<String>,
    source_path: PathBuf,
}

fn load_receipt_from_file(path: &Path) -> Result<LoadedReceipt, ServiceError> {
    let is_zip = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("zip"))
        .unwrap_or(false);

    if is_zip {
        return load_receipt_from_zip(path);
    }

    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let raw: Value =
        serde_json::from_reader(reader).map_err(|source| ServiceError::ReceiptParse {
            path: path.to_path_buf(),
            source,
        })?;

    parse_loaded_receipt(raw, path.to_path_buf())
}

fn load_receipt_from_zip(path: &Path) -> Result<LoadedReceipt, ServiceError> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file).map_err(|source| ServiceError::BundleArchive {
        path: path.to_path_buf(),
        source,
    })?;

    let mut receipt_entry: Option<(usize, String)> = None;
    let total = archive.len();
    for index in 0..total {
        let entry_name = {
            let entry = archive
                .by_index(index)
                .map_err(|source| ServiceError::BundleArchive {
                    path: path.to_path_buf(),
                    source,
                })?;
            entry
                .name()
                .map_err(|source| ServiceError::BundleArchive {
                    path: path.to_path_buf(),
                    source,
                })?
                .into_owned()
        };

        if entry_name.to_lowercase().ends_with("receipt.json") {
            receipt_entry = Some((index, entry_name));
            break;
        }
    }

    let (entry_index, entry_name) =
        receipt_entry.ok_or_else(|| ServiceError::ReceiptFileNotFound(path.to_path_buf()))?;

    let mut entry =
        archive
            .by_index(entry_index)
            .map_err(|source| ServiceError::BundleArchive {
                path: path.to_path_buf(),
                source,
            })?;

    let mut content = String::new();
    entry.read_to_string(&mut content)?;

    let virtual_path = path.join(&entry_name);
    let raw: Value =
        serde_json::from_str(&content).map_err(|source| ServiceError::ReceiptParse {
            path: virtual_path.clone(),
            source,
        })?;

    parse_loaded_receipt(raw, virtual_path)
}

fn parse_loaded_receipt(raw: Value, source_path: PathBuf) -> Result<LoadedReceipt, ServiceError> {
    let image_id = raw
        .get("image_id")
        .and_then(Value::as_str)
        .map(normalize_hex_string);

    if let Ok(receipt) = serde_json::from_value::<Receipt>(raw.clone()) {
        return Ok(LoadedReceipt {
            receipt,
            image_id,
            source_path,
        });
    }

    if let Some(receipt_value) = raw.get("receipt") {
        let path_for_result = source_path.clone();
        return serde_json::from_value::<Receipt>(receipt_value.clone())
            .map(|receipt| LoadedReceipt {
                receipt,
                image_id,
                source_path: path_for_result,
            })
            .map_err(|source| ServiceError::ReceiptParse {
                path: source_path.clone(),
                source,
            });
    }

    Err(ServiceError::ReceiptMissing(source_path))
}

impl ImageId {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err("expected non-empty value".to_string());
        }

        let hex = trimmed.strip_prefix("0x").unwrap_or(trimmed);

        if hex.len() != 64 {
            return Err(format!("expected 64 hex characters, got {}", hex.len()));
        }

        let digest = Digest::from_hex(hex).map_err(|err| err.to_string())?;
        Ok(Self {
            normalized: format!("0x{}", hex.to_lowercase()),
            digest,
        })
    }

    pub fn as_str(&self) -> &str {
        &self.normalized
    }

    pub fn digest(&self) -> Digest {
        self.digest
    }
}

fn normalize_hex_string(value: &str) -> String {
    let trimmed = value.trim();
    let hex = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    format!("0x{}", hex.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use risc0_zkvm::{
        sha::Digest as ShaDigest, FakeReceipt, InnerReceipt, MaybePruned, Receipt as ZkReceipt,
        ReceiptClaim,
    };
    use serde_json::json;
    use std::sync::{Mutex, MutexGuard, OnceLock};
    use tempfile::tempdir;
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    #[test]
    fn parse_verify_command_requires_bundle_path() {
        let args = ["verifier-service", "verify", "--image-id", SAMPLE_IMAGE_ID];
        let parse_result = parse_args(&args);

        assert!(
            parse_result.is_err(),
            "expected missing bundle path to produce an error"
        );
    }

    #[test]
    fn parse_verify_command_requires_image_id_when_not_provided() {
        let _env_lock = lock_env();
        let _guard = EnvGuard::new(&["EXPECTED_IMAGE_ID"]);
        let args = ["verifier-service", "verify", "/tmp/bundle.json"];

        let parse_result = parse_args(&args);
        assert!(
            parse_result.is_err(),
            "expected missing image ID to produce an error when env vars unset"
        );
    }

    #[test]
    fn parse_verify_command_uses_env_when_missing_flag() {
        let _env_lock = lock_env();
        let _guard = EnvGuard::new(&["EXPECTED_IMAGE_ID"]);
        unsafe {
            std::env::set_var("EXPECTED_IMAGE_ID", SAMPLE_IMAGE_ID);
        }

        let args = ["verifier-service", "verify", "/tmp/bundle.json"];
        let command = parse_args(&args).expect("parse should succeed");

        match command {
            Command::Verify(cmd) => {
                assert_eq!(cmd.bundle_path, PathBuf::from("/tmp/bundle.json"));
                assert_eq!(cmd.image_id.normalized, SAMPLE_IMAGE_ID);
            }
            Command::DecodeJournal(_) => panic!("expected verify command"),
        }
    }

    #[test]
    fn parse_verify_command_supports_flags() {
        let args = [
            "verifier-service",
            "verify",
            "--bundle",
            "/tmp/bundle",
            "--image-id",
            SAMPLE_IMAGE_ID,
            "--output",
            "/tmp/report.json",
            "--quiet",
        ];

        let command = parse_args(&args).expect("parse should succeed");

        match command {
            Command::Verify(cmd) => {
                assert_eq!(cmd.bundle_path, PathBuf::from("/tmp/bundle"));
                assert_eq!(cmd.image_id.normalized, SAMPLE_IMAGE_ID);
                assert_eq!(cmd.output_path, Some(PathBuf::from("/tmp/report.json")));
                assert!(cmd.quiet);
            }
            Command::DecodeJournal(_) => panic!("expected verify command"),
        }
    }

    #[test]
    fn parse_decode_journal_command_supports_bounded_output() {
        let args = [
            "verifier-service",
            "decode-journal",
            "--bundle",
            "/tmp/bundle.zip",
            "--image-id",
            SAMPLE_IMAGE_ID,
            "--output",
            "/tmp/journal.json",
            "--quiet",
        ];

        let command = parse_args(&args).expect("decode-journal command should parse");

        match command {
            Command::DecodeJournal(command) => {
                assert_eq!(command.bundle_path, PathBuf::from("/tmp/bundle.zip"));
                assert_eq!(command.image_id.normalized, SAMPLE_IMAGE_ID);
                assert_eq!(
                    command.output_path,
                    Some(PathBuf::from("/tmp/journal.json"))
                );
                assert!(command.quiet);
            }
            Command::Verify(_) => panic!("expected decode-journal command"),
        }
    }

    #[test]
    fn decode_bundle_journal_projects_actual_risc0_serde() {
        let dir = tempdir().expect("temp dir");
        let target = dir.path().join("receipt.json");
        let expected = current_verification_output();
        let receipt_json = build_fake_receipt_json_with_output(SAMPLE_IMAGE_ID, &expected);
        write_receipt_json(&target, &receipt_json);

        let loaded = load_receipt_from_file(&target).expect("fake receipt should load");
        let decoded =
            decode_loaded_journal(&loaded).expect("current receipt journal should decode");

        assert_eq!(decoded.election_id, expected.election_id);
        assert_eq!(decoded.verified_tally, expected.verified_tally);
        assert_eq!(decoded.method_version, CURRENT_METHOD_VERSION);
        assert_eq!(decoded.image_id, SAMPLE_IMAGE_ID);
    }

    #[test]
    fn decode_bundle_journal_refuses_a_non_current_method() {
        let dir = tempdir().expect("temp dir");
        let target = dir.path().join("receipt.json");
        let mut output = current_verification_output();
        output.method_version = CURRENT_METHOD_VERSION - 1;
        write_receipt_json(
            &target,
            &build_fake_receipt_json_with_output(SAMPLE_IMAGE_ID, &output),
        );

        let loaded = load_receipt_from_file(&target).expect("fake receipt should load");
        let result = decode_loaded_journal(&loaded);

        assert!(matches!(
            result,
            Err(ServiceError::JournalDecode(message))
                if message.contains("unsupported method version")
        ));
    }

    #[test]
    fn decode_bundle_journal_refuses_an_unverified_receipt() {
        let dir = tempdir().expect("temp dir");
        let target = dir.path().join("receipt.json");
        let receipt_json =
            build_fake_receipt_json_with_output(SAMPLE_IMAGE_ID, &current_verification_output());
        write_receipt_json(&target, &receipt_json);

        let result = decode_bundle_journal(&DecodeJournalCommand {
            bundle_path: target,
            image_id: ImageId::parse(SAMPLE_IMAGE_ID).expect("valid ImageID"),
            output_path: None,
            quiet: true,
        });

        assert!(matches!(
            result,
            Err(ServiceError::VerificationDidNotSucceed(report))
                if report.status() == VerificationStatus::DevMode
        ));
    }

    #[test]
    fn verify_receipt_rejects_fake_receipts_in_production_mode() {
        let _env_lock = lock_env();
        let _guard = EnvGuard::new(&["RISC0_DEV_MODE"]);

        let claim = ReceiptClaim::ok(ShaDigest::ZERO, Vec::<u8>::new());
        let fake = FakeReceipt::new(MaybePruned::Value(claim));
        let receipt = ZkReceipt::new(InnerReceipt::Fake(fake), vec![]);

        let image_id = ImageId::parse(SAMPLE_IMAGE_ID).expect("valid image id");
        let result = verify_receipt(&receipt, &image_id);

        assert!(
            matches!(
                result,
                Err(ProofVerificationError::ReceiptVerificationFailed(_))
            ),
            "fake receipts should fail verification"
        );
    }

    #[test]
    #[cfg(feature = "production")]
    fn production_feature_rejects_risc0_dev_mode_env() {
        let _env_lock = lock_env();
        let _guard = EnvGuard::new(&["RISC0_DEV_MODE"]);
        unsafe {
            std::env::set_var("RISC0_DEV_MODE", "1");
        }

        let result = std::panic::catch_unwind(|| {
            #[allow(deprecated)]
            {
                let _ = risc0_zkvm::is_dev_mode();
            }
        });

        assert!(
            result.is_err(),
            "production verifier builds must reject inherited RISC0_DEV_MODE"
        );
    }

    #[test]
    fn verify_bundle_reports_dev_mode_with_fixture_receipt() {
        let dir = tempdir().expect("temp dir");
        let target = dir.path().join("valid-receipt.json");
        let receipt_json = build_fake_receipt_json(SAMPLE_IMAGE_ID);
        write_receipt_json(&target, &receipt_json);

        let command = VerifyCommand {
            bundle_path: dir.path().to_path_buf(),
            image_id: ImageId::parse(SAMPLE_IMAGE_ID).expect("image"),
            output_path: None,
            quiet: true,
        };

        let report = verify_bundle(&command).expect("verification should succeed");
        assert_eq!(report.status(), VerificationStatus::DevMode);
        assert_eq!(report.expected_image_id(), SAMPLE_IMAGE_ID);
        assert!(
            report
                .errors()
                .iter()
                .any(|e| e.to_lowercase().contains("proof")),
            "expected proof error in dev mode, got: {:?}",
            report.errors()
        );
        assert_eq!(report.receipt_image_id(), Some(SAMPLE_IMAGE_ID));
        assert!(report.dev_mode_receipt());
    }

    #[test]
    fn verify_bundle_reports_dev_mode_with_zip_archive() {
        let dir = tempdir().expect("temp dir");
        let receipt_json = build_fake_receipt_json(SAMPLE_IMAGE_ID);
        let zip_path = dir.path().join("bundle.zip");
        let file = File::create(&zip_path).expect("create zip bundle");
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        let receipt_content = serialize_receipt_json(&receipt_json);
        zip.start_file("receipt.json", options)
            .expect("start receipt entry");
        zip.write_all(receipt_content.as_bytes())
            .expect("write receipt entry");

        zip.start_file("metadata.json", options)
            .expect("start metadata entry");
        zip.write_all(b"{}\n").expect("write metadata entry");
        zip.finish().expect("finish zip bundle");

        let command = VerifyCommand {
            bundle_path: zip_path,
            image_id: ImageId::parse(SAMPLE_IMAGE_ID).expect("image"),
            output_path: None,
            quiet: true,
        };

        let report = verify_bundle(&command).expect("verification should succeed");
        assert_eq!(report.status(), VerificationStatus::DevMode);
        assert_eq!(report.receipt_path(), "receipt.json");
        assert!(
            report
                .errors()
                .iter()
                .any(|e| e.to_lowercase().contains("proof")),
            "expected proof error in dev mode, got: {:?}",
            report.errors()
        );
        assert!(report.dev_mode_receipt());
    }

    #[test]
    fn verify_bundle_reports_dev_mode_for_tampered_fake_receipt() {
        let valid_fixture = build_fake_receipt_json(SAMPLE_IMAGE_ID);
        let tampered = modify_receipt_with_empty_seal(&valid_fixture)
            .expect("tampered fixture should be generated");

        let dir = tempdir().expect("temp dir");
        let target = dir.path().join("tampered-receipt.json");
        fs::write(&target, tampered).expect("write tampered receipt");

        let command = VerifyCommand {
            bundle_path: dir.path().to_path_buf(),
            image_id: ImageId::parse(SAMPLE_IMAGE_ID).expect("image"),
            output_path: None,
            quiet: true,
        };

        let report = verify_bundle(&command).expect("verification should complete");

        assert_eq!(report.status(), VerificationStatus::DevMode);
        assert!(
            report
                .errors()
                .iter()
                .any(|e| e.to_lowercase().contains("proof")),
            "expected proof error in dev mode, got: {:?}",
            report.errors()
        );
        assert!(report.dev_mode_receipt());
    }

    #[test]
    fn verify_bundle_rejects_mismatched_image_id() {
        let valid_fixture = build_fake_receipt_json(SAMPLE_IMAGE_ID);
        // Modify receipt to have a different image_id
        let wrong_image_id = "0x0000000000000000000000000000000000000000000000000000000000000000";
        let tampered = modify_receipt_image_id(&valid_fixture, wrong_image_id)
            .expect("tampered fixture should be generated");

        let dir = tempdir().expect("temp dir");
        let target = dir.path().join("wrong-imageid-receipt.json");
        fs::write(&target, tampered).expect("write tampered receipt");

        let command = VerifyCommand {
            bundle_path: dir.path().to_path_buf(),
            image_id: ImageId::parse(SAMPLE_IMAGE_ID).expect("image"),
            output_path: None,
            quiet: true,
        };

        let report = verify_bundle(&command).expect("verification should complete");

        assert_eq!(report.status(), VerificationStatus::Failed);
        assert!(
            report
                .errors()
                .iter()
                .any(|e| e.contains("image_id mismatch")),
            "expected image_id mismatch error, got: {:?}",
            report.errors()
        );
        assert_eq!(report.receipt_image_id(), Some(wrong_image_id));
    }

    #[test]
    fn verify_bundle_reports_dev_mode_when_image_id_missing() {
        let valid_fixture = build_fake_receipt_json(SAMPLE_IMAGE_ID);
        // Remove image_id field from receipt
        let tampered =
            remove_receipt_image_id(&valid_fixture).expect("tampered fixture should be generated");

        let dir = tempdir().expect("temp dir");
        let target = dir.path().join("no-imageid-receipt.json");
        fs::write(&target, tampered).expect("write tampered receipt");

        let command = VerifyCommand {
            bundle_path: dir.path().to_path_buf(),
            image_id: ImageId::parse(SAMPLE_IMAGE_ID).expect("image"),
            output_path: None,
            quiet: true,
        };

        let report = verify_bundle(&command).expect("verification should complete");

        assert_eq!(report.status(), VerificationStatus::DevMode);
        assert!(
            report
                .errors()
                .iter()
                .any(|e| e.contains("missing image_id")),
            "expected missing image_id error, got: {:?}",
            report.errors()
        );
        assert_eq!(report.receipt_image_id(), None);
        assert!(report.dev_mode_receipt());
    }

    #[test]
    fn failed_report_requires_nonempty_errors() {
        let report = VerificationReport::failed(
            sentinel_report_common(),
            Some(SAMPLE_IMAGE_ID.to_string()),
            false,
            Vec::new(),
        );

        assert!(
            report.is_err(),
            "failed reports must carry at least one error"
        );
    }

    #[test]
    fn deterministic_report_sentinels_match_current_json() {
        let reports = [
            (
                "current-verifier-report-success.json",
                VerificationReport::success(sentinel_report_common(), SAMPLE_IMAGE_ID.to_string())
                    .expect("coherent success sentinel"),
            ),
            (
                "current-verifier-report-dev-mode.json",
                VerificationReport::dev_mode(
                    sentinel_report_common(),
                    Some(SAMPLE_IMAGE_ID.to_string()),
                    vec!["development receipt rejected".to_string()],
                )
                .expect("coherent dev-mode sentinel"),
            ),
            (
                "current-verifier-report-failed.json",
                VerificationReport::failed(
                    sentinel_report_common(),
                    Some(
                        "0x0000000000000000000000000000000000000000000000000000000000000000"
                            .to_string(),
                    ),
                    false,
                    vec!["receipt metadata image_id mismatch".to_string()],
                )
                .expect("coherent failed sentinel"),
            ),
        ];
        let testdata = Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata");

        for (file_name, report) in reports {
            let expected_json = fs::read_to_string(testdata.join(file_name))
                .unwrap_or_else(|error| panic!("read {file_name}: {error}"));
            let expected: Value = serde_json::from_str(&expected_json)
                .unwrap_or_else(|error| panic!("parse {file_name}: {error}"));
            let actual: Value = serde_json::from_str(
                &serialize_report(&report).expect("serialize report sentinel"),
            )
            .expect("parse emitted report sentinel");
            assert_eq!(
                actual, expected,
                "stale verifier report sentinel: {file_name}"
            );
        }
    }

    fn sentinel_report_common() -> VerificationReportCommon {
        VerificationReportCommon {
            verifier_version: VERSION.to_string(),
            verified_at: "2026-08-11T09:10:11.123456789Z".to_string(),
            duration_ms: 42,
            expected_image_id: SAMPLE_IMAGE_ID.to_string(),
            bundle_path: "bundle.zip".to_string(),
            receipt_path: "receipt.json".to_string(),
        }
    }

    const SAMPLE_IMAGE_ID: &str =
        "0x98465a16a6776bd5fc35299e06dfea5886f87d2f94aac5fd79353af50caa01f4";

    fn build_fake_receipt_json(image_id: &str) -> Value {
        let journal = vec![1, 2, 3];
        let claim = ReceiptClaim::ok(ShaDigest::ZERO, journal.clone());
        let fake = FakeReceipt::new(MaybePruned::Value(claim));
        let receipt = ZkReceipt::new(InnerReceipt::Fake(fake), journal);
        json!({
            "receipt": receipt,
            "image_id": image_id,
        })
    }

    fn current_verification_output() -> contract_core::VerificationOutput {
        contract_core::VerificationOutput {
            election_id: [1; 16],
            election_config_hash: [2; 32],
            bulletin_root: [3; 32],
            tree_size: 5,
            total_expected: 5,
            sth_digest: [4; 32],
            verified_tally: [1, 1, 1, 1, 1],
            total_votes: 5,
            valid_votes: 5,
            invalid_votes: 0,
            seen_indices_count: 5,
            missing_slots: 0,
            invalid_presented_slots: 0,
            rejected_records: 0,
            seen_bitmap_root: [5; 32],
            included_bitmap_root: [6; 32],
            excluded_slots: 0,
            input_commitment: [7; 32],
            method_version: contract_core::CURRENT_METHOD_VERSION,
        }
    }

    fn build_fake_receipt_json_with_output(
        image_id: &str,
        output: &contract_core::VerificationOutput,
    ) -> Value {
        let encoded_words = risc0_zkvm::serde::to_vec(output).expect("encode current journal");
        let journal = encoded_words
            .iter()
            .flat_map(|word| word.to_le_bytes())
            .collect::<Vec<_>>();
        let claim = ReceiptClaim::ok(ShaDigest::ZERO, journal.clone());
        let fake = FakeReceipt::new(MaybePruned::Value(claim));
        let receipt = ZkReceipt::new(InnerReceipt::Fake(fake), journal);
        json!({
            "receipt": receipt,
            "image_id": image_id,
        })
    }

    fn serialize_receipt_json(receipt_json: &Value) -> String {
        serde_json::to_string(receipt_json).expect("serialize receipt json")
    }

    fn write_receipt_json(path: &Path, receipt_json: &Value) {
        let content = serialize_receipt_json(receipt_json);
        fs::write(path, content).expect("write receipt json");
    }

    fn lock_env() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .expect("env lock poisoned")
    }

    struct EnvGuard {
        keys: Vec<&'static str>,
        originals: Vec<Option<String>>,
    }

    impl EnvGuard {
        fn new(keys: &[&'static str]) -> Self {
            let originals = keys
                .iter()
                .map(|key| std::env::var(key).ok())
                .collect::<Vec<_>>();

            for key in keys {
                unsafe {
                    std::env::remove_var(key);
                }
            }

            Self {
                keys: keys.to_vec(),
                originals,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, original) in self.keys.iter().zip(self.originals.iter()) {
                match original {
                    Some(value) => unsafe {
                        std::env::set_var(key, value);
                    },
                    None => unsafe {
                        std::env::remove_var(key);
                    },
                }
            }
        }
    }

    fn modify_receipt_with_empty_seal(receipt_json: &Value) -> Result<String, ServiceError> {
        let mut json = receipt_json.clone();
        let mut modified = false;

        if let Some(Value::Object(ref mut receipt)) = json.get_mut("receipt") {
            if let Some(Value::Object(ref mut inner)) = receipt.get_mut("inner") {
                if let Some(Value::Object(ref mut composite)) = inner.get_mut("Composite") {
                    if let Some(Value::Array(ref mut segments)) = composite.get_mut("segments") {
                        if let Some(Value::Object(ref mut first_segment)) = segments.get_mut(0) {
                            first_segment.insert("seal".to_string(), Value::Array(Vec::new()));
                            modified = true;
                        }
                    }
                }
            }
        }

        if !modified {
            if let Some(Value::Array(ref mut journal)) =
                json.pointer_mut("/receipt/inner/Fake/claim/Value/output/Value/journal/Value")
            {
                if journal.is_empty() {
                    journal.push(Value::from(1));
                } else if let Some(first) = journal.first_mut() {
                    let next = first
                        .as_u64()
                        .map(|value| value.wrapping_add(1))
                        .unwrap_or(1);
                    *first = Value::from(next);
                }
                modified = true;
            }
        }

        if !modified {
            if let Some(top) = json.as_object_mut() {
                top.insert("tampered".to_string(), Value::Bool(true));
            }
        }

        serde_json::to_string(&json).map_err(ServiceError::ReportSerialize)
    }

    fn modify_receipt_image_id(
        receipt_json: &Value,
        new_image_id: &str,
    ) -> Result<String, ServiceError> {
        let mut json = receipt_json.clone();

        // Modify the top-level image_id field
        if let Some(obj) = json.as_object_mut() {
            obj.insert(
                "image_id".to_string(),
                Value::String(new_image_id.to_string()),
            );
        }

        serde_json::to_string(&json).map_err(ServiceError::ReportSerialize)
    }

    fn remove_receipt_image_id(receipt_json: &Value) -> Result<String, ServiceError> {
        let mut json = receipt_json.clone();

        // Remove the top-level image_id field
        if let Some(obj) = json.as_object_mut() {
            obj.remove("image_id");
        }

        serde_json::to_string(&json).map_err(ServiceError::ReportSerialize)
    }
}
