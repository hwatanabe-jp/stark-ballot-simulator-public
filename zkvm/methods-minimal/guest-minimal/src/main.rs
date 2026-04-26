#![no_main]
#![no_std]

extern crate alloc;
use alloc::vec::Vec;
use risc0_zkvm::guest::env;
use serde::{Deserialize, Serialize};

// Minimal data structures
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
    counts: [u32; 5], // A-E vote counts
    total_votes: u32,
}

#[cfg(not(test))]
risc0_zkvm::guest::entry!(guest_main);

#[cfg(test)]
#[no_mangle]
pub extern "C" fn main() -> i32 {
    0
}

pub fn guest_main() {
    if cfg!(test) {
        return;
    }

    // Read input from host
    let input: MinimalInput = env::read();

    // Simple vote counting
    let mut counts = [0u32; 5];
    let mut total_votes = 0u32;

    for vote in input.votes.iter() {
        if vote.valid && vote.choice < 5 {
            counts[vote.choice as usize] += 1;
            total_votes += 1;
        }
    }

    let output = MinimalOutput {
        counts,
        total_votes,
    };

    // Commit output
    env::commit(&output);
}
