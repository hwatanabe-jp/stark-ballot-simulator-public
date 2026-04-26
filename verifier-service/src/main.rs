use verifier_service::{
    parse_args, serialize_report, verify_bundle, write_report, Command, ServiceError,
    VerificationStatus, VerifyCommand,
};

fn main() {
    let owned_args: Vec<String> = std::env::args().collect();
    let borrowed_args: Vec<&str> = owned_args.iter().map(String::as_str).collect();

    let command = match parse_args(&borrowed_args) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };

    if let Err(error) = dispatch(command) {
        report_error_and_exit(error);
    }
}

fn dispatch(command: Command) -> Result<(), ServiceError> {
    match command {
        Command::Verify(command) => handle_verify(command),
    }
}

fn handle_verify(command: VerifyCommand) -> Result<(), ServiceError> {
    let report = verify_bundle(&command)?;

    if !command.quiet {
        let stdout = serialize_report(&report)?;
        println!("{stdout}");
    }

    if let Some(path) = &command.output_path {
        write_report(path, &report)?;
    }

    if report.status == VerificationStatus::Success {
        Ok(())
    } else {
        Err(ServiceError::VerificationDidNotSucceed(Box::new(report)))
    }
}

fn report_error_and_exit(error: ServiceError) -> ! {
    match &error {
        ServiceError::VerificationDidNotSucceed(report) => match report.status {
            VerificationStatus::DevMode => {
                eprintln!("verification completed in dev mode (receipt rejected)");
                std::process::exit(2);
            }
            VerificationStatus::Failed => {
                eprintln!("verification failed");
                if !report.errors.is_empty() {
                    for err in &report.errors {
                        eprintln!("  - {err}");
                    }
                }
                std::process::exit(3);
            }
            VerificationStatus::Success => {
                // Should not happen, but fall back to generic handling.
                eprintln!("{error}");
                std::process::exit(1);
            }
        },
        _ => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
