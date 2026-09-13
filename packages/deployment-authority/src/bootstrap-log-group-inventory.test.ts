import { afterEach, describe, expect, it, vi } from 'vitest';
import { productionConfigurationFixture } from './test-support/deployment-target-fixtures';

const sourceSha = 'a'.repeat(40);
const checksum = 'b'.repeat(64);
const executionId = '11111111-2222-3333-4444-555555555555';

type StateResource = {
  address: string;
  mode: string;
  type: string;
  name: string;
  index?: string;
  values: Record<string, unknown>;
};

function resourceAt(resources: StateResource[], index: number): StateResource {
  const resource = resources[index];
  if (resource === undefined) throw new Error('Missing log-group state fixture resource.');
  return resource;
}

async function fixture() {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  const targets = await import('./index.js');
  const authority = await import('./source-path-build-authority.js');
  const target = targets.resolveAllowedDeploymentTarget('stark-prod/main');
  const context = targets.renderDeploymentLaneContext({
    target,
    lane: 'bootstrap',
    accountId: target.accountId,
    requestedControlSourceSha: sourceSha,
    selectedApplicationSourceSha: sourceSha,
    frameworkSourceSha: sourceSha,
  });
  const inventory = authority.resolveBootstrapLogGroupInventory(context);
  const groups: StateResource[] = inventory.map((entry) => ({
    address: entry.address,
    mode: 'managed',
    type: 'aws_cloudwatch_log_group',
    name: 'this',
    index: entry.projectName,
    values: { name: entry.remoteId, id: entry.remoteId, retention_in_days: 365 },
  }));
  const projects: StateResource[] = inventory.map((entry, index) => ({
    address: `aws_codebuild_project.project_${index}`,
    mode: 'managed',
    type: 'aws_codebuild_project',
    name: `project_${index}`,
    values: {
      name: entry.projectName,
      logs_config: [{ cloudwatch_logs: [{ group_name: entry.remoteId, status: 'ENABLED' }] }],
    },
  }));
  const body = (resources: StateResource[] = [...groups, ...projects]) =>
    JSON.stringify({ values: { root_module: { resources } } });
  const produce = () => authority.createBootstrapLogGroupInventoryEvidence(body(), context, checksum, executionId);
  return { authority, targets, target, context, inventory, groups, projects, body, produce };
}

afterEach(() => {
  vi.doUnmock('../deployment-targets.json');
  vi.resetModules();
});

describe('Bootstrap complete log-group inventory', () => {
  it('binds all production projects, their module identities, retention, and log destinations', async () => {
    const f = await fixture();
    expect(f.inventory).toHaveLength(24);
    expect(
      Object.fromEntries(
        [...new Set(f.inventory.map((entry) => entry.moduleAddress))].map((module) => [
          module,
          f.inventory.filter((entry) => entry.moduleAddress === module).length,
        ]),
      ),
    ).toEqual({
      'module.bootstrap_pipeline_codebuild_log_groups': 3,
      'module.foundation_pipeline_codebuild_log_groups': 9,
      'module.app_pipeline_codebuild_log_groups': 9,
      'module.terraform_drift_codebuild_log_groups': 3,
    });
    expect(f.inventory.some((entry) => entry.projectName.includes('static-fast'))).toBe(false);
    const evidence = f.produce();
    expect(evidence).toMatchObject({
      evidenceType: 'bootstrap-codebuild-log-group-inventory',
      targetKey: 'stark-prod/main',
      expectedProjectCount: 24,
      verifiedProjectCount: 24,
      unexpectedLogGroupCount: 0,
      remoteIdentityMismatchCount: 0,
      retentionMismatchCount: 0,
      projectLoggingMismatchCount: 0,
    });
    expect(f.authority.admitBootstrapLogGroupInventoryEvidence(evidence, f.context, checksum, executionId)).toEqual(
      evidence,
    );
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain('logs_config');
    expect(JSON.stringify(evidence)).not.toContain('values');
    const reversed = f.authority.createBootstrapLogGroupInventoryEvidence(
      f.body([...f.projects, ...f.groups].reverse()),
      f.context,
      checksum,
      executionId,
    );
    expect(reversed.inventorySha256).toBe(evidence.inventorySha256);
    expect(reversed.stateJsonSha256).not.toBe(evidence.stateJsonSha256);
  });

  it.each([
    [
      'missing log group',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.groups.pop();
      },
    ],
    [
      'missing project',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.projects.pop();
      },
    ],
    [
      'extra group',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.groups.push({ ...resourceAt(f.groups, 0), address: 'aws_cloudwatch_log_group.extra' });
      },
    ],
    [
      'extra project',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.projects.push({ ...resourceAt(f.projects, 0), address: 'aws_codebuild_project.extra' });
      },
    ],
    [
      'duplicate address',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        resourceAt(f.groups, 1).address = resourceAt(f.groups, 0).address;
      },
    ],
    [
      'wrong address',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        resourceAt(f.groups, 0).address = 'module.unreviewed.aws_cloudwatch_log_group.this["extra"]';
      },
    ],
    [
      'wrong index',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        resourceAt(f.groups, 0).index = 'extra';
      },
    ],
    [
      'wrong resource name',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        resourceAt(f.groups, 0).name = 'extra';
      },
    ],
    [
      'wrong resource type',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        resourceAt(f.groups, 0).type = 'aws_s3_bucket';
      },
    ],
    [
      'data resource',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        resourceAt(f.groups, 0).mode = 'data';
      },
    ],
    [
      'wrong remote name',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        resourceAt(f.groups, 0).values['name'] = '/aws/codebuild/extra';
      },
    ],
    [
      'duplicate remote id',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        resourceAt(f.groups, 0).values['id'] = resourceAt(f.groups, 1).values['id'];
      },
    ],
    [
      'unbounded retention',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        resourceAt(f.groups, 0).values['retention_in_days'] = 0;
      },
    ],
    [
      'wrong finite retention',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        resourceAt(f.groups, 0).values['retention_in_days'] = 30;
      },
    ],
    [
      'missing retention',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        delete resourceAt(f.groups, 0).values['retention_in_days'];
      },
    ],
    [
      'missing logging',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        resourceAt(f.projects, 0).values['logs_config'] = [];
      },
    ],
    [
      'detached logging',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        resourceAt(f.projects, 0).values['logs_config'] = [
          { cloudwatch_logs: [{ group_name: '/aws/codebuild/extra', status: 'ENABLED' }] },
        ];
      },
    ],
    [
      'disabled logging',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        resourceAt(f.projects, 0).values['logs_config'] = [
          { cloudwatch_logs: [{ group_name: resourceAt(f.groups, 0).values['name'], status: 'DISABLED' }] },
        ];
      },
    ],
  ])('rejects %s', async (_label, mutate) => {
    const f = await fixture();
    mutate(f);
    expect(f.produce).toThrow();
  });

  it('redacts malformed Terraform state before surfacing a parse failure', async () => {
    const f = await fixture();
    const marker = 'nonsecret-state-parse-canary';
    try {
      f.authority.createBootstrapLogGroupInventoryEvidence(`${marker} malformed`, f.context, checksum, executionId);
      throw new Error('Expected malformed state rejection.');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const failure = error as Error;
      expect(failure.message).toBe('Bootstrap log-group Terraform state JSON is not valid JSON.');
      expect(failure.stack).not.toContain(marker);
      expect(failure.cause).toBeUndefined();
    }
  });

  it('rejects detached or incomplete smoke evidence and the development context', async () => {
    const f = await fixture();
    const evidence = f.produce();
    for (const overrides of [
      { targetKey: 'stark-dev/develop' },
      { stateIdentity: 'stark-dev/develop/bootstrap' },
      { expectedProjectCount: 0, verifiedProjectCount: 0 },
      { expectedProjectCount: 23, verifiedProjectCount: 23 },
      { inventorySha256: 'f'.repeat(64) },
      { pipelineExecutionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      { remoteIdentityMismatchCount: 1 },
      { retentionMismatchCount: 1 },
      { projectLoggingMismatchCount: 1 },
      { unexpectedLogGroupCount: 1 },
      { stateJsonSha256: 'invalid' },
      { extra: true },
    ]) {
      expect(() =>
        f.authority.admitBootstrapLogGroupInventoryEvidence(
          { ...evidence, ...overrides },
          f.context,
          checksum,
          executionId,
        ),
      ).toThrow();
    }
    const development = f.targets.resolveAllowedDeploymentTarget('stark-dev/develop');
    const developmentContext = f.targets.renderDeploymentLaneContext({
      target: development,
      lane: 'bootstrap',
      accountId: development.accountId,
      requestedControlSourceSha: sourceSha,
      selectedApplicationSourceSha: sourceSha,
      frameworkSourceSha: sourceSha,
    });
    expect(() =>
      f.authority.createBootstrapLogGroupInventoryEvidence(f.body(), developmentContext, checksum, executionId),
    ).toThrow('production Bootstrap');
    expect(() => f.authority.createBootstrapLogGroupInventoryEvidence('{', f.context, checksum, executionId)).toThrow();
  });
});
