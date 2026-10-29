import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { RuntimeConfigValidationError } from '@stark-ballot/runtime-config/env/configValidationError';
import { targetRuntimeProfileEnv } from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { REPLACED_RUNTIME_SELECTOR_NAMES } from '@stark-ballot/runtime-config/env/runtimeProfile';

const logsSendMock = vi.hoisted(() => vi.fn());
const awsClientConstructedMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-cloudwatch-logs', () => {
  class MockCloudWatchLogsClient {
    send = logsSendMock;

    constructor(options: unknown) {
      awsClientConstructedMock('logs', options);
    }
  }

  class MockCreateLogStreamCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class MockPutLogEventsCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    CloudWatchLogsClient: MockCloudWatchLogsClient,
    CreateLogStreamCommand: MockCreateLogStreamCommand,
    PutLogEventsCommand: MockPutLogEventsCommand,
  };
});

vi.mock('@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver', () => ({
  ensureAwsRuntimeConfigReferencesLoaded: vi.fn(async () => await Promise.resolve(undefined)),
}));

vi.mock('@stark-ballot/runtime-config/env/validate', () => ({
  validateEnv: vi.fn(),
}));

vi.mock('@stark-ballot/runtime-config/env/observability', () => ({
  validateTargetObservabilityEnv: vi.fn(),
}));

const resolverModule = await import('@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver');
const observabilityModule = await import('@stark-ballot/runtime-config/env/observability');
const { logger } = await import('@stark-ballot/diagnostics/logger');
const { handler } = await import('./handler');

const STATE_MACHINE_ARN =
  'arn:aws:states:ap-northeast-1:123456789012:stateMachine:stark-ballot-simulator-stark-dev-develop-finalization';
const RESOURCE_PREFIX = 'stark-ballot-simulator-stark-dev-develop';
const OPS_LEDGER_LOG_GROUP_NAME = `/aws/events/${RESOURCE_PREFIX}-ops-ledger`;
const PIPELINE_NAMES = [
  'stark-ballot-simulator-pipeline-stark-dev-develop',
  'stark-ballot-simulator-pipeline-stark-dev-develop-foundation',
  'stark-ballot-simulator-pipeline-stark-dev-develop-app',
  'stark-ballot-simulator-pipeline-stark-dev-develop-toolchain-release',
  'stark-ballot-simulator-pipeline-stark-dev-develop-prover-release',
] as const;
const DEPLOYMENT_ID = `dep_${'a'.repeat(32)}`;
const PIPELINE_EXECUTION_ID = '11111111-2222-3333-4444-555555555555';
const NOW = '2026-07-06T00:00:00.000Z';

interface CommandLike {
  input: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCommandLike(value: unknown): value is CommandLike {
  return isRecord(value) && isRecord(value['input']);
}

function logsCommandInputAt(index: number): Record<string, unknown> {
  const command: unknown = logsSendMock.mock.calls[index]?.[0];
  if (!isCommandLike(command)) {
    throw new Error(`Expected CloudWatch Logs command at call ${index}`);
  }
  return command.input;
}

function buildOpsLedgerEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const event: Record<string, unknown> = {
    ts: NOW,
    event_type: 'deployment_accepted',
    env: 'develop',
    deployment_id: DEPLOYMENT_ID,
    deployment_mode: 'normal',
    pipeline_execution_id: PIPELINE_EXECUTION_ID,
    plan_disposition: 'changed',
    resource_name: 'app',
    state: 'ACCEPTED',
    ...overrides,
  };
  for (const key of Object.keys(event)) {
    if (event[key] === undefined) {
      delete event[key];
    }
  }
  return event;
}

describe('target ops ledger handler', () => {
  const originalEnv = { ...process.env };
  let infoSpy: MockInstance<typeof logger.info>;
  let warnSpy: MockInstance<typeof logger.warn>;
  let errorSpy: MockInstance<typeof logger.error>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    Object.assign(process.env, targetRuntimeProfileEnv());
    for (const name of REPLACED_RUNTIME_SELECTOR_NAMES) {
      delete process.env[name];
    }
    for (const name of [
      'SESSION_CAPABILITY_SECRET',
      'VOTE_SECRET_ENCRYPTION_KEY',
      'SESSION_CAPABILITY_TTL_SECONDS',
      'TURNSTILE_SECRET_KEY',
      'EXPECTED_ORIGIN_VERIFY_HEADER',
      'LOG_IP_HASH_SALT',
      'FINALIZE_CALLBACK_SECRET',
    ]) {
      delete process.env[name];
    }
    process.env['PROVER_STATE_MACHINE_ARN'] = STATE_MACHINE_ARN;
    process.env['OPS_LEDGER_LOG_GROUP_NAME'] = OPS_LEDGER_LOG_GROUP_NAME;
    process.env['OPS_LEDGER_PIPELINE_BASE_NAME'] = PIPELINE_NAMES[0];
    process.env['OPS_LEDGER_RESOURCE_PREFIX'] = RESOURCE_PREFIX;
    process.env['RUNTIME_DEPLOYMENT_ENV'] = 'develop';
    logsSendMock.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('fails closed when the runtime profile changes before any ledger side effect', async () => {
    await handler(buildOpsLedgerEvent());
    logsSendMock.mockClear();
    process.env['RUNTIME_PROFILE'] = 'local-demo';

    await expect(handler(buildOpsLedgerEvent())).rejects.toThrow('Runtime configuration validation failed');

    expect(errorSpy).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: ['RUNTIME_PROFILE'],
    });
  });

  it('fails before ledger writes when the target observability contract is invalid', async () => {
    const observabilityError = new RuntimeConfigValidationError(
      ['DEPLOYMENT_ID'],
      undefined,
      'invalid target observability contract',
    );
    vi.mocked(observabilityModule.validateTargetObservabilityEnv).mockImplementationOnce(() => {
      throw observabilityError;
    });

    await expect(handler(buildOpsLedgerEvent())).rejects.toMatchObject({
      name: 'RuntimeConfigValidationError',
      message: 'Runtime configuration validation failed',
      invalidNames: ['DEPLOYMENT_ID'],
    });

    const resolverCall = vi.mocked(resolverModule.ensureAwsRuntimeConfigReferencesLoaded).mock.calls.at(-1);
    expect(resolverCall?.[0]).toBe('semaphore_janitor');
    expect(typeof resolverCall?.[1]?.invalidNameCollector?.add).toBe('function');
    expect(errorSpy).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: ['DEPLOYMENT_ID'],
    });
  });

  it('rejects unknown EventBridge shapes without logging attacker-controlled values', async () => {
    const privateUri = 's3://private-bucket/sessions/raw-session/input.json';
    await expect(
      handler({
        source: 'stark-ballot.local',
        detail: {
          status: privateUri,
        },
      }),
    ).rejects.toThrow('Invalid ops ledger invocation');

    expect(warnSpy).toHaveBeenCalledWith('Invocation payload is invalid', {
      event: 'invocation_invalid',
      source_kind: 'ops_ledger',
      reason: 'event_shape_invalid',
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(privateUri);
  });

  it('emits names only when the log-salt reference cannot be resolved', async () => {
    const secretValue = 'never-log-this-resolved-secret';
    const resolutionError = new Error(`resolution failed: ${secretValue}`);
    vi.mocked(resolverModule.ensureAwsRuntimeConfigReferencesLoaded).mockImplementationOnce(
      async (_entrypoint, options) => {
        options.invalidNameCollector?.add('LOG_IP_HASH_SALT_REF');
        await Promise.reject(resolutionError);
      },
    );

    await expect(handler(buildOpsLedgerEvent())).rejects.toMatchObject({
      name: 'RuntimeConfigValidationError',
      message: 'Runtime configuration validation failed',
      invalidNames: ['LOG_IP_HASH_SALT_REF'],
    });

    expect(errorSpy).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: ['LOG_IP_HASH_SALT_REF'],
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secretValue);
    expect(observabilityModule.validateTargetObservabilityEnv).not.toHaveBeenCalled();
  });

  it.each([
    {
      event: buildOpsLedgerEvent({
        ts: '2026-07-06T00:00:00Z',
        event_type: 'alarm_state_changed',
        deployment_id: undefined,
        deployment_mode: undefined,
        pipeline_execution_id: undefined,
        plan_disposition: undefined,
        resource_name: `${RESOURCE_PREFIX}-public-api-errors`,
        state: 'ALARM',
      }),
      expectedEventType: 'alarm_state_changed',
    },
    {
      event: buildOpsLedgerEvent({
        event_type: 'prover_job_finished',
        deployment_mode: undefined,
        pipeline_execution_id: undefined,
        plan_disposition: undefined,
        resource_name: 'prover-job',
        state: 'SUCCEEDED',
      }),
      expectedEventType: 'prover_job_finished',
    },
    {
      event: buildOpsLedgerEvent({
        event_type: 'pipeline_execution_changed',
        deployment_id: undefined,
        deployment_mode: undefined,
        plan_disposition: undefined,
        resource_name: PIPELINE_NAMES[2],
        state: 'SUCCEEDED',
      }),
      expectedEventType: 'pipeline_execution_changed',
    },
    {
      event: buildOpsLedgerEvent(),
      expectedEventType: 'deployment_accepted',
    },
  ])('writes one exact common-schema $expectedEventType record', async ({ event, expectedEventType }) => {
    await expect(handler(event)).resolves.toEqual({ recorded: true });

    expect(logsSendMock).toHaveBeenCalledTimes(2);
    expect(logsCommandInputAt(0)).toEqual({
      logGroupName: OPS_LEDGER_LOG_GROUP_NAME,
      logStreamName: 'normalized-events',
    });
    const putInput = logsCommandInputAt(1);
    expect(putInput['logGroupName']).toBe(OPS_LEDGER_LOG_GROUP_NAME);
    expect(putInput['logStreamName']).toBe('normalized-events');
    const logEvents = putInput['logEvents'];
    expect(Array.isArray(logEvents)).toBe(true);
    const logEvent = (logEvents as Array<Record<string, unknown>>)[0];
    expect(logEvent?.['timestamp']).toBe(Date.parse(NOW));
    expect(typeof logEvent?.['message']).toBe('string');
    const stored = JSON.parse(String(logEvent?.['message'])) as Record<string, unknown>;
    expect(stored['event_type']).toBe(expectedEventType);
    expect(stored['ts']).toBe(NOW);
    expect(Object.keys(stored).sort()).toEqual(Object.keys(event).sort());
    expect(JSON.stringify(stored)).not.toMatch(/(?:arn:aws|image_uri|stoppedReason|reason|detail|resources)/i);
  });

  it('treats an existing normalized ledger stream as ready without weakening delivery', async () => {
    logsSendMock
      .mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'ResourceAlreadyExistsException' }))
      .mockResolvedValueOnce({});

    await expect(handler(buildOpsLedgerEvent())).resolves.toEqual({ recorded: true });

    expect(logsSendMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    buildOpsLedgerEvent({ raw_event: { detail: 'must-not-pass' } }),
    buildOpsLedgerEvent({
      event_type: 'prover_job_finished',
      deployment_mode: undefined,
      pipeline_execution_id: undefined,
      plan_disposition: undefined,
      resource_name: 'prover-job',
      state: 'RUNNING',
    }),
    buildOpsLedgerEvent({
      event_type: 'pipeline_execution_changed',
      deployment_id: undefined,
      deployment_mode: undefined,
      plan_disposition: undefined,
      resource_name: 'unrelated-pipeline',
    }),
    buildOpsLedgerEvent({
      event_type: 'pipeline_execution_changed',
      deployment_id: undefined,
      deployment_mode: undefined,
      plan_disposition: undefined,
      resource_name: 'stark-ballot-simulator-pipeline-stark-dev-develop-release-candidate',
      state: 'SUCCEEDED',
    }),
    buildOpsLedgerEvent({
      event_type: 'alarm_state_changed',
      deployment_id: undefined,
      deployment_mode: undefined,
      pipeline_execution_id: undefined,
      plan_disposition: undefined,
      resource_name: 'other-alarm',
    }),
    buildOpsLedgerEvent({ pipeline_execution_id: 'latest' }),
    buildOpsLedgerEvent({ pipeline_execution_id: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE' }),
    buildOpsLedgerEvent({ deployment_mode: 'recovery' }),
    buildOpsLedgerEvent({ plan_disposition: 'unchanged' }),
    buildOpsLedgerEvent({ source_sha: 'b'.repeat(40) }),
    buildOpsLedgerEvent({ pipeline_execution_id: undefined }),
    buildOpsLedgerEvent({ deployment_mode: undefined }),
    buildOpsLedgerEvent({ plan_disposition: undefined }),
    buildOpsLedgerEvent({
      event_type: 'pipeline_execution_changed',
      deployment_id: undefined,
      deployment_mode: undefined,
      pipeline_execution_id: undefined,
      plan_disposition: undefined,
      resource_name: PIPELINE_NAMES[2],
      state: 'SUCCEEDED',
    }),
    buildOpsLedgerEvent({ deployment_id: 'dep_not-valid' }),
    buildOpsLedgerEvent({ env: 'main' }),
    buildOpsLedgerEvent({ ts: 'not-a-timestamp' }),
    buildOpsLedgerEvent({ ts: '2026-07-06T00:00:00.00Z' }),
    buildOpsLedgerEvent({ ts: '2026-07-04T21:59:59.999Z' }),
    buildOpsLedgerEvent({ ts: '2026-07-06T00:05:00.001Z' }),
  ])('rejects an invalid or non-allowlisted normalized ledger record', async (event) => {
    await expect(handler(event)).rejects.toThrow('Invalid ops ledger invocation');

    expect(logsSendMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('Invocation payload is invalid', {
      event: 'invocation_invalid',
      source_kind: 'ops_ledger',
      reason: 'event_shape_invalid',
    });
  });

  it.each(['OPS_LEDGER_LOG_GROUP_NAME', 'OPS_LEDGER_PIPELINE_BASE_NAME', 'OPS_LEDGER_RESOURCE_PREFIX'])(
    'fails closed when %s is missing',
    async (name) => {
      delete process.env[name];

      await expect(handler(buildOpsLedgerEvent())).rejects.toEqual(
        expect.objectContaining({
          name: 'RuntimeConfigValidationError',
          invalidNames: [name],
        }),
      );

      expect(logsSendMock).not.toHaveBeenCalled();
    },
  );

  it('fails the invocation when CloudWatch Logs rejects the normalized log event', async () => {
    logsSendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({
      rejectedLogEventsInfo: {
        tooNewLogEventStartIndex: 0,
      },
    });

    await expect(handler(buildOpsLedgerEvent())).rejects.toThrow(
      'CloudWatch Logs rejected normalized ops ledger event',
    );

    expect(logsSendMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(DEPLOYMENT_ID);
  });
});
