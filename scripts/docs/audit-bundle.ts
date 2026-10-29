import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectVerificationBundleArchiveBuffer } from '@stark-ballot/node-adapters/verification-bundle';
import { extractZipFromBuffer, listZipEntryNamesFromBuffer } from '@stark-ballot/node-adapters/zip';
import { resolvePublicBundlePolicy } from '@stark-ballot/verification/public-bundle-manifest';
import { parseVerifierServiceProtocol } from '@stark-ballot/verification/verifier-service-report';
import { currentZkvmJournalSchema } from '@stark-ballot/api-contract/schemas/verification';
import { parseHostZkVMOutput } from '@stark-ballot/zkvm-contract/zkvm/host-io';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  buildCloseStatement,
  recomputeElectionManifestHash,
  electionManifestArtifactSchema,
  closeStatementArtifactSchema,
} from '@stark-ballot/verification/public-audit-artifacts';
import { parsePublicInputArtifact, type PublicInputAuthority } from '@stark-ballot/verification/public-input';

function normalizeHex(value: string | undefined): string {
  if (value === undefined) throw new Error('Required journal hash is missing');
  return value.replace(/^0x/i, '').toLowerCase();
}
const sameHex = (left: unknown, right: unknown): boolean =>
  typeof left === 'string' && typeof right === 'string' && normalizeHex(left) === normalizeHex(right);
const sameNumber = (left: unknown, right: unknown): boolean =>
  typeof left === 'number' && typeof right === 'number' && left === right;
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

async function check<T>(failure: string, action: () => T | Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    console.log(failure);
    throw error;
  }
}

function runProcess(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`Audit process terminated: ${result.signal}`);
  return result;
}

const proofProjection = (
  journal: ReturnType<typeof parseHostZkVMOutput> | ReturnType<typeof currentZkvmJournalSchema.parse>,
) => ({
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

type AuditJournal = ReturnType<typeof currentZkvmJournalSchema.parse>;

async function admitArchive(bundlePath: string, destination: string): Promise<void> {
  const archive = await readFile(bundlePath);
  await listZipEntryNamesFromBuffer(archive);
  const failures = [];
  let inspection;
  for (const mode of ['sync', 'async'] as const) {
    try {
      inspection = await inspectVerificationBundleArchiveBuffer(archive, resolvePublicBundlePolicy(mode));
      break;
    } catch (error) {
      failures.push({ mode, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (!inspection) throw new Error(JSON.stringify(failures));
  await mkdir(destination);
  await extractZipFromBuffer(archive, { destination });
  console.log(JSON.stringify({ bundle_manifest: 'ok', mode: inspection.mode, members: inspection.members }, null, 2));
}

function resolveExpectedImageId(repoRoot: string, destination: string, rawJournal: unknown): string {
  const artifactPath = (name: string) => path.join(destination, name);
  const methodVersion =
    typeof rawJournal === 'object' && rawJournal !== null && 'methodVersion' in rawJournal
      ? rawJournal.methodVersion
      : undefined;
  if (methodVersion !== CURRENT_METHOD_VERSION) {
    throw new Error(
      `methodVersion=${String(methodVersion)} is not the current supported contract (${CURRENT_METHOD_VERSION})`,
    );
  }
  const imageId = runProcess(process.execPath, [
    path.join(repoRoot, 'verifier-service/scripts/read-image-id.mjs'),
    path.join(repoRoot, 'public/imageId-mapping.json'),
  ]);
  if (imageId.status !== 0 || !imageId.stdout.trim())
    throw new Error('expected Image ID could not be resolved from imageId-mapping.json');
  const expectedImageId = imageId.stdout.trim();
  const receipt = readJson(artifactPath('receipt.json'));
  if (
    typeof receipt !== 'object' ||
    receipt === null ||
    !('image_id' in receipt) ||
    typeof receipt.image_id !== 'string' ||
    !receipt.image_id
  )
    throw new Error('Receipt Image ID is missing');
  console.log(
    `methodVersion=${methodVersion}\nimageIdVariant=${process.env['EXPECTED_IMAGE_ID_VARIANT']}\nreceiptImageId=${receipt.image_id.toLowerCase()}\nexpectedImageId=${expectedImageId}`,
  );

  return expectedImageId;
}

function verifyReceipt(verifier: string, auditRoot: string, bundlePath: string, expectedImageId: string): void {
  const reportPath = path.join(auditRoot, 'verification.json');
  const verification = runProcess(verifier, [
    'verify',
    '--bundle',
    bundlePath,
    '--image-id',
    expectedImageId,
    '--output',
    reportPath,
  ]);
  const result = parseVerifierServiceProtocol(verification.status, readJson(reportPath));
  if (
    result.wireReport.expected_image_id !== expectedImageId ||
    result.wireReport.bundle_path !== path.basename(bundlePath)
  )
    throw new Error('Verifier report does not match this invocation');
  console.log(JSON.stringify({ exit_code: result.exitCode, ...result.wireReport }, null, 2));
  if (result.status !== 'success') throw new Error('Receipt verification did not succeed');
}

function compareJournal(receiptJournalPath: string, rawJournal: unknown): AuditJournal {
  const receiptJournal = parseHostZkVMOutput(readJson(receiptJournalPath));
  const bundleJournal = currentZkvmJournalSchema.parse(rawJournal);
  const receiptProjection = proofProjection(receiptJournal);
  const bundleEntries = Object.entries(proofProjection(bundleJournal));
  const mismatches = Object.entries(receiptProjection)
    .filter(
      ([field, value]) => JSON.stringify(value) !== JSON.stringify(bundleEntries.find(([key]) => key === field)?.[1]),
    )
    .map(([field]) => field);
  console.log(JSON.stringify({ receipt_journal_matches: mismatches.length === 0, mismatches }, null, 2));
  if (mismatches.length) throw new Error('Receipt journal differs from the bundle');
  return bundleJournal;
}

function checkIntegrity(journal: AuditJournal): void {
  const {
    excludedSlots,
    missingSlots,
    invalidPresentedSlots,
    rejectedRecords,
    totalExpected,
    treeSize,
    totalVotes,
    validVotes,
    verifiedTally,
  } = journal;
  console.log(
    JSON.stringify(
      {
        excludedSlots,
        missingSlots,
        invalidPresentedSlots,
        rejectedRecords,
        totalExpected,
        treeSize,
        totalVotes,
        validVotes,
        verifiedTally,
      },
      null,
      2,
    ),
  );
  for (const [name, passed] of Object.entries({
    integrity_counts: excludedSlots === 0 && missingSlots === 0 && invalidPresentedSlots === 0,
    expected_vs_tree: totalExpected === treeSize,
    total_votes_positive: Number.isInteger(totalVotes) && totalVotes > 0,
    tally_sum: verifiedTally.reduce((total, value) => total + value, 0) === validVotes,
  })) {
    console.log(`${name}=${passed ? 'ok' : 'ng'}`);
    if (!passed) throw new Error(`Bundle integrity check failed: ${name}`);
  }
}

function publicInputChecks(publicAuthority: PublicInputAuthority, journal: AuditJournal) {
  return {
    public_input_contract_ok: true,
    public_input_current_method_version_ok:
      journal.methodVersion === CURRENT_METHOD_VERSION && publicAuthority.methodVersion === CURRENT_METHOD_VERSION,
    public_input_election_id_ok: String(publicAuthority.electionId) === String(journal.electionId),
    public_input_config_hash_ok: sameHex(publicAuthority.electionConfigHash, journal.electionConfigHash),
    public_input_bulletin_root_ok: sameHex(publicAuthority.bulletinRoot, journal.bulletinRoot),
    public_input_tree_size_ok: sameNumber(publicAuthority.treeSize, journal.treeSize),
    public_input_total_expected_ok: sameNumber(publicAuthority.totalExpected, journal.totalExpected),
    public_input_votes_not_over_tree_size_ok: publicAuthority.votesCount <= publicAuthority.treeSize,
    public_input_tree_size_positive_ok: Number.isInteger(publicAuthority.treeSize) && publicAuthority.treeSize > 0,
    public_input_bulletin_root_nonzero_ok: !/^(?:0x)?0{64}$/i.test(publicAuthority.bulletinRoot),
    public_input_unique_indices_ok: publicAuthority.uniqueIndices === true,
    public_input_unique_commitments_ok: publicAuthority.uniqueCommitments === true,
  };
}

function manifestChecks(
  manifest: ReturnType<typeof electionManifestArtifactSchema.parse>,
  publicAuthority: PublicInputAuthority,
  journal: AuditJournal,
) {
  const recomputedManifestHash = recomputeElectionManifestHash(manifest);
  return {
    manifest_hash_ok: sameHex(recomputedManifestHash, manifest.electionConfigHash),
    manifest_election_id_ok:
      String(manifest.electionId) === String(publicAuthority.electionId) &&
      String(manifest.electionId) === String(journal.electionId),
    manifest_total_expected_ok:
      sameNumber(manifest.totalExpected, publicAuthority.totalExpected) &&
      sameNumber(manifest.totalExpected, journal.totalExpected),
    manifest_config_hash_ok:
      sameHex(manifest.electionConfigHash, publicAuthority.electionConfigHash) &&
      sameHex(manifest.electionConfigHash, journal.electionConfigHash),
  };
}

function closeChecks(
  closeStatement: ReturnType<typeof closeStatementArtifactSchema.parse>,
  publicAuthority: PublicInputAuthority,
  journal: AuditJournal,
) {
  const rebuiltCloseStatement = buildCloseStatement({
    logId: closeStatement.logId,
    treeSize: closeStatement.treeSize,
    timestamp: closeStatement.timestamp,
    bulletinRoot: closeStatement.bulletinRoot,
  });
  return {
    close_digest_ok: sameHex(rebuiltCloseStatement.sthDigest, closeStatement.sthDigest),
    close_timestamp_ok: sameNumber(closeStatement.timestamp, publicAuthority.timestamp),
    close_log_id_ok: sameHex(closeStatement.logId, publicAuthority.logId),
    close_tree_size_ok:
      sameNumber(closeStatement.treeSize, publicAuthority.treeSize) &&
      sameNumber(closeStatement.treeSize, journal.treeSize),
    close_bulletin_root_ok:
      sameHex(closeStatement.bulletinRoot, publicAuthority.bulletinRoot) &&
      sameHex(closeStatement.bulletinRoot, journal.bulletinRoot),
    close_sth_digest_ok: sameHex(closeStatement.sthDigest, journal.sthDigest),
  };
}

function checkPublicArtifacts(destination: string, journal: AuditJournal): string {
  const artifactPath = (name: string) => path.join(destination, name);
  const manifest = electionManifestArtifactSchema.parse(readJson(artifactPath('election-manifest.json')));
  const closeStatement = closeStatementArtifactSchema.parse(readJson(artifactPath('close-statement.json')));
  const parsedPublicInput = parsePublicInputArtifact(readJson(artifactPath('public-input.json')), { source: 'bundle' });
  const publicAuthority = parsedPublicInput.typedAuthority;
  if (!parsedPublicInput.valid || !publicAuthority) {
    console.log(
      JSON.stringify(
        { checks: { public_input_contract_ok: false }, publicInputErrors: parsedPublicInput.errors },
        null,
        2,
      ),
    );
    throw new Error('Public input admission failed');
  }
  const checks = {
    ...publicInputChecks(publicAuthority, journal),
    ...manifestChecks(manifest, publicAuthority, journal),
    ...closeChecks(closeStatement, publicAuthority, journal),
  };

  console.log(JSON.stringify({ checks, publicInputErrors: parsedPublicInput.errors }, null, 2));
  if (!Object.values(checks).every(Boolean)) throw new Error('Public artifact checks did not pass');
  return publicAuthority.recomputedInputCommitment;
}

async function main(): Promise<void> {
  const auditRoot = process.argv[2];
  const repoRoot = process.env['REPO_ROOT'];
  if (!auditRoot || !repoRoot) throw new Error('Run audit-bundle.sh with a bundle ZIP');
  const bundlePath = path.join(auditRoot, 'bundle.zip');
  const destination = path.join(auditRoot, 'bundle');
  const verifier = path.join(repoRoot, 'verifier-service/target/release/verifier-service');
  console.log('1/6: inspect and extract the public ZIP');
  await check('bundle admission or extraction failed', () => admitArchive(bundlePath, destination));
  console.log(readdirSync(destination).sort().join('\n'));
  console.log('2/6: resolve the expected Image ID');
  const rawJournal = readJson(path.join(destination, 'journal.json'));
  const expectedImageId = resolveExpectedImageId(repoRoot, destination, rawJournal);
  console.log('3/6: verify the STARK receipt');
  await check('receipt verification failed; stop the audit', () =>
    verifyReceipt(verifier, auditRoot, bundlePath, expectedImageId),
  );
  console.log('4/6: compare the authenticated journal');
  const receiptJournalPath = path.join(auditRoot, 'receipt-journal-host.json');
  await check('receipt journal decoding failed; stop the audit', () => {
    const result = runProcess(verifier, [
      'decode-journal',
      '--bundle',
      bundlePath,
      '--image-id',
      expectedImageId,
      '--output',
      receiptJournalPath,
      '--quiet',
    ]);
    if (result.status !== 0) throw new Error('Receipt journal decoding did not succeed');
  });
  const journal = await check('receipt journal comparison failed; stop the audit', () =>
    compareJournal(receiptJournalPath, rawJournal),
  );
  console.log('exit_code=0');
  checkIntegrity(journal);
  console.log('5/6: check public election artifacts');
  const recalculated = await check('public audit artifact checks failed; stop the audit', () =>
    checkPublicArtifacts(destination, journal),
  );
  console.log('exit_code=0');
  console.log('6/6: recompute the input commitment');
  // Public-input admission computes this with the shared canonical encoder.
  console.log(`recalculated=${recalculated}\njournal=${journal.inputCommitment}`);
  const commitmentMatches = recalculated.toLowerCase() === journal.inputCommitment.toLowerCase();
  console.log(`input_commitment=${commitmentMatches ? 'ok' : 'ng'}`);
  if (!commitmentMatches) throw new Error('Input commitment differs from the journal');
  console.log('Bundle audit passed. This is not the browser overall verdict.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
