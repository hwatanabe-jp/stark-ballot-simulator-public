# zkvm Makefile
# Common build and test tasks for RISC Zero zkVM Prover Service

.PHONY: help build build-release test test-dev test-prod clean verify-fixture fmt lint check all

# Default ImageID for local x86_64 testing (override on ARM64 / AWS)
EXPECTED_IMAGE_ID ?= 0x090ad73dbc6d3504b947ab5d41e7327f10d8bbcd649df141c47cfa1bb1610db6
FIXTURE_VALID ?= test-data/test-fixture-valid.json
FIXTURE_TAMPERED ?= test-data/test-fixture-tampered.json

help:
	@echo "zkvm - RISC Zero zkVM Prover Service"
	@echo ""
	@echo "Available targets:"
	@echo "  make build            - Build in debug mode"
	@echo "  make build-release    - Build in release mode (optimized)"
	@echo "  make test             - Run all tests (dev mode)"
	@echo "  make test-dev         - Run tests with dev mode (fake proofs)"
	@echo "  make test-prod        - Run tests with production mode (real proofs, slow)"
	@echo "  make clean            - Remove build artifacts"
	@echo "  make verify-fixture   - Run host against test fixtures"
	@echo "  make fmt              - Format code with rustfmt"
	@echo "  make lint             - Lint code with clippy"
	@echo "  make check            - Type-check without building"
	@echo "  make all              - Build, test, and verify"
	@echo ""
	@echo "Environment variables:"
	@echo "  EXPECTED_IMAGE_ID     - ImageID for verification (default: 0x090a...10db6)"
	@echo "  RISC0_DEV_MODE        - Set to 1 for dev mode (fake proofs)"

build:
	@echo "Building zkVM (debug mode)..."
	cargo build

build-release:
	@echo "Building zkVM (release mode)..."
	cargo build --release

test:
	@echo "Running tests (dev mode)..."
	RISC0_DEV_MODE=1 cargo test

test-dev: test

test-prod:
	@echo "Running tests (production mode, real STARK proofs)..."
	@echo "⚠️  Warning: This will take ~6 minutes per test"
	cargo test --release

clean:
	@echo "Cleaning build artifacts..."
	cargo clean
	@echo "Removing generated test outputs..."
	rm -f test-data/*-output.json test-data/*-receipt.json
	@echo "Clean complete."

verify-fixture: build-release
	@echo "Verifying test fixtures..."
	@echo ""
	@echo "=== Valid Fixture (dev mode) ==="
	RISC0_DEV_MODE=1 ./target/release/host $(FIXTURE_VALID)
	@echo ""
	@echo "=== Tampered Fixture (should detect tampering) ==="
	RISC0_DEV_MODE=1 ./target/release/host $(FIXTURE_TAMPERED) || true
	@echo ""
	@echo "Fixture verification complete."

fmt:
	@echo "Formatting code..."
	cargo fmt

lint:
	@echo "Linting code..."
	cargo clippy -- -D warnings

check:
	@echo "Type-checking code..."
	cargo check

all: clean build-release test verify-fixture
	@echo ""
	@echo "All tasks completed successfully!"
