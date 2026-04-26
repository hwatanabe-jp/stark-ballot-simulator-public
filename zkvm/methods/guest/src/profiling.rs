use alloc::vec::Vec;
use risc0_zkvm::guest::env;

/// Simple profiling utility for zkVM guest code
/// Note: This is for development only, remove for production
pub struct Profiler {
    checkpoints: Vec<(&'static str, u64)>,
    start_cycle: u64,
}

impl Profiler {
    pub fn new() -> Self {
        Self {
            checkpoints: Vec::new(),
            start_cycle: env::cycle_count(),
        }
    }

    pub fn checkpoint(&mut self, name: &'static str) {
        let current = env::cycle_count();
        self.checkpoints.push((name, current));
    }

    pub fn report(&self) {
        if self.checkpoints.is_empty() {
            return;
        }

        eprintln!("=== Performance Profile ===");
        eprintln!("Total cycles: {}", env::cycle_count() - self.start_cycle);
        eprintln!();

        let mut prev_cycle = self.start_cycle;
        for (name, cycle) in &self.checkpoints {
            let delta = cycle - prev_cycle;
            eprintln!("{}: {} cycles", name, delta);
            prev_cycle = *cycle;
        }
        eprintln!("===========================");
    }
}
