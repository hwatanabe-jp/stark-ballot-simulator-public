import { resolveRuntimeProfile, type ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

const TARGET_ACCOUNT_ID = '123456789012';
const TARGET_REGION = 'ap-northeast-1';

function tableArn(name: string): string {
  return `arn:aws:dynamodb:${TARGET_REGION}:${TARGET_ACCOUNT_ID}:table/${name}`;
}

export function targetRuntimeProfileEnv(deploymentEnvironment: 'develop' | 'main' = 'develop'): NodeJS.ProcessEnv {
  const accountAlias = deploymentEnvironment === 'develop' ? 'stark-dev' : 'stark-prod';
  const resourcePrefix = `stark-ballot-simulator-${accountAlias}-${deploymentEnvironment}`;
  const referencePrefix = `/stark-ballot-simulator/${accountAlias}/${deploymentEnvironment}/app`;
  return {
    RUNTIME_PROFILE: 'target-aws-async',
    RUNTIME_DEPLOYMENT_ENV: deploymentEnvironment,
    AWS_ACCOUNT_ID: TARGET_ACCOUNT_ID,
    AWS_REGION: TARGET_REGION,
    DYNAMODB_SESSIONS_TABLE: tableArn(`${resourcePrefix}-sessions`),
    DYNAMODB_VOTES_TABLE: tableArn(`${resourcePrefix}-votes`),
    RATE_LIMIT_EVENTS_TABLE: tableArn(`${resourcePrefix}-rate-limit-events`),
    RATE_LIMIT_COUNTERS_TABLE: tableArn(`${resourcePrefix}-rate-limit-counters`),
    PROVER_WORK_QUEUE_URL: `https://sqs.${TARGET_REGION}.amazonaws.com/${TARGET_ACCOUNT_ID}/${resourcePrefix}-prover-work`,
    VERIFICATION_WORK_QUEUE_URL: `https://sqs.${TARGET_REGION}.amazonaws.com/${TARGET_ACCOUNT_ID}/${resourcePrefix}-verification-work`,
    PROVER_STATE_MACHINE_ARN: `arn:aws:states:${TARGET_REGION}:${TARGET_ACCOUNT_ID}:stateMachine:${resourcePrefix}-finalization`,
    VERIFICATION_WORKER_FUNCTION_NAME: `${resourcePrefix}-verification-worker`,
    S3_PROOF_BUCKET: `${resourcePrefix}-proof-artifacts`,
    S3_PROOF_PREFIX: 'sessions/',
    VERIFIER_PUBLIC_BASE_URL:
      deploymentEnvironment === 'develop'
        ? 'https://develop.stark-ballot-sim.hwatanabe.dev'
        : 'https://stark-ballot-sim.hwatanabe.dev',
    EXPECTED_IMAGE_ID: `0x${'1'.repeat(64)}`,
    SESSION_CAPABILITY_SECRET_REF: `${referencePrefix}/secrets/session-capability-secret`,
    VOTE_SECRET_ENCRYPTION_KEY_REF: `${referencePrefix}/secrets/vote-secret-encryption-key`,
    SESSION_CAPABILITY_TTL_SECONDS_REF: `${referencePrefix}/config/session-capability-ttl-seconds`,
    TURNSTILE_SECRET_KEY_REF: `${referencePrefix}/secrets/turnstile-secret-key`,
    EXPECTED_ORIGIN_VERIFY_HEADER_REF: `${referencePrefix}/secrets/expected-origin-verify-header`,
    LOG_IP_HASH_SALT_REF: `${referencePrefix}/secrets/log-ip-hash-salt`,
    TURNSTILE_ALLOWED_HOSTNAMES:
      deploymentEnvironment === 'develop' ? 'develop.stark-ballot-sim.hwatanabe.dev' : 'stark-ballot-sim.hwatanabe.dev',
    TRUSTED_PROXY: 'api-gateway',
  };
}

export function localRuntimeProfile(
  name: 'local-demo' | 'static-mock-e2e' | 'local-proof-development' | 'local-proof-production' = 'local-demo',
): ResolvedRuntimeProfile {
  return resolveRuntimeProfile({ RUNTIME_PROFILE: name });
}

export function targetRuntimeProfile(deploymentEnvironment: 'develop' | 'main' = 'develop'): ResolvedRuntimeProfile {
  return resolveRuntimeProfile(targetRuntimeProfileEnv(deploymentEnvironment));
}
