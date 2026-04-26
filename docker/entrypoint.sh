#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

HOST_BIN="${HOST_BIN:-/opt/zkvm/bin/host}"
INPUT_PATH="${INPUT_PATH:-}"
INPUT_S3_BUCKET="${INPUT_S3_BUCKET:-}"
INPUT_S3_KEY="${INPUT_S3_KEY:-}"
OUTPUT_DIR="${OUTPUT_DIR:-/var/task/output}"
OUTPUT_S3_BUCKET="${OUTPUT_S3_BUCKET:-}"
OUTPUT_S3_PREFIX="${OUTPUT_S3_PREFIX:-}"
PUBLIC_INPUT_SCHEMA="${PUBLIC_INPUT_SCHEMA:-stark-ballot.public_input}"
PUBLIC_INPUT_VERSION="${PUBLIC_INPUT_VERSION:-1.1}"
CURRENT_METHOD_VERSION=12

log() {
  local level="$1"; shift
  printf '[%(%Y-%m-%dT%H:%M:%S%z)T] [%s] %s\n' -1 "$level" "$*"
}

fatal() {
  log "ERROR" "$*"
  exit 1
}

normalize_prefix() {
  local value="${1:-}"
  value="${value#/}"
  value="${value%/}"
  printf '%s' "$value"
}

ensure_host_binary() {
  if [[ ! -x "$HOST_BIN" ]]; then
    fatal "Host binary not found or not executable at $HOST_BIN"
  fi
}

resolve_input_file() {
  if [[ -n "$INPUT_PATH" ]]; then
    if [[ ! -f "$INPUT_PATH" ]]; then
      fatal "INPUT_PATH set to '$INPUT_PATH' but file does not exist"
    fi
    cp "$INPUT_PATH" "$WORK_INPUT"
    return
  fi

  if [[ -n "$INPUT_S3_BUCKET" && -n "$INPUT_S3_KEY" ]]; then
    log INFO "Downloading payload from s3://$INPUT_S3_BUCKET/$INPUT_S3_KEY"
    aws s3 cp "s3://$INPUT_S3_BUCKET/$INPUT_S3_KEY" "$WORK_INPUT"
    return
  fi

  fatal "No input provided. Set INPUT_PATH or INPUT_S3_BUCKET/INPUT_S3_KEY"
}

validate_input_json() {
  if ! jq empty "$WORK_INPUT" >/dev/null 2>&1; then
    fatal "Invalid JSON format in input file"
  fi

  local required_fields=(
    "election_id (or electionId)|(.election_id // .electionId)"
    "election_config_hash (or electionConfigHash)|(.election_config_hash // .electionConfigHash)"
    "bulletin_root (or bulletinRoot)|(.bulletin_root // .bulletinRoot)"
    "tree_size (or treeSize)|(.tree_size // .treeSize)"
    "log_id (or logId)|(.log_id // .logId)"
    "timestamp|(.timestamp)"
    "total_expected (or totalExpected)|(.total_expected // .totalExpected)"
    "votes|(.votes)"
  )

  for entry in "${required_fields[@]}"; do
    local label="${entry%%|*}"
    local expr="${entry#*|}"
    if ! jq -e "$expr" "$WORK_INPUT" >/dev/null 2>&1; then
      fatal "Missing required field: ${label}"
    fi
  done
}

upload_with_retry() {
  local file_path="$1"
  local destination="$2"
  local max_attempts="${UPLOAD_MAX_ATTEMPTS:-3}"
  local backoff_base="${UPLOAD_RETRY_BASE_SECONDS:-2}"
  local attempt=1

  while (( attempt <= max_attempts )); do
    if aws s3 cp "$file_path" "$destination"; then
      return 0
    fi

    if (( attempt == max_attempts )); then
      break
    fi

    local delay=$(( backoff_base ** attempt ))
    log WARN "Upload attempt ${attempt} failed, retrying in ${delay}s..."
    sleep "$delay"
    ((attempt++))
  done

  fatal "Failed to upload ${file_path} to ${destination} after ${max_attempts} attempts"
}

convert_output_to_journal() {
  local output_path="$1"
  local journal_path="$2"

  python3 - "$output_path" "$journal_path" "$CURRENT_METHOD_VERSION" <<'PY'
import json
import re
import sys

output_path, journal_path, current_method_version_raw = sys.argv[1:4]
CURRENT_METHOD_VERSION = int(current_method_version_raw)
HEX_PATTERN = re.compile(r"^[0-9a-fA-F]+$")
UUID_PATTERN = re.compile(r"^[0-9a-fA-F]{32}$")

with open(output_path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

if not isinstance(data, dict):
    raise SystemExit("Invalid zkVM output payload")

def get_value(key):
    if key in data:
        return data[key]
    return None

def normalize_hex_string(value, expected_len=None):
    if not isinstance(value, str):
        return None
    compact = value[2:] if value.startswith("0x") else value
    if len(compact) == 0 or len(compact) % 2 != 0:
        return None
    if HEX_PATTERN.fullmatch(compact) is None:
        return None
    if expected_len is not None and len(compact) != expected_len * 2:
        return None
    return "0x" + compact.lower()

def bytes_to_hex(value, expected_len=None):
    if isinstance(value, str):
        return normalize_hex_string(value, expected_len)
    if isinstance(value, list) and all(isinstance(item, int) and 0 <= item <= 255 for item in value):
        if expected_len is not None and len(value) != expected_len:
            return None
        return "0x" + bytes(value).hex()
    return None

def bytes_to_uuid(value):
    if isinstance(value, str):
        compact = value.replace("-", "")
        if UUID_PATTERN.fullmatch(compact) is None:
            return None
        hex_str = compact.lower()
        return f"{hex_str[0:8]}-{hex_str[8:12]}-{hex_str[12:16]}-{hex_str[16:20]}-{hex_str[20:32]}"
    if isinstance(value, list) and len(value) == 16 and all(isinstance(item, int) and 0 <= item <= 255 for item in value):
        hex_str = bytes(value).hex()
        return f"{hex_str[0:8]}-{hex_str[8:12]}-{hex_str[12:16]}-{hex_str[16:20]}-{hex_str[20:32]}"
    return None

def require(value, label):
    if value is None:
        raise SystemExit(f"Missing {label} in zkVM output")
    return value

def require_int(value, label):
    if not isinstance(value, int) or value < 0:
        raise SystemExit(f"Invalid {label} in zkVM output")
    return value

def require_list(value, label, expected_len=None):
    if (
        not isinstance(value, list)
        or (expected_len is not None and len(value) != expected_len)
        or any(not isinstance(item, int) or item < 0 for item in value)
    ):
        raise SystemExit(f"Invalid {label} in zkVM output")
    return value

def require_current_method_version(value, label):
    method_version = require_int(value, label)
    if method_version != CURRENT_METHOD_VERSION:
        raise SystemExit(f"Unsupported {label} in zkVM output: {method_version}")
    return method_version

election_id = require(bytes_to_uuid(get_value("electionId")), "electionId")
election_config_hash = require(bytes_to_hex(get_value("electionConfigHash"), 32), "electionConfigHash")
bulletin_root = require(bytes_to_hex(get_value("bulletinRoot"), 32), "bulletinRoot")
sth_digest = require(bytes_to_hex(get_value("sthDigest"), 32), "sthDigest")
included_bitmap_root = require(bytes_to_hex(get_value("includedBitmapRoot"), 32), "includedBitmapRoot")
seen_bitmap_root = require(bytes_to_hex(get_value("seenBitmapRoot"), 32), "seenBitmapRoot")
input_commitment = require(bytes_to_hex(get_value("inputCommitment"), 32), "inputCommitment")
image_id = require(bytes_to_hex(get_value("imageId"), 32), "imageId")

verified_tally = require_list(get_value("verifiedTally"), "verifiedTally", expected_len=5)

journal = {
    "electionId": election_id,
    "electionConfigHash": election_config_hash,
    "bulletinRoot": bulletin_root,
    "treeSize": require_int(get_value("treeSize"), "treeSize"),
    "totalExpected": require_int(get_value("totalExpected"), "totalExpected"),
    "sthDigest": sth_digest,
    "verifiedTally": verified_tally,
    "totalVotes": require_int(get_value("totalVotes"), "totalVotes"),
    "validVotes": require_int(get_value("validVotes"), "validVotes"),
    "invalidVotes": require_int(get_value("invalidVotes"), "invalidVotes"),
    "seenIndicesCount": require_int(get_value("seenIndicesCount"), "seenIndicesCount"),
    "missingSlots": require_int(get_value("missingSlots"), "missingSlots"),
    "invalidPresentedSlots": require_int(get_value("invalidPresentedSlots"), "invalidPresentedSlots"),
    "rejectedRecords": require_int(get_value("rejectedRecords"), "rejectedRecords"),
    "seenBitmapRoot": seen_bitmap_root,
    "includedBitmapRoot": included_bitmap_root,
    "excludedSlots": require_int(get_value("excludedSlots"), "excludedSlots"),
    "inputCommitment": input_commitment,
    "methodVersion": require_current_method_version(get_value("methodVersion"), "methodVersion"),
    "imageId": image_id,
}

with open(journal_path, "w", encoding="utf-8") as handle:
    json.dump(journal, handle)
PY
}

build_public_input() {
  local input_path="$1"
  local output_path="$2"
  local public_path="$3"

  python3 - "$input_path" "$output_path" "$public_path" "$PUBLIC_INPUT_SCHEMA" "$PUBLIC_INPUT_VERSION" "$CURRENT_METHOD_VERSION" <<'PY'
import json
import sys

input_path, output_path, public_path, schema, version, current_method_version_raw = sys.argv[1:7]
CURRENT_METHOD_VERSION = int(current_method_version_raw)

with open(input_path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

with open(output_path, "r", encoding="utf-8") as handle:
    output = json.load(handle)

if not isinstance(output, dict):
    raise SystemExit("Invalid zkVM output payload")

def get_value(record, *keys):
    if not isinstance(record, dict):
        return None
    for key in keys:
        if key in record:
            return record[key]
    return None

def bytes_to_hex(value, expected_len=None):
    if isinstance(value, str):
        return value if value.startswith("0x") else f"0x{value}"
    if isinstance(value, list) and all(isinstance(item, int) for item in value):
        if expected_len is not None and len(value) != expected_len:
            return None
        return "0x" + bytes(value).hex()
    return None

def bytes_to_uuid(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list) and len(value) == 16 and all(isinstance(item, int) for item in value):
        hex_str = bytes(value).hex()
        return f"{hex_str[0:8]}-{hex_str[8:12]}-{hex_str[12:16]}-{hex_str[16:20]}-{hex_str[20:32]}"
    return None

def require(value, label):
    if value is None:
        raise SystemExit(f"Missing {label} in zkVM input")
    return value

def require_int(value, label):
    if not isinstance(value, int):
        raise SystemExit(f"Invalid {label} in zkVM input")
    return value

def require_list(value, label):
    if not isinstance(value, list):
        raise SystemExit(f"Invalid {label} in zkVM input")
    return value

def require_current_method_version(value):
    if not isinstance(value, int):
        raise SystemExit("Missing methodVersion in zkVM output")
    if value != CURRENT_METHOD_VERSION:
        raise SystemExit(f"Unsupported methodVersion in zkVM output: {value}")
    return value

election_id = require(
    bytes_to_uuid(get_value(payload, "election_id", "electionId")),
    "election_id",
)
contract_generation = require(
    get_value(payload, "contract_generation", "contractGeneration"),
    "contract_generation",
)
election_config_hash = require(
    bytes_to_hex(get_value(payload, "election_config_hash", "electionConfigHash"), 32),
    "election_config_hash",
)
bulletin_root = require(
    bytes_to_hex(get_value(payload, "bulletin_root", "bulletinRoot"), 32),
    "bulletin_root",
)
tree_size = require_int(get_value(payload, "tree_size", "treeSize"), "tree_size")
total_expected = require_int(get_value(payload, "total_expected", "totalExpected"), "total_expected")
log_id = require(
    bytes_to_hex(get_value(payload, "log_id", "logId"), 32),
    "log_id",
)
timestamp = require_int(get_value(payload, "timestamp"), "timestamp")

method_version = require_current_method_version(get_value(output, "methodVersion"))

votes = require_list(get_value(payload, "votes"), "votes")
public_votes = []
for vote in votes:
    if not isinstance(vote, dict):
        raise SystemExit("Invalid vote entry")

    index = get_value(vote, "index")
    if not isinstance(index, int):
        raise SystemExit("Invalid vote index")

    commitment = bytes_to_hex(get_value(vote, "commitment"), 32)
    if commitment is None:
        raise SystemExit("Invalid vote commitment")

    merkle_path = get_value(vote, "merkle_path", "merklePath")
    if not isinstance(merkle_path, list):
        raise SystemExit("Invalid vote merkle_path")

    path_nodes = []
    for node in merkle_path:
        node_hex = bytes_to_hex(node, 32)
        if node_hex is None:
            raise SystemExit("Invalid merkle path node")
        path_nodes.append(node_hex)

    public_votes.append(
        {
            "index": index,
            "commitment": commitment,
            "merklePath": path_nodes,
        }
    )

public_input = {
    "schema": schema,
    "version": version,
    "contractGeneration": contract_generation,
    "electionId": election_id,
    "electionConfigHash": election_config_hash,
    "bulletinRoot": bulletin_root,
    "treeSize": tree_size,
    "totalExpected": total_expected,
    "logId": log_id,
    "timestamp": timestamp,
    "methodVersion": method_version,
    "votes": public_votes,
}

with open(public_path, "w", encoding="utf-8") as handle:
    json.dump(public_input, handle)
PY
}

build_election_manifest() {
  local input_path="$1"
  local manifest_path="$2"

  python3 - "$input_path" "$manifest_path" <<'PY'
import hashlib
import json
import sys

input_path, manifest_path = sys.argv[1:3]

with open(input_path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

def get_value(record, *keys):
    if not isinstance(record, dict):
        return None
    for key in keys:
        if key in record:
            return record[key]
    return None

def bytes_to_uuid(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list) and len(value) == 16 and all(isinstance(item, int) for item in value):
        hex_str = bytes(value).hex()
        return f"{hex_str[0:8]}-{hex_str[8:12]}-{hex_str[12:16]}-{hex_str[16:20]}-{hex_str[20:32]}"
    return None

def bytes_to_hex(value, expected_len=None):
    if isinstance(value, str):
        normalized = value if value.startswith("0x") else f"0x{value}"
        if expected_len is not None and len(normalized) != (2 + expected_len * 2):
            return None
        return normalized
    if isinstance(value, list) and all(isinstance(item, int) for item in value):
        if expected_len is not None and len(value) != expected_len:
            return None
        return "0x" + bytes(value).hex()
    return None

def require(value, label):
    if value is None:
        raise SystemExit(f"Missing {label} in zkVM input")
    return value

def require_int(value, label):
    if not isinstance(value, int):
        raise SystemExit(f"Invalid {label} in zkVM input")
    return value

def normalize_election_config(value):
    if not isinstance(value, dict):
        raise SystemExit("Invalid election_config in zkVM input")

    total_expected = get_value(value, "totalExpected", "total_expected")
    choices = get_value(value, "choices")
    version = get_value(value, "version")
    bot_count = get_value(value, "botCount", "bot_count")
    merkle_tree_depth = get_value(value, "merkleTreeDepth", "merkle_tree_depth")

    if not isinstance(total_expected, int):
        raise SystemExit("Invalid election_config.totalExpected in zkVM input")
    if not isinstance(choices, list) or not choices or not all(isinstance(choice, str) and choice for choice in choices):
        raise SystemExit("Invalid election_config.choices in zkVM input")
    if not isinstance(version, str) or not version:
        raise SystemExit("Invalid election_config.version in zkVM input")
    if not isinstance(bot_count, int) or bot_count < 0:
        raise SystemExit("Invalid election_config.botCount in zkVM input")
    if not isinstance(merkle_tree_depth, int) or merkle_tree_depth <= 0:
        raise SystemExit("Invalid election_config.merkleTreeDepth in zkVM input")

    return {
        "totalExpected": total_expected,
        "choices": choices,
        "version": version,
        "botCount": bot_count,
        "merkleTreeDepth": merkle_tree_depth,
    }

def compute_election_config_hash(config):
    hash_payload = {
        "totalExpected": config["totalExpected"],
        "choices": config["choices"],
        "version": config["version"],
        "botCount": config["botCount"],
        "merkleTreeDepth": config["merkleTreeDepth"],
    }
    return "0x" + hashlib.sha256(
        json.dumps(hash_payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()

election_id = require(
    bytes_to_uuid(get_value(payload, "election_id", "electionId")),
    "election_id",
)
election_config_hash = require(
    bytes_to_hex(get_value(payload, "election_config_hash", "electionConfigHash"), 32),
    "election_config_hash",
)
input_total_expected = require_int(get_value(payload, "total_expected", "totalExpected"), "total_expected")
raw_election_config = require(
    get_value(payload, "election_config", "electionConfig"),
    "election_config",
)
manifest_config = normalize_election_config(raw_election_config)
computed_hash = compute_election_config_hash(manifest_config)

if manifest_config["totalExpected"] != input_total_expected:
    raise SystemExit("election_config.totalExpected does not match zkVM input")

if computed_hash != election_config_hash:
    raise SystemExit("election_config hash does not match zkVM input")

manifest = {
    "electionId": election_id,
    "totalExpected": manifest_config["totalExpected"],
    "choices": manifest_config["choices"],
    "version": manifest_config["version"],
    "botCount": manifest_config["botCount"],
    "merkleTreeDepth": manifest_config["merkleTreeDepth"],
    "electionConfigHash": computed_hash,
}

with open(manifest_path, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle)
PY
}

build_close_statement() {
  local input_path="$1"
  local output_path="$2"
  local close_path="$3"

  python3 - "$input_path" "$output_path" "$close_path" <<'PY'
import hashlib
import json
import struct
import sys

input_path, output_path, close_path = sys.argv[1:4]

with open(input_path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

with open(output_path, "r", encoding="utf-8") as handle:
    output = json.load(handle)

def get_value(record, *keys):
    if not isinstance(record, dict):
        return None
    for key in keys:
        if key in record:
            return record[key]
    return None

def bytes_to_hex(value, expected_len=None):
    if isinstance(value, str):
        return value if value.startswith("0x") else f"0x{value}"
    if isinstance(value, list) and all(isinstance(item, int) for item in value):
        if expected_len is not None and len(value) != expected_len:
            return None
        return "0x" + bytes(value).hex()
    return None

def require(value, label):
    if value is None:
        raise SystemExit(f"Missing {label}")
    return value

def require_int(value, label):
    if not isinstance(value, int):
        raise SystemExit(f"Invalid {label}")
    return value

log_id = require(
    bytes_to_hex(get_value(payload, "log_id", "logId"), 32),
    "log_id in zkVM input",
)
timestamp = require_int(get_value(payload, "timestamp"), "timestamp in zkVM input")
tree_size = require_int(get_value(output, "treeSize", "tree_size"), "treeSize in zkVM output")
bulletin_root = require(
    bytes_to_hex(get_value(output, "bulletinRoot", "bulletin_root"), 32),
    "bulletinRoot in zkVM output",
)

digest = hashlib.sha256(
    bytes.fromhex(log_id[2:])
    + struct.pack("<I", tree_size)
    + struct.pack("<Q", timestamp)
    + bytes.fromhex(bulletin_root[2:])
).hexdigest()

close_statement = {
    "logId": log_id,
    "treeSize": tree_size,
    "timestamp": timestamp,
    "bulletinRoot": bulletin_root,
    "sthDigest": "0x" + digest,
}

with open(close_path, "w", encoding="utf-8") as handle:
    json.dump(close_statement, handle)
PY
}

# Keep this validator aligned with
# src/lib/finalize/finalization-result.ts::resolveConsistentPublicAuditArtifacts.
validate_public_audit_artifacts() {
  local journal_path="$1"
  local public_input_path="$2"
  local election_manifest_path="$3"
  local close_statement_path="$4"

  python3 - "$journal_path" "$public_input_path" "$election_manifest_path" "$close_statement_path" <<'PY'
import hashlib
import json
import struct
import sys

journal_path, public_input_path, election_manifest_path, close_statement_path = sys.argv[1:5]

with open(journal_path, "r", encoding="utf-8") as handle:
    journal = json.load(handle)

with open(public_input_path, "r", encoding="utf-8") as handle:
    public_input = json.load(handle)

with open(election_manifest_path, "r", encoding="utf-8") as handle:
    election_manifest = json.load(handle)

with open(close_statement_path, "r", encoding="utf-8") as handle:
    close_statement = json.load(handle)

def require_record(value, label):
    if not isinstance(value, dict):
        raise SystemExit(f"Invalid {label}")
    return value

def require_string(record, key, label=None):
    value = record.get(key)
    if not isinstance(value, str) or not value:
        raise SystemExit(f"Missing {label or key}")
    return value

def require_int(record, key, label=None):
    value = record.get(key)
    if not isinstance(value, int):
        raise SystemExit(f"Invalid {label or key}")
    return value

def normalize_hex(value, expected_len=None):
    if not isinstance(value, str):
        raise SystemExit("Expected hex string")
    normalized = value[2:] if value.startswith("0x") else value
    if expected_len is not None and len(normalized) != expected_len * 2:
        raise SystemExit("Unexpected hex length")
    return normalized.lower()

def uuid_to_bytes(value):
    if not isinstance(value, str):
        raise SystemExit("Expected UUID string")
    return bytes.fromhex(value.replace("-", ""))

def uint16le(value):
    return struct.pack("<H", value)

def uint32le(value):
    return struct.pack("<I", value)

def uint64le(value):
    return struct.pack("<Q", value)

def matches_hex(left, right, expected_len=None):
    return normalize_hex(left, expected_len) == normalize_hex(right, expected_len)

def compute_input_commitment(public_input_record):
    votes = public_input_record.get("votes")
    if not isinstance(votes, list):
        raise SystemExit("Invalid public-input votes")

    digest = hashlib.sha256()
    digest.update(b"stark-ballot:input|v1.0")
    digest.update(uint32le(10))
    digest.update(uuid_to_bytes(require_string(public_input_record, "electionId")))
    digest.update(bytes.fromhex(normalize_hex(require_string(public_input_record, "bulletinRoot"), 32)))
    digest.update(uint32le(require_int(public_input_record, "treeSize")))
    digest.update(uint32le(require_int(public_input_record, "totalExpected")))
    digest.update(uint32le(len(votes)))

    for vote in sorted(votes, key=lambda item: require_int(require_record(item, "vote"), "index", "vote.index")):
        vote_record = require_record(vote, "vote")
        digest.update(uint32le(require_int(vote_record, "index", "vote.index")))
        digest.update(uint16le(32))
        digest.update(bytes.fromhex(normalize_hex(require_string(vote_record, "commitment", "vote.commitment"), 32)))

        merkle_path = vote_record.get("merklePath")
        if not isinstance(merkle_path, list):
            raise SystemExit("Invalid vote.merklePath")
        digest.update(uint16le(len(merkle_path)))
        for node in merkle_path:
            if not isinstance(node, str):
                raise SystemExit("Invalid merkle path node")
            digest.update(bytes.fromhex(normalize_hex(node, 32)))

    return "0x" + digest.hexdigest()

def compute_election_manifest_hash(manifest_record):
    payload = {
        "totalExpected": require_int(manifest_record, "totalExpected", "election-manifest.totalExpected"),
        "choices": manifest_record.get("choices"),
        "version": require_string(manifest_record, "version", "election-manifest.version"),
        "botCount": require_int(manifest_record, "botCount", "election-manifest.botCount"),
        "merkleTreeDepth": require_int(manifest_record, "merkleTreeDepth", "election-manifest.merkleTreeDepth"),
    }
    if not isinstance(payload["choices"], list) or not all(isinstance(choice, str) and choice for choice in payload["choices"]):
        raise SystemExit("Invalid election-manifest.choices")
    return "0x" + hashlib.sha256(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()

def compute_sth_digest(close_statement_record):
    log_id = require_string(close_statement_record, "logId", "close-statement.logId")
    tree_size = require_int(close_statement_record, "treeSize", "close-statement.treeSize")
    timestamp = require_int(close_statement_record, "timestamp", "close-statement.timestamp")
    bulletin_root = require_string(close_statement_record, "bulletinRoot", "close-statement.bulletinRoot")
    return "0x" + hashlib.sha256(
        bytes.fromhex(normalize_hex(log_id, 32))
        + uint32le(tree_size)
        + uint64le(timestamp)
        + bytes.fromhex(normalize_hex(bulletin_root, 32))
    ).hexdigest()

require_record(journal, "journal")
require_record(public_input, "public-input")
require_record(election_manifest, "election-manifest")
require_record(close_statement, "close-statement")

if public_input.get("schema") != "stark-ballot.public_input":
    raise SystemExit("Invalid public-input schema")
if public_input.get("version") != "1.1":
    raise SystemExit("Invalid public-input version")
if not isinstance(public_input.get("contractGeneration"), str) or not public_input.get("contractGeneration"):
    raise SystemExit("Invalid public-input contractGeneration")

if require_string(public_input, "electionId", "public-input.electionId") != require_string(
    journal, "electionId", "journal.electionId"
):
    raise SystemExit("public-input.electionId drifted from journal")
if not matches_hex(require_string(public_input, "electionConfigHash"), require_string(journal, "electionConfigHash"), 32):
    raise SystemExit("public-input.electionConfigHash drifted from journal")
if not matches_hex(require_string(public_input, "bulletinRoot"), require_string(journal, "bulletinRoot"), 32):
    raise SystemExit("public-input.bulletinRoot drifted from journal")
if require_int(public_input, "treeSize") != require_int(journal, "treeSize"):
    raise SystemExit("public-input.treeSize drifted from journal")
if require_int(public_input, "totalExpected") != require_int(journal, "totalExpected"):
    raise SystemExit("public-input.totalExpected drifted from journal")
if require_int(public_input, "methodVersion") != require_int(journal, "methodVersion"):
    raise SystemExit("public-input.methodVersion drifted from journal")
if not matches_hex(compute_input_commitment(public_input), require_string(journal, "inputCommitment"), 32):
    raise SystemExit("public-input commitment drifted from journal")

manifest_hash = compute_election_manifest_hash(election_manifest)
if require_string(election_manifest, "electionId", "election-manifest.electionId") != require_string(
    journal, "electionId", "journal.electionId"
):
    raise SystemExit("election-manifest.electionId drifted from journal")
if require_string(election_manifest, "electionId", "election-manifest.electionId") != require_string(
    public_input, "electionId", "public-input.electionId"
):
    raise SystemExit("election-manifest.electionId drifted from public-input")
if require_int(election_manifest, "totalExpected", "election-manifest.totalExpected") != require_int(
    journal, "totalExpected", "journal.totalExpected"
):
    raise SystemExit("election-manifest.totalExpected drifted from journal")
if not matches_hex(require_string(election_manifest, "electionConfigHash"), manifest_hash, 32):
    raise SystemExit("election-manifest self-hash mismatch")
if not matches_hex(
    require_string(election_manifest, "electionConfigHash"),
    require_string(journal, "electionConfigHash"),
    32,
):
    raise SystemExit("election-manifest.electionConfigHash drifted from journal")
if not matches_hex(
    require_string(election_manifest, "electionConfigHash"),
    require_string(public_input, "electionConfigHash"),
    32,
):
    raise SystemExit("election-manifest.electionConfigHash drifted from public-input")

if not matches_hex(require_string(close_statement, "logId"), require_string(public_input, "logId"), 32):
    raise SystemExit("close-statement.logId drifted from public-input")
if require_int(close_statement, "timestamp", "close-statement.timestamp") != require_int(
    public_input, "timestamp", "public-input.timestamp"
):
    raise SystemExit("close-statement.timestamp drifted from public-input")
if require_int(close_statement, "treeSize", "close-statement.treeSize") != require_int(
    journal, "treeSize", "journal.treeSize"
):
    raise SystemExit("close-statement.treeSize drifted from journal")
if not matches_hex(require_string(close_statement, "bulletinRoot"), require_string(journal, "bulletinRoot"), 32):
    raise SystemExit("close-statement.bulletinRoot drifted from journal")
if not matches_hex(require_string(close_statement, "sthDigest"), compute_sth_digest(close_statement), 32):
    raise SystemExit("close-statement.sthDigest self-check failed")
if not matches_hex(require_string(close_statement, "sthDigest"), require_string(journal, "sthDigest"), 32):
    raise SystemExit("close-statement.sthDigest drifted from journal")
PY
}

create_bundle_archive() {
  local output_dir="$1"
  shopt -s nullglob
  local receipt_files=("$output_dir"/*-receipt.json)
  local output_files=("$output_dir"/*-output.json)
  local bitmap_files=("$output_dir"/*-bitmap.json)
  local seen_bitmap_files=("$output_dir"/*-seen-bitmap.json)

  if (( ${#receipt_files[@]} == 0 )); then
    fatal "Receipt artifact not found for bundle"
  fi
  if (( ${#output_files[@]} == 0 )); then
    fatal "Output artifact not found for bundle"
  fi

  local receipt_file="${receipt_files[0]}"
  local output_file="${output_files[0]}"
  local bundle_dir
  bundle_dir="$(mktemp -d /tmp/zkvm-bundle-XXXX)"
  local bundle_zip="${output_dir}/bundle.zip"
  local public_input_path="${output_dir}/public-input.json"
  local election_manifest_path="${output_dir}/election-manifest.json"
  local close_statement_path="${output_dir}/close-statement.json"
  local included_bitmap_path="${output_dir}/included-bitmap.json"
  local seen_bitmap_path="${output_dir}/seen-bitmap.json"

  cp "$receipt_file" "${bundle_dir}/receipt.json"
  convert_output_to_journal "$output_file" "${bundle_dir}/journal.json"

  if [[ -n "${WORK_INPUT:-}" && -f "$WORK_INPUT" ]]; then
    build_public_input "$WORK_INPUT" "$output_file" "$public_input_path"
    build_election_manifest "$WORK_INPUT" "$election_manifest_path"
    build_close_statement "$WORK_INPUT" "$output_file" "$close_statement_path"
    validate_public_audit_artifacts \
      "${bundle_dir}/journal.json" \
      "$public_input_path" \
      "$election_manifest_path" \
      "$close_statement_path"
    cp "$public_input_path" "${bundle_dir}/public-input.json"
    cp "$election_manifest_path" "${bundle_dir}/election-manifest.json"
    cp "$close_statement_path" "${bundle_dir}/close-statement.json"
  else
    fatal "WORK_INPUT not available; cannot create public-input.json"
  fi

  if (( ${#bitmap_files[@]} > 0 )); then
    mv "${bitmap_files[0]}" "$included_bitmap_path"
  else
    log WARN "Exact included bitmap artifact not found; bitmap proof availability will be reduced"
  fi

  if (( ${#seen_bitmap_files[@]} > 0 )); then
    mv "${seen_bitmap_files[0]}" "$seen_bitmap_path"
  else
    log WARN "Exact seen bitmap artifact not found; per-index explainability will be reduced"
  fi

  rm -f "$bundle_zip"
  (cd "$bundle_dir" && zip -q -r "$bundle_zip" .)
  rm -rf "$bundle_dir"
  shopt -u nullglob

  log INFO "Bundle archive created: ${bundle_zip}"
}

stage_outputs() {
  mkdir -p "$OUTPUT_DIR"
  local base="${WORK_INPUT%.json}"
  local moved=false

  for suffix in -output.json -receipt.json -journal.json -bitmap.json -seen-bitmap.json; do
    local produced="$base$suffix"
    if [[ -f "$produced" ]]; then
      mv "$produced" "$OUTPUT_DIR/"
      moved=true
    fi
  done

  if [[ "$moved" = false ]]; then
    log WARN "No output artifacts detected next to $WORK_INPUT"
  fi
}

upload_outputs() {
  if [[ -z "$OUTPUT_S3_BUCKET" ]]; then
    return
  fi

  local normalized_prefix
  normalized_prefix="$(normalize_prefix "$OUTPUT_S3_PREFIX")"
  local destination="s3://${OUTPUT_S3_BUCKET}"
  if [[ -n "$normalized_prefix" ]]; then
    destination="${destination}/${normalized_prefix}"
  fi
  log INFO "Uploading outputs to ${destination}"
  shopt -s nullglob
  local files=("$OUTPUT_DIR"/*)
  if (( ${#files[@]} == 0 )); then
    log WARN "No files to upload from $OUTPUT_DIR"
    return
  fi

  for f in "${files[@]}"; do
    if [[ -d "$f" ]]; then
      continue
    fi
    local key
    if [[ -n "$normalized_prefix" ]]; then
      key="${normalized_prefix}/$(basename "$f")"
    else
      key="$(basename "$f")"
    fi
    upload_with_retry "$f" "s3://$OUTPUT_S3_BUCKET/$key"
  done
}

main() {
  ensure_host_binary

  export PATH="/root/.cargo/bin:/root/.risc0/bin:$PATH"
  export RUST_LOG="${RUST_LOG:-info}"

  WORK_INPUT="$(mktemp /tmp/zkvm-input-XXXX.json)"
  trap 'rm -f "$WORK_INPUT"' EXIT

  resolve_input_file
  validate_input_json

  local timeout_seconds="${ZKVM_TIMEOUT_SECONDS:-900}"
  log INFO "Running host with payload $(basename "$WORK_INPUT") (timeout: ${timeout_seconds}s)"
  if ! timeout "$timeout_seconds" "$HOST_BIN" "$WORK_INPUT"; then
    local exit_code=$?
    if (( exit_code == 124 )); then
      fatal "zkVM execution timed out after ${timeout_seconds}s"
    fi
    fatal "zkVM execution failed with exit code ${exit_code}"
  fi

  stage_outputs
  if [[ -n "$OUTPUT_S3_BUCKET" ]]; then
    if [[ -z "$OUTPUT_S3_PREFIX" ]]; then
      fatal "OUTPUT_S3_BUCKET is set but OUTPUT_S3_PREFIX is empty"
    fi
    create_bundle_archive "$OUTPUT_DIR"
  fi
  upload_outputs

  log INFO "Proof generation completed"
}

if [[ "${ENTRYPOINT_SKIP_MAIN:-}" != "1" ]]; then
  main "$@"
fi
