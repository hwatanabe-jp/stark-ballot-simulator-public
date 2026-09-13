#!/usr/bin/env bash
# Audit the public bundle using the same parsers as the application.
set -euo pipefail

usage() {
  echo 'Usage: bash scripts/docs/audit-bundle.sh BUNDLE_ZIP [default|x86_64]'
  echo 'Build verifier-service with --features production before running.'
}
if [[ "${1:-}" == --help && $# == 1 ]]; then
  usage
  exit 0
fi
if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage >&2
  exit 2
fi
export EXPECTED_IMAGE_ID_VARIANT="${2:-default}"
case "$EXPECTED_IMAGE_ID_VARIANT" in
  default|x86_64) ;;
  *) echo 'Image ID variant must be default or x86_64' >&2; exit 2 ;;
esac
if [[ ! -f "$1" ]]; then
  echo 'Bundle ZIP must be an existing regular file' >&2
  exit 2
fi
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_ROOT
for audit_tool in node pnpm jq; do
  if ! command -v "$audit_tool" >/dev/null; then
    echo "Required tool is missing: $audit_tool" >&2
    exit 2
  fi
done
if [[ ! -x "$REPO_ROOT/verifier-service/target/release/verifier-service" ]]; then
  echo 'Build verifier-service with --features production before running' >&2
  exit 2
fi
AUDIT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/stark-ballot-audit.XXXXXX")"
export AUDIT_ROOT
# Retain the exact archive and diagnostic output even if a check fails.
trap 'echo "Audit files: $AUDIT_ROOT" >&2' EXIT
cp -- "$1" "$AUDIT_ROOT/bundle.zip"

echo '1/6: inspect and extract the public ZIP'
cd "$REPO_ROOT"

if ! pnpm tsx -e "
import fs from 'node:fs/promises';
import { inspectVerificationBundleArchiveBuffer } from './packages/node-adapters/src/verification-bundle';
import { extractZipFromBuffer, listZipEntryNamesFromBuffer } from './packages/node-adapters/src/zip';
import { resolvePublicBundlePolicy } from './packages/verification/src/verification/public-bundle-manifest.ts';

const [archivePath, destination] = process.argv.slice(1);

void (async () => {
  const archive = await fs.readFile(archivePath);
  await listZipEntryNamesFromBuffer(archive);
  const failures = [];
  let inspection;
  for (const mode of ['sync', 'async']) {
    try {
      inspection = await inspectVerificationBundleArchiveBuffer(
        archive,
        resolvePublicBundlePolicy(mode),
      );
      break;
    } catch (error) {
      failures.push({ mode, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (!inspection) throw new Error(JSON.stringify(failures));
  await fs.mkdir(destination);
  await extractZipFromBuffer(archive, { destination });
  console.log(JSON.stringify({ bundle_manifest: 'ok', mode: inspection.mode, members: inspection.members }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
" "$AUDIT_ROOT/bundle.zip" "$AUDIT_ROOT/bundle"; then
  echo 'bundle admission or extraction failed'
  exit 1
fi

cd "$AUDIT_ROOT"

ls -1 bundle

echo '2/6: resolve the expected Image ID'
METHOD_VERSION="$(jq -r '.methodVersion' bundle/journal.json)"
CURRENT_METHOD_VERSION="$(cd "$REPO_ROOT" && pnpm tsx -e "import { CURRENT_METHOD_VERSION } from './packages/zkvm-contract/src/zkvm/types'; console.log(CURRENT_METHOD_VERSION);")" || exit 1

if [ "$METHOD_VERSION" != "$CURRENT_METHOD_VERSION" ]; then
  echo "methodVersion=$METHOD_VERSION is not the current supported contract ($CURRENT_METHOD_VERSION)"
  exit 1
fi

EXPECTED_IMAGE_ID="$(
  node "$REPO_ROOT/verifier-service/scripts/read-image-id.mjs" \
    "$REPO_ROOT/public/imageId-mapping.json"
)"
RECEIPT_IMAGE_ID="$(jq -er '.image_id | select(type == "string" and length > 0) | ascii_downcase' bundle/receipt.json)" || exit 1

if [ -z "$EXPECTED_IMAGE_ID" ]; then
  echo "expected Image ID could not be resolved from imageId-mapping.json"
  exit 1
fi

echo "methodVersion=$METHOD_VERSION"
echo "imageIdVariant=$EXPECTED_IMAGE_ID_VARIANT"
echo "receiptImageId=$RECEIPT_IMAGE_ID"
echo "expectedImageId=$EXPECTED_IMAGE_ID"

echo '3/6: verify the STARK receipt'
rm -f "$AUDIT_ROOT/verification.json"
VERIFY_EXIT=0
if "$REPO_ROOT/verifier-service/target/release/verifier-service" verify \
  --bundle "$AUDIT_ROOT/bundle.zip" \
  --image-id "$EXPECTED_IMAGE_ID" \
  --output "$AUDIT_ROOT/verification.json"; then
  VERIFY_EXIT=0
else
  VERIFY_EXIT=$?
fi

cd "$REPO_ROOT"
if ! pnpm tsx -e "
import fs from 'node:fs';
import path from 'node:path';
import { parseVerifierServiceProtocol } from './packages/verification/src/verification/verifier-service-report';

const [exitCode, reportPath, expectedImageId, bundlePath] = process.argv.slice(1);
const result = parseVerifierServiceProtocol(Number(exitCode), JSON.parse(fs.readFileSync(reportPath, 'utf8')));
if (result.wireReport.expected_image_id !== expectedImageId || result.wireReport.bundle_path !== path.basename(bundlePath)) {
  throw new Error('Verifier report does not match this invocation');
}
console.log(JSON.stringify({ exit_code: result.exitCode, ...result.wireReport }, null, 2));
process.exit(result.status === 'success' ? 0 : 1);
" "$VERIFY_EXIT" "$AUDIT_ROOT/verification.json" "$EXPECTED_IMAGE_ID" "$AUDIT_ROOT/bundle.zip"; then
  echo 'receipt verification failed; stop the audit'
  exit 1
fi
cd "$AUDIT_ROOT"

echo '4/6: compare the authenticated journal'
rm -f "$AUDIT_ROOT/receipt-journal-host.json"
if ! "$REPO_ROOT/verifier-service/target/release/verifier-service" decode-journal \
  --bundle "$AUDIT_ROOT/bundle.zip" \
  --image-id "$EXPECTED_IMAGE_ID" \
  --output "$AUDIT_ROOT/receipt-journal-host.json" \
  --quiet; then
  echo 'receipt journal decoding failed; stop the audit'
  exit 1
fi

cd "$REPO_ROOT"

if ! pnpm tsx -e "
import fs from 'node:fs';
import { currentZkvmJournalSchema } from './packages/api-contract/src/schemas/verification';
import { parseHostZkVMOutput } from './packages/zkvm-contract/src/zkvm/host-io';

const [receiptJournalPath, bundleJournalPath] = process.argv.slice(1);
const readUnknownJson = (path) => JSON.parse(fs.readFileSync(path, 'utf-8')) as unknown;
const receiptJournal = parseHostZkVMOutput(readUnknownJson(receiptJournalPath));
const bundleJournal = currentZkvmJournalSchema.parse(readUnknownJson(bundleJournalPath));
const normalizeHex = (value) => value.replace(/^0x/i, '').toLowerCase();
const proofProjection = (journal) => ({
  electionId: journal.electionId.toLowerCase(),
  electionConfigHash: normalizeHex(journal.electionConfigHash),
  bulletinRoot: normalizeHex(journal.bulletinRoot),
  treeSize: journal.treeSize,
  totalExpected: journal.totalExpected,
  sthDigest: normalizeHex(journal.sthDigest),
  verifiedTally: journal.verifiedTally,
  totalVotes: journal.totalVotes,
  validVotes: journal.validVotes,
  invalidVotes: journal.invalidVotes,
  seenIndicesCount: journal.seenIndicesCount,
  missingSlots: journal.missingSlots,
  invalidPresentedSlots: journal.invalidPresentedSlots,
  rejectedRecords: journal.rejectedRecords,
  seenBitmapRoot: normalizeHex(journal.seenBitmapRoot),
  includedBitmapRoot: normalizeHex(journal.includedBitmapRoot),
  excludedSlots: journal.excludedSlots,
  inputCommitment: normalizeHex(journal.inputCommitment),
  methodVersion: journal.methodVersion,
});
const receiptProjection = proofProjection(receiptJournal);
const bundleProjection = proofProjection(bundleJournal);
const mismatches = Object.keys(receiptProjection).filter(
  (field) => JSON.stringify(receiptProjection[field]) !== JSON.stringify(bundleProjection[field]),
);

console.log(JSON.stringify({ receipt_journal_matches: mismatches.length === 0, mismatches }, null, 2));
process.exit(mismatches.length === 0 ? 0 : 1);
" \
  "$AUDIT_ROOT/receipt-journal-host.json" \
  "$AUDIT_ROOT/bundle/journal.json"; then
  echo 'receipt journal comparison failed; stop the audit'
  exit 1
fi
echo 'exit_code=0'
cd "$AUDIT_ROOT"

jq '{excludedSlots, missingSlots, invalidPresentedSlots, rejectedRecords, totalExpected, treeSize, totalVotes, validVotes, verifiedTally}' bundle/journal.json

jq -e '.excludedSlots == 0 and .missingSlots == 0 and .invalidPresentedSlots == 0' bundle/journal.json >/dev/null \
  && echo 'integrity_counts=ok' \
  || { echo 'integrity_counts=ng'; exit 1; }

jq -e '.totalExpected == .treeSize' bundle/journal.json >/dev/null \
  && echo 'expected_vs_tree=ok' \
  || { echo 'expected_vs_tree=ng'; exit 1; }

jq -e '.totalVotes | type == "number" and . > 0 and floor == .' bundle/journal.json >/dev/null \
  && echo 'total_votes_positive=ok' \
  || { echo 'total_votes_positive=ng'; exit 1; }

jq -e '(.verifiedTally | add) == .validVotes' bundle/journal.json >/dev/null \
  && echo 'tally_sum=ok' \
  || { echo 'tally_sum=ng'; exit 1; }

echo '5/6: check public election artifacts'
cd "$REPO_ROOT"

if ! pnpm tsx -e "
import fs from 'node:fs';
import { buildCloseStatement, recomputeElectionManifestHash, electionManifestArtifactSchema, closeStatementArtifactSchema } from './packages/verification/src/verification/public-audit-artifacts';
import { parsePublicInputArtifact } from './packages/verification/src/verification/public-input-contract';
import { CURRENT_METHOD_VERSION } from './packages/zkvm-contract/src/zkvm/types';

const [manifestPath, closePath, journalPath, publicInputPath] = process.argv.slice(1);
const manifest = electionManifestArtifactSchema.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
const closeStatement = closeStatementArtifactSchema.parse(JSON.parse(fs.readFileSync(closePath, 'utf-8')));
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
const publicInput = JSON.parse(fs.readFileSync(publicInputPath, 'utf-8'));

const parsedPublicInput = parsePublicInputArtifact(publicInput, { source: 'bundle' });
const publicAuthority = parsedPublicInput.typedAuthority;

const normalizeHex = (value) => String(value).replace(/^0x/i, '').toLowerCase();
const sameHex = (left, right) =>
  typeof left === 'string' && typeof right === 'string' && normalizeHex(left) === normalizeHex(right);
const sameNumber = (left, right) => typeof left === 'number' && typeof right === 'number' && left === right;

const recomputedManifestHash = recomputeElectionManifestHash(manifest);
const rebuiltCloseStatement = buildCloseStatement({
  logId: closeStatement.logId,
  treeSize: closeStatement.treeSize,
  timestamp: closeStatement.timestamp,
  bulletinRoot: closeStatement.bulletinRoot,
});

const checks = {
  public_input_contract_ok: parsedPublicInput.valid && Boolean(publicAuthority),
  public_input_current_method_version_ok:
    journal.methodVersion === CURRENT_METHOD_VERSION && publicAuthority?.methodVersion === CURRENT_METHOD_VERSION,
  public_input_election_id_ok: String(publicAuthority?.electionId) === String(journal.electionId),
  public_input_config_hash_ok: sameHex(publicAuthority?.electionConfigHash, journal.electionConfigHash),
  public_input_bulletin_root_ok: sameHex(publicAuthority?.bulletinRoot, journal.bulletinRoot),
  public_input_tree_size_ok: sameNumber(publicAuthority?.treeSize, journal.treeSize),
  public_input_total_expected_ok: sameNumber(publicAuthority?.totalExpected, journal.totalExpected),
  public_input_votes_not_over_tree_size_ok:
    typeof publicAuthority?.votesCount === 'number' &&
    typeof publicAuthority?.treeSize === 'number' &&
    publicAuthority.votesCount <= publicAuthority.treeSize,
  public_input_tree_size_positive_ok:
    typeof publicAuthority?.treeSize === 'number' &&
    Number.isInteger(publicAuthority.treeSize) &&
    publicAuthority.treeSize > 0,
  public_input_bulletin_root_nonzero_ok:
    typeof publicAuthority?.bulletinRoot === 'string' &&
    !/^(?:0x)?0{64}$/i.test(publicAuthority.bulletinRoot),
  public_input_unique_indices_ok: publicAuthority?.uniqueIndices === true,
  public_input_unique_commitments_ok: publicAuthority?.uniqueCommitments === true,
  manifest_hash_ok: sameHex(recomputedManifestHash, manifest.electionConfigHash),
  manifest_election_id_ok:
    String(manifest.electionId) === String(publicAuthority?.electionId) &&
    String(manifest.electionId) === String(journal.electionId),
  manifest_total_expected_ok:
    sameNumber(manifest.totalExpected, publicAuthority?.totalExpected) &&
    sameNumber(manifest.totalExpected, journal.totalExpected),
  manifest_config_hash_ok:
    sameHex(manifest.electionConfigHash, publicAuthority?.electionConfigHash) &&
    sameHex(manifest.electionConfigHash, journal.electionConfigHash),
  close_digest_ok: sameHex(rebuiltCloseStatement.sthDigest, closeStatement.sthDigest),
  close_timestamp_ok: sameNumber(closeStatement.timestamp, publicAuthority?.timestamp),
  close_log_id_ok: sameHex(closeStatement.logId, publicAuthority?.logId),
  close_tree_size_ok:
    sameNumber(closeStatement.treeSize, publicAuthority?.treeSize) &&
    sameNumber(closeStatement.treeSize, journal.treeSize),
  close_bulletin_root_ok:
    sameHex(closeStatement.bulletinRoot, publicAuthority?.bulletinRoot) &&
    sameHex(closeStatement.bulletinRoot, journal.bulletinRoot),
  close_sth_digest_ok: sameHex(closeStatement.sthDigest, journal.sthDigest),
};

console.log(JSON.stringify({ checks, publicInputErrors: parsedPublicInput.errors }, null, 2));
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
" \
  "$AUDIT_ROOT/bundle/election-manifest.json" \
  "$AUDIT_ROOT/bundle/close-statement.json" \
  "$AUDIT_ROOT/bundle/journal.json" \
  "$AUDIT_ROOT/bundle/public-input.json"; then
  echo 'public audit artifact checks failed; stop the audit'
  exit 1
fi
echo 'exit_code=0'

echo '6/6: recompute the input commitment'
RECALC="$(cd "$REPO_ROOT" && pnpm tsx -e "import fs from 'node:fs'; import { computeInputCommitmentFromPublicInput } from './packages/zkvm-contract/src/zkvm/types'; const p = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8')); console.log(computeInputCommitmentFromPublicInput(p));" "$AUDIT_ROOT/bundle/public-input.json")" || exit 1
JOURNAL_COMMITMENT="$(jq -er '.inputCommitment | select(type == "string" and length > 0)' "$AUDIT_ROOT/bundle/journal.json")" || exit 1

echo "recalculated=$RECALC"
echo "journal=$JOURNAL_COMMITMENT"

[ "${RECALC,,}" = "${JOURNAL_COMMITMENT,,}" ] && echo 'input_commitment=ok' || { echo 'input_commitment=ng'; exit 1; }

echo "Bundle audit passed. This is not the browser overall verdict."
