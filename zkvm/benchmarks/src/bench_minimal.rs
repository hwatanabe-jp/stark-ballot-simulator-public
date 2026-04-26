use chrono::Local;
use csv::Writer;
use methods_minimal::GUEST_MINIMAL_ELF;
use risc0_zkvm::{default_prover, ExecutorEnv};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::File;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MinimalVote {
    choice: u8,
    valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MinimalInput {
    votes: Vec<MinimalVote>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MinimalOutput {
    counts: [u32; 5],
    total_votes: u32,
}

#[derive(Debug, Serialize)]
struct BenchmarkResult {
    timestamp: String,
    vote_count: usize,
    dev_mode: bool,
    proof_time_ms: u128,
    execution_time_ms: u128,
    total_time_ms: u128,
}

fn create_test_votes(count: usize) -> MinimalInput {
    let mut votes = Vec::with_capacity(count);
    for i in 0..count {
        votes.push(MinimalVote {
            choice: (i % 5) as u8,
            valid: true,
        });
    }
    MinimalInput { votes }
}

fn run_benchmark(
    vote_count: usize,
    dev_mode: bool,
) -> Result<BenchmarkResult, Box<dyn std::error::Error>> {
    println!(
        "\n=== Benchmarking {} votes (dev_mode: {}) ===",
        vote_count, dev_mode
    );

    // Create test data
    let input = create_test_votes(vote_count);

    // Start total timing
    let total_start = Instant::now();

    // Create executor environment
    let env = ExecutorEnv::builder().write(&input)?.build()?;

    // Time execution phase
    let exec_start = Instant::now();
    let prover = default_prover();
    let exec_time = exec_start.elapsed();

    // Time proof generation
    let proof_start = Instant::now();
    let receipt = prover.prove(env, GUEST_MINIMAL_ELF)?;
    let proof_time = proof_start.elapsed();

    let total_time = total_start.elapsed();

    // Extract and verify output
    let output: MinimalOutput = receipt.receipt.journal.decode()?;
    println!("Total votes counted: {}", output.total_votes);

    let result = BenchmarkResult {
        timestamp: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        vote_count,
        dev_mode,
        proof_time_ms: proof_time.as_millis(),
        execution_time_ms: exec_time.as_millis(),
        total_time_ms: total_time.as_millis(),
    };

    println!("Proof generation: {:?}", proof_time);
    println!("Total time: {:?}", total_time);

    Ok(result)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("RISC Zero Minimal Benchmark Tool");

    // Parse command line arguments
    let args: Vec<String> = env::args().collect();

    // Vote counts to test
    let vote_counts = if args.len() > 1 {
        args[1..]
            .iter()
            .filter_map(|s| s.parse::<usize>().ok())
            .collect()
    } else {
        vec![1, 10, 100, 1000]
    };

    // Check if in dev mode
    let dev_mode = env::var("RISC0_DEV_MODE").unwrap_or_default() == "1";

    // Create CSV writer
    let csv_file = format!(
        "benchmark_results_{}.csv",
        Local::now().format("%Y%m%d_%H%M%S")
    );
    let file = File::create(&csv_file)?;
    let mut wtr = Writer::from_writer(file);

    // Run benchmarks
    let mut results = Vec::new();
    for count in vote_counts {
        match run_benchmark(count, dev_mode) {
            Ok(result) => {
                wtr.serialize(&result)?;
                wtr.flush()?;
                results.push(result);
            }
            Err(e) => {
                eprintln!("Error benchmarking {} votes: {}", count, e);
            }
        }
    }

    // Summary
    println!("\n=== Benchmark Summary ===");
    println!("Results saved to: {}", csv_file);
    println!("\nVote Count | Proof Time (ms) | Total Time (ms)");
    println!("-----------|-----------------|----------------");
    for result in &results {
        println!(
            "{:10} | {:15} | {:15}",
            result.vote_count, result.proof_time_ms, result.total_time_ms
        );
    }

    // Complexity analysis
    if results.len() >= 2 {
        println!("\n=== Complexity Analysis ===");
        let base = &results[0];
        for current in results.iter().skip(1) {
            let vote_ratio = current.vote_count as f64 / base.vote_count as f64;
            let time_ratio = current.proof_time_ms as f64 / base.proof_time_ms.max(1) as f64;

            println!(
                "{}→{} votes: {:.1}x votes, {:.1}x time (expected O(n): {:.1}x, O(n²): {:.1}x)",
                base.vote_count,
                current.vote_count,
                vote_ratio,
                time_ratio,
                vote_ratio,
                vote_ratio * vote_ratio
            );
        }
    }

    Ok(())
}
