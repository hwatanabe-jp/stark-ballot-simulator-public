# zkVM Benchmark Notes

## Status

This document summarizes the checked-in benchmark artifacts under `zkvm/`.

The CSV files currently committed in this repository:

- `zkvm/benchmark_results_20250803_162242.csv`
- `zkvm/benchmark_results_20250803_162253.csv`

were generated on August 3, 2025 by the minimal benchmark harness in
`zkvm/benchmarks/src/bench_minimal.rs`.

These results are useful as a prover-overhead baseline. They are not a
performance report for the full STARK Ballot guest used by the application.

## What Was Benchmarked

The checked-in harness measures:

- binary: `bench-minimal`
- guest: `methods_minimal::GUEST_MINIMAL_ELF`
- workload: simple tallying over `MinimalVote { choice, valid }`
- modes: dev mode (`RISC0_DEV_MODE=1`) and production proving
- output columns: `proof_time_ms`, `total_time_ms`

This benchmark intentionally uses a stripped-down guest so we can see how much
wall-clock time comes from the prover path even when the guest logic is tiny.

## Checked-in Results

### Dev Mode Run

From `zkvm/benchmark_results_20250803_162242.csv`:

- 1 vote: 16 ms
- 10 votes: 16 ms
- 100 votes: 16 ms

### Production Proving Run

From `zkvm/benchmark_results_20250803_162253.csv`:

- 1 vote: 3420 ms
- 10 votes: 3279 ms
- 100 votes: 3408 ms

## Current Interpretation

For this minimal guest, proving time stayed roughly flat across 1, 10, and
100 votes in the August 3, 2025 runs.

The most likely interpretation is:

- when guest work is intentionally tiny, prover overhead dominates wall-clock time
- the benchmark is useful for establishing a lower bound on local proving cost
- the benchmark does not show that the full zkVM implementation has constant-time behavior

The old conclusion that "proof generation is O(1)" was too broad for the
current project. The data only supports a narrower statement about this minimal
benchmark workload.

## What These Results Do Not Measure

The checked-in benchmark does not exercise the current full guest in
`zkvm/methods/guest/src/`.

In particular, it does not measure the cost of:

- commitment verification with domain-separated SHA-256
- RFC 6962 inclusion proof verification
- duplicate commitment detection
- seen/included bitmap root construction
- canonical input commitment encoding and sorting
- real fixture shapes from `zkvm/test-data/`
- app-driven proof generation through `src/lib/zkvm/executor.ts`
- async ARM64 ECS/Fargate prover execution
- `verifier-service` receipt verification latency

## Notes About the Harness

The current benchmark harness records useful end-to-end wall-clock numbers, but
it also has limitations:

- it benchmarks `methods-minimal`, not the production guest
- the current `execution_time_ms` field is not a guest-execution metric; it only
  measures the small interval around prover construction
- it does not include guest-internal cycle checkpoints
- it does not compare valid and tampered full-fixture paths

Because of that, this document should be treated as a baseline note, not a
comprehensive optimization report.

## Historical Note

Earlier benchmark notes referred to a "Merkle tree + Poseidon" bottleneck.
That does not describe the current guest implementation in this repository,
which centers on domain-separated SHA-256 and RFC 6962-style inclusion proofs.

Keep the older discussion only as historical context for prior experiments.

## Recommended Next Measurements

To make this document reflect current project reality more directly, the next
benchmark pass should measure the full guest with production-shaped inputs.

Recommended additions:

1. Add a benchmark harness for the full guest using checked-in fixture inputs.
2. Capture runs for at least 8, 32, and 64 votes in both dev and production modes.
3. Compare a valid fixture and a tampered fixture to understand failure-path cost.
4. Add guest cycle checkpoints around:
   - commitment verification
   - inclusion proof verification
   - bitmap root construction
   - input commitment computation
5. Record the environment for each run:
   - host architecture
   - dev vs production proving
   - local vs async ARM64 prover path
   - Rust toolchain and RISC Zero version

## Practical Takeaway

Today, the checked-in benchmark supports one narrow claim:

- local proving has a non-trivial fixed cost even for a very small guest

It does not yet answer the more important question for this project:

- where the full STARK Ballot guest spends cycles, and which optimization would
  materially reduce real proving time
