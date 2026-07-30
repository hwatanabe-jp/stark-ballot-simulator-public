import {
  RuntimeConfigValidationError,
  type RuntimeConfigName,
} from '@stark-ballot/runtime-config/env/configValidationError';

const TARGET_PROJECT_NAME = 'stark-ballot-simulator';
const TARGET_NAME_PREFIXES = [
  `${TARGET_PROJECT_NAME}-stark-dev-develop`,
  `${TARGET_PROJECT_NAME}-stark-prod-main`,
] as const;
const TARGET_PROOF_ARTIFACT_PREFIX = 'sessions/';

interface TargetReferenceValidationOptions {
  expectedAccountId?: string;
  expectedRegion?: string;
}

interface TargetS3ProofReferenceValues {
  s3ProofBucket: string;
  s3ProofPrefix: string;
}

export interface TargetRuntimeReferenceValues extends TargetS3ProofReferenceValues {
  proverWorkQueueUrl: string;
  proverStateMachineArn: string;
  verificationWorkerFunctionName: string;
}

function targetReferenceError(name: RuntimeConfigName, message: string): RuntimeConfigValidationError {
  return new RuntimeConfigValidationError([name], undefined, message);
}

function assertPresent(name: RuntimeConfigName, value: string): void {
  if (value.trim().length === 0) {
    throw targetReferenceError(name, `${name} must be set when TARGET_AWS_RUNTIME=1.`);
  }
}

function assertNoLegacyMarker(name: RuntimeConfigName, value: string): void {
  const lowered = value.toLowerCase();
  if (
    lowered.includes('amplify') ||
    lowered.includes('legacy') ||
    lowered.includes('placeholder') ||
    lowered.includes('proof-bundles-develop') ||
    lowered.startsWith('change-me')
  ) {
    throw targetReferenceError(name, `${name} must reference Terraform-managed target runtime resources.`);
  }
}

function assertRegion(name: RuntimeConfigName, actualRegion: string, expectedRegion: string | undefined): void {
  if (expectedRegion && actualRegion !== expectedRegion) {
    throw targetReferenceError(name, `${name} region must match AWS_REGION/AWS_DEFAULT_REGION.`);
  }
}

function assertAccount(name: RuntimeConfigName, actualAccountId: string, expectedAccountId: string | undefined): void {
  if (expectedAccountId && actualAccountId !== expectedAccountId) {
    throw targetReferenceError(name, `${name} account must match AWS_ACCOUNT_ID.`);
  }
}

function requiredMatchGroup(
  name: RuntimeConfigName,
  match: RegExpExecArray,
  index: number,
  errorMessage: string,
): string {
  const value = match[index];
  if (!value) {
    throw targetReferenceError(name, errorMessage);
  }
  return value;
}

function isTargetResourceName(name: string, suffix: string): boolean {
  return TARGET_NAME_PREFIXES.some((prefix) => name === `${prefix}-${suffix}`);
}

function validateQueueUrl(value: string, options: TargetReferenceValidationOptions): void {
  assertPresent('PROVER_WORK_QUEUE_URL', value);
  assertNoLegacyMarker('PROVER_WORK_QUEUE_URL', value);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new RuntimeConfigValidationError(
      ['PROVER_WORK_QUEUE_URL'],
      cause,
      'PROVER_WORK_QUEUE_URL must be a valid SQS queue URL.',
    );
  }

  if (parsed.protocol !== 'https:' || parsed.search || parsed.hash) {
    throw targetReferenceError('PROVER_WORK_QUEUE_URL', 'PROVER_WORK_QUEUE_URL must be a valid SQS queue URL.');
  }

  const sqsMatch = /^sqs\.([a-z]{2}-[a-z]+-[0-9])\.amazonaws\.com$/.exec(parsed.hostname);
  if (!sqsMatch) {
    throw targetReferenceError('PROVER_WORK_QUEUE_URL', 'PROVER_WORK_QUEUE_URL must reference an AWS SQS endpoint.');
  }
  const region = requiredMatchGroup(
    'PROVER_WORK_QUEUE_URL',
    sqsMatch,
    1,
    'PROVER_WORK_QUEUE_URL must reference an AWS SQS endpoint.',
  );
  assertRegion('PROVER_WORK_QUEUE_URL', region, options.expectedRegion);

  const pathMatch = /^\/([0-9]{12})\/([A-Za-z0-9_-]{1,80})$/.exec(parsed.pathname);
  if (!pathMatch) {
    throw targetReferenceError(
      'PROVER_WORK_QUEUE_URL',
      'PROVER_WORK_QUEUE_URL must include a 12-digit account ID and queue name.',
    );
  }
  const accountId = requiredMatchGroup(
    'PROVER_WORK_QUEUE_URL',
    pathMatch,
    1,
    'PROVER_WORK_QUEUE_URL must include a 12-digit account ID and queue name.',
  );
  const queueName = requiredMatchGroup(
    'PROVER_WORK_QUEUE_URL',
    pathMatch,
    2,
    'PROVER_WORK_QUEUE_URL must include a 12-digit account ID and queue name.',
  );
  assertAccount('PROVER_WORK_QUEUE_URL', accountId, options.expectedAccountId);

  if (!isTargetResourceName(queueName, 'prover-work')) {
    throw targetReferenceError(
      'PROVER_WORK_QUEUE_URL',
      'PROVER_WORK_QUEUE_URL must reference the Terraform-managed target prover work queue.',
    );
  }
}

function validateStateMachineArn(value: string, options: TargetReferenceValidationOptions): void {
  assertPresent('PROVER_STATE_MACHINE_ARN', value);
  assertNoLegacyMarker('PROVER_STATE_MACHINE_ARN', value);

  const arnMatch = /^arn:aws:states:([^:]+):([0-9]{12}):stateMachine:([A-Za-z0-9-_]+)$/.exec(value);
  if (!arnMatch) {
    throw targetReferenceError(
      'PROVER_STATE_MACHINE_ARN',
      'PROVER_STATE_MACHINE_ARN must be a valid Step Functions state machine ARN.',
    );
  }

  const region = requiredMatchGroup(
    'PROVER_STATE_MACHINE_ARN',
    arnMatch,
    1,
    'PROVER_STATE_MACHINE_ARN must be a valid Step Functions state machine ARN.',
  );
  const accountId = requiredMatchGroup(
    'PROVER_STATE_MACHINE_ARN',
    arnMatch,
    2,
    'PROVER_STATE_MACHINE_ARN must be a valid Step Functions state machine ARN.',
  );
  const stateMachineName = requiredMatchGroup(
    'PROVER_STATE_MACHINE_ARN',
    arnMatch,
    3,
    'PROVER_STATE_MACHINE_ARN must be a valid Step Functions state machine ARN.',
  );
  assertRegion('PROVER_STATE_MACHINE_ARN', region, options.expectedRegion);
  assertAccount('PROVER_STATE_MACHINE_ARN', accountId, options.expectedAccountId);

  if (!isTargetResourceName(stateMachineName, 'finalization')) {
    throw targetReferenceError(
      'PROVER_STATE_MACHINE_ARN',
      'PROVER_STATE_MACHINE_ARN must reference the Terraform-managed target state machine.',
    );
  }
}

function validateVerifierFunctionName(value: string, options: TargetReferenceValidationOptions): void {
  assertPresent('VERIFICATION_WORKER_FUNCTION_NAME', value);
  assertNoLegacyMarker('VERIFICATION_WORKER_FUNCTION_NAME', value);

  const arnMatch = /^arn:aws:lambda:([^:]+):([0-9]{12}):function:([A-Za-z0-9-_]+)$/.exec(value);
  if (arnMatch) {
    const region = requiredMatchGroup(
      'VERIFICATION_WORKER_FUNCTION_NAME',
      arnMatch,
      1,
      'VERIFICATION_WORKER_FUNCTION_NAME must be a Lambda function name or ARN.',
    );
    const accountId = requiredMatchGroup(
      'VERIFICATION_WORKER_FUNCTION_NAME',
      arnMatch,
      2,
      'VERIFICATION_WORKER_FUNCTION_NAME must be a Lambda function name or ARN.',
    );
    const functionName = requiredMatchGroup(
      'VERIFICATION_WORKER_FUNCTION_NAME',
      arnMatch,
      3,
      'VERIFICATION_WORKER_FUNCTION_NAME must be a Lambda function name or ARN.',
    );
    assertRegion('VERIFICATION_WORKER_FUNCTION_NAME', region, options.expectedRegion);
    assertAccount('VERIFICATION_WORKER_FUNCTION_NAME', accountId, options.expectedAccountId);
    if (!isTargetResourceName(functionName, 'verification-worker')) {
      throw targetReferenceError(
        'VERIFICATION_WORKER_FUNCTION_NAME',
        'VERIFICATION_WORKER_FUNCTION_NAME must reference the Terraform-managed verification worker.',
      );
    }
    return;
  }

  if (!/^[A-Za-z0-9-_]{1,64}$/.test(value)) {
    throw targetReferenceError(
      'VERIFICATION_WORKER_FUNCTION_NAME',
      'VERIFICATION_WORKER_FUNCTION_NAME must be a Lambda function name or ARN.',
    );
  }
  if (!isTargetResourceName(value, 'verification-worker')) {
    throw targetReferenceError(
      'VERIFICATION_WORKER_FUNCTION_NAME',
      'VERIFICATION_WORKER_FUNCTION_NAME must reference the Terraform-managed verification worker.',
    );
  }
}

export function validateTargetS3ProofReferences(values: TargetS3ProofReferenceValues): void {
  assertPresent('S3_PROOF_BUCKET', values.s3ProofBucket);
  assertPresent('S3_PROOF_PREFIX', values.s3ProofPrefix);
  assertNoLegacyMarker('S3_PROOF_BUCKET', values.s3ProofBucket);
  assertNoLegacyMarker('S3_PROOF_PREFIX', values.s3ProofPrefix);

  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(values.s3ProofBucket)) {
    throw targetReferenceError('S3_PROOF_BUCKET', 'S3_PROOF_BUCKET must be a valid S3 bucket name.');
  }
  if (!isTargetResourceName(values.s3ProofBucket, 'proof-artifacts')) {
    throw targetReferenceError(
      'S3_PROOF_BUCKET',
      'S3_PROOF_BUCKET must reference the Terraform-managed target proof/artifact bucket.',
    );
  }
  if (values.s3ProofPrefix !== TARGET_PROOF_ARTIFACT_PREFIX) {
    throw targetReferenceError(
      'S3_PROOF_PREFIX',
      'S3_PROOF_PREFIX must match the Terraform-managed target proof/artifact prefix.',
    );
  }
}

export function validateTargetRuntimeReferences(
  values: TargetRuntimeReferenceValues,
  options: TargetReferenceValidationOptions = {},
): void {
  validateQueueUrl(values.proverWorkQueueUrl, options);
  validateStateMachineArn(values.proverStateMachineArn, options);
  validateVerifierFunctionName(values.verificationWorkerFunctionName, options);
  validateTargetS3ProofReferences(values);
}
