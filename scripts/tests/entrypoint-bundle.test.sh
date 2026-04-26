#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENTRYPOINT_PATH="${ROOT_DIR}/docker/entrypoint.sh"
CURRENT_CONTRACT_GENERATION="$(
  sed -n "s/^const DEFAULT_CONTRACT_GENERATION = '\\([^']*\\)';$/\\1/p" \
    "${ROOT_DIR}/src/lib/contract/contractGeneration.ts"
)"

if [[ -z "$CURRENT_CONTRACT_GENERATION" ]]; then
  echo "Failed to resolve current contract generation"
  exit 1
fi

export CURRENT_CONTRACT_GENERATION

export ENTRYPOINT_SKIP_MAIN=1

# shellcheck source=/dev/null
source "$ENTRYPOINT_PATH"

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

output_dir="${tmp_dir}/output"
mkdir -p "$output_dir"

output_json="${output_dir}/sample-output.json"
receipt_json="${output_dir}/sample-receipt.json"
bitmap_json="${output_dir}/sample-bitmap.json"
seen_bitmap_json="${output_dir}/sample-seen-bitmap.json"
input_json="${tmp_dir}/input.json"

python3 - "$output_json" "$receipt_json" "$bitmap_json" "$seen_bitmap_json" "$input_json" <<'PY'
import hashlib
import json
import os
import sys

output_path, receipt_path, bitmap_path, seen_bitmap_path, input_path = sys.argv[1:6]
current_contract_generation = os.environ["CURRENT_CONTRACT_GENERATION"]

def hex_bytes(hex_str):
    return list(bytes.fromhex(hex_str))

def uint32le(value):
    return value.to_bytes(4, byteorder="little", signed=False)

def uint64le(value):
    return value.to_bytes(8, byteorder="little", signed=False)

def compute_sth_digest(log_id_hex, tree_size, timestamp, bulletin_root_hex):
    payload = (
        bytes.fromhex(log_id_hex)
        + uint32le(tree_size)
        + uint64le(timestamp)
        + bytes.fromhex(bulletin_root_hex)
    )
    return "0x" + hashlib.sha256(payload).hexdigest()

def uint16le(value):
    return value.to_bytes(2, byteorder="little", signed=False)

def compute_input_commitment(election_id_hex, bulletin_root_hex, tree_size, total_expected, votes):
    payload = hashlib.sha256()
    payload.update(b"stark-ballot:input|v1.0")
    payload.update(uint32le(10))
    payload.update(bytes.fromhex(election_id_hex))
    payload.update(bytes.fromhex(bulletin_root_hex))
    payload.update(uint32le(tree_size))
    payload.update(uint32le(total_expected))
    payload.update(uint32le(len(votes)))

    for vote in sorted(votes, key=lambda item: item["index"]):
        payload.update(uint32le(vote["index"]))
        payload.update(uint16le(32))
        payload.update(bytes.fromhex(vote["commitment"]))
        payload.update(uint16le(len(vote["merkle_path"])))
        for node in vote["merkle_path"]:
            payload.update(bytes.fromhex(node))

    return "0x" + payload.hexdigest()

def pack_bits(bits):
    num_bytes = (len(bits) + 7) // 8
    payload = bytearray(num_bytes)
    for index, bit in enumerate(bits):
        if bit:
            payload[index // 8] |= 1 << (index % 8)
    return bytes(payload)

def hash_leaf(chunk):
    return hashlib.sha256(b"\x00" + b"stark-ballot:leaf|v1" + chunk).digest()

def hash_node(left, right):
    return hashlib.sha256(b"\x01" + left + right).digest()

def compute_bitmap_root(bits):
    packed = pack_bits(bits)
    chunks = []
    for start in range(0, len(packed), 32):
        chunk = packed[start : start + 32]
        chunks.append(chunk.ljust(32, b"\x00"))
    if not chunks:
        chunks = [bytes(32)]

    level = [hash_leaf(chunk) for chunk in chunks]
    while len(level) > 1:
        next_level = []
        for start in range(0, len(level), 2):
            if start + 1 < len(level):
                next_level.append(hash_node(level[start], level[start + 1]))
            else:
                next_level.append(level[start])
        level = next_level
    return "0x" + level[0].hex()

election_config = {
    "totalExpected": 64,
    "choices": ["A", "B", "C", "D", "Legacy"],
    "version": "legacy-v0",
    "botCount": 63,
    "merkleTreeDepth": 6,
}
election_config_hash = hashlib.sha256(
    json.dumps(election_config, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
).hexdigest()
log_id = "66" * 32
bulletin_root = "22" * 32
timestamp = 1700000000
tree_size = 64
included_bitmap = [True] * tree_size
seen_bitmap = [True] * tree_size
included_bitmap_root = compute_bitmap_root(included_bitmap)
seen_bitmap_root = compute_bitmap_root(seen_bitmap)
sth_digest = compute_sth_digest(log_id, tree_size, timestamp, bulletin_root)
votes = [
    {
        "commitment": "aa" * 32,
        "choice": 2,
        "random": "bb" * 32,
        "index": 0,
        "merkle_path": ["cc" * 32, "dd" * 32],
    }
]
input_commitment = compute_input_commitment(
    "550e8400e29b41d4a716446655440000",
    bulletin_root,
    tree_size,
    tree_size,
    votes,
)

output = {
    "electionId": hex_bytes("550e8400e29b41d4a716446655440000"),
    "electionConfigHash": hex_bytes(election_config_hash),
    "bulletinRoot": hex_bytes(bulletin_root),
    "treeSize": tree_size,
    "totalExpected": tree_size,
    "sthDigest": hex_bytes(sth_digest[2:]),
    "verifiedTally": [1, 2, 3, 4, 5],
    "totalVotes": tree_size,
    "validVotes": tree_size,
    "invalidVotes": 0,
    "seenIndicesCount": tree_size,
    "missingSlots": 0,
    "invalidPresentedSlots": 0,
    "rejectedRecords": 0,
    "seenBitmapRoot": hex_bytes(seen_bitmap_root[2:]),
    "includedBitmapRoot": hex_bytes(included_bitmap_root[2:]),
    "excludedSlots": 0,
    "inputCommitment": hex_bytes(input_commitment[2:]),
    "methodVersion": 12,
    "imageId": "0x" + "ab" * 32,
}

with open(output_path, "w", encoding="utf-8") as handle:
    json.dump(output, handle)

with open(receipt_path, "w", encoding="utf-8") as handle:
    json.dump({"receipt": {"seal": "dummy"}, "image_id": "0x" + "ab" * 32}, handle)

with open(bitmap_path, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "schema": "stark-ballot.included_bitmap",
            "version": "1.0",
            "treeSize": tree_size,
            "includedBitmapRoot": included_bitmap_root,
            "includedBitmap": included_bitmap,
        },
        handle,
    )

with open(seen_bitmap_path, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "schema": "stark-ballot.seen_bitmap",
            "version": "1.0",
            "treeSize": tree_size,
            "seenBitmapRoot": seen_bitmap_root,
            "seenBitmap": seen_bitmap,
        },
        handle,
    )

with open(input_path, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "election_id": hex_bytes("550e8400e29b41d4a716446655440000"),
            "election_config_hash": hex_bytes(election_config_hash),
            "election_config": election_config,
            "bulletin_root": hex_bytes(bulletin_root),
            "tree_size": tree_size,
            "log_id": hex_bytes(log_id),
            "timestamp": timestamp,
            "total_expected": tree_size,
            "contract_generation": current_contract_generation,
            "votes": [
                {
                    "commitment": hex_bytes(votes[0]["commitment"]),
                    "choice": votes[0]["choice"],
                    "random": hex_bytes(votes[0]["random"]),
                    "index": votes[0]["index"],
                    "merkle_path": [hex_bytes(node) for node in votes[0]["merkle_path"]],
                }
            ],
        },
        handle,
    )
PY

WORK_INPUT="$input_json"
create_bundle_archive "$output_dir"

bundle_zip="${output_dir}/bundle.zip"
test -f "$bundle_zip"
test -f "${output_dir}/included-bitmap.json"
test -f "${output_dir}/seen-bitmap.json"

entries="$(unzip -Z1 "$bundle_zip")"
echo "$entries" | grep -q "^receipt.json$"
echo "$entries" | grep -q "^journal.json$"
echo "$entries" | grep -q "^public-input.json$"
echo "$entries" | grep -q "^election-manifest.json$"
echo "$entries" | grep -q "^close-statement.json$"
if echo "$entries" | grep -q "^input.json$"; then
  echo "input.json should not be in the public bundle"
  exit 1
fi
if echo "$entries" | grep -q "^included-bitmap.json$"; then
  echo "included-bitmap.json should not be in the public bundle"
  exit 1
fi
if echo "$entries" | grep -q "^seen-bitmap.json$"; then
  echo "seen-bitmap.json should not be in the public bundle"
  exit 1
fi

python3 - "$bundle_zip" "${output_dir}/included-bitmap.json" "${output_dir}/seen-bitmap.json" <<'PY'
import hashlib
import json
import os
import subprocess
import sys

bundle_zip, bitmap_path, seen_bitmap_path = sys.argv[1:4]
current_contract_generation = os.environ["CURRENT_CONTRACT_GENERATION"]

def uint32le(value):
    return value.to_bytes(4, byteorder="little", signed=False)

def uint64le(value):
    return value.to_bytes(8, byteorder="little", signed=False)

def compute_sth_digest(log_id_hex, tree_size, timestamp, bulletin_root_hex):
    payload = (
        bytes.fromhex(log_id_hex)
        + uint32le(tree_size)
        + uint64le(timestamp)
        + bytes.fromhex(bulletin_root_hex)
    )
    return "0x" + hashlib.sha256(payload).hexdigest()

def uint16le(value):
    return value.to_bytes(2, byteorder="little", signed=False)

def normalize_hex(value):
    return value[2:] if value.startswith("0x") else value

def compute_input_commitment(public_input):
    payload = hashlib.sha256()
    payload.update(b"stark-ballot:input|v1.0")
    payload.update(uint32le(10))
    payload.update(bytes.fromhex(public_input["electionId"].replace("-", "")))
    payload.update(bytes.fromhex(normalize_hex(public_input["bulletinRoot"])))
    payload.update(uint32le(public_input["treeSize"]))
    payload.update(uint32le(public_input["totalExpected"]))
    payload.update(uint32le(len(public_input["votes"])))

    for vote in sorted(public_input["votes"], key=lambda item: item["index"]):
        payload.update(uint32le(vote["index"]))
        payload.update(uint16le(32))
        payload.update(bytes.fromhex(normalize_hex(vote["commitment"])))
        payload.update(uint16le(len(vote["merklePath"])))
        for node in vote["merklePath"]:
            payload.update(bytes.fromhex(normalize_hex(node)))

    return "0x" + payload.hexdigest()

def pack_bits(bits):
    num_bytes = (len(bits) + 7) // 8
    payload = bytearray(num_bytes)
    for index, bit in enumerate(bits):
        if bit:
            payload[index // 8] |= 1 << (index % 8)
    return bytes(payload)

def hash_leaf(chunk):
    return hashlib.sha256(b"\x00" + b"stark-ballot:leaf|v1" + chunk).digest()

def hash_node(left, right):
    return hashlib.sha256(b"\x01" + left + right).digest()

def compute_bitmap_root(bits):
    packed = pack_bits(bits)
    chunks = []
    for start in range(0, len(packed), 32):
        chunk = packed[start : start + 32]
        chunks.append(chunk.ljust(32, b"\x00"))
    if not chunks:
        chunks = [bytes(32)]

    level = [hash_leaf(chunk) for chunk in chunks]
    while len(level) > 1:
        next_level = []
        for start in range(0, len(level), 2):
            if start + 1 < len(level):
                next_level.append(hash_node(level[start], level[start + 1]))
            else:
                next_level.append(level[start])
        level = next_level
    return "0x" + level[0].hex()

expected_bitmap_root = compute_bitmap_root([True] * 64)
expected_sth_digest = compute_sth_digest("66" * 32, 64, 1700000000, "22" * 32)
journal_raw = subprocess.check_output(["unzip", "-p", bundle_zip, "journal.json"])
journal = json.loads(journal_raw)
public_raw = subprocess.check_output(["unzip", "-p", bundle_zip, "public-input.json"])
public_input = json.loads(public_raw)
input_commitment = compute_input_commitment(public_input)

assert journal["electionId"] == "550e8400-e29b-41d4-a716-446655440000"
assert journal["electionConfigHash"] == "0x" + hashlib.sha256(
    json.dumps(
        {
            "totalExpected": 64,
            "choices": ["A", "B", "C", "D", "Legacy"],
            "version": "legacy-v0",
            "botCount": 63,
            "merkleTreeDepth": 6,
        },
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
).hexdigest()
assert journal["bulletinRoot"] == "0x" + "22" * 32
assert journal["sthDigest"] == expected_sth_digest
assert journal["includedBitmapRoot"] == expected_bitmap_root
assert journal["seenBitmapRoot"] == expected_bitmap_root
assert journal["inputCommitment"] == input_commitment
assert journal["verifiedTally"] == [1, 2, 3, 4, 5]
assert journal["imageId"] == "0x" + "ab" * 32

assert public_input["schema"] == "stark-ballot.public_input"
assert public_input["version"] == "1.1"
assert public_input["contractGeneration"] == current_contract_generation
assert public_input["electionId"] == "550e8400-e29b-41d4-a716-446655440000"
assert public_input["electionConfigHash"] == journal["electionConfigHash"]
assert public_input["bulletinRoot"] == "0x" + "22" * 32
assert public_input["treeSize"] == 64
assert public_input["totalExpected"] == 64
assert public_input["logId"] == "0x" + "66" * 32
assert public_input["timestamp"] == 1700000000
assert public_input["methodVersion"] == 12
assert public_input["votes"] == [
    {
        "index": 0,
        "commitment": "0x" + "aa" * 32,
        "merklePath": ["0x" + "cc" * 32, "0x" + "dd" * 32],
    }
]

assert "choice" not in public_input["votes"][0]
assert "random" not in public_input["votes"][0]

manifest_raw = subprocess.check_output(["unzip", "-p", bundle_zip, "election-manifest.json"])
manifest = json.loads(manifest_raw)

assert manifest == {
    "electionId": "550e8400-e29b-41d4-a716-446655440000",
    "totalExpected": 64,
    "choices": ["A", "B", "C", "D", "Legacy"],
    "version": "legacy-v0",
    "botCount": 63,
    "merkleTreeDepth": 6,
    "electionConfigHash": journal["electionConfigHash"],
}

close_statement_raw = subprocess.check_output(["unzip", "-p", bundle_zip, "close-statement.json"])
close_statement = json.loads(close_statement_raw)

assert close_statement == {
    "logId": "0x" + "66" * 32,
    "treeSize": 64,
    "timestamp": 1700000000,
    "bulletinRoot": "0x" + "22" * 32,
    "sthDigest": journal["sthDigest"],
}

with open(bitmap_path, "r", encoding="utf-8") as handle:
    bitmap = json.load(handle)

assert bitmap["schema"] == "stark-ballot.included_bitmap"
assert bitmap["version"] == "1.0"
assert bitmap["treeSize"] == 64
assert bitmap["includedBitmapRoot"] == journal["includedBitmapRoot"]
assert all(bitmap["includedBitmap"])

with open(seen_bitmap_path, "r", encoding="utf-8") as handle:
    seen_bitmap = json.load(handle)

assert seen_bitmap["schema"] == "stark-ballot.seen_bitmap"
assert seen_bitmap["version"] == "1.0"
assert seen_bitmap["treeSize"] == 64
assert seen_bitmap["seenBitmapRoot"] == journal["seenBitmapRoot"]
assert all(seen_bitmap["seenBitmap"])
PY

journal_path="${tmp_dir}/journal.json"
close_statement_path="${tmp_dir}/close-statement.json"
drifted_close_statement_path="${tmp_dir}/close-statement-drifted.json"

unzip -p "$bundle_zip" journal.json >"$journal_path"
unzip -p "$bundle_zip" close-statement.json >"$close_statement_path"
cp "$close_statement_path" "$drifted_close_statement_path"

python3 - "$drifted_close_statement_path" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

payload["timestamp"] += 1

with open(path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
PY

if validate_public_audit_artifacts \
  "$journal_path" \
  "${output_dir}/public-input.json" \
  "${output_dir}/election-manifest.json" \
  "$drifted_close_statement_path"; then
  echo "validate_public_audit_artifacts should fail on drifted close statement"
  exit 1
fi

echo "ok"

legacy_output_json="${output_dir}/legacy-output.json"
unsupported_version_output_json="${output_dir}/unsupported-version-output.json"
missing_seen_bitmap_output_json="${output_dir}/missing-seen-bitmap-output.json"

python3 - "$output_json" "$legacy_output_json" "$unsupported_version_output_json" "$missing_seen_bitmap_output_json" <<'PY'
import json
import sys

source_path, legacy_path, unsupported_path, missing_seen_path = sys.argv[1:5]

with open(source_path, "r", encoding="utf-8") as handle:
    source = json.load(handle)

legacy = {
    "election_id": source["electionId"],
    "election_config_hash": source["electionConfigHash"],
    "bulletin_root": source["bulletinRoot"],
    "tree_size": source["treeSize"],
    "total_expected": source["totalExpected"],
    "sth_digest": source["sthDigest"],
    "verified_tally": source["verifiedTally"],
    "total_votes": source["totalVotes"],
    "valid_votes": source["validVotes"],
    "invalid_votes": source["invalidVotes"],
    "seen_indices_count": source["seenIndicesCount"],
    "missing_slots": source["missingSlots"],
    "invalid_presented_slots": source["invalidPresentedSlots"],
    "rejected_records": source["rejectedRecords"],
    "seen_bitmap_root": source["seenBitmapRoot"],
    "included_bitmap_root": source["includedBitmapRoot"],
    "excluded_slots": source["excludedSlots"],
    "input_commitment": source["inputCommitment"],
    "method_version": source["methodVersion"],
    "image_id": source["imageId"],
}
with open(legacy_path, "w", encoding="utf-8") as handle:
    json.dump(legacy, handle)

unsupported = dict(source)
unsupported["methodVersion"] = 11
with open(unsupported_path, "w", encoding="utf-8") as handle:
    json.dump(unsupported, handle)

missing_seen = dict(source)
missing_seen.pop("seenBitmapRoot")
with open(missing_seen_path, "w", encoding="utf-8") as handle:
    json.dump(missing_seen, handle)
PY

if convert_output_to_journal "$legacy_output_json" "${tmp_dir}/legacy-journal.json"; then
  echo "convert_output_to_journal should reject legacy snake_case output"
  exit 1
fi

if convert_output_to_journal "$unsupported_version_output_json" "${tmp_dir}/unsupported-journal.json"; then
  echo "convert_output_to_journal should reject unsupported methodVersion output"
  exit 1
fi

if convert_output_to_journal "$missing_seen_bitmap_output_json" "${tmp_dir}/missing-seen-journal.json"; then
  echo "convert_output_to_journal should reject output without seenBitmapRoot"
  exit 1
fi

if build_public_input "$input_json" "$legacy_output_json" "${tmp_dir}/legacy-public-input.json"; then
  echo "build_public_input should reject legacy snake_case output"
  exit 1
fi
