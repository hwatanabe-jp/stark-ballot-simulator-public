import { describe, expect, it, vi } from 'vitest';
import { productionConfigurationFixture } from './test-support/deployment-target-fixtures';
import { canonicalRecordJson, resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import { FOUNDATION_CONTRACT_CLOSURE_IDENTITY } from './foundation-contract.js';
import {
  PROVER_ACCEPTED_POINTER_KIND,
  PROVER_CANDIDATE_KIND,
  PROVER_RELEASE_KIND,
  TOOLCHAIN_ACCEPTED_POINTER_KIND,
  TOOLCHAIN_CANDIDATE_KIND,
  TOOLCHAIN_RELEASE_KIND,
  admitReleaseRecordKey,
  admitReleaseRecord,
  createReleaseLedger,
  deriveReleaseRecordKey,
  releaseRecordKeySha256,
} from './release-ledger.js';

const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const toolchain = resolveDeploymentLaneAuthority(target, 'toolchain');
const prover = resolveDeploymentLaneAuthority(target, 'prover');
const foundation = resolveDeploymentLaneAuthority(target, 'foundation');
const candidateExecutionId = '11111111-2222-3333-4444-555555555555';
const promotionExecutionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const sourceSha = 'b'.repeat(40);
const historicalSourceSha = 'c'.repeat(40);
const imageDigest = `sha256:${'d'.repeat(64)}`;
const proverImageDigest = `sha256:${'f'.repeat(64)}`;

type StoredObject = Readonly<{
  body: string;
  etag: string;
  versionId: string;
}>;

class MemoryTransport {
  readonly gets: string[] = [];
  readonly puts: Array<Readonly<Record<string, unknown>>> = [];
  readonly objects = new Map<string, StoredObject>();
  #writeSequence = 0;

  getObject(input: Readonly<{ key: string }>): StoredObject | undefined {
    this.gets.push(input.key);
    return this.objects.get(input.key);
  }

  putObject(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    this.puts.push(input);
    const key = input['key'];
    const body = input['body'];
    const condition = input['condition'];
    if (typeof key !== 'string' || typeof body !== 'string' || !isRecord(condition)) {
      throw new Error('invalid test transport input');
    }
    const current = this.objects.get(key);
    const conditionMatches =
      (condition['type'] === 'if-none-match' && current === undefined) ||
      (condition['type'] === 'if-match' &&
        current !== undefined &&
        condition['etag'] === current.etag &&
        condition['versionId'] === current.versionId);
    if (!conditionMatches) {
      return { status: 'precondition-failed' };
    }
    this.#writeSequence += 1;
    const stored = Object.freeze({
      body,
      etag: `"etag-${this.#writeSequence}"`,
      versionId: `version-${this.#writeSequence}`,
    });
    this.objects.set(key, stored);
    return { status: 'written', etag: stored.etag, versionId: stored.versionId };
  }

  forceWrite(key: string, body: string): StoredObject {
    this.#writeSequence += 1;
    const stored = Object.freeze({
      body,
      etag: `"forced-etag-${this.#writeSequence}"`,
      versionId: `forced-version-${this.#writeSequence}`,
    });
    this.objects.set(key, stored);
    return stored;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createMemoryLedger(transport: MemoryTransport) {
  return createReleaseLedger(
    {
      getObject: transport.getObject.bind(transport),
      putObject: transport.putObject.bind(transport),
    },
    'stark-dev/develop',
  );
}

function requiredRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a record`);
  }
  return value;
}

function imageUri(): string {
  return `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${toolchain.names.toolchainRepository}@${imageDigest}`;
}

function candidate(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    kind: TOOLCHAIN_CANDIDATE_KIND,
    targetKey: target.targetKey,
    requestedSourceSha: historicalSourceSha,
    sourceActionSourceSha: historicalSourceSha,
    resolvedSourceSha: historicalSourceSha,
    candidateExecutionId: `toolchain-candidate/${candidateExecutionId}`,
    candidateMetadataSha256: 'e'.repeat(64),
    imageUri: imageUri(),
    imageTag: `candidate-${candidateExecutionId}`,
    imageDigest,
    risc0Version: '3.0.3',
    rustVersion: '1.93.1',
    rustToolchainTag: '1.93.1',
    scanStatus: 'FINDINGS_PRESENT',
    criticalHighCount: 8,
    buildApprovalEvidenceId: `toolchain-build/${candidateExecutionId}`,
    ...overrides,
  };
}

function release(
  selectedCandidateKey: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    kind: TOOLCHAIN_RELEASE_KIND,
    targetKey: target.targetKey,
    requestedControlSourceSha: sourceSha,
    sourceActionControlSourceSha: sourceSha,
    resolvedControlSourceSha: sourceSha,
    selectionMode: 'existing',
    selectedCandidateKey,
    candidateExecutionId: `toolchain-candidate/${candidateExecutionId}`,
    candidateMetadataSha256: 'e'.repeat(64),
    imageUri: imageUri(),
    imageTag: `candidate-${candidateExecutionId}`,
    imageDigest,
    risc0Version: '3.0.3',
    rustVersion: '1.93.1',
    rustToolchainTag: '1.93.1',
    scanStatus: 'FINDINGS_PRESENT',
    criticalHighCount: 8,
    buildApprovalEvidenceId: `toolchain-build/${candidateExecutionId}`,
    candidateSelectionApprovalEvidenceId: `toolchain-candidate-selection/${promotionExecutionId}`,
    promotionExecutionId,
    promotionApprovalEvidenceId: `toolchain-promotion/${promotionExecutionId}`,
    ...overrides,
  };
}

function toolchainReleaseRecordKey(): string {
  const candidateKey = deriveReleaseRecordKey(TOOLCHAIN_CANDIDATE_KIND, candidate(), 'stark-dev/develop');
  return deriveReleaseRecordKey(TOOLCHAIN_RELEASE_KIND, release(candidateKey), 'stark-dev/develop');
}

function foundationAcceptance(
  acceptedSourceSha = historicalSourceSha,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    recordKey:
      `${foundation.names.terraformBaselinePrefix}/${foundation.stateIdentity}/acceptances/` + `${'7'.repeat(64)}.json`,
    acceptedSourceSha,
    closureIdentity: FOUNDATION_CONTRACT_CLOSURE_IDENTITY,
    foundationContractHash: '6'.repeat(64),
    ...overrides,
  };
}

function proverImageUri(): string {
  return `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${prover.names.proverRepository}@${proverImageDigest}`;
}

function proverCandidate(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    kind: PROVER_CANDIDATE_KIND,
    targetKey: target.targetKey,
    requestedSourceSha: historicalSourceSha,
    sourceActionSourceSha: historicalSourceSha,
    resolvedSourceSha: historicalSourceSha,
    candidateExecutionId: `prover-candidate/${candidateExecutionId}`,
    candidateMetadataSha256: '8'.repeat(64),
    selectedToolchainReleaseKey: toolchainReleaseRecordKey(),
    selectedToolchainImageUri: imageUri(),
    selectedToolchainImageDigest: imageDigest,
    foundationAcceptance: foundationAcceptance(),
    imageUri: proverImageUri(),
    imageTag: `candidate-${candidateExecutionId}`,
    imageDigest: proverImageDigest,
    expectedImageId: `0x${'1'.repeat(64)}`,
    prePushImageId: `0x${'1'.repeat(64)}`,
    postPushImageId: `0x${'1'.repeat(64)}`,
    methodVersion: 4,
    prePushMethodVersion: 4,
    postPushMethodVersion: 4,
    imageIdVariant: 'default',
    zkvmContractHash: '2'.repeat(64),
    scanStatus: 'PASS',
    criticalHighCount: 0,
    containerPostureSmokeStatus: 'PASS',
    failureMarkerContractSha256: '3'.repeat(64),
    failureMarkerSmokeStatus: 'PASS',
    managedSigningStatus: 'COMPLETE',
    buildApprovalEvidenceId: `prover-build/${candidateExecutionId}`,
    ...overrides,
  };
}

function proverRelease(
  selectedCandidateKey: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const candidateRecord = proverCandidate();
  const candidateTrustFields = Object.fromEntries(
    [
      'buildApprovalEvidenceId',
      'candidateExecutionId',
      'candidateMetadataSha256',
      'containerPostureSmokeStatus',
      'criticalHighCount',
      'expectedImageId',
      'failureMarkerContractSha256',
      'failureMarkerSmokeStatus',
      'foundationAcceptance',
      'imageDigest',
      'imageIdVariant',
      'imageTag',
      'imageUri',
      'managedSigningStatus',
      'methodVersion',
      'postPushImageId',
      'postPushMethodVersion',
      'prePushImageId',
      'prePushMethodVersion',
      'scanStatus',
      'selectedToolchainImageDigest',
      'selectedToolchainImageUri',
      'selectedToolchainReleaseKey',
      'zkvmContractHash',
    ].map((field) => [field, candidateRecord[field]]),
  );
  return {
    kind: PROVER_RELEASE_KIND,
    targetKey: target.targetKey,
    requestedControlSourceSha: sourceSha,
    sourceActionControlSourceSha: sourceSha,
    resolvedControlSourceSha: sourceSha,
    selectionMode: 'existing',
    selectedCandidateKey,
    ...candidateTrustFields,
    promotionFoundationAcceptance: foundationAcceptance(sourceSha, {
      recordKey:
        `${foundation.names.terraformBaselinePrefix}/${foundation.stateIdentity}/acceptances/` +
        `${'5'.repeat(64)}.json`,
    }),
    candidateSelectionApprovalEvidenceId: `prover-candidate-selection/${promotionExecutionId}`,
    promotionExecutionId,
    promotionApprovalEvidenceId: `prover-promotion/${promotionExecutionId}`,
    ...overrides,
  };
}

async function publishReleaseFixture(transport: MemoryTransport) {
  const ledger = createMemoryLedger(transport);
  const candidatePublication = await ledger.publishRecord(TOOLCHAIN_CANDIDATE_KIND, candidate());
  const releasePublication = await ledger.publishRecord(TOOLCHAIN_RELEASE_KIND, release(candidatePublication.key));
  return { candidatePublication, ledger, releasePublication };
}

async function publishProverCandidateFixture(transport: MemoryTransport) {
  const { ledger, releasePublication: toolchainReleasePublication } = await publishReleaseFixture(transport);
  expect(toolchainReleasePublication.key).toBe(toolchainReleaseRecordKey());
  const candidatePublication = await ledger.publishRecord(PROVER_CANDIDATE_KIND, proverCandidate());
  return { candidatePublication, ledger, toolchainReleasePublication };
}

async function publishProverReleaseFixture(transport: MemoryTransport) {
  const { candidatePublication, ledger, toolchainReleasePublication } = await publishProverCandidateFixture(transport);
  const releasePublication = await ledger.publishRecord(PROVER_RELEASE_KIND, proverRelease(candidatePublication.key));
  return { candidatePublication, ledger, releasePublication, toolchainReleasePublication };
}

describe('release-ledger Toolchain records', () => {
  it('admits only exact target shapes without invoking hidden accessors', () => {
    const admitted = admitReleaseRecord(TOOLCHAIN_CANDIDATE_KIND, candidate(), 'stark-dev/develop');
    expect(admitted).toEqual(candidate());
    expect(Object.isFrozen(admitted)).toBe(true);

    expect(() =>
      admitReleaseRecord(TOOLCHAIN_CANDIDATE_KIND, candidate({ unknown: 'rejected' }), 'stark-dev/develop'),
    ).toThrow('must contain exactly');
    expect(() => admitReleaseRecord(TOOLCHAIN_RELEASE_KIND, candidate(), 'stark-dev/develop')).toThrow('kind');

    let getterCalls = 0;
    const withAccessor = { ...candidate() };
    Object.defineProperty(withAccessor, 'hidden', {
      enumerable: false,
      get() {
        getterCalls += 1;
        return 'not authority';
      },
    });
    expect(() => admitReleaseRecord(TOOLCHAIN_CANDIDATE_KIND, withAccessor, 'stark-dev/develop')).toThrow(
      'must contain exactly',
    );
    expect(getterCalls).toBe(0);
  });

  it('derives closed content-addressed keys beneath the existing Toolchain namespace', () => {
    const candidateKey = deriveReleaseRecordKey(TOOLCHAIN_CANDIDATE_KIND, candidate(), 'stark-dev/develop');
    expect(candidateKey).toMatch(
      new RegExp(`^${toolchain.names.toolchainArtifactPrefix}/candidates/[0-9a-f]{64}\\.json$`, 'u'),
    );
    const releaseKey = deriveReleaseRecordKey(TOOLCHAIN_RELEASE_KIND, release(candidateKey), 'stark-dev/develop');
    expect(releaseKey).toMatch(
      new RegExp(`^${toolchain.names.toolchainArtifactPrefix}/releases/[0-9a-f]{64}\\.json$`, 'u'),
    );
    expect(admitReleaseRecordKey(TOOLCHAIN_RELEASE_KIND, releaseKey, 'stark-dev/develop')).toBe(releaseKey);
    expect(releaseRecordKeySha256(TOOLCHAIN_RELEASE_KIND, releaseKey, 'stark-dev/develop')).toBe(
      releaseKey.slice(-69, -5),
    );
    expect(() => admitReleaseRecordKey(TOOLCHAIN_RELEASE_KIND, candidateKey, 'stark-dev/develop')).toThrow('namespace');
    expect(() => releaseRecordKeySha256(TOOLCHAIN_RELEASE_KIND, `${releaseKey}.json`, 'stark-dev/develop')).toThrow(
      'namespace',
    );
  });

  it('publishes canonical bytes create-only and admits an identical conditional retry', async () => {
    const transport = new MemoryTransport();
    const ledger = createMemoryLedger(transport);

    const first = await ledger.publishRecord(TOOLCHAIN_CANDIDATE_KIND, candidate());
    const retry = await ledger.publishRecord(TOOLCHAIN_CANDIDATE_KIND, candidate());

    expect(first.status).toBe('created');
    expect(retry.status).toBe('idempotent-retry');
    expect(retry.key).toBe(first.key);
    expect(transport.puts).toHaveLength(2);
    expect(
      transport.puts.every((put) => isRecord(put['condition']) && put['condition']['type'] === 'if-none-match'),
    ).toBe(true);
    expect(transport.objects.get(first.key)?.body).toBe(
      `${JSON.stringify(candidate(), Object.keys(candidate()).sort(), 2)}\n`,
    );
  });

  it('rejects non-canonical, wrong-kind, detached, and divergent immutable records', async () => {
    const transport = new MemoryTransport();
    const ledger = createMemoryLedger(transport);
    const candidateKey = deriveReleaseRecordKey(TOOLCHAIN_CANDIDATE_KIND, candidate(), 'stark-dev/develop');
    transport.forceWrite(candidateKey, `${JSON.stringify(candidate())}\n`);
    await expect(ledger.readRecord(candidateKey)).rejects.toThrow('canonical JSON bytes');

    transport.objects.clear();
    const publishedCandidate = await ledger.publishRecord(TOOLCHAIN_CANDIDATE_KIND, candidate());
    await expect(
      ledger.publishRecord(TOOLCHAIN_RELEASE_KIND, release(publishedCandidate.key, { criticalHighCount: 9 })),
    ).rejects.toThrow('detached from its selected candidate');
    expect(() =>
      admitReleaseRecord(
        TOOLCHAIN_RELEASE_KIND,
        release(publishedCandidate.key, {
          candidateSelectionApprovalEvidenceId: `toolchain-candidate-selection/${candidateExecutionId}`,
        }),
        'stark-dev/develop',
      ),
    ).toThrow('candidate-selection approval is detached from its promotion execution');

    const divergentKey = deriveReleaseRecordKey(
      TOOLCHAIN_CANDIDATE_KIND,
      candidate({ imageTag: 'candidate-divergent' }),
      'stark-dev/develop',
    );
    transport.forceWrite(divergentKey, transport.objects.get(publishedCandidate.key)?.body ?? '');
    await expect(
      ledger.publishRecord(TOOLCHAIN_CANDIDATE_KIND, candidate({ imageTag: 'candidate-divergent' })),
    ).rejects.toThrow('derived key');
    await expect(ledger.readRecord(`${toolchain.names.toolchainArtifactPrefix}/unknown/value.json`)).rejects.toThrow(
      'record key',
    );
  });

  it('preserves the one-mebibyte release object ceiling', async () => {
    const transport = new MemoryTransport();
    const ledger = createMemoryLedger(transport);
    const candidateKey = deriveReleaseRecordKey(TOOLCHAIN_CANDIDATE_KIND, candidate(), 'stark-dev/develop');
    transport.forceWrite(candidateKey, 'x'.repeat(1024 * 1024 + 1));

    await expect(ledger.readRecord(candidateKey)).rejects.toThrow('empty or oversized');
  });
});

describe('release-ledger Toolchain pointer', () => {
  it('moves the pointer by first-create and resolves one observed pointer state to its exact release', async () => {
    const transport = new MemoryTransport();
    const { ledger, releasePublication } = await publishReleaseFixture(transport);
    const moved = await ledger.movePointer({
      kind: TOOLCHAIN_ACCEPTED_POINTER_KIND,
      pointerKey: toolchain.names.toolchainAcceptedPointerKey,
      recordKey: releasePublication.key,
      promotionExecutionId,
      expected: null,
    });
    expect(moved.status).toBe('moved');
    if (moved.status !== 'moved') {
      throw new Error('test invariant failed');
    }
    expect(moved.pointer).toEqual({
      kind: TOOLCHAIN_ACCEPTED_POINTER_KIND,
      targetKey: target.targetKey,
      recordKey: releasePublication.key,
      promotionExecutionId,
      previous: null,
      compareAndSwapEvidenceId: `cas/toolchain/${promotionExecutionId}`,
    });

    transport.gets.length = 0;
    const resolved = await ledger.resolvePointer(toolchain.names.toolchainAcceptedPointerKey);
    expect(resolved.pointer).toEqual(moved.pointer);
    expect(resolved.record).toEqual(releasePublication.record);
    expect(resolved.recordObservation).toEqual(releasePublication.recordObservation);
    expect(transport.gets.filter((key) => key === toolchain.names.toolchainAcceptedPointerKey)).toHaveLength(1);

    const movedPointer = requiredRecord(moved.pointer, 'moved pointer');
    const laterPointer = { ...movedPointer, compareAndSwapEvidenceId: 'cas/toolchain/later' };
    transport.forceWrite(toolchain.names.toolchainAcceptedPointerKey, `${JSON.stringify(laterPointer)}\n`);
    expect(resolved.pointer).toEqual(moved.pointer);
    expect(resolved.record).toEqual(releasePublication.record);
  });

  it('classifies a lost response as an idempotent retry and preserves structured stale-CAS conflict state', async () => {
    const transport = new MemoryTransport();
    const { ledger, releasePublication } = await publishReleaseFixture(transport);
    const first = await ledger.movePointer({
      kind: TOOLCHAIN_ACCEPTED_POINTER_KIND,
      pointerKey: toolchain.names.toolchainAcceptedPointerKey,
      recordKey: releasePublication.key,
      promotionExecutionId,
      expected: null,
    });
    expect(first.status).toBe('moved');
    const retry = await ledger.movePointer({
      kind: TOOLCHAIN_ACCEPTED_POINTER_KIND,
      pointerKey: toolchain.names.toolchainAcceptedPointerKey,
      recordKey: releasePublication.key,
      promotionExecutionId,
      expected: null,
    });
    expect(retry.status).toBe('idempotent-retry');

    const resolved = await ledger.resolvePointer(toolchain.names.toolchainAcceptedPointerKey);
    const resolvedPointer = requiredRecord(resolved.pointer, 'resolved pointer');
    const resolvedPointerObservation = requiredRecord(resolved.pointerObservation, 'resolved pointer observation');
    const replacementCandidate = await ledger.publishRecord(
      TOOLCHAIN_CANDIDATE_KIND,
      candidate({
        candidateExecutionId: `toolchain-candidate/${promotionExecutionId}`,
        buildApprovalEvidenceId: `toolchain-build/${promotionExecutionId}`,
        candidateMetadataSha256: '1'.repeat(64),
        imageTag: `candidate-${promotionExecutionId}`,
      }),
    );
    const replacementRelease = await ledger.publishRecord(
      TOOLCHAIN_RELEASE_KIND,
      release(replacementCandidate.key, {
        candidateExecutionId: `toolchain-candidate/${promotionExecutionId}`,
        buildApprovalEvidenceId: `toolchain-build/${promotionExecutionId}`,
        candidateMetadataSha256: '1'.repeat(64),
        imageTag: `candidate-${promotionExecutionId}`,
      }),
    );
    const concurrentPointer = {
      ...resolvedPointer,
      recordKey: replacementRelease.key,
      compareAndSwapEvidenceId: `cas/toolchain/${promotionExecutionId}`,
      previous: resolvedPointerObservation,
    };
    const concurrent = transport.forceWrite(
      toolchain.names.toolchainAcceptedPointerKey,
      canonicalRecordJson(concurrentPointer),
    );

    const conflict = await ledger.movePointer({
      kind: TOOLCHAIN_ACCEPTED_POINTER_KIND,
      pointerKey: toolchain.names.toolchainAcceptedPointerKey,
      recordKey: releasePublication.key,
      promotionExecutionId,
      expected: resolvedPointerObservation,
    });
    expect(conflict).toEqual({
      status: 'conflict',
      pointerKey: toolchain.names.toolchainAcceptedPointerKey,
      expected: resolvedPointerObservation,
      observed: {
        pointer: concurrentPointer,
        pointerObservation: { etag: concurrent.etag, versionId: concurrent.versionId },
      },
    });
  });
});

describe('release-ledger Prover records', () => {
  it('admits the complete candidate trust chain and derives its content-addressed key', () => {
    const admitted = admitReleaseRecord(PROVER_CANDIDATE_KIND, proverCandidate(), 'stark-dev/develop');
    const admittedRecord = requiredRecord(admitted, 'Prover candidate');

    expect(admitted).toEqual(proverCandidate());
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(requiredRecord(admittedRecord['foundationAcceptance'], 'Foundation acceptance'))).toBe(true);
    expect(deriveReleaseRecordKey(PROVER_CANDIDATE_KIND, admitted, 'stark-dev/develop')).toMatch(
      new RegExp(`^${prover.names.proverReleasePrefix}/candidates/[0-9a-f]{64}\\.json$`, 'u'),
    );
  });

  it('publishes an existing candidate as a separate release with current Foundation authority', async () => {
    const transport = new MemoryTransport();
    const { candidatePublication, releasePublication } = await publishProverReleaseFixture(transport);
    const releaseRecord = requiredRecord(releasePublication.record, 'Prover release');

    expect(releasePublication.record).toEqual(proverRelease(candidatePublication.key));
    expect(releasePublication.key).toMatch(
      new RegExp(`^${prover.names.proverReleasePrefix}/releases/[0-9a-f]{64}\\.json$`, 'u'),
    );
    expect(releaseRecord['foundationAcceptance']).not.toEqual(releaseRecord['promotionFoundationAcceptance']);
  });

  it('rejects a release whose copied trust chain diverges from its selected candidate', async () => {
    const transport = new MemoryTransport();
    const { candidatePublication, ledger } = await publishProverCandidateFixture(transport);

    await expect(
      ledger.publishRecord(
        PROVER_RELEASE_KIND,
        proverRelease(candidatePublication.key, { zkvmContractHash: '4'.repeat(64) }),
      ),
    ).rejects.toThrow('detached from its selected candidate');
  });

  it('rejects a candidate whose Toolchain image is detached from the selected Toolchain release key', async () => {
    const transport = new MemoryTransport();
    const { ledger } = await publishReleaseFixture(transport);
    const otherDigest = `sha256:${'5'.repeat(64)}`;
    const otherImageUri = `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${toolchain.names.toolchainRepository}@${otherDigest}`;

    await expect(
      ledger.publishRecord(
        PROVER_CANDIDATE_KIND,
        proverCandidate({
          selectedToolchainImageUri: otherImageUri,
          selectedToolchainImageDigest: otherDigest,
        }),
      ),
    ).rejects.toThrow('detached from its selected Toolchain release');
  });

  it.each([
    [
      'a Toolchain key outside the Toolchain release namespace',
      { selectedToolchainReleaseKey: `${prover.names.proverReleasePrefix}/releases/${'5'.repeat(64)}.json` },
    ],
    ['a Toolchain digest detached from its URI', { selectedToolchainImageDigest: `sha256:${'5'.repeat(64)}` }],
    ['a Prover digest detached from its URI', { imageDigest: `sha256:${'5'.repeat(64)}` }],
    ['mismatched post-push ImageID evidence', { postPushImageId: `0x${'5'.repeat(64)}` }],
    ['mismatched post-push method evidence', { postPushMethodVersion: 5 }],
    ['an invalid zkVM contract hash', { zkvmContractHash: 'not-a-sha256' }],
    ['an invalid failure-marker contract hash', { failureMarkerContractSha256: 'not-a-sha256' }],
    ['a non-passing scan', { scanStatus: 'FINDINGS_PRESENT' }],
    ['HIGH/CRITICAL scan findings', { criticalHighCount: 1 }],
    ['incomplete managed signing', { managedSigningStatus: 'IN_PROGRESS' }],
    ['a failed container-posture smoke', { containerPostureSmokeStatus: 'FAIL' }],
    ['a failed failure-marker smoke', { failureMarkerSmokeStatus: 'FAIL' }],
    [
      'a Foundation acceptance outside its content-addressed namespace',
      { foundationAcceptance: foundationAcceptance(historicalSourceSha, { recordKey: 'not-an-acceptance' }) },
    ],
    [
      'a retired Foundation closure identity',
      { foundationAcceptance: foundationAcceptance(historicalSourceSha, { closureIdentity: '0'.repeat(64) }) },
    ],
  ])('rejects %s', (_label, overrides) => {
    expect(() => admitReleaseRecord(PROVER_CANDIDATE_KIND, proverCandidate(overrides), 'stark-dev/develop')).toThrow();
  });

  it('requires build promotion to retain the candidate source and exact Foundation acceptance', async () => {
    const transport = new MemoryTransport();
    const { candidatePublication, ledger } = await publishProverCandidateFixture(transport);

    await expect(
      ledger.publishRecord(
        PROVER_RELEASE_KIND,
        proverRelease(candidatePublication.key, {
          selectionMode: 'build',
          candidateSelectionApprovalEvidenceId: `prover-build/${candidateExecutionId}`,
          promotionExecutionId: candidateExecutionId,
          promotionApprovalEvidenceId: `prover-promotion/${candidateExecutionId}`,
          foundationAcceptance: foundationAcceptance(sourceSha, {
            recordKey:
              `${foundation.names.terraformBaselinePrefix}/${foundation.stateIdentity}/acceptances/` +
              `${'5'.repeat(64)}.json`,
          }),
        }),
      ),
    ).rejects.toThrow('detached from its selected candidate');

    const candidateAuthority = foundationAcceptance();
    const releasePublication = await ledger.publishRecord(
      PROVER_RELEASE_KIND,
      proverRelease(candidatePublication.key, {
        requestedControlSourceSha: historicalSourceSha,
        sourceActionControlSourceSha: historicalSourceSha,
        resolvedControlSourceSha: historicalSourceSha,
        selectionMode: 'build',
        promotionFoundationAcceptance: candidateAuthority,
        candidateSelectionApprovalEvidenceId: `prover-build/${candidateExecutionId}`,
        promotionExecutionId: candidateExecutionId,
        promotionApprovalEvidenceId: `prover-promotion/${candidateExecutionId}`,
      }),
    );
    const releaseRecord = requiredRecord(releasePublication.record, 'Prover build release');
    expect(releaseRecord['foundationAcceptance']).toEqual(candidateAuthority);
    expect(releaseRecord['promotionFoundationAcceptance']).toEqual(candidateAuthority);
    expect(releaseRecord['candidateSelectionApprovalEvidenceId']).toBe(`prover-build/${candidateExecutionId}`);

    expect(() =>
      admitReleaseRecord(
        PROVER_RELEASE_KIND,
        proverRelease(candidatePublication.key, {
          requestedControlSourceSha: historicalSourceSha,
          sourceActionControlSourceSha: historicalSourceSha,
          resolvedControlSourceSha: historicalSourceSha,
          selectionMode: 'build',
          promotionFoundationAcceptance: candidateAuthority,
        }),
        'stark-dev/develop',
      ),
    ).toThrow('build approval');
  });

  it('rejects an unknown record kind', () => {
    expect(() =>
      admitReleaseRecord('unknown-record-kind' as typeof PROVER_CANDIDATE_KIND, proverCandidate(), 'stark-dev/develop'),
    ).toThrow('not registered');
  });
});

describe('release-ledger Prover pointer', () => {
  it('observes an exact pointer without reading its predecessor release body', async () => {
    const transport = new MemoryTransport();
    const { ledger, releasePublication } = await publishProverReleaseFixture(transport);
    const predecessorRecordKey = `${prover.names.proverReleasePrefix}/releases/` + `${'0'.repeat(64)}.json`;
    const predecessorPointer = {
      kind: PROVER_ACCEPTED_POINTER_KIND,
      targetKey: target.targetKey,
      recordKey: predecessorRecordKey,
      promotionExecutionId: candidateExecutionId,
      previous: null,
      compareAndSwapEvidenceId: `cas/prover/${candidateExecutionId}`,
    };
    const predecessorObservation = transport.forceWrite(
      prover.names.proverAcceptedPointerKey,
      canonicalRecordJson(predecessorPointer),
    );
    transport.gets.length = 0;

    const observed = await ledger.observePointer(prover.names.proverAcceptedPointerKey);
    expect(observed).toEqual({
      pointerKey: prover.names.proverAcceptedPointerKey,
      pointer: predecessorPointer,
      pointerObservation: {
        etag: predecessorObservation.etag,
        versionId: predecessorObservation.versionId,
      },
    });
    expect(transport.gets).toEqual([prover.names.proverAcceptedPointerKey]);

    const moved = await ledger.movePointer({
      kind: PROVER_ACCEPTED_POINTER_KIND,
      pointerKey: prover.names.proverAcceptedPointerKey,
      recordKey: releasePublication.key,
      promotionExecutionId,
      expected: observed.pointerObservation,
    });
    expect(moved.status).toBe('moved');
    expect(transport.gets).not.toContain(predecessorRecordKey);
  });

  it('moves and resolves the key-only pointer through the shared CAS boundary', async () => {
    const transport = new MemoryTransport();
    const { ledger, releasePublication } = await publishProverReleaseFixture(transport);

    const moved = await ledger.movePointer({
      kind: PROVER_ACCEPTED_POINTER_KIND,
      pointerKey: prover.names.proverAcceptedPointerKey,
      recordKey: releasePublication.key,
      promotionExecutionId,
      expected: null,
    });
    expect(moved.status).toBe('moved');
    if (moved.status !== 'moved') {
      throw new Error('test invariant failed');
    }
    expect(moved.pointer).toEqual({
      kind: PROVER_ACCEPTED_POINTER_KIND,
      targetKey: target.targetKey,
      recordKey: releasePublication.key,
      promotionExecutionId,
      previous: null,
      compareAndSwapEvidenceId: `cas/prover/${promotionExecutionId}`,
    });

    transport.gets.length = 0;
    const resolved = await ledger.resolvePointer(prover.names.proverAcceptedPointerKey);
    expect(resolved.recordKind).toBe(PROVER_RELEASE_KIND);
    expect(resolved.record).toEqual(releasePublication.record);
    expect(transport.gets.filter((key) => key === prover.names.proverAcceptedPointerKey)).toHaveLength(1);

    const movedPointer = requiredRecord(moved.pointer, 'moved Prover pointer');
    const laterPointer = { ...movedPointer, compareAndSwapEvidenceId: 'cas/prover/later' };
    transport.forceWrite(prover.names.proverAcceptedPointerKey, canonicalRecordJson(laterPointer));
    expect(resolved.pointer).toEqual(moved.pointer);
    expect(resolved.record).toEqual(releasePublication.record);
  });

  it('returns the exact observed Prover pointer after a stale CAS', async () => {
    const transport = new MemoryTransport();
    const { ledger, releasePublication } = await publishProverReleaseFixture(transport);
    const first = await ledger.movePointer({
      kind: PROVER_ACCEPTED_POINTER_KIND,
      pointerKey: prover.names.proverAcceptedPointerKey,
      recordKey: releasePublication.key,
      promotionExecutionId,
      expected: null,
    });
    expect(first.status).toBe('moved');
    if (first.status !== 'moved') {
      throw new Error('test invariant failed');
    }
    const staleObservation = first.pointerObservation;
    const concurrentPointer = {
      ...first.pointer,
      previous: { etag: 'concurrent-etag', versionId: 'concurrent-version' },
    };
    const concurrent = transport.forceWrite(
      prover.names.proverAcceptedPointerKey,
      canonicalRecordJson(concurrentPointer),
    );

    const conflict = await ledger.movePointer({
      kind: PROVER_ACCEPTED_POINTER_KIND,
      pointerKey: prover.names.proverAcceptedPointerKey,
      recordKey: releasePublication.key,
      promotionExecutionId,
      expected: staleObservation,
    });
    expect(conflict).toEqual({
      status: 'conflict',
      pointerKey: prover.names.proverAcceptedPointerKey,
      expected: staleObservation,
      observed: {
        pointer: concurrentPointer,
        pointerObservation: { etag: concurrent.etag, versionId: concurrent.versionId },
      },
    });
  });
});

it('requires an independently selected release target before transport access', () => {
  const getObject = vi.fn();
  const putObject = vi.fn();
  const key = deriveReleaseRecordKey(TOOLCHAIN_CANDIDATE_KIND, candidate(), target.targetKey);
  for (const expectedTargetKey of [undefined, '', 'unreviewed/main']) {
    expect(() => createReleaseLedger({ getObject, putObject }, expectedTargetKey)).toThrow();
    expect(() => admitReleaseRecord(TOOLCHAIN_CANDIDATE_KIND, candidate(), expectedTargetKey)).toThrow();
    expect(() => deriveReleaseRecordKey(TOOLCHAIN_CANDIDATE_KIND, candidate(), expectedTargetKey)).toThrow();
    expect(() => admitReleaseRecordKey(TOOLCHAIN_CANDIDATE_KIND, key, expectedTargetKey)).toThrow();
    expect(() => releaseRecordKeySha256(TOOLCHAIN_CANDIDATE_KIND, key, expectedTargetKey)).toThrow();
  }
  expect(getObject).not.toHaveBeenCalled();
  expect(putObject).not.toHaveBeenCalled();
});

it('keeps production release closure and conditional pointers bound to their selected target', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const configured = await import('./index.js');
    const authority = await import('./release-ledger.js');
    const production = configured.resolveAllowedDeploymentTarget('stark-prod/main');
    function project(value: unknown): unknown {
      if (typeof value === 'string')
        return value
          .replaceAll(target.accountId, production.accountId)
          .replaceAll('stark-dev', 'stark-prod')
          .replaceAll('stark_dev', 'stark_prod')
          .replaceAll('develop', 'main');
      if (Array.isArray(value)) return value.map((entry: unknown) => project(entry));
      if (isRecord(value))
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, project(entry)]));
      return value;
    }
    const projected = (value: unknown) => requiredRecord(project(value), 'production fixture');
    const toolchainCandidate = projected(candidate());
    const toolchainCandidateKey = authority.deriveReleaseRecordKey(
      TOOLCHAIN_CANDIDATE_KIND,
      toolchainCandidate,
      production.targetKey,
    );
    const toolchainRelease = projected(release(toolchainCandidateKey));
    const toolchainReleaseKey = authority.deriveReleaseRecordKey(
      TOOLCHAIN_RELEASE_KIND,
      toolchainRelease,
      production.targetKey,
    );
    const proverCandidateBody = { ...projected(proverCandidate()), selectedToolchainReleaseKey: toolchainReleaseKey };
    const proverCandidateKey = authority.deriveReleaseRecordKey(
      PROVER_CANDIDATE_KIND,
      proverCandidateBody,
      production.targetKey,
    );
    const proverReleaseBody = {
      ...projected(proverRelease(proverCandidateKey)),
      selectedToolchainReleaseKey: toolchainReleaseKey,
    };
    const transport = new MemoryTransport();
    const ports = { getObject: transport.getObject.bind(transport), putObject: transport.putObject.bind(transport) };
    const ledger = authority.createReleaseLedger(ports, production.targetKey);
    const developmentLedger = authority.createReleaseLedger(ports, target.targetKey);
    for (const [kind, body] of [
      [TOOLCHAIN_CANDIDATE_KIND, toolchainCandidate],
      [TOOLCHAIN_RELEASE_KIND, toolchainRelease],
      [PROVER_CANDIDATE_KIND, proverCandidateBody],
      [PROVER_RELEASE_KIND, proverReleaseBody],
    ] as const) {
      const admitted = authority.admitReleaseRecord(kind, body, production.targetKey);
      expect(canonicalRecordJson(admitted)).toBe(canonicalRecordJson(body));
      const key = authority.deriveReleaseRecordKey(kind, body, production.targetKey);
      expect(authority.admitReleaseRecordKey(kind, key, production.targetKey)).toBe(key);
      expect(authority.releaseRecordKeySha256(kind, key, production.targetKey)).toBe(
        key.split('/').at(-1)?.slice(0, -5),
      );
      const readsBefore = transport.gets.length;
      const writesBefore = transport.puts.length;
      expect(() => authority.admitReleaseRecord(kind, body, target.targetKey)).toThrow('target');
      expect(() => authority.deriveReleaseRecordKey(kind, body, target.targetKey)).toThrow('target');
      await expect(developmentLedger.publishRecord(kind, body)).rejects.toThrow('target');
      expect(transport.gets).toHaveLength(readsBefore);
      expect(transport.puts).toHaveLength(writesBefore);
      await expect(ledger.publishRecord(kind, body)).resolves.toMatchObject({
        status: 'created',
        key,
        record: admitted,
      });
      await expect(ledger.publishRecord(kind, body)).resolves.toMatchObject({ status: 'idempotent-retry', key });
      await expect(ledger.readRecord(key)).resolves.toMatchObject({ key, record: admitted });
      await expect(developmentLedger.readRecord(key)).rejects.toThrow('target');
      expect(() =>
        authority.admitReleaseRecord(kind, { ...body, imageUri: imageUri() }, production.targetKey),
      ).toThrow();
    }
    for (const [lane, pointerKind, releaseKind, body] of [
      ['toolchain', TOOLCHAIN_ACCEPTED_POINTER_KIND, TOOLCHAIN_RELEASE_KIND, toolchainRelease],
      ['prover', PROVER_ACCEPTED_POINTER_KIND, PROVER_RELEASE_KIND, proverReleaseBody],
    ] as const) {
      const laneAuthority = configured.resolveDeploymentLaneAuthority(production, lane);
      const pointerKey =
        lane === 'toolchain'
          ? laneAuthority.names.toolchainAcceptedPointerKey
          : laneAuthority.names.proverAcceptedPointerKey;
      const recordKey = authority.deriveReleaseRecordKey(releaseKind, body, production.targetKey);
      const request = { kind: pointerKind, pointerKey, recordKey, promotionExecutionId, expected: null };
      const first = await ledger.movePointer(request);
      expect(first.status).toBe('moved');
      if (first.status !== 'moved') throw new Error('production pointer was not created');
      expect(first.pointer.targetKey).toBe(production.targetKey);
      const pointerBytes = transport.objects.get(pointerKey);
      await expect(ledger.resolvePointer(pointerKey)).resolves.toMatchObject({ recordKey, record: body });
      await expect(ledger.movePointer(request)).resolves.toMatchObject({ status: 'idempotent-retry' });
      expect(transport.objects.get(pointerKey)).toEqual(pointerBytes);
      await expect(developmentLedger.resolvePointer(pointerKey)).rejects.toThrow('pointer key');
      expect(() => authority.admitReleasePointer(pointerKind, first.pointer, undefined)).toThrow('expected target');
      const nextPromotion = '12345678-1234-4234-8234-123456789abc';
      const nextBody = {
        ...body,
        promotionExecutionId: nextPromotion,
        promotionApprovalEvidenceId: `${lane}-promotion/${nextPromotion}`,
        candidateSelectionApprovalEvidenceId: `${lane}-candidate-selection/${nextPromotion}`,
      };
      const next = await ledger.publishRecord(releaseKind, nextBody);
      await expect(
        ledger.movePointer({
          ...request,
          recordKey: next.key,
          promotionExecutionId: nextPromotion,
          expected: first.pointerObservation,
        }),
      ).resolves.toMatchObject({ status: 'moved' });
      await expect(ledger.movePointer(request)).resolves.toMatchObject({ status: 'conflict' });
      const crossPointer = authority.admitReleasePointer(
        pointerKind,
        { ...first.pointer, targetKey: target.targetKey },
        target.targetKey,
      );
      transport.forceWrite(pointerKey, canonicalRecordJson(crossPointer));
      await expect(ledger.movePointer(request)).rejects.toThrow('target');
      if (pointerBytes === undefined) throw new Error('production pointer bytes are absent');
      transport.objects.set(pointerKey, pointerBytes);
    }
    for (const overrides of [
      { selectedToolchainImageUri: imageUri() },
      { foundationAcceptance: foundationAcceptance() },
    ])
      expect(() =>
        authority.admitReleaseRecord(
          PROVER_CANDIDATE_KIND,
          { ...proverCandidateBody, ...overrides },
          production.targetKey,
        ),
      ).toThrow();
    expect(() =>
      authority.admitReleaseRecord(
        PROVER_RELEASE_KIND,
        {
          ...proverReleaseBody,
          promotionFoundationAcceptance: foundationAcceptance(sourceSha),
        },
        production.targetKey,
      ),
    ).toThrow();
    transport.forceWrite(toolchainCandidateKey, canonicalRecordJson(candidate()));
    const writesBefore = transport.puts.length;
    await expect(ledger.readRecord(toolchainReleaseKey)).rejects.toThrow('target');
    await expect(ledger.preflightRecordPublication(PROVER_CANDIDATE_KIND, proverCandidateBody)).rejects.toThrow(
      'target',
    );
    expect(transport.puts).toHaveLength(writesBefore);
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
