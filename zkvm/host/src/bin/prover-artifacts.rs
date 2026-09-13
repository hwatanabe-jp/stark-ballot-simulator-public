use std::{env, fs, process};

use host::artifacts::{
    build_public_audit_artifacts, to_pretty_json, validate_serialized_public_audit_artifacts,
};

fn main() {
    if let Err(message) = run(env::args().skip(1).collect()) {
        eprintln!("{message}");
        process::exit(1);
    }
}

fn run(args: Vec<String>) -> Result<(), String> {
    match args.as_slice() {
        [command, input_path, output_path]
            if command == "journal"
                || command == "public-input"
                || command == "election-manifest"
                || command == "close-statement" =>
        {
            render_artifact(command, input_path, output_path)
        }
        [command, journal_path, public_input_path, manifest_path, close_path]
            if command == "validate" =>
        {
            validate_serialized_public_audit_artifacts(
                &read_json(journal_path, "journal artifact")?,
                &read_json(public_input_path, "public-input artifact")?,
                &read_json(manifest_path, "election-manifest artifact")?,
                &read_json(close_path, "close-statement artifact")?,
            )
        }
        _ => Err(usage()),
    }
}

fn render_artifact(command: &str, input_path: &str, output_path: &str) -> Result<(), String> {
    let artifacts = build_public_audit_artifacts(
        &read_json(input_path, "prover input")?,
        &read_json(output_path, "host output")?,
    )?;
    let rendered = match command {
        "journal" => to_pretty_json(&artifacts.journal)?,
        "public-input" => to_pretty_json(&artifacts.public_input)?,
        "election-manifest" => to_pretty_json(&artifacts.election_manifest)?,
        "close-statement" => to_pretty_json(&artifacts.close_statement)?,
        _ => return Err(usage()),
    };
    println!("{rendered}");
    Ok(())
}

fn read_json(path: &str, label: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|_| format!("failed to read {label}"))
}

fn usage() -> String {
    "usage: prover-artifacts <journal|public-input|election-manifest|close-statement> <input> <output> | prover-artifacts validate <journal> <public-input> <election-manifest> <close-statement>"
        .to_string()
}
