import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { parseImageIdMapping } from '@stark-ballot/validation/image-id-mapping';
import { buildCloseStatement, buildElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import { PUBLIC_INPUT_SCHEMA, PUBLIC_INPUT_VERSION } from '@stark-ballot/verification/public-input';
import { buildDefaultElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { computeInputCommitmentFromPublicInput, CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const hex = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
let fixtureRoot: string;

function createArtifacts() {
  const manifest = buildElectionManifest('550e8400-e29b-41d4-a716-446655440000', buildDefaultElectionConfig());
  const close = buildCloseStatement({
    logId: hex(1),
    treeSize: 64,
    timestamp: 1_700_000_000_000,
    bulletinRoot: hex(2),
  });
  const publicInput = {
    schema: PUBLIC_INPUT_SCHEMA,
    version: PUBLIC_INPUT_VERSION,
    electionId: manifest.electionId,
    electionConfigHash: manifest.electionConfigHash,
    bulletinRoot: close.bulletinRoot,
    treeSize: 64,
    totalExpected: 64,
    logId: close.logId,
    timestamp: close.timestamp,
    methodVersion: CURRENT_METHOD_VERSION,
    votes: Array.from({ length: 64 }, (_, index) => ({ index, commitment: hex(index + 10), merklePath: [] })),
  };
  // The verifier process is a test double. These values test orchestration and
  // public-data checks, and do not constitute a cryptographic receipt fixture.
  const journal = {
    electionId: manifest.electionId,
    electionConfigHash: manifest.electionConfigHash,
    bulletinRoot: close.bulletinRoot,
    treeSize: 64,
    totalExpected: 64,
    sthDigest: close.sthDigest,
    verifiedTally: [0, 64, 0, 0, 0],
    totalVotes: 64,
    validVotes: 64,
    invalidVotes: 0,
    seenIndicesCount: 64,
    missingSlots: 0,
    invalidPresentedSlots: 0,
    rejectedRecords: 0,
    seenBitmapRoot: hex(3),
    includedBitmapRoot: hex(3),
    excludedSlots: 0,
    inputCommitment: computeInputCommitmentFromPublicInput(publicInput),
    methodVersion: CURRENT_METHOD_VERSION,
  };
  return { manifest, close, publicInput, journal };
}

async function writeArchive(
  extraMembers: Record<string, unknown> = {},
  journalOverride: Record<string, unknown> = {},
  receiptJournalOverride: Record<string, unknown> = {},
) {
  const { manifest, close, publicInput, journal } = createArtifacts();
  const archivePath = path.join(fixtureRoot, 'input with spaces.zip');
  const zip = new ZipFile();
  const members = {
    'public-input.json': publicInput,
    'election-manifest.json': manifest,
    'close-statement.json': close,
    'receipt.json': { receipt: {}, image_id: hex(4) },
    'journal.json': { ...journal, ...journalOverride },
    ...extraMembers,
  };
  for (const [name, value] of Object.entries(members)) zip.addBuffer(Buffer.from(JSON.stringify(value)), name);
  const saved = pipeline(zip.outputStream, createWriteStream(archivePath));
  zip.end();
  await saved;
  await writeFile(
    path.join(fixtureRoot, 'host-journal.json'),
    JSON.stringify({ ...journal, ...receiptJournalOverride }),
  );
  return archivePath;
}

function runAudit(archivePath: string, environment: NodeJS.ProcessEnv = {}, variant: 'default' | 'x86_64' = 'x86_64') {
  return spawnSync('bash', [path.join(fixtureRoot, 'scripts/docs/audit-bundle.sh'), archivePath, variant], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      ...environment,
      PATH: `${path.join(fixtureRoot, 'tools')}:${process.env['PATH'] ?? ''}`,
      TMPDIR: fixtureRoot,
      AUDIT_TEST_ROOT: fixtureRoot,
      AUDIT_TEST_TSX_CLI: TSX_CLI,
    },
  });
}

async function verifierCalls() {
  try {
    return (await readFile(path.join(fixtureRoot, 'verifier-calls.txt'), 'utf8')).trim().split('\n');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), 'audit-bundle-test-'));
  for (const directory of [
    'scripts/docs',
    'tools',
    'public',
    'verifier-service/target/release',
    'verifier-service/scripts',
  ]) {
    await mkdir(path.join(fixtureRoot, directory), { recursive: true });
  }
  for (const entry of ['packages', 'node_modules', 'scripts/node_modules']) {
    await symlink(path.join(REPO_ROOT, entry), path.join(fixtureRoot, entry));
  }
  await copyFile(
    path.join(REPO_ROOT, 'public/imageId-mapping.json'),
    path.join(fixtureRoot, 'public/imageId-mapping.json'),
  );
  await writeFile(path.join(fixtureRoot, 'package.json'), '{"type":"module"}');
  await copyFile(
    path.join(REPO_ROOT, 'scripts/docs/audit-bundle.sh'),
    path.join(fixtureRoot, 'scripts/docs/audit-bundle.sh'),
  );
  await copyFile(
    path.join(REPO_ROOT, 'scripts/docs/audit-bundle.ts'),
    path.join(fixtureRoot, 'scripts/docs/audit-bundle.ts'),
  );
  await copyFile(
    path.join(REPO_ROOT, 'verifier-service/scripts/read-image-id.mjs'),
    path.join(fixtureRoot, 'verifier-service/scripts/read-image-id.mjs'),
  );
  // Run the real tsx and repository parsers without provisioning a second pnpm
  // workspace. Only package-manager dispatch and the Rust process are replaced.
  await writeFile(
    path.join(fixtureRoot, 'tools/pnpm'),
    `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const [command, ...args] = process.argv.slice(2);
if (command !== 'tsx') process.exit(64);
const result = spawnSync(process.execPath, [process.env.AUDIT_TEST_TSX_CLI, ...args], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(fixtureRoot, 'verifier-service/target/release/verifier-service'),
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const [command, ...args] = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
fs.appendFileSync(path.join(process.env.AUDIT_TEST_ROOT, 'verifier-calls.txt'), command + '\\n');
const expected = option('--image-id');
if (command === 'verify') {
  const report = {
    status: 'success', verifier_version: 'test-double', verified_at: '2026-09-06T00:00:00Z', duration_ms: 1,
    expected_image_id: expected, receipt_image_id: expected, bundle_path: path.basename(option('--bundle')),
    receipt_path: 'receipt.json', dev_mode_receipt: false,
    ...JSON.parse(process.env.AUDIT_TEST_REPORT_OVERRIDE ?? '{}'),
  };
  fs.writeFileSync(option('--output'), JSON.stringify(report));
  process.exit(Number(process.env.AUDIT_TEST_VERIFY_EXIT ?? 0));
}
if (command === 'decode-journal') {
  const journal = JSON.parse(fs.readFileSync(path.join(process.env.AUDIT_TEST_ROOT, 'host-journal.json'), 'utf8'));
  for (const key of ['electionConfigHash', 'bulletinRoot', 'sthDigest', 'seenBitmapRoot', 'includedBitmapRoot', 'inputCommitment']) {
    journal[key] = Array.from(Buffer.from(journal[key].slice(2), 'hex'));
  }
  journal.electionId = Array.from(Buffer.from(journal.electionId.replaceAll('-', ''), 'hex'));
  fs.writeFileSync(option('--output'), JSON.stringify({ ...journal, imageId: expected }));
  process.exit(0);
}
process.exit(64);
`,
    { mode: 0o755 },
  );
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe('public bundle audit orchestration', () => {
  it('rejects private ZIP members before invoking the verifier', async () => {
    const result = runAudit(await writeArchive({ 'input.json': { choice: 'B' } }));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('bundle admission or extraction failed');
    expect(result.stderr).toContain('input.json');
    expect(await verifierCalls()).toEqual([]);
  }, 30_000);

  it('rejects an unconfirmed default ImageID before invoking the verifier', async () => {
    const mappingPath = path.join(fixtureRoot, 'public/imageId-mapping.json');
    const mapping = parseImageIdMapping(JSON.parse(await readFile(mappingPath, 'utf8')));
    const method = mapping.mappings[mapping.current];
    if (!method) throw new Error('Current method mapping is missing from the fixture.');
    await writeFile(
      mappingPath,
      JSON.stringify({
        ...mapping,
        mappings: {
          ...mapping.mappings,
          [mapping.current]: {
            ...method,
            variants: {
              ...method.variants,
              default: { state: 'unconfirmed', requiredEvidence: 'accepted-prover-release' },
            },
          },
        },
      }),
    );
    const result = runAudit(await writeArchive(), {}, 'default');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('2/6:');
    expect(result.stdout).not.toContain('3/6:');
    expect(result.stderr).toContain(
      `Expected ImageID variant default is unconfirmed for method version ${CURRENT_METHOD_VERSION}`,
    );
    expect(await verifierCalls()).toEqual([]);
  }, 30_000);

  it.each([
    { exit: '3', report: {} },
    { exit: '0', report: { status: 'failed', errors: ['proof rejected'] } },
    { exit: '2', report: { status: 'dev_mode', dev_mode_receipt: true } },
    { exit: '0', report: { bundle_path: 'another.zip' } },
  ])(
    'stops after an unusable verifier result: %j',
    async ({ exit, report }) => {
      const result = runAudit(await writeArchive(), {
        AUDIT_TEST_VERIFY_EXIT: exit,
        AUDIT_TEST_REPORT_OVERRIDE: JSON.stringify(report),
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('receipt verification failed; stop the audit');
      expect(result.stdout).not.toContain('4/6:');
      expect(await verifierCalls()).toEqual(['verify']);
    },
    30_000,
  );

  it('rejects a bundle journal that differs from the authenticated receipt output', async () => {
    const result = runAudit(await writeArchive({}, { verifiedTally: [1, 63, 0, 0, 0] }));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('receipt journal comparison failed');
    expect(result.stdout).not.toContain('5/6:');
    expect(await verifierCalls()).toEqual(['verify', 'decode-journal']);
  }, 30_000);

  it.each(['election-manifest.json', 'close-statement.json'] as const)(
    'rejects unknown fields in %s before checking the input commitment',
    async (member) => {
      const { manifest, close } = createArtifacts();
      const artifact = member === 'election-manifest.json' ? manifest : close;
      const result = runAudit(await writeArchive({ [member]: { ...artifact, unexpected: true } }));
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain('5/6: check public election artifacts');
      expect(result.stdout).toContain('public audit artifact checks failed; stop the audit');
      expect(result.stdout).not.toContain('6/6:');
      expect(await verifierCalls()).toEqual(['verify', 'decode-journal']);
    },
    30_000,
  );

  it('rejects excluded slots even when the receipt and bundle journal agree', async () => {
    const journal = {
      excludedSlots: 1,
      missingSlots: 1,
      seenIndicesCount: 63,
      totalVotes: 63,
      validVotes: 63,
      verifiedTally: [0, 63, 0, 0, 0],
    };
    const result = runAudit(await writeArchive({}, journal, journal));
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('integrity_counts=ng');
    expect(result.stdout).not.toContain('5/6:');
    expect(await verifierCalls()).toEqual(['verify', 'decode-journal']);
  });

  it('rejects public-input authority that disagrees with the authenticated journal', async () => {
    const { publicInput } = createArtifacts();
    const result = runAudit(await writeArchive({ 'public-input.json': { ...publicInput, totalExpected: 63 } }));
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('public audit artifact checks failed; stop the audit');
    expect(result.stdout).not.toContain('6/6:');
  });

  it('rejects a commitment mismatch after the preceding public checks succeed', async () => {
    const journal = { inputCommitment: hex(99) };
    const result = runAudit(await writeArchive({}, journal, journal));
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('6/6:');
    expect(result.stdout).toContain('input_commitment=ng');
    expect(result.stdout).not.toContain('Bundle audit passed');
  });

  it('executes the full audit with real ZIP, journal and public-input checks', async () => {
    const result = runAudit(await writeArchive());
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('imageIdVariant=x86_64');
    expect(result.stdout).toContain('receipt_journal_matches');
    expect(result.stdout).toContain('input_commitment=ok');
    expect(result.stdout).toContain('Bundle audit passed. This is not the browser overall verdict.');
    expect(result.stderr).toContain('Audit files:');
    expect(await verifierCalls()).toEqual(['verify', 'decode-journal']);
  }, 30_000);
});
