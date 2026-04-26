# verifier-service Makefile
# Common build and test tasks for RISC Zero Receipt Verification Service

.PHONY: help build build-release test refresh-fixture-receipt test-tamper clean verify-fixture fmt lint check all

HOST_BIN ?= ../zkvm/target/release/host
FIXTURE_INPUT_PATH ?= ../zkvm/test-data/test-fixture-valid.json
VALID_FIXTURE_PATH ?= ../zkvm/test-data/test-fixture-valid-receipt.json
VALID_FIXTURE_OUTPUT_PATH ?= ../zkvm/test-data/test-fixture-valid-output.json
TAMPERED_FIXTURE_PATH ?= ../zkvm/test-data/test-fixture-tampered-stark-receipt.json
IMAGE_ID_READER ?= ./scripts/read-image-id.mjs
CURRENT_IMAGE_ID ?= $(shell node $(IMAGE_ID_READER) ../public/imageId-mapping.json 2>/dev/null)

help:
	@echo "verifier-service - RISC Zero Receipt Verification Service"
	@echo ""
	@echo "Available targets:"
	@echo "  make build            - Build in debug mode"
	@echo "  make build-release    - Build in release mode (optimized)"
	@echo "  make test             - Run all tests"
	@echo "  make refresh-fixture-receipt - Regenerate a real fixture receipt from zkVM input"
	@echo "  make test-tamper      - Test STARK proof tamper detection"
	@echo "  make clean            - Remove build artifacts"
	@echo "  make verify-fixture   - Verify test fixture with actual binary"
	@echo "  make fmt              - Format code with rustfmt"
	@echo "  make lint             - Lint code with clippy"
	@echo "  make check            - Type-check without building"
	@echo "  make all              - Build, test, and verify"
	@echo ""
	@echo "Environment variables:"
	@echo "  CURRENT_IMAGE_ID      - Current mapping ImageID (default: $(CURRENT_IMAGE_ID))"
	@echo "  HOST_BIN              - Path to zkVM host binary (default: ../zkvm/target/release/host)"
	@echo "  FIXTURE_INPUT_PATH    - zkVM fixture input JSON (default: ../zkvm/test-data/test-fixture-valid.json)"
	@echo "  VALID_FIXTURE_PATH    - Regenerated valid receipt path (default: ../zkvm/test-data/test-fixture-valid-receipt.json)"
	@echo "  TAMPERED_FIXTURE_PATH - Tampered receipt path (default: ../zkvm/test-data/test-fixture-tampered-stark-receipt.json)"

build:
	@echo "Building verifier-service (debug mode)..."
	cargo build

build-release:
	@echo "Building verifier-service (release mode)..."
	cargo build --release

test:
	@echo "Running tests..."
	cargo test

refresh-fixture-receipt:
	@echo "Generating fresh real receipt from $(FIXTURE_INPUT_PATH)..."
	@test -x "$(HOST_BIN)" || { echo "zkVM host binary not found at $(HOST_BIN). Run 'pnpm build:zkvm' first."; exit 1; }
	env -u RISC0_DEV_MODE "$(HOST_BIN)" "$(FIXTURE_INPUT_PATH)"

test-tamper: build-release refresh-fixture-receipt
	@echo "Testing STARK proof tamper detection..."
	@echo ""
	@echo "Step 1: Generating tampered receipt..."
	cd .. && pnpm tsx scripts/tests/tamper-stark-proof.ts
	@echo ""
	@echo "Step 2: Verifying tampered receipt (should fail with exit code 3)..."
	@fixture_image_id="$$(node $(IMAGE_ID_READER) "$(abspath $(VALID_FIXTURE_OUTPUT_PATH))")"; \
	status=0; \
	./target/release/verifier-service verify \
		"$(abspath $(TAMPERED_FIXTURE_PATH))" \
		--image-id "$$fixture_image_id" || status=$$?; \
	if [ $$status -ne 3 ]; then \
		echo "Expected verifier-service to exit with code 3, got $$status"; \
		exit 1; \
	fi
	@echo ""
	@echo "STARK proof tamper detection: PASSED"

clean:
	@echo "Cleaning build artifacts..."
	cargo clean
	@echo "Clean complete."

verify-fixture: build-release refresh-fixture-receipt
	@echo "Verifying regenerated fixture..."
	@echo ""
	@fixture_image_id="$$(node $(IMAGE_ID_READER) "$(abspath $(VALID_FIXTURE_OUTPUT_PATH))")"; \
	echo "Receipt path: $(abspath $(VALID_FIXTURE_PATH))"; \
	echo "Expected ImageID: $$fixture_image_id"; \
	echo ""; \
	./target/release/verifier-service verify \
		"$(abspath $(VALID_FIXTURE_PATH))" \
		--image-id "$$fixture_image_id"

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
