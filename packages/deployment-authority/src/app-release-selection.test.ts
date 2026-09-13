import { describe, expect, it, vi } from 'vitest';

import {
  admitAppProverFoundationAcceptanceBinding,
  admitAppReleaseSelection,
  projectAppReleaseLedgerSelection,
} from './app-release-selection.js';
import {
  PROVER_CANDIDATE_KIND,
  PROVER_RELEASE_KIND,
  TOOLCHAIN_CANDIDATE_KIND,
  TOOLCHAIN_RELEASE_KIND,
  deriveReleaseRecordKey,
} from './release-ledger.js';
import {
  createAppReleaseSelectionFixture,
  deriveSelectedReleaseFacts,
} from './testdata/app-release-selection-fixture.js';

import { productionConfigurationFixture } from './test-support/deployment-target-fixtures.js';

type Data = Record<string, unknown>;

function data(value: unknown, label: string): Data {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  return value as Data;
}

function mutableFixture(): Data {
  return structuredClone(createAppReleaseSelectionFixture());
}

function currentFoundationBinding(fixture = createAppReleaseSelectionFixture()) {
  return {
    foundationAcceptanceKey: fixture.foundation.recordKey,
    foundationAcceptedSourceSha: fixture.foundation.consumerAuthority.foundationAcceptedSourceSha,
    closureIdentity: fixture.foundation.record.foundationContract.closureIdentity,
    foundationContractHash: fixture.foundation.record.foundationContract.foundationContractHash,
  } as const;
}

function rekeyRelease(
  selection: Data,
  candidateKind: typeof TOOLCHAIN_CANDIDATE_KIND | typeof PROVER_CANDIDATE_KIND,
  releaseKind: typeof TOOLCHAIN_RELEASE_KIND | typeof PROVER_RELEASE_KIND,
): void {
  const candidateRecord = data(selection['candidateRecord'], 'candidate record');
  const candidateRecordKey = deriveReleaseRecordKey(candidateKind, candidateRecord, 'stark-dev/develop');
  selection['candidateRecordKey'] = candidateRecordKey;
  const releaseRecord = data(selection['releaseRecord'], 'release record');
  releaseRecord['selectedCandidateKey'] = candidateRecordKey;
  const releaseRecordKey = deriveReleaseRecordKey(releaseKind, releaseRecord, 'stark-dev/develop');
  selection['releaseRecordKey'] = releaseRecordKey;
  data(selection['pointer'], 'release pointer')['recordKey'] = releaseRecordKey;
}

describe('App release selection admission', () => {
  it('projects exact typed selector output into the aggregate release shape', () => {
    const fixture = createAppReleaseSelectionFixture();

    expect(
      projectAppReleaseLedgerSelection(
        { selectionType: 'app-toolchain-ledger-selection', ...fixture.toolchain },
        'toolchain',
      ),
    ).toEqual(fixture.toolchain);
    expect(
      projectAppReleaseLedgerSelection({ selectionType: 'app-prover-ledger-selection', ...fixture.prover }, 'prover'),
    ).toEqual(fixture.prover);
  });

  it('rejects mistyped, extended, and proxied selector output before projection', () => {
    const fixture = createAppReleaseSelectionFixture();
    expect(() =>
      projectAppReleaseLedgerSelection(
        { selectionType: 'app-prover-ledger-selection', ...fixture.toolchain },
        'toolchain',
      ),
    ).toThrow(/type/iu);
    expect(() =>
      projectAppReleaseLedgerSelection(
        { selectionType: 'app-toolchain-ledger-selection', ...fixture.toolchain, extra: true },
        'toolchain',
      ),
    ).toThrow(/exact enumerable data shape/iu);

    let traps = 0;
    const proxied = new Proxy(
      { selectionType: 'app-toolchain-ledger-selection', ...fixture.toolchain },
      {
        ownKeys(target) {
          traps += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    expect(() => projectAppReleaseLedgerSelection(proxied, 'toolchain')).toThrow(/proxy/iu);
    expect(traps).toBe(0);
  });

  it('exact-admits the selected Prover candidate and release against carried current Foundation authority', () => {
    const fixture = createAppReleaseSelectionFixture();

    expect(
      admitAppProverFoundationAcceptanceBinding(
        {
          foundationAcceptance: currentFoundationBinding(fixture),
          prover: fixture.prover,
        },
        'stark-dev/develop',
      ),
    ).toEqual(fixture.prover);
  });

  it('rejects a Prover candidate whose Foundation closure differs before it can become App authority', () => {
    const fixture = mutableFixture();
    const prover = data(fixture['prover'], 'Prover selection');
    const candidate = data(prover['candidateRecord'], 'Prover candidate');
    const release = data(prover['releaseRecord'], 'Prover release');
    data(candidate['foundationAcceptance'], 'Prover candidate Foundation acceptance')['foundationContractHash'] =
      'e'.repeat(64);
    data(release['foundationAcceptance'], 'Prover release Foundation acceptance')['foundationContractHash'] =
      'e'.repeat(64);
    data(release['promotionFoundationAcceptance'], 'Prover promotion Foundation acceptance')['foundationContractHash'] =
      'e'.repeat(64);
    rekeyRelease(prover, PROVER_CANDIDATE_KIND, PROVER_RELEASE_KIND);

    expect(() =>
      admitAppProverFoundationAcceptanceBinding(
        {
          foundationAcceptance: currentFoundationBinding(),
          prover,
        },
        'stark-dev/develop',
      ),
    ).toThrow('App Prover Foundation exact current acceptance is detached.');
  });

  it('rejects a Prover promotion that does not repeat the exact current Foundation tuple', () => {
    const fixture = mutableFixture();
    const prover = data(fixture['prover'], 'Prover selection');
    const release = data(prover['releaseRecord'], 'Prover release');
    release['selectionMode'] = 'existing';
    release['candidateSelectionApprovalEvidenceId'] =
      `prover-candidate-selection/${String(release['promotionExecutionId'])}`;
    data(release['promotionFoundationAcceptance'], 'Prover promotion Foundation acceptance')['recordKey'] =
      `accepted-baselines/stark-dev/develop/foundation/acceptances/${'f'.repeat(64)}.json`;
    rekeyRelease(prover, PROVER_CANDIDATE_KIND, PROVER_RELEASE_KIND);

    expect(() =>
      admitAppProverFoundationAcceptanceBinding(
        {
          foundationAcceptance: currentFoundationBinding(),
          prover,
        },
        'stark-dev/develop',
      ),
    ).toThrow('App Prover Foundation exact current acceptance is detached.');
  });

  it('binds current Foundation, Toolchain, and Prover observations into preflight authority', () => {
    const fixture = createAppReleaseSelectionFixture();
    const admitted = admitAppReleaseSelection(fixture, 'stark-dev/develop');

    expect(admitted).toEqual({
      selectedSourceSha: fixture.selectedSourceSha,
      foundation: fixture.foundation,
      toolchain: fixture.toolchain,
      prover: fixture.prover,
      selectedReleaseAuthority: {
        ...deriveSelectedReleaseFacts(fixture),
        zkvmContractHash: fixture.prover.releaseRecord.zkvmContractHash,
      },
    });
    expect(admitted).not.toBe(fixture);
    expect(admitted.foundation).not.toBe(fixture.foundation);
    expect(admitted.toolchain.candidateRecordObservation).toEqual(fixture.toolchain.candidateRecordObservation);
    expect(admitted.prover.candidateRecordObservation).toEqual(fixture.prover.candidateRecordObservation);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.selectedReleaseAuthority)).toBe(true);
  });

  it('rejects a selected source detached from the Foundation consumer authority', () => {
    const fixture = mutableFixture();
    fixture['selectedSourceSha'] = 'e'.repeat(40);

    expect(() => admitAppReleaseSelection(fixture, 'stark-dev/develop')).toThrow(
      /selected source.*Foundation consumer authority/iu,
    );
  });

  it.each(['root', 'nested'] as const)('rejects a %s proxy without invoking its traps', (placement) => {
    let trapCalls = 0;
    const trap = (): never => {
      trapCalls += 1;
      throw new Error('proxy trap must not run');
    };
    const fixture = mutableFixture();
    const target = placement === 'root' ? fixture : data(fixture['foundation'], 'Foundation selection');
    const proxied = new Proxy(target, {
      get: trap,
      getOwnPropertyDescriptor: trap,
      ownKeys: trap,
    });
    const input = placement === 'root' ? proxied : fixture;
    if (placement === 'nested') fixture['foundation'] = proxied;

    expect(() => admitAppReleaseSelection(input, 'stark-dev/develop')).toThrow(/proxy/iu);
    expect(trapCalls).toBe(0);
  });

  it.each(['root', 'nested'] as const)('rejects a %s accessor without invoking it', (placement) => {
    let accessorCalls = 0;
    const fixture = mutableFixture();
    const target =
      placement === 'root'
        ? fixture
        : data(data(fixture['foundation'], 'Foundation selection')['recordObservation'], 'record observation');
    const key = placement === 'root' ? 'selectedSourceSha' : 'versionId';
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error('accessor must not run');
      },
    });

    expect(() => admitAppReleaseSelection(fixture, 'stark-dev/develop')).toThrow(/data|shape|accessor/iu);
    expect(accessorCalls).toBe(0);
  });

  it.each(['array', 'object'] as const)('rejects an over-bound %s before inspecting nested proxies', (collection) => {
    let trapCalls = 0;
    const nestedProxy = new Proxy(
      {},
      {
        ownKeys() {
          trapCalls += 1;
          throw new Error('nested proxy trap must not run');
        },
      },
    );
    const fixture = mutableFixture();
    fixture['overBound'] =
      collection === 'array'
        ? Array.from({ length: 10_001 }, () => nestedProxy)
        : Object.fromEntries(Array.from({ length: 10_001 }, (_entry, index) => [`entry${String(index)}`, nestedProxy]));

    expect(() => admitAppReleaseSelection(fixture, 'stark-dev/develop')).toThrow(/over-bound collection/iu);
    expect(trapCalls).toBe(0);
  });

  it('rejects byte views before enumerating their indexed properties', () => {
    const fixture = mutableFixture();
    const bytes = new Uint8Array(10_001);
    fixture['overBound'] = bytes;
    const ownKeys = vi.spyOn(Reflect, 'ownKeys');
    try {
      expect(() => admitAppReleaseSelection(fixture, 'stark-dev/develop')).toThrow();
      expect(ownKeys.mock.calls.some(([value]) => value === bytes)).toBe(false);
    } finally {
      ownKeys.mockRestore();
    }
  });

  it('counts primitive values toward the inspection bound', () => {
    const fixture = mutableFixture();
    fixture['overBound'] = Array.from({ length: 11 }, () => Array.from({ length: 10_000 }, () => 0));

    expect(() => admitAppReleaseSelection(fixture, 'stark-dev/develop')).toThrow(/inspection bound/iu);
  });

  it('bounds primitive bytes before descriptor capture', () => {
    const fixture = mutableFixture();
    fixture['overBound'] = 'x'.repeat(64 * 1024 * 1024 + 1);

    expect(() => admitAppReleaseSelection(fixture, 'stark-dev/develop')).toThrow(/inspection bound/iu);
  });

  it('rejects extended selections and malformed object observations', () => {
    const extended = mutableFixture();
    extended['note'] = 'not authority';
    expect(() => admitAppReleaseSelection(extended, 'stark-dev/develop')).toThrow(/exact enumerable data shape/iu);

    const malformed = mutableFixture();
    const foundation = data(malformed['foundation'], 'Foundation selection');
    data(foundation['recordObservation'], 'Foundation record observation')['versionId'] = 'null';
    expect(() => admitAppReleaseSelection(malformed, 'stark-dev/develop')).toThrow(/VersionId/iu);

    const extendedObservation = mutableFixture();
    const prover = data(extendedObservation['prover'], 'Prover selection');
    data(prover['candidateRecordObservation'], 'Prover candidate observation')['note'] = 'not authority';
    expect(() => admitAppReleaseSelection(extendedObservation, 'stark-dev/develop')).toThrow(
      /exact enumerable data shape/iu,
    );
  });

  it.each([
    [
      'Foundation current pointer',
      (fixture: Data) => {
        const foundation = data(fixture['foundation'], 'Foundation selection');
        data(foundation['pointer'], 'Foundation pointer')['recordKey'] =
          `accepted-baselines/stark-dev/develop/foundation/acceptances/${'f'.repeat(64)}.json`;
      },
    ],
    [
      'Foundation acceptance body',
      (fixture: Data) => {
        const foundation = data(fixture['foundation'], 'Foundation selection');
        data(foundation['record'], 'Foundation record')['acceptedAt'] = '2026-08-14T01:05:05.000Z';
      },
    ],
    [
      'Foundation consumer contract',
      (fixture: Data) => {
        const foundation = data(fixture['foundation'], 'Foundation selection');
        data(foundation['consumerAuthority'], 'Foundation consumer authority')['foundationContractHash'] = 'f'.repeat(
          64,
        );
      },
    ],
    [
      'Toolchain pointer promotion',
      (fixture: Data) => {
        const toolchain = data(fixture['toolchain'], 'Toolchain selection');
        const pointer = data(toolchain['pointer'], 'Toolchain pointer');
        pointer['promotionExecutionId'] = '99999999-8888-7777-6666-555555555555';
        pointer['compareAndSwapEvidenceId'] = 'cas/toolchain/99999999-8888-7777-6666-555555555555';
      },
    ],
  ] as const)('rejects a detached %s', (_label, mutate) => {
    const fixture = mutableFixture();
    mutate(fixture);
    expect(() => admitAppReleaseSelection(fixture, 'stark-dev/develop')).toThrow(/detached|content-addressed/iu);
  });

  it('rejects a release whose copied fields differ from its selected candidate', () => {
    const fixture = mutableFixture();
    const toolchain = data(fixture['toolchain'], 'Toolchain selection');
    data(toolchain['candidateRecord'], 'Toolchain candidate')['candidateMetadataSha256'] = 'e'.repeat(64);
    rekeyRelease(toolchain, TOOLCHAIN_CANDIDATE_KIND, TOOLCHAIN_RELEASE_KIND);

    expect(() => admitAppReleaseSelection(fixture, 'stark-dev/develop')).toThrow(
      /candidateMetadataSha256.*candidate/iu,
    );
  });

  it('rejects a Prover release whose copied Foundation acceptance differs from its candidate', () => {
    const fixture = mutableFixture();
    const prover = data(fixture['prover'], 'Prover selection');
    const candidate = data(prover['candidateRecord'], 'Prover candidate');
    data(candidate['foundationAcceptance'], 'Prover candidate Foundation acceptance')['foundationContractHash'] =
      'e'.repeat(64);
    rekeyRelease(prover, PROVER_CANDIDATE_KIND, PROVER_RELEASE_KIND);

    expect(() => admitAppReleaseSelection(fixture, 'stark-dev/develop')).toThrow(/foundationAcceptance.*candidate/iu);
  });

  it('rejects a Prover promotion detached from the exact current Foundation acceptance', () => {
    const fixture = mutableFixture();
    const prover = data(fixture['prover'], 'Prover selection');
    const candidate = data(prover['candidateRecord'], 'Prover candidate');
    const release = data(prover['releaseRecord'], 'Prover release');
    const detachedRecordKey = `accepted-baselines/stark-dev/develop/foundation/acceptances/${'f'.repeat(64)}.json`;
    data(candidate['foundationAcceptance'], 'Prover candidate Foundation acceptance')['recordKey'] = detachedRecordKey;
    data(release['foundationAcceptance'], 'Prover release candidate Foundation acceptance')['recordKey'] =
      detachedRecordKey;
    data(release['promotionFoundationAcceptance'], 'Prover promotion Foundation acceptance')['recordKey'] =
      detachedRecordKey;
    rekeyRelease(prover, PROVER_CANDIDATE_KIND, PROVER_RELEASE_KIND);

    expect(() => admitAppReleaseSelection(fixture, 'stark-dev/develop')).toThrow(
      /Prover.*Foundation.*current acceptance.*detached/iu,
    );
  });

  it('rejects a Prover selection detached from the admitted Toolchain release', () => {
    const fixture = mutableFixture();
    const prover = data(fixture['prover'], 'Prover selection');
    const candidate = data(prover['candidateRecord'], 'Prover candidate');
    const release = data(prover['releaseRecord'], 'Prover release');
    const detachedToolchainKey = `artifacts/toolchain/releases/${'f'.repeat(64)}.json`;
    candidate['selectedToolchainReleaseKey'] = detachedToolchainKey;
    release['selectedToolchainReleaseKey'] = detachedToolchainKey;
    rekeyRelease(prover, PROVER_CANDIDATE_KIND, PROVER_RELEASE_KIND);

    expect(() => admitAppReleaseSelection(fixture, 'stark-dev/develop')).toThrow(/Prover.*Toolchain.*detached/iu);
  });
});

it('requires the caller target before admitting an App release chain', () => {
  const fixture = createAppReleaseSelectionFixture();
  for (const targetKey of [undefined, 'unreviewed/main']) {
    expect(() => admitAppReleaseSelection(fixture, targetKey)).toThrow();
    expect(() =>
      admitAppProverFoundationAcceptanceBinding(
        {
          foundationAcceptance: currentFoundationBinding(fixture),
          prover: fixture.prover,
        },
        targetKey,
      ),
    ).toThrow();
  }
});

it('binds the complete production release chain and preserves the exact current Foundation requirement', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const authority = await import('./app-release-selection.js');
    const releases = await import('./release-ledger.js');
    const fixtures = await import('./testdata/app-release-selection-fixture.js');
    const fixture = fixtures.createAppReleaseSelectionFixture('stark-prod/main');
    const development = fixtures.createAppReleaseSelectionFixture('stark-dev/develop');
    const result = authority.admitAppReleaseSelection(fixture, 'stark-prod/main');
    expect(result).toEqual({
      ...fixture,
      selectedReleaseAuthority: {
        ...fixtures.deriveSelectedReleaseFacts(fixture),
        zkvmContractHash: fixture.prover.releaseRecord.zkvmContractHash,
      },
    });
    expect(Object.isFrozen(result.prover.candidateRecord)).toBe(true);
    expect(
      authority.admitAppProverFoundationAcceptanceBinding(
        {
          foundationAcceptance: currentFoundationBinding(fixture),
          prover: fixture.prover,
        },
        'stark-prod/main',
      ),
    ).toEqual(fixture.prover);
    expect(() => authority.admitAppReleaseSelection(fixture, 'stark-dev/develop')).toThrow();
    expect(() => authority.admitAppReleaseSelection(development, 'stark-prod/main')).toThrow();
    for (const family of ['foundation', 'toolchain', 'prover'] as const) {
      expect(() =>
        authority.admitAppReleaseSelection({ ...fixture, [family]: development[family] }, 'stark-prod/main'),
      ).toThrow();
      for (const member of Object.keys(fixture[family])) {
        if (member.endsWith('Observation')) continue;
        expect(() =>
          authority.admitAppReleaseSelection(
            {
              ...fixture,
              [family]: { ...fixture[family], [member]: data(development[family], family)[member] },
            },
            'stark-prod/main',
          ),
        ).toThrow();
      }
    }
    expect(() =>
      authority.admitAppProverFoundationAcceptanceBinding(
        {
          foundationAcceptance: currentFoundationBinding(development),
          prover: fixture.prover,
        },
        'stark-prod/main',
      ),
    ).toThrow();
    expect(() =>
      authority.admitAppProverFoundationAcceptanceBinding(
        {
          foundationAcceptance: currentFoundationBinding(fixture),
          prover: development.prover,
        },
        'stark-prod/main',
      ),
    ).toThrow();
    expect(() =>
      authority.admitAppReleaseSelection({ ...fixture, selectedSourceSha: 'e'.repeat(40) }, 'stark-prod/main'),
    ).toThrow('selected source');

    // Each mutated release remains internally valid and content-addressed;
    // aggregate admission must still reject a detached current Foundation.
    for (const field of ['recordKey', 'foundationContractHash', 'acceptedSourceSha'] as const) {
      const modified = structuredClone(fixture);
      const oldBinding = modified.prover.releaseRecord.promotionFoundationAcceptance;
      const replacement =
        field === 'recordKey'
          ? oldBinding.recordKey.replace(/[^/]+\.json$/u, `${'e'.repeat(64)}.json`)
          : 'e'.repeat(field === 'acceptedSourceSha' ? 40 : 64);
      const releaseRecord = {
        ...modified.prover.releaseRecord,
        selectionMode: 'existing',
        candidateSelectionApprovalEvidenceId: `prover-candidate-selection/${modified.prover.releaseRecord.promotionExecutionId}`,
        promotionFoundationAcceptance: { ...oldBinding, [field]: replacement },
      };
      const releaseRecordKey = releases.deriveReleaseRecordKey(PROVER_RELEASE_KIND, releaseRecord, 'stark-prod/main');
      const prover = {
        ...modified.prover,
        releaseRecord,
        releaseRecordKey,
        pointer: { ...modified.prover.pointer, recordKey: releaseRecordKey },
      };
      expect(() =>
        authority.admitAppProverFoundationAcceptanceBinding(
          {
            foundationAcceptance: currentFoundationBinding(fixture),
            prover,
          },
          'stark-prod/main',
        ),
      ).toThrow('exact current acceptance is detached');
      expect(() => authority.admitAppReleaseSelection({ ...fixture, prover }, 'stark-prod/main')).toThrow(
        'exact current acceptance is detached',
      );
    }
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
