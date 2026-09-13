import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { persistCliReport } from '@stark-ballot/test-support/testing/cli-artifacts';
import * as artifacts from '@stark-ballot/test-support/testing/cli-artifacts';
import * as evidenceCollector from './cli-run-evidence';
import { collectCliRunEvidence, type CollectCliRunEvidenceOptions } from './cli-run-evidence';
import { CLIVotingTest, stopCliServer, type CLITestConfig } from '../cli-e2e-voting-flow';
import * as cliHelpers from '@stark-ballot/test-support/testing/cli-test-helpers';
import { requireRecord } from '@stark-ballot/validation/unknown-value-guards';
import rootPackage from '../../../package.json';

const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const mockConfig: CLITestConfig = {
  scenarios: [],
  useRealZkVM: false,
  realMode: 'dev',
  verbose: false,
  outputFormat: 'table',
  allScenarios: false,
  userChoice: 'A',
  skipBuild: true,
};

async function fixture(withGit = true): Promise<CollectCliRunEvidenceOptions> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cli-evidence-'));
  cleanup.push(root);
  await mkdir(path.join(root, 'packages/example/src'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager: rootPackage.packageManager }));
  await writeFile(path.join(root, 'packages/example/src/index.ts'), 'export const version = 1;\n');
  if (withGit) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=CLI fixture', '-c', 'user.email=cli@example.invalid', 'commit', '-qm', 'fixture');
  }
  return {
    projectRoot: root,
    profile: 'static-mock-e2e',
    scenarios: ['S0', 'S1'],
    useRealZkVM: false,
    externalServer: false,
    finalizeTimeoutMs: 120000,
    ownedSourceRoots: ['packages/example'],
    environment: { EXPECTED_IMAGE_ID: `0x${'a'.repeat(64)}` },
  };
}

describe('CLI run evidence', () => {
  it('binds clean and dirty Git source while retaining only hashes of changes', async () => {
    const options = await fixture();
    const clean = await collectCliRunEvidence(options);
    expect(clean.source.commit).toMatch(/^[0-9a-f]{40,64}$/);
    expect(clean.source).toMatchObject({
      dirty: false,
      trackedDiffSha256: createHash('sha256').update('').digest('hex'),
      untrackedSources: [],
      untrackedScope: 'manifest-workspaces',
      complete: true,
    });

    const sentinel = 'private-source-content-sentinel';
    await writeFile(path.join(options.projectRoot, 'packages/example/src/index.ts'), `// ${sentinel}\n`);
    await writeFile(path.join(options.projectRoot, 'packages/example/src/extra.ts'), `// ${sentinel}\n`);
    const dirty = await collectCliRunEvidence(options);
    expect(dirty.source.dirty).toBe(true);
    expect(dirty.source.commit).toBe(clean.source.commit);
    expect(dirty.source.trackedDiffSha256).not.toBe(clean.source.trackedDiffSha256);
    expect(dirty.source.untrackedSources).toEqual([
      {
        path: 'packages/example/src/extra.ts',
        sha256: createHash('sha256').update(`// ${sentinel}\n`).digest('hex'),
      },
    ]);
    expect(JSON.stringify(dirty)).not.toContain(sentinel);
  });

  it('excludes secret files and symlink contents and admits incomplete source identity explicitly', async () => {
    const options = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'cli-evidence-outside-'));
    cleanup.push(outside);
    const sentinel = 'secret-environment-and-process-sentinel';
    await writeFile(path.join(outside, 'outside.ts'), sentinel);
    await writeFile(path.join(options.projectRoot, '.env.local'), sentinel);
    await writeFile(path.join(options.projectRoot, 'packages/example/credentials.json'), sentinel);
    await symlink(path.join(outside, 'outside.ts'), path.join(options.projectRoot, 'packages/example/src/link.ts'));
    await symlink(outside, path.join(options.projectRoot, 'packages/example/src/linked-directory'));
    await writeFile(path.join(options.projectRoot, 'unowned.ts'), sentinel);
    const evidence = await collectCliRunEvidence({
      ...options,
      environment: {
        SESSION_CAPABILITY_SECRET: sentinel,
        RAYON_NUM_THREADS: sentinel,
        EXPECTED_IMAGE_ID: sentinel,
        CLI_FINALIZE_TIMEOUT_MS: sentinel,
      },
    });
    expect(evidence.source.complete).toBe(false);
    expect(evidence.source.untrackedSources).toEqual([]);
    expect(evidence.issues).toEqual(
      expect.arrayContaining(['source_untracked_excluded', 'source_untracked_unavailable', 'rayon_setting_invalid']),
    );
    expect(JSON.stringify(evidence)).not.toContain(sentinel);
    expect(JSON.stringify(evidence)).not.toContain(outside);
  });

  it('keeps non-Git evidence usable and reports unknown source identity', async () => {
    const options = await fixture(false);
    const evidence = await collectCliRunEvidence(options);
    expect(evidence.source).toMatchObject({ commit: null, dirty: null, trackedDiffSha256: null, complete: false });
    expect(evidence.issues).toContain('source_metadata_unavailable');
    expect(evidence.runtime).toMatchObject({
      node: process.versions.node,
      pnpmDeclared: rootPackage.packageManager.slice('pnpm@'.length).split('+')[0],
      platform: process.platform,
      architecture: process.arch,
      host: { sha256: null, unavailableReason: 'not_used' },
      verifier: { sha256: null, unavailableReason: 'not_used' },
    });
  });

  it.each(['local-proof-development', 'local-proof-production'])(
    'records local binary identities and requested conditions for %s without inventing worker counts',
    async (profile) => {
      const options = await fixture();
      for (const relative of ['zkvm/target/release/host', 'verifier-service/target/release/verifier-service']) {
        const file = path.join(options.projectRoot, relative);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'binary-fixture');
        await chmod(file, 0o700);
      }
      const evidence = await collectCliRunEvidence({
        ...options,
        profile,
        useRealZkVM: true,
        finalizeTimeoutMs: 636000,
        environment: { ...options.environment, CLI_FINALIZE_TIMEOUT_MS: '600000', RAYON_NUM_THREADS: '4' },
      });
      const expectedHash = createHash('sha256').update('binary-fixture').digest('hex');
      expect(evidence.runtime).toMatchObject({
        profile,
        finalizeTimeoutMs: { requested: 600000, effective: 636000 },
        rayonThreads: { configured: 4, observed: null },
        host: { sha256: expectedHash, unavailableReason: null },
        verifier: { sha256: expectedHash, unavailableReason: null },
      });
    },
  );

  it('does not claim the local host identifies an external server', async () => {
    const evidence = await collectCliRunEvidence({ ...(await fixture()), useRealZkVM: true, externalServer: true });
    expect(evidence.runtime.host).toEqual({ sha256: null, unavailableReason: 'external_server' });
    expect(evidence.runtime.server).toBe('external');
  });

  it.each(['table', 'markdown', 'json'] as const)(
    'persists the same conditions and interrupted scenario dispositions in %s and JSON',
    async (format) => {
      const options = await fixture();
      const evidence = await collectCliRunEvidence(options);
      const output = await persistCliReport({
        sessionId: 'fixture-run',
        outputFormat: format,
        reportContent: 'S0 passed; S1 was not run.\n',
        results: [{ name: 'S0: Normal case', passed: true, duration: 1, details: {} }],
        evidence,
        runFailure: 'run_interrupted',
        outputDir: options.projectRoot,
      });
      const payload: unknown = JSON.parse(await readFile(output.jsonPath, 'utf8'));
      const record = requireRecord(payload, 'CLI report');
      expect(record['evidence']).toEqual(evidence);
      expect(record['scenarioExecution']).toEqual([
        { scenario: 'S0', status: 'passed', reason: null },
        { scenario: 'S1', status: 'not_run', reason: 'run_interrupted' },
      ]);
      expect(evidence.source.commit).not.toBeNull();
      expect(output.content).toContain(evidence.source.commit ?? '');
      expect(output.content).toContain('run_interrupted');
      expect(output.content).toContain('not_run');
      expect(await readFile(output.formattedPath ?? output.jsonPath, 'utf8')).toBe(output.content);
    },
  );

  it('persists setup failure without marking selected scenarios as executed', async () => {
    const options = await fixture();
    const evidence = await collectCliRunEvidence(options);
    const output = await persistCliReport({
      sessionId: 'setup-failure',
      outputFormat: 'json',
      reportContent: '',
      results: [],
      evidence,
      runFailure: 'setup_failed',
      outputDir: options.projectRoot,
    });
    const payload: unknown = JSON.parse(output.content);
    const record = requireRecord(payload, 'CLI report');
    expect(record['summary']).toEqual({ total: 0, passed: 0, failed: 0, duration: 0 });
    expect(record['runFailure']).toBe('setup_failed');
    expect(record['scenarioExecution']).toEqual([
      { scenario: 'S0', status: 'not_run', reason: 'setup_failed' },
      { scenario: 'S1', status: 'not_run', reason: 'setup_failed' },
    ]);
  });

  it('collects before setup and preserves the original setup error after saving evidence and cleanup', async () => {
    const evidence = await collectCliRunEvidence(await fixture());
    const events: string[] = [];
    vi.spyOn(evidenceCollector, 'collectCliRunEvidence').mockImplementation(() => {
      events.push('capture');
      return Promise.resolve(evidence);
    });
    const persist = vi.spyOn(artifacts, 'persistCliReport').mockImplementation(() => {
      events.push('persist');
      return Promise.resolve({ jsonPath: 'fixture-report', content: 'fixture report' });
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const test = new CLIVotingTest({
      scenarios: [],
      useRealZkVM: false,
      realMode: 'dev',
      verbose: false,
      outputFormat: 'table',
      allScenarios: false,
      userChoice: 'A',
      skipBuild: true,
    });
    const originalError = new Error('setup failed');
    vi.spyOn(test, 'setup').mockImplementation(() => {
      events.push('setup');
      return Promise.reject(originalError);
    });
    vi.spyOn(test, 'teardown').mockImplementation(() => {
      events.push('cleanup');
      return Promise.resolve();
    });
    await expect(test.execute()).rejects.toBe(originalError);
    expect(events).toEqual(['capture', 'setup', 'persist', 'cleanup']);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ evidence, results: [], runFailure: 'setup_failed' }),
    );
  });

  it('continues the run with unknown metadata when collection fails, without retaining its raw error', async () => {
    const sentinel = 'metadata-error-secret-sentinel';
    vi.spyOn(evidenceCollector, 'collectCliRunEvidence').mockRejectedValue(new Error(sentinel));
    const persist = vi.spyOn(artifacts, 'persistCliReport').mockResolvedValue({ jsonPath: 'report', content: '' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const helpers = new cliHelpers.CLITestHelpers();
    vi.spyOn(helpers, 'generateReport').mockResolvedValue('two scenarios passed');
    const test = new CLIVotingTest(mockConfig, helpers);
    vi.spyOn(test, 'runTestCase').mockImplementation((scenario) =>
      Promise.resolve({ name: scenario.name, passed: true, duration: 1, details: {} }),
    );
    await expect(test.execute()).resolves.toMatchObject({ passed: true });
    const saved = persist.mock.calls[0]?.[0];
    expect(saved?.results).toHaveLength(2);
    expect(saved?.evidence?.issues).toContain('run_metadata_unavailable');
    expect(saved?.evidence?.source.complete).toBe(false);
    expect(JSON.stringify(saved)).not.toContain(sentinel);
    expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
  });

  it('retains the actual setup failure when metadata and teardown also fail', async () => {
    vi.spyOn(evidenceCollector, 'collectCliRunEvidence').mockRejectedValue(new Error('metadata failure'));
    const persist = vi.spyOn(artifacts, 'persistCliReport').mockResolvedValue({ jsonPath: 'report', content: '' });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const test = new CLIVotingTest(mockConfig);
    const setupFailure = new Error('actual setup failure');
    vi.spyOn(test, 'setup').mockRejectedValue(setupFailure);
    vi.spyOn(test, 'teardown').mockRejectedValue(new Error('cleanup failure'));
    await expect(test.execute()).rejects.toBe(setupFailure);
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ runFailure: 'setup_failed', results: [] }));
  });

  it.each([
    { useRealZkVM: false, realMode: 'dev', expectedTimeout: 600000 },
    { useRealZkVM: true, realMode: 'dev', expectedTimeout: 636000 },
    { useRealZkVM: true, realMode: 'prod', expectedTimeout: 636000 },
  ] as const)('uses the selected proof profile for the actual HTTP wait: %j', async (selection) => {
    vi.stubEnv('STARK_BALLOT_CLI_BASE_URL', 'http://127.0.0.1:12345');
    vi.stubEnv('CLI_FINALIZE_TIMEOUT_MS', '600000');
    const ActualHelpers = cliHelpers.CLITestHelpers;
    const created: cliHelpers.CLITestHelpers[] = [];
    class ObservedHelpers extends ActualHelpers {
      constructor(...args: ConstructorParameters<typeof ActualHelpers>) {
        super(...args);
        created.push(this);
      }
    }
    vi.spyOn(cliHelpers, 'CLITestHelpers').mockImplementation(ObservedHelpers);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const test = new CLIVotingTest({ ...mockConfig, ...selection });
    await test.setup();
    const helper = created[0];
    if (!helper) throw new Error('Expected CLI to construct its HTTP helper');
    const timer = vi.spyOn(globalThis, 'setTimeout');
    // No session capability has been set. Admission fails after arming (and then clearing) the real HTTP deadline.
    await expect(ActualHelpers.prototype.finalizeWithScenarios.call(helper, 'session-fixture', 'S0')).rejects.toThrow();
    expect(timer.mock.calls.map((call) => call[1])).toContain(selection.expectedTimeout);
    await test.teardown();
  });

  it('saves selected scenarios and an unknown effective deadline when timeout admission fails', async () => {
    vi.stubEnv('CLI_FINALIZE_TIMEOUT_MS', '1.5');
    const persist = vi.spyOn(artifacts, 'persistCliReport').mockResolvedValue({ jsonPath: 'report', content: '' });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const test = new CLIVotingTest(mockConfig);
    const setup = vi.spyOn(test, 'setup').mockResolvedValue();
    await expect(test.execute()).rejects.toThrow('CLI_FINALIZE_TIMEOUT_MS');
    expect(setup).not.toHaveBeenCalled();
    const saved = persist.mock.calls[0]?.[0];
    expect(saved?.runFailure).toBe('setup_failed');
    expect(saved?.evidence?.runtime.scenarios).toEqual(['S0', 'S1']);
    expect(saved?.evidence?.runtime.finalizeTimeoutMs.effective).toBeNull();
  });
});

describe('CLI server teardown', () => {
  it('observes an exit emitted immediately by the stop request', async () => {
    const child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: 12345 });
    vi.spyOn(child, 'kill').mockImplementation(() => {
      child.emit('exit', 0, null);
      return true;
    });
    await expect(stopCliServer(child, 20, 20)).resolves.toBeUndefined();
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('returns for an already exited server and kills a server that ignores graceful termination', async () => {
    const exited = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await once(exited, 'exit');
    await expect(stopCliServer(exited, 20, 20)).resolves.toBeUndefined();

    const stubborn = spawn(process.execPath, [
      '-e',
      'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);',
    ]);
    try {
      await once(stubborn.stdout, 'data');
      await stopCliServer(stubborn, 20, 1000);
      expect(stubborn.signalCode).toBe('SIGKILL');
    } finally {
      if (stubborn.exitCode === null && stubborn.signalCode === null) stubborn.kill('SIGKILL');
    }
  });
});
