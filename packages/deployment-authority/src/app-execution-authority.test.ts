import { describe, expect, it, vi } from 'vitest';

import {
  admitAppExecutionAuthority,
  deriveAppExecutionAuthoritySha256,
  projectNormalAppExecutionAuthority,
  projectRollbackAppExecutionAuthority,
} from './app-execution-authority.js';
import { canonicalJsonSha256, deepFreeze } from './internal.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import { createBoundSelectionFixture } from './testdata/app-acceptance-ledger-fixture.js';
import { createAppReleaseSelectionFixture } from './testdata/app-release-selection-fixture.js';

import { productionConfigurationFixture } from './test-support/deployment-target-fixtures.js';

type Data = Record<string, unknown>;

const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const app = resolveDeploymentLaneAuthority(target, 'app');

function data(value: unknown, label: string): Data {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  return value as Data;
}

function normalVerifier(selection: ReturnType<typeof createAppReleaseSelectionFixture>, selectedApp = app) {
  const prover = selection.prover.releaseRecord;
  return {
    confirmedImageIdMapping: {
      proverReleaseKey: selection.prover.releaseRecordKey,
      proverImageDigest: prover.imageDigest,
      expectedImageId: prover.expectedImageId,
      methodVersion: prover.methodVersion,
      imageIdVariant: prover.imageIdVariant,
      imageIdMappingSha256: '4'.repeat(64),
      zkvmContractHash: prover.zkvmContractHash,
    },
    signaturePreflight: {
      result: 'passed',
      selectedApplicationSourceSha: selection.selectedSourceSha,
      proverReleaseKey: selection.prover.releaseRecordKey,
      proverImageUri: prover.imageUri,
      managedSigningStatus: 'COMPLETE',
      evidence: {
        key: 'signature-preflight/result.json',
        versionId: 'preflight-version',
        sha256: '1'.repeat(64),
      },
      verifierIdentitySha256: '2'.repeat(64),
      verifierPackage: {
        bucket: selectedApp.names.appRetainedArtifactBucket,
        key: `${selectedApp.names.lambdaArtifactPrefix}/${selection.selectedSourceSha}/image-signature-verifier.zip`,
        versionId: 'verifier-package-version',
        sha256: '3'.repeat(64),
        sourceCodeHash: Buffer.from('3'.repeat(64), 'hex').toString('base64'),
        assetManifestSha256: '4'.repeat(64),
        trustRootSha256: '5'.repeat(64),
      },
    },
  } as const;
}

describe('App execution authority', () => {
  it('freezes nested authority even when its containing record was already frozen', () => {
    const source = { sha: 'a'.repeat(40) };
    const authority = Object.freeze({ source });

    deepFreeze(authority);

    expect(() => {
      source.sha = 'changed';
    }).toThrow(TypeError);
    expect(authority.source.sha).toBe('a'.repeat(40));
  });

  it('projects one normal execution from the exact admitted current release selection', () => {
    const releaseSelection = createAppReleaseSelectionFixture();
    const verifier = normalVerifier(releaseSelection);

    const authority = projectNormalAppExecutionAuthority(
      {
        controlSourceSha: releaseSelection.selectedSourceSha,
        selectedApplicationSourceSha: releaseSelection.selectedSourceSha,
        releaseSelection,
        verifier,
      },
      target.targetKey,
    );

    expect(authority).toEqual({
      authorityType: 'app-execution-authority',
      targetKey: 'stark-dev/develop',
      controlSourceSha: releaseSelection.selectedSourceSha,
      selectedApplicationSourceSha: releaseSelection.selectedSourceSha,
      deploymentMode: 'normal',
      selectedAcceptanceKey: null,
      releaseAuthority: {
        foundationAcceptanceKey: releaseSelection.foundation.recordKey,
        foundationContractHash: releaseSelection.foundation.record.foundationContract.foundationContractHash,
        toolchainReleaseKey: releaseSelection.toolchain.releaseRecordKey,
        proverReleaseKey: releaseSelection.prover.releaseRecordKey,
        toolchainImage: {
          imageUri: releaseSelection.toolchain.releaseRecord.imageUri,
          imageDigest: releaseSelection.toolchain.releaseRecord.imageDigest,
        },
        proverImage: {
          imageUri: releaseSelection.prover.releaseRecord.imageUri,
          imageDigest: releaseSelection.prover.releaseRecord.imageDigest,
        },
        zkvm: {
          applicationZkvmContractHash: releaseSelection.prover.releaseRecord.zkvmContractHash,
          proverZkvmContractHash: releaseSelection.prover.releaseRecord.zkvmContractHash,
          zkvmContractHash: releaseSelection.prover.releaseRecord.zkvmContractHash,
          expectedImageId: releaseSelection.prover.releaseRecord.expectedImageId,
          methodVersion: releaseSelection.prover.releaseRecord.methodVersion,
          imageIdVariant: releaseSelection.prover.releaseRecord.imageIdVariant,
          imageIdMappingSha256: verifier.confirmedImageIdMapping.imageIdMappingSha256,
          failureMarkerContractSha256: releaseSelection.prover.releaseRecord.failureMarkerContractSha256,
        },
      },
      verifier,
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.releaseAuthority)).toBe(true);
    expect(deriveAppExecutionAuthoritySha256(authority, target.targetKey)).toBe(canonicalJsonSha256(authority));
  });

  it('projects rollback solely from one retained target acceptance', () => {
    const acceptanceSelection = createBoundSelectionFixture('retained');
    const controlSourceSha = 'b'.repeat(40);

    const authority = projectRollbackAppExecutionAuthority({ controlSourceSha, acceptanceSelection }, target.targetKey);

    expect(authority).toEqual({
      authorityType: 'app-execution-authority',
      targetKey: 'stark-dev/develop',
      controlSourceSha,
      selectedApplicationSourceSha: acceptanceSelection.acceptance.selectedApplicationSourceSha,
      deploymentMode: 'rollback',
      selectedAcceptanceKey: acceptanceSelection.acceptanceKey,
      releaseAuthority: acceptanceSelection.acceptance.releaseAuthority,
      verifier: acceptanceSelection.acceptance.verifier,
    });
    expect(Object.isFrozen(authority.verifier)).toBe(true);
  });

  it('rejects detached mode, source, acceptance key, release, verifier, and hash authority', () => {
    const retained = createBoundSelectionFixture('retained');
    const authority = projectRollbackAppExecutionAuthority(
      {
        controlSourceSha: 'b'.repeat(40),
        acceptanceSelection: retained,
      },
      target.targetKey,
    );

    for (const candidate of [
      { ...authority, deploymentMode: 'normal' },
      { ...authority, selectedApplicationSourceSha: 'c'.repeat(40) },
      { ...authority, selectedAcceptanceKey: null },
      { ...authority, releaseAuthority: { ...authority.releaseAuthority, foundationContractHash: 'invalid' } },
      { ...authority, verifier: { ...authority.verifier, confirmedImageIdMapping: {} } },
      { ...authority, appExecutionAuthoritySha256: deriveAppExecutionAuthoritySha256(authority, target.targetKey) },
    ]) {
      expect(() => admitAppExecutionAuthority(candidate, target.targetKey)).toThrow();
    }
  });

  it('rejects a current acceptance for rollback and never invokes unowned current-reader or descriptor code', () => {
    expect(() =>
      projectRollbackAppExecutionAuthority(
        {
          controlSourceSha: 'b'.repeat(40),
          acceptanceSelection: createBoundSelectionFixture('current'),
        },
        target.targetKey,
      ),
    ).toThrow(/retained/iu);

    const retained = createBoundSelectionFixture('retained');
    const currentFoundationReader = vi.fn(() => {
      throw new Error('must not read current Foundation');
    });
    const currentReleaseReader = vi.fn(() => {
      throw new Error('must not read current release pointers');
    });
    const extended = {
      controlSourceSha: 'b'.repeat(40),
      acceptanceSelection: retained,
    };
    Object.defineProperties(extended, {
      currentFoundationReader: { enumerable: true, get: currentFoundationReader },
      currentReleaseReader: { enumerable: true, get: currentReleaseReader },
    });
    expect(() => projectRollbackAppExecutionAuthority(extended, target.targetKey)).toThrow(/exact|shape|data/iu);
    expect(currentFoundationReader).not.toHaveBeenCalled();
    expect(currentReleaseReader).not.toHaveBeenCalled();

    let trapCount = 0;
    const proxy = new Proxy(data(retained, 'retained selection'), {
      ownKeys() {
        trapCount += 1;
        return [];
      },
    });
    expect(() =>
      projectRollbackAppExecutionAuthority(
        { controlSourceSha: 'b'.repeat(40), acceptanceSelection: proxy },
        target.targetKey,
      ),
    ).toThrow(/proxy/iu);
    expect(trapCount).toBe(0);
  });
});

it('binds production execution to its selected release chain and rejects omitted or mixed targets', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const configured = await import('./index.js');
    const authority = await import('./app-execution-authority.js');
    const fixtures = await import('./testdata/app-release-selection-fixture.js');
    const production = configured.resolveAllowedDeploymentTarget('stark-prod/main');
    const releaseSelection = fixtures.createAppReleaseSelectionFixture(production.targetKey);
    const verifier = normalVerifier(releaseSelection, configured.resolveDeploymentLaneAuthority(production, 'app'));
    const input = {
      controlSourceSha: releaseSelection.selectedSourceSha,
      selectedApplicationSourceSha: releaseSelection.selectedSourceSha,
      releaseSelection,
      verifier,
    };
    const result = authority.projectNormalAppExecutionAuthority(input, production.targetKey);
    expect(result.targetKey).toBe(production.targetKey);
    expect(result.releaseAuthority.proverReleaseKey).toBe(releaseSelection.prover.releaseRecordKey);
    expect(authority.admitAppExecutionAuthority(result, production.targetKey)).toEqual(result);
    expect(authority.deriveAppExecutionAuthoritySha256(result, production.targetKey)).toBe(canonicalJsonSha256(result));
    for (const wrongTarget of [undefined, 'unreviewed/main', 'stark-dev/develop']) {
      expect(() => authority.projectNormalAppExecutionAuthority(input, wrongTarget)).toThrow();
      expect(() => authority.admitAppExecutionAuthority(result, wrongTarget)).toThrow();
      expect(() => authority.deriveAppExecutionAuthoritySha256(result, wrongTarget)).toThrow();
    }
    for (const change of [
      { releaseSelection: fixtures.createAppReleaseSelectionFixture('stark-dev/develop') },
      { verifier: normalVerifier(releaseSelection) },
      { selectedApplicationSourceSha: 'e'.repeat(40) },
    ]) {
      expect(() =>
        authority.projectNormalAppExecutionAuthority({ ...input, ...change }, production.targetKey),
      ).toThrow();
    }
    const rollbackInput = {
      acceptanceSelection: createBoundSelectionFixture('retained'),
      controlSourceSha: 'e'.repeat(40),
    };
    for (const wrongTarget of [undefined, 'unreviewed/main', production.targetKey]) {
      expect(() => authority.projectRollbackAppExecutionAuthority(rollbackInput, wrongTarget)).toThrow();
    }
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
