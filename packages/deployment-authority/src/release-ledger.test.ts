import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalRecordJson, resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import {
  admitImageCandidate,
  admitImagePromotion,
  assertProverImageContract,
  candidateKey,
  createImageLedger,
  promotionKey,
  type ImageTransport,
  type StoredObject,
} from './release-ledger.js';

const targetKey = 'stark-dev/develop';
const target = resolveAllowedDeploymentTarget(targetKey);
const source = 'a'.repeat(40),
  execution = '11111111-1111-4111-8111-111111111111';
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
function image(kind: 'toolchain' | 'prover', digest = 'a') {
  const names = resolveDeploymentLaneAuthority(target, kind).names;
  return `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${kind === 'prover' ? names.proverRepository : names.toolchainRepository}@sha256:${digest.repeat(64)}`;
}
function toolchain() {
  return admitImageCandidate(
    {
      kind: 'toolchain',
      targetKey,
      sourceSha: source,
      executionId: execution,
      approvalEvidenceId: `toolchain-build/${execution}`,
      metadataSha256: 'c'.repeat(64),
      imageUri: image('toolchain'),
      imageTag: 'candidate',
      scan: { status: 'FINDINGS_PRESENT', criticalHighCount: 3 },
      evidence: { risc0Version: '3.0.6', rustVersion: '1.99.0', rustToolchainTag: 'stable' },
    },
    targetKey,
  );
}
function store() {
  let serial = 0;
  const versions = new Map<string, StoredObject>(),
    current = new Map<string, StoredObject>();
  const transport: ImageTransport = {
    async getObject({ key, versionId }) {
      return (versionId === undefined ? current.get(key) : versions.get(`${key}/${versionId}`)) ?? null;
    },
    async putObject({ key, body, expected }) {
      const previous = current.get(key);
      if (
        expected === null
          ? !!previous
          : !previous ||
            previous.etag !== expected.etag ||
            previous.versionId !== expected.versionId ||
            hash(previous.body) !== expected.sha256
      )
        throw new Error('Conditional publication conflict');
      const object = { body, versionId: `version-${++serial}`, etag: `"etag-${serial}"` };
      current.set(key, object);
      versions.set(`${key}/${object.versionId}`, object);
      return object;
    },
  };
  return { transport, current, versions, ledger: createImageLedger(transport, targetKey) };
}
function promotion(
  candidate: unknown,
  kind: 'toolchain' | 'prover' = 'toolchain',
  revalidation: unknown = { imageUri: image('toolchain'), scan: { status: 'FINDINGS_PRESENT', criticalHighCount: 3 } },
) {
  return {
    kind,
    targetKey,
    candidate,
    sourceSha: source,
    selectionMode: 'build',
    executionId: execution,
    candidateApprovalEvidenceId: `${kind}-candidate-selection/${execution}`,
    promotionApprovalEvidenceId: `${kind}-promotion/${execution}`,
    revalidation,
  };
}
async function withToolchain() {
  const state = store(),
    candidate = toolchain(),
    candidateRef = await state.ledger.publishCandidate(candidate);
  const ref = await state.ledger.publishPromotion(promotion(candidateRef), 'toolchain', null);
  return { ...state, candidate, candidateRef, ref };
}
function prover(original: unknown) {
  return admitImageCandidate(
    {
      kind: 'prover',
      targetKey,
      sourceSha: source,
      executionId: execution,
      approvalEvidenceId: `prover-build/${execution}`,
      metadataSha256: 'd'.repeat(64),
      imageUri: image('prover'),
      imageTag: 'candidate',
      scan: { status: 'PASS', criticalHighCount: 0 },
      evidence: {
        foundation: {
          reference: {
            key: `deployment/${targetKey}/foundation/checkpoint.json`,
            versionId: 'foundation-original',
            sha256: 'e'.repeat(64),
          },
          consumerContractSha256: 'f'.repeat(64),
        },
        toolchain: { promotion: original, imageUri: image('toolchain') },
        imageId: `0x${'1'.repeat(64)}`,
        methodVersion: 4,
        variant: 'default',
        zkvmContractHash: '2'.repeat(64),
        failureMarkerContractSha256: '3'.repeat(64),
        posture: 'PASS',
        failureMarker: 'PASS',
        managedSigning: 'COMPLETE',
      },
    },
    targetKey,
  );
}
describe('versioned image promotion authority', () => {
  it('admits only current exact shapes and preserves digest-bound warn-only Toolchain findings', () => {
    const candidate = toolchain();
    expect(candidate.scan.criticalHighCount).toBe(3);
    expect(candidateKey(candidate)).toBe(`artifacts/toolchain/candidates/${hash(canonicalRecordJson(candidate))}.json`);
    expect(() => admitImageCandidate({ ...candidate, legacy: true }, targetKey)).toThrow();
    expect(() => admitImageCandidate({ ...candidate, targetKey: 'stark-prod/main' }, targetKey)).toThrow();
    expect(() =>
      admitImageCandidate({ ...candidate, scan: { status: 'PASS', criticalHighCount: 3 } }, targetKey),
    ).toThrow();
  });
  it('stores only candidate reference and promotion checks, and resolves exact historical versions', async () => {
    const state = await withToolchain();
    const original = await state.ledger.selectPromotion('toolchain');
    expect(original.reference).toEqual(state.ref);
    expect(original.promotion).not.toHaveProperty('evidence');
    expect(original.candidate).toEqual(state.candidate);
    const next = { ...promotion(state.candidateRef), sourceSha: 'b'.repeat(40), selectionMode: 'existing' };
    await state.ledger.publishPromotion(next, 'toolchain', {
      etag: original.etag,
      versionId: state.ref.versionId,
      sha256: state.ref.sha256,
    });
    expect((await state.ledger.selectPromotion('toolchain', state.ref.versionId)).promotion.sourceSha).toBe(source);
  });
  it('rejects stale CAS without adopting the newer predecessor and rejects implicit initial publication', async () => {
    const state = await withToolchain();
    await expect(state.ledger.publishPromotion(promotion(state.candidateRef), 'toolchain', null)).rejects.toThrow(
      'conflict',
    );
    await expect(
      state.ledger.publishPromotion(promotion(state.candidateRef), 'toolchain', {
        etag: '"stale"',
        versionId: 'stale',
        sha256: '0'.repeat(64),
      }),
    ).rejects.toThrow('conflict');
  });
  it('rejects missing, noncanonical and mismatched exact candidate bytes', async () => {
    const state = await withToolchain();
    await expect(state.ledger.readCandidate({ ...state.candidateRef, sha256: '0'.repeat(64) })).rejects.toThrow('hash');
    await expect(state.ledger.readCandidate({ ...state.candidateRef, versionId: 'missing' })).rejects.toThrow(
      'missing',
    );
    const key = `${state.candidateRef.key}/${state.candidateRef.versionId}`;
    const retained = state.versions.get(key);
    if (!retained) throw new Error('Expected retained candidate');
    state.versions.set(key, { ...retained, body: ' ' + canonicalRecordJson(state.candidate) });
    await expect(state.ledger.readCandidate(state.candidateRef)).rejects.toThrow();
  });
  it('keeps original Toolchain provenance while accepting same-digest re-promotion and unrelated Foundation changes', async () => {
    const state = await withToolchain(),
      candidate = prover(state.ref);
    const original = await state.ledger.selectPromotion('toolchain');
    await state.ledger.publishPromotion(
      { ...promotion(state.candidateRef), sourceSha: 'b'.repeat(40), selectionMode: 'existing' },
      'toolchain',
      { etag: original.etag, versionId: state.ref.versionId, sha256: state.ref.sha256 },
    );
    const current = await state.ledger.selectPromotion('toolchain');
    expect(current.reference.versionId).not.toBe(state.ref.versionId);
    const ref = await state.ledger.publishCandidate(candidate);
    expect(await state.ledger.readCandidate(ref)).toEqual(candidate);
    expect(() =>
      assertProverImageContract(candidate, {
        toolchainImageUri: current.candidate.imageUri,
        zkvmContractHash: '2'.repeat(64),
        failureMarkerContractSha256: '3'.repeat(64),
      }),
    ).not.toThrow();
    if (candidate.kind !== 'prover') throw new Error('fixture');
    const revalidation = {
      imageUri: candidate.imageUri,
      scan: candidate.scan,
      foundation: {
        ...candidate.evidence.foundation,
        reference: { ...candidate.evidence.foundation.reference, versionId: 'foundation-later' },
      },
      toolchainImageUri: current.candidate.imageUri,
      managedSigning: 'COMPLETE',
    };
    await expect(
      state.ledger.publishPromotion(promotion(ref, 'prover', revalidation), 'prover', null),
    ).resolves.toHaveProperty('versionId');
  });
  it('rejects false original provenance, changed base bytes and changed image contracts', async () => {
    const state = await withToolchain();
    await expect(state.ledger.publishCandidate(prover({ ...state.ref, sha256: '0'.repeat(64) }))).rejects.toThrow(
      'provenance',
    );
    expect(() =>
      assertProverImageContract(prover(state.ref), {
        toolchainImageUri: image('toolchain', 'b'),
        zkvmContractHash: '2'.repeat(64),
        failureMarkerContractSha256: '3'.repeat(64),
      }),
    ).toThrow('dependencies');
  });
  it('blocks Prover failed trust evidence and promotion/candidate detachments', async () => {
    const state = await withToolchain(),
      candidate = prover(state.ref);
    for (const field of ['posture', 'failureMarker', 'managedSigning'])
      expect(() =>
        admitImageCandidate({ ...candidate, evidence: { ...candidate.evidence, [field]: 'FAIL' } }, targetKey),
      ).toThrow();
    expect(() =>
      admitImagePromotion(
        { ...promotion(state.candidateRef), candidate: { ...state.candidateRef, key: 'other.json' } },
        targetKey,
        'toolchain',
      ),
    ).toThrow();
    await expect(
      state.ledger.publishPromotion({ ...promotion(state.candidateRef), sourceSha: 'b'.repeat(40) }, 'toolchain', null),
    ).rejects.toThrow('mismatch');
  });
  it('derives both target current keys and treats absent promotion as a failed selection', async () => {
    expect(promotionKey(targetKey, 'prover')).toBe('promotions/prover/current.json');
    await expect(store().ledger.selectPromotion('prover')).rejects.toThrow('explicit successful build');
  });
});
