use std::{
    fs,
    fs::File,
    io::{self, BufReader, Read, Write},
    path::{Path, PathBuf},
    time::Instant,
};

use hex::FromHex;
use risc0_zkp::{core::digest::Digest, verify::VerificationError as Risc0VerificationError};
use risc0_zkvm::{InnerReceipt, Receipt};
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use zip::ZipArchive;

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedImageId {
    pub normalized: String,
    pub digest: Digest,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Verify(VerifyCommand),
}

#[derive(Debug, PartialEq, Eq)]
pub struct VerifyCommand {
    pub bundle_path: PathBuf,
    pub image_id: ParsedImageId,
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
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    Success,
    Failed,
    DevMode,
}

#[derive(Debug, Clone, Serialize)]
pub struct VerificationReport {
    pub status: VerificationStatus,
    pub verifier_version: String,
    pub verified_at: String,
    pub duration_ms: u128,
    pub expected_image_id: String,
    pub receipt_image_id: Option<String>,
    pub bundle_path: String,
    pub receipt_path: String,
    pub dev_mode_receipt: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

pub fn parse_args(args: &[&str]) -> Result<Command, String> {
    let mut iter = args.iter().copied();

    // Skip binary name if present.
    iter.next();

    let command = iter.next().ok_or_else(|| {
        "no command provided; usage: verifier-service verify [options]".to_string()
    })?;

    match command {
        "verify" => parse_verify_command(iter),
        other => Err(format!(
            "unknown command `{other}`; supported commands: verify"
        )),
    }
}

fn print_help() {
    println!(
        r#"verifier-service - RISC Zero Receipt Verification Tool

USAGE:
    verifier-service verify [OPTIONS] <BUNDLE_PATH> [IMAGE_ID]

ARGS:
    <BUNDLE_PATH>    Path to receipt bundle (file, directory, or zip archive)
    [IMAGE_ID]       Expected ImageID (hex string with 0x prefix)

OPTIONS:
    -b, --bundle <PATH>      Path to receipt bundle (alternative to positional arg)
    -i, --image-id <ID>      Expected ImageID (alternative to positional arg)
    -o, --output <PATH>      Write verification report to file
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

EXIT CODES:
    0    Verification succeeded
    1    General error (invalid arguments, I/O error, etc.)
    2    Verification completed in dev mode (fake receipt detected)
    3    Verification failed (proof invalid or ImageID mismatch)
"#
    );
}

fn parse_verify_command<'a, I>(mut iter: I) -> Result<Command, String>
where
    I: Iterator<Item = &'a str>,
{
    let mut bundle: Option<PathBuf> = None;
    let mut image_id: Option<ParsedImageId> = None;
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
                    parse_image_id_from_str(value)
                        .map_err(|msg| format!("invalid --image-id: {msg}"))?,
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
                        parse_image_id_from_str(value)
                            .map_err(|msg| format!("invalid image ID: {msg}"))?,
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

    let image_id = match image_id {
        Some(id) => id,
        None => {
            let env_value = std::env::var("EXPECTED_IMAGE_ID").map_err(|_| {
                "missing expected image ID; pass --image-id or set EXPECTED_IMAGE_ID".to_string()
            })?;
            parse_image_id_from_str(&env_value)
                .map_err(|msg| format!("invalid expected image ID from environment: {msg}"))?
        }
    };

    Ok(Command::Verify(VerifyCommand {
        bundle_path,
        image_id,
        output_path: output,
        quiet,
    }))
}

pub fn verify_receipt(
    receipt: &Receipt,
    image_id: &ParsedImageId,
) -> Result<(), ProofVerificationError> {
    receipt
        .verify(image_id.digest)
        .map_err(ProofVerificationError::from)
}

pub fn verify_bundle(command: &VerifyCommand) -> Result<VerificationReport, ServiceError> {
    let receipt_path = resolve_receipt_path(&command.bundle_path)?;
    let loaded = load_receipt_from_file(&receipt_path)?;

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

    let report = VerificationReport {
        status,
        verifier_version: VERSION.to_string(),
        verified_at: timestamp,
        duration_ms,
        expected_image_id: command.image_id.normalized.clone(),
        receipt_image_id: loaded.image_id,
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
        dev_mode_receipt: dev_mode,
        errors,
    };

    Ok(report)
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
            entry.name().to_string()
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

fn parse_image_id_from_str(raw: &str) -> Result<ParsedImageId, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("expected non-empty value".to_string());
    }

    let hex = trimmed.strip_prefix("0x").unwrap_or(trimmed);

    if hex.len() != 64 {
        return Err(format!("expected 64 hex characters, got {}", hex.len()));
    }

    let digest = Digest::from_hex(hex).map_err(|err| err.to_string())?;
    Ok(ParsedImageId {
        normalized: format!("0x{}", hex.to_lowercase()),
        digest,
    })
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
        }
    }

    #[test]
    fn verify_receipt_rejects_fake_receipts_in_production_mode() {
        let _env_lock = lock_env();
        let _guard = EnvGuard::new(&["RISC0_DEV_MODE"]);

        let claim = ReceiptClaim::ok(ShaDigest::ZERO, Vec::<u8>::new());
        let fake = FakeReceipt::new(MaybePruned::Value(claim));
        let receipt = ZkReceipt::new(InnerReceipt::Fake(fake), vec![]);

        let image_id = parse_image_id_from_str(SAMPLE_IMAGE_ID).expect("valid image id");
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
    fn verify_bundle_reports_dev_mode_with_fixture_receipt() {
        let dir = tempdir().expect("temp dir");
        let target = dir.path().join("valid-receipt.json");
        let receipt_json = build_fake_receipt_json(SAMPLE_IMAGE_ID);
        write_receipt_json(&target, &receipt_json);

        let command = VerifyCommand {
            bundle_path: dir.path().to_path_buf(),
            image_id: parse_image_id_from_str(SAMPLE_IMAGE_ID).expect("image"),
            output_path: None,
            quiet: true,
        };

        let report = verify_bundle(&command).expect("verification should succeed");
        assert_eq!(report.status, VerificationStatus::DevMode);
        assert_eq!(report.expected_image_id, SAMPLE_IMAGE_ID);
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.to_lowercase().contains("proof")),
            "expected proof error in dev mode, got: {:?}",
            report.errors
        );
        assert_eq!(report.receipt_image_id.as_deref(), Some(SAMPLE_IMAGE_ID));
        assert!(report.dev_mode_receipt);
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
            image_id: parse_image_id_from_str(SAMPLE_IMAGE_ID).expect("image"),
            output_path: None,
            quiet: true,
        };

        let report = verify_bundle(&command).expect("verification should succeed");
        assert_eq!(report.status, VerificationStatus::DevMode);
        assert_eq!(report.receipt_path, "receipt.json");
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.to_lowercase().contains("proof")),
            "expected proof error in dev mode, got: {:?}",
            report.errors
        );
        assert!(report.dev_mode_receipt);
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
            image_id: parse_image_id_from_str(SAMPLE_IMAGE_ID).expect("image"),
            output_path: None,
            quiet: true,
        };

        let report = verify_bundle(&command).expect("verification should complete");

        assert_eq!(report.status, VerificationStatus::DevMode);
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.to_lowercase().contains("proof")),
            "expected proof error in dev mode, got: {:?}",
            report.errors
        );
        assert!(report.dev_mode_receipt);
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
            image_id: parse_image_id_from_str(SAMPLE_IMAGE_ID).expect("image"),
            output_path: None,
            quiet: true,
        };

        let report = verify_bundle(&command).expect("verification should complete");

        assert_eq!(report.status, VerificationStatus::Failed);
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("image_id mismatch")),
            "expected image_id mismatch error, got: {:?}",
            report.errors
        );
        assert_eq!(report.receipt_image_id.as_deref(), Some(wrong_image_id));
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
            image_id: parse_image_id_from_str(SAMPLE_IMAGE_ID).expect("image"),
            output_path: None,
            quiet: true,
        };

        let report = verify_bundle(&command).expect("verification should complete");

        assert_eq!(report.status, VerificationStatus::DevMode);
        assert!(
            report.errors.iter().any(|e| e.contains("missing image_id")),
            "expected missing image_id error, got: {:?}",
            report.errors
        );
        assert_eq!(report.receipt_image_id, None);
        assert!(report.dev_mode_receipt);
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
