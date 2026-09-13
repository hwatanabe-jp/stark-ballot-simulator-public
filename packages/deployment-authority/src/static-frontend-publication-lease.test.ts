import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { canonicalRecordJson } from './internal.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import {
  createStaticFrontendPublicationLease,
  withStaticFrontendPublicationLease,
} from './static-frontend-publication-lease.js';

const FULL_PROJECT = 'stark-ballot-simulator-pipeline-stark-dev-develop-app-static-deploy';
const FAST_PROJECT = 'stark-ballot-simulator-pipeline-stark-dev-develop-app-static-fast-deploy';
const DEVELOPMENT = resolveAllowedDeploymentTarget('stark-dev/develop');
const PRODUCTION = resolveAllowedDeploymentTarget('stark-prod/main');
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function names(target: typeof DEVELOPMENT | typeof PRODUCTION) {
  return resolveDeploymentLaneAuthority(target, 'app').names;
}

type Coordinates = Readonly<{ etag: string; sha256: string; versionId: string }>;
type Stored = Coordinates & Readonly<{ body: string }>;

function sha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function body(projectName: string, uuid: string): string {
  return canonicalRecordJson({
    buildId: `${projectName}:${uuid}`,
    leaseType: 'static-frontend-publication-lease',
    projectName,
  });
}

function build(
  projectName: string,
  uuid: string,
  buildStatus: string,
  buildComplete: boolean,
  selectedTarget: typeof DEVELOPMENT | typeof PRODUCTION = DEVELOPMENT,
) {
  const buildId = `${projectName}:${uuid}`;
  return {
    arn: `arn:${selectedTarget.partition}:codebuild:${selectedTarget.region}:${selectedTarget.accountId}:build/${buildId}`,
    buildComplete,
    buildId,
    buildStatus,
    projectName,
  };
}

function createTransport(
  options: {
    readonly initial?: Stored;
    readonly incumbentBuild?: ReturnType<typeof build>;
    readonly replaceBeforeCas?: Stored;
  } = {},
) {
  let current = options.initial;
  let version = 0;
  let replacedBeforeCas = false;
  const calls: Array<Readonly<{ input: Record<string, unknown>; operation: string }>> = [];

  const transport = {
    deleteObject: vi.fn((input: Record<string, unknown>) => {
      calls.push({ input, operation: 'delete' });
      const condition = input['condition'] as { etag?: string; type?: string };
      if (current === undefined || condition.type !== 'if-match' || condition.etag !== current.etag) {
        return { status: 'precondition-failed' };
      }
      current = undefined;
      version += 1;
      return { deleteMarker: true, status: 'deleted', versionId: `delete-${version}` };
    }),
    getBuild: vi.fn((input: Record<string, unknown>) => {
      calls.push({ input, operation: 'build' });
      if (options.incumbentBuild === undefined || input['buildId'] !== options.incumbentBuild.buildId) {
        throw new Error('Unexpected build observation.');
      }
      return options.incumbentBuild;
    }),
    getObject: vi.fn((input: Record<string, unknown>) => {
      calls.push({ input, operation: 'get' });
      return current;
    }),
    putObject: vi.fn((input: Record<string, unknown>) => {
      calls.push({ input, operation: 'put' });
      const condition = input['condition'] as { etag?: string; type?: string };
      if (condition.type === 'if-none-match' && current !== undefined) {
        return { status: 'precondition-failed' };
      }
      if (condition.type === 'if-match' && options.replaceBeforeCas !== undefined && !replacedBeforeCas) {
        current = options.replaceBeforeCas;
        replacedBeforeCas = true;
      }
      if (condition.type === 'if-match' && (current === undefined || condition.etag !== current.etag)) {
        return { status: 'precondition-failed' };
      }
      const proposedBody = String(input['body']);
      expect(input['checksumSha256']).toBe(sha256(proposedBody));
      version += 1;
      current = {
        body: proposedBody,
        etag: `"etag-${version}"`,
        sha256: sha256(proposedBody),
        versionId: `version-${version}`,
      };
      return {
        etag: current.etag,
        sha256: current.sha256,
        status: 'written',
        versionId: current.versionId,
      };
    }),
  };

  return {
    calls,
    current: () => current,
    replaceCurrent: (replacement: Stored | undefined) => {
      current = replacement;
    },
    transport,
  };
}

function leaseInput(
  projectName: string,
  uuid: string,
  transport: ReturnType<typeof createTransport>['transport'],
  selectedTarget: typeof DEVELOPMENT | typeof PRODUCTION = DEVELOPMENT,
) {
  return {
    currentBuild: { buildId: `${projectName}:${uuid}`, projectName },
    key: names(selectedTarget).staticFrontendArtifactPrefix,
    target: { accountId: selectedTarget.accountId, partition: selectedTarget.partition, region: selectedTarget.region },
    transport,
  };
}

function lease(
  projectName: string,
  uuid: string,
  transport: ReturnType<typeof createTransport>['transport'],
  selectedTarget: typeof DEVELOPMENT | typeof PRODUCTION = DEVELOPMENT,
) {
  return createStaticFrontendPublicationLease(
    leaseInput(projectName, uuid, transport, selectedTarget),
    selectedTarget.targetKey,
  );
}

describe('static frontend publication lease', () => {
  it.each([DEVELOPMENT, PRODUCTION])(
    'creates, exact-rereads, and releases the first $targetKey lease',
    async (target) => {
      const project = names(target).appStaticDeployProject;
      const key = names(target).staticFrontendArtifactPrefix;
      const model = createTransport();
      const current = lease(project, UUID_A, model.transport, target);

      await current.acquire();
      expect(model.calls.map(({ operation }) => operation)).toEqual(['put', 'get']);
      expect(model.calls[0]?.input).toMatchObject({
        body: body(project, UUID_A),
        checksumSha256: sha256(body(project, UUID_A)),
        condition: { type: 'if-none-match' },
        key,
      });
      expect(model.transport.getBuild).not.toHaveBeenCalled();

      await current.release();
      expect(model.calls.map(({ operation }) => operation)).toEqual(['put', 'get', 'get', 'delete']);
      expect(model.calls.at(-1)?.input).toMatchObject({
        condition: { etag: '"etag-1"', type: 'if-match', versionId: 'version-1' },
        key,
      });
      expect(model.current()).toBeUndefined();
    },
  );

  it.each(['IN_PROGRESS', 'FAILED'])(
    'uses exact same-project main build evidence for %s incumbents',
    async (status) => {
      const project = names(PRODUCTION).appStaticDeployProject;
      const incumbentBody = body(project, UUID_A);
      const model = createTransport({
        incumbentBuild: build(project, UUID_A, status, status === 'FAILED', PRODUCTION),
        initial: {
          body: incumbentBody,
          etag: '"incumbent"',
          sha256: sha256(incumbentBody),
          versionId: 'incumbent-version',
        },
      });
      const current = lease(project, UUID_B, model.transport, PRODUCTION);
      if (status === 'IN_PROGRESS') {
        await expect(current.acquire()).rejects.toThrow(/active/u);
        expect(model.calls.filter(({ operation }) => operation === 'put')).toHaveLength(1);
      } else {
        await current.acquire();
        expect(model.calls[3]?.input).toMatchObject({
          condition: { etag: '"incumbent"', type: 'if-match', versionId: 'incumbent-version' },
        });
        await current.release();
        expect(model.current()).toBeUndefined();
      }
    },
  );

  it.each([DEVELOPMENT, PRODUCTION])('rejects another target or unregistered publisher for $targetKey', (target) => {
    const model = createTransport();
    const other = target.targetKey === DEVELOPMENT.targetKey ? PRODUCTION : DEVELOPMENT;
    for (const project of [names(other).appStaticDeployProject, 'unregistered-static-publisher']) {
      expect(() => lease(project, UUID_A, model.transport, target)).toThrow(/governed static publishers/u);
    }
    expect(model.calls).toEqual([]);
  });

  it('rejects a static-fast incumbent in main before querying its build', async () => {
    const incumbentBody = body(FAST_PROJECT, UUID_A);
    const model = createTransport({
      initial: {
        body: incumbentBody,
        etag: '"incumbent"',
        sha256: sha256(incumbentBody),
        versionId: 'incumbent-version',
      },
    });
    await expect(
      lease(names(PRODUCTION).appStaticDeployProject, UUID_B, model.transport, PRODUCTION).acquire(),
    ).rejects.toThrow(/governed static publishers/u);
    expect(model.transport.getBuild).not.toHaveBeenCalled();
    expect(model.calls.filter(({ operation }) => operation === 'put')).toHaveLength(1);
  });

  it('blocks behind an active exact governed build without using object time metadata', async () => {
    const incumbentBody = body(FULL_PROJECT, UUID_A);
    const model = createTransport({
      incumbentBuild: build(FULL_PROJECT, UUID_A, 'IN_PROGRESS', false),
      initial: {
        body: incumbentBody,
        etag: '"incumbent"',
        sha256: sha256(incumbentBody),
        versionId: 'incumbent-version',
      },
    });

    await expect(lease(FAST_PROJECT, UUID_B, model.transport).acquire()).rejects.toThrow(/active/u);
    expect(model.calls.map(({ operation }) => operation)).toEqual(['put', 'get', 'build']);
    expect(model.calls.filter(({ operation }) => operation === 'put')).toHaveLength(1);
    expect(model.calls.some(({ input }) => Object.hasOwn(input, 'lastModified'))).toBe(false);
  });

  it.each(['FAILED', 'FAULT', 'STOPPED', 'SUCCEEDED', 'TIMED_OUT'])(
    'takes over only a complete terminal %s build with exact CAS coordinates',
    async (status) => {
      const incumbentBody = body(FULL_PROJECT, UUID_A);
      const model = createTransport({
        incumbentBuild: build(FULL_PROJECT, UUID_A, status, true),
        initial: {
          body: incumbentBody,
          etag: '"incumbent"',
          sha256: sha256(incumbentBody),
          versionId: 'incumbent-version',
        },
      });

      await lease(FAST_PROJECT, UUID_B, model.transport).acquire();
      expect(model.calls.map(({ operation }) => operation)).toEqual(['put', 'get', 'build', 'put', 'get']);
      expect(model.calls[3]?.input).toMatchObject({
        condition: { etag: '"incumbent"', type: 'if-match', versionId: 'incumbent-version' },
      });
      expect(model.current()?.body).toBe(body(FAST_PROJECT, UUID_B));
    },
  );

  it.each([
    ['IN_PROGRESS', true],
    ['FAILED', false],
    ['UNKNOWN', true],
  ])('rejects inconsistent or unknown build state %s/%s without takeover', async (status, complete) => {
    const incumbentBody = body(FULL_PROJECT, UUID_A);
    const model = createTransport({
      incumbentBuild: build(FULL_PROJECT, UUID_A, status, complete),
      initial: {
        body: incumbentBody,
        etag: '"incumbent"',
        sha256: sha256(incumbentBody),
        versionId: 'incumbent-version',
      },
    });

    await expect(lease(FAST_PROJECT, UUID_B, model.transport).acquire()).rejects.toThrow();
    expect(model.calls.filter(({ operation }) => operation === 'put')).toHaveLength(1);
  });

  it('rejects malformed or checksum-detached incumbent bytes before querying CodeBuild', async () => {
    const incumbentBody = body(FULL_PROJECT, UUID_A);
    const model = createTransport({
      incumbentBuild: build(FULL_PROJECT, UUID_A, 'FAILED', true),
      initial: {
        body: incumbentBody,
        etag: '"incumbent"',
        sha256: '0'.repeat(64),
        versionId: 'incumbent-version',
      },
    });

    await expect(lease(FAST_PROJECT, UUID_B, model.transport).acquire()).rejects.toThrow(/SHA-256/u);
    expect(model.transport.getBuild).not.toHaveBeenCalled();
  });

  it('reobserves a lost terminal-holder CAS and never reports false ownership', async () => {
    const incumbentBody = body(FULL_PROJECT, UUID_A);
    const winnerBody = body(FAST_PROJECT, '33333333-3333-4333-8333-333333333333');
    const model = createTransport({
      incumbentBuild: build(FULL_PROJECT, UUID_A, 'FAILED', true),
      initial: {
        body: incumbentBody,
        etag: '"incumbent"',
        sha256: sha256(incumbentBody),
        versionId: 'incumbent-version',
      },
      replaceBeforeCas: {
        body: winnerBody,
        etag: '"winner"',
        sha256: sha256(winnerBody),
        versionId: 'winner-version',
      },
    });

    await expect(lease(FAST_PROJECT, UUID_B, model.transport).acquire()).rejects.toThrow();
    expect(model.current()?.body).toBe(winnerBody);
    expect(model.calls.some(({ operation }) => operation === 'delete')).toBe(false);
  });

  it('fences a former holder from assertion and release after takeover', async () => {
    const model = createTransport();
    const former = lease(FULL_PROJECT, UUID_A, model.transport);
    await former.acquire();
    const terminal = build(FULL_PROJECT, UUID_A, 'FAILED', true);
    model.transport.getBuild.mockImplementation(() => terminal);
    const winner = lease(FAST_PROJECT, UUID_B, model.transport);
    await winner.acquire();

    await expect(former.assertHeld()).rejects.toThrow(/not held/u);
    await expect(former.release()).rejects.toThrow(/not held/u);
    expect(model.current()?.body).toBe(body(FAST_PROJECT, UUID_B));
  });

  it('rejects same-size byte replacement even when opaque S3 coordinates are unchanged', async () => {
    const model = createTransport();
    const current = lease(FULL_PROJECT, UUID_A, model.transport);
    await current.acquire();
    const owned = model.current();
    if (owned === undefined) throw new Error('Expected the fixture lease to be held.');
    const replacementBody = body(FULL_PROJECT, UUID_B);
    expect(Buffer.byteLength(replacementBody)).toBe(Buffer.byteLength(owned.body));
    model.replaceCurrent({
      body: replacementBody,
      etag: owned.etag,
      sha256: sha256(replacementBody),
      versionId: owned.versionId,
    });

    await expect(current.assertHeld()).rejects.toThrow(/not held/u);
  });

  it('acquires before the fenced callback and releases only after it returns', async () => {
    const events: string[] = [];
    const capability = {
      acquire: vi.fn(() => {
        events.push('acquire');
      }),
      assertHeld: vi.fn(() => {
        events.push('assert');
      }),
      release: vi.fn(() => {
        events.push('release');
      }),
    };

    await expect(
      withStaticFrontendPublicationLease(capability, () => {
        events.push('callback');
        return 'done';
      }),
    ).resolves.toBe('done');
    expect(events).toEqual(['acquire', 'callback', 'release']);
    expect(capability.assertHeld).not.toHaveBeenCalled();
  });

  it('releases exactly once on callback success or failure and preserves both failures', async () => {
    const successModel = createTransport();
    const successLease = lease(FULL_PROJECT, UUID_A, successModel.transport);
    await expect(withStaticFrontendPublicationLease(successLease, () => 'done')).resolves.toBe('done');
    expect(successModel.calls.filter(({ operation }) => operation === 'delete')).toHaveLength(1);

    const failureModel = createTransport();
    const failureLease = lease(FULL_PROJECT, UUID_A, failureModel.transport);
    await expect(
      withStaticFrontendPublicationLease(failureLease, () => {
        throw new Error('publication failed');
      }),
    ).rejects.toThrow(/publication failed/u);
    expect(failureModel.calls.filter(({ operation }) => operation === 'delete')).toHaveLength(1);
  });

  it('preserves an undefined callback throw after releasing the lease', async () => {
    const model = createTransport();
    const current = lease(FULL_PROJECT, UUID_A, model.transport);
    const operation = vi.fn().mockRejectedValue(undefined);

    await expect(withStaticFrontendPublicationLease(current, operation)).rejects.toBeUndefined();
    expect(model.calls.filter(({ operation }) => operation === 'delete')).toHaveLength(1);
  });

  it('rejects malformed current-build and caller-supplied publisher authority before transport use', () => {
    const model = createTransport();
    const input = leaseInput(FULL_PROJECT, UUID_A, model.transport);
    for (const change of [
      { currentBuild: { buildId: `${FULL_PROJECT}:${UUID_A}`, projectName: FAST_PROJECT } },
      { governedProjects: [FULL_PROJECT, FAST_PROJECT] },
      { governedProjects: ['unregistered-static-publisher'] },
    ]) {
      expect(() => createStaticFrontendPublicationLease({ ...input, ...change }, DEVELOPMENT.targetKey)).toThrow();
    }
    expect(model.calls).toEqual([]);
  });

  it('rejects detached target, key, and caller coordinates before transport use', () => {
    const model = createTransport();
    const input = leaseInput(FULL_PROJECT, UUID_A, model.transport);
    for (const targetKey of [undefined, 'unregistered/main', PRODUCTION.targetKey]) {
      expect(() => createStaticFrontendPublicationLease(input, targetKey as string)).toThrow();
    }
    for (const change of [
      { key: 'other-static-lease' },
      { target: { ...input.target, accountId: PRODUCTION.accountId } },
      { target: { ...input.target, partition: 'aws-us-gov' } },
      { target: { ...input.target, region: 'us-east-1' } },
    ]) {
      expect(() => createStaticFrontendPublicationLease({ ...input, ...change }, DEVELOPMENT.targetKey)).toThrow();
    }
    expect(model.calls).toEqual([]);
  });
});
