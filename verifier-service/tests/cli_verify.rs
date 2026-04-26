use std::{fs, path::Path, process::Command};

use risc0_zkvm::{
    sha::Digest as ShaDigest, FakeReceipt, InnerReceipt, MaybePruned, Receipt as ZkReceipt,
    ReceiptClaim,
};
use serde_json::{json, Value};
use tempfile::tempdir;

const SAMPLE_IMAGE_ID: &str = "0x98465a16a6776bd5fc35299e06dfea5886f87d2f94aac5fd79353af50caa01f4";
const WRONG_IMAGE_ID: &str = "0x0000000000000000000000000000000000000000000000000000000000000000";

#[test]
fn verify_command_returns_dev_mode_exit_code_and_report_for_fake_receipt() {
    let temp_dir = tempdir().expect("temp dir");
    let receipt_path = temp_dir.path().join("receipt.json");
    let report_path = temp_dir.path().join("report.json");

    write_receipt_json(&receipt_path, SAMPLE_IMAGE_ID);

    let output = run_verify(&receipt_path, SAMPLE_IMAGE_ID, Some(&report_path), false);

    assert_eq!(
        output.status.code(),
        Some(2),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout_report = parse_report(&output.stdout);
    let file_report = parse_report_file(&report_path);

    assert_eq!(stdout_report, file_report);
    assert_eq!(stdout_report["status"], "dev_mode");
    assert_eq!(stdout_report["expected_image_id"], SAMPLE_IMAGE_ID);
    assert_eq!(stdout_report["receipt_image_id"], SAMPLE_IMAGE_ID);
    assert_eq!(stdout_report["bundle_path"], "receipt.json");
    assert_eq!(stdout_report["receipt_path"], "receipt.json");
    assert_eq!(stdout_report["dev_mode_receipt"], true);
    assert!(
        stdout_report["errors"]
            .as_array()
            .expect("errors array")
            .iter()
            .filter_map(Value::as_str)
            .any(|error| error.to_lowercase().contains("proof")),
        "expected proof error in report: {stdout_report}"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("verification completed in dev mode"),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn verify_command_returns_failed_exit_code_for_mismatched_image_id() {
    let temp_dir = tempdir().expect("temp dir");
    let receipt_path = temp_dir.path().join("receipt.json");
    let report_path = temp_dir.path().join("report.json");

    write_receipt_json(&receipt_path, WRONG_IMAGE_ID);

    let output = run_verify(&receipt_path, SAMPLE_IMAGE_ID, Some(&report_path), true);

    assert_eq!(
        output.status.code(),
        Some(3),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stdout.is_empty(),
        "quiet mode should suppress stdout, got: {}",
        String::from_utf8_lossy(&output.stdout)
    );

    let file_report = parse_report_file(&report_path);
    assert_eq!(file_report["status"], "failed");
    assert_eq!(file_report["expected_image_id"], SAMPLE_IMAGE_ID);
    assert_eq!(file_report["receipt_image_id"], WRONG_IMAGE_ID);
    assert_eq!(file_report["dev_mode_receipt"], true);
    assert!(
        file_report["errors"]
            .as_array()
            .expect("errors array")
            .iter()
            .filter_map(Value::as_str)
            .any(|error| error.contains("image_id mismatch")),
        "expected image mismatch in report: {file_report}"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("verification failed"),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn verify_command_returns_general_error_for_missing_bundle() {
    let temp_dir = tempdir().expect("temp dir");
    let missing_path = temp_dir.path().join("missing-receipt.json");

    let output = run_verify(&missing_path, SAMPLE_IMAGE_ID, None, false);

    assert_eq!(
        output.status.code(),
        Some(1),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stdout.is_empty(),
        "general errors should not emit JSON to stdout, got: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("bundle not found"),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_verify(
    bundle_path: &Path,
    image_id: &str,
    output_path: Option<&Path>,
    quiet: bool,
) -> std::process::Output {
    let binary = env!("CARGO_BIN_EXE_verifier-service");
    let mut command = Command::new(binary);
    command.arg("verify").arg("--bundle").arg(bundle_path);
    command.arg("--image-id").arg(image_id);

    if let Some(path) = output_path {
        command.arg("--output").arg(path);
    }

    if quiet {
        command.arg("--quiet");
    }

    command.output().expect("run verifier-service binary")
}

fn write_receipt_json(path: &Path, image_id: &str) {
    let content =
        serde_json::to_vec(&build_fake_receipt_json(image_id)).expect("serialize receipt");
    fs::write(path, content).expect("write receipt json");
}

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

fn parse_report(stdout: &[u8]) -> Value {
    serde_json::from_slice(stdout).expect("stdout report json")
}

fn parse_report_file(path: &Path) -> Value {
    let content = fs::read_to_string(path).expect("read report file");
    serde_json::from_str(&content).expect("report file json")
}
