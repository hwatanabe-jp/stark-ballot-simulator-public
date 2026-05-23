#![no_main]

extern crate alloc;

use alloc::format;
use contract_core::AggregatorInput;
use risc0_zkvm::guest::env;
use tally::verify_and_tally_checked;

#[cfg(feature = "profiling")]
mod profiling;
mod sth;
mod tally;

#[cfg(feature = "profiling")]
use profiling::Profiler;

#[cfg(not(feature = "profiling"))]
struct Profiler;

#[cfg(not(feature = "profiling"))]
impl Profiler {
    #[inline(always)]
    fn new() -> Self {
        Self
    }

    #[inline(always)]
    fn checkpoint(&mut self, _label: &'static str) {}

    #[inline(always)]
    fn report(&self) {}
}

#[cfg(feature = "profiling")]
fn log_message(message: &str) {
    eprintln!("{}", message);
}

#[cfg(not(feature = "profiling"))]
fn log_message(_message: &str) {}

#[cfg(not(test))]
risc0_zkvm::guest::entry!(guest_main);

#[cfg(test)]
#[no_mangle]
pub extern "C" fn main() -> i32 {
    0
}

/// Main entry point for the zkVM implementation.
pub fn guest_main() {
    if cfg!(test) {
        return;
    }

    let mut profiler = Profiler::new();
    let input: AggregatorInput = env::read();
    profiler.checkpoint("read input");
    log_message(&format!("Processing {} votes", input.votes.len()));

    let output = verify_and_tally_checked(&input)
        .unwrap_or_else(|e| panic!("Input validation failed: {}", e))
        .output;
    profiler.checkpoint("process and verify");

    env::commit(&output);
    profiler.checkpoint("commit output");
    profiler.report();
}
