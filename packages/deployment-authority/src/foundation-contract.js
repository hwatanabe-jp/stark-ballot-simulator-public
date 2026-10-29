import { snapshotDataTree } from './descriptor-snapshot.js';
import { canonicalJsonSha256, deepFreeze, parseSha256, requireExactKeys, requireString } from './internal.js';

// These are consumer requirements, not a digest of deployment implementation.
// Owning Smoke admits the resource-derived Apply output and checks live signing/retention.
export const FOUNDATION_CONSUMER_REQUIREMENTS = deepFreeze({
  networking: {
    dnsHostnames: true,
    dnsSupport: true,
    ingress: [],
    ipv4Egress: ['0.0.0.0/0'],
    ipv6Egress: [],
    allProtocolsEgress: true,
    egressRuleCount: 1,
    subnetsInVpc: true,
    securityGroupInVpc: true,
    publicSubnets: true,
    subnetCount: 2,
    securityGroupCount: 1,
    internetGatewayRoute: true,
  },
  images: {
    tagMutability: 'IMMUTABLE',
    scanOnPush: true,
    proverSigningStatusRequired: 'COMPLETE',
    retentionPolicy: 'newest-five-images',
  },
});

// Retain the approval reference's field names in this first cutover. Its identity
// now names the explicit consumer schema; it never represents a source closure.
export const FOUNDATION_CONTRACT_CLOSURE_IDENTITY = canonicalJsonSha256({
  contractType: 'foundation-consumer-requirements',
  fields: ['images', 'networking'],
});

/** @param {unknown} value */
export function admitFoundationConsumerRequirements(value) {
  if (canonicalJsonSha256(value) !== canonicalJsonSha256(FOUNDATION_CONSUMER_REQUIREMENTS)) {
    throw new Error('Foundation consumer requirements do not match the selected source.');
  }
  return FOUNDATION_CONSUMER_REQUIREMENTS;
}

const MAX_PATH_BYTES = 1024;
/** @param {unknown} value @param {string} label @returns {string} */
function requireRepositoryPath(value, label) {
  const path = requireString(value, label);
  if (
    Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES ||
    path.startsWith('/') ||
    /^[A-Za-z]:\//u.test(path) ||
    path.includes('\\') ||
    path.endsWith('/') ||
    path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} must be a normalized POSIX repository-relative path`);
  }
  return path;
}

const NONSECRET_INPUT_KEYS = [
  'accountAlias',
  'awsAccountId',
  'awsRegion',
  'deploymentEnvironment',
  'deploymentTargetKey',
  'projectName',
  'publicHostnameDisposition',
  'stateBackendKey',
  'stateScope',
];
const SOURCE_CONTRACT_KEYS = ['closureIdentity', 'foundationContractHash'];

/** @param {unknown} value @returns {Readonly<Record<string, string>>} */
function admitNonsecretInputs(value) {
  const inputs = requireExactKeys(value, NONSECRET_INPUT_KEYS, 'Foundation contract nonsecret inputs');
  const admitted = {
    accountAlias: requireString(inputs['accountAlias'], 'Foundation account alias', /^[a-z][a-z0-9-]{1,62}$/u),
    awsAccountId: requireString(inputs['awsAccountId'], 'Foundation AWS account ID', /^[0-9]{12}$/u),
    awsRegion: requireString(inputs['awsRegion'], 'Foundation AWS region', /^[a-z]{2}-[a-z]+-[0-9]$/u),
    deploymentEnvironment: requireString(
      inputs['deploymentEnvironment'],
      'Foundation deployment environment',
      /^[a-z][a-z0-9-]{1,62}$/u,
    ),
    deploymentTargetKey: requireString(
      inputs['deploymentTargetKey'],
      'Foundation deployment target key',
      /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/u,
    ),
    projectName: requireString(inputs['projectName'], 'Foundation project name'),
    publicHostnameDisposition: requireString(
      inputs['publicHostnameDisposition'],
      'Foundation public hostname disposition',
      /^(?:external-dns-acm|foundation-owned-dns-acm|generated-cloudfront-hostname)$/u,
    ),
    stateBackendKey: requireRepositoryPath(inputs['stateBackendKey'], 'Foundation state backend key'),
    stateScope: requireString(inputs['stateScope'], 'Foundation state scope', /^foundation$/u),
  };
  if (admitted.projectName.length > 128) {
    throw new Error('Foundation project name is too long');
  }
  return deepFreeze(admitted);
}

/**
 * Admit and detach the exact canonical nonsecret hash-input projection shared
 * by Foundation publication and forward consumers.
 *
 * @param {unknown} value
 * @returns {Readonly<Record<string, string>>}
 */
function admitFoundationContractNonsecretInputs(value) {
  return admitNonsecretInputs(snapshotDataTree(value, 'Foundation contract nonsecret input snapshot'));
}

/** @param {unknown} value */
export function computeFoundationSourceContract(value) {
  const input = requireExactKeys(value, ['nonsecretInputs', 'requirements'], 'Foundation consumer contract');
  const nonsecretInputs = admitFoundationContractNonsecretInputs(input['nonsecretInputs']);
  const requirements = admitFoundationConsumerRequirements(input['requirements']);
  return deepFreeze({
    closureIdentity: FOUNDATION_CONTRACT_CLOSURE_IDENTITY,
    foundationContractHash: canonicalJsonSha256({ nonsecretInputs, requirements }),
    requirements,
  });
}

/** @param {unknown} value */
export function admitFoundationConsumerContract(value) {
  const input = requireExactKeys(
    value,
    ['closureIdentity', 'foundationContractHash', 'requirements'],
    'Foundation consumer contract',
  );
  return deepFreeze({
    ...admitFoundationSourceContract({
      closureIdentity: input['closureIdentity'],
      foundationContractHash: input['foundationContractHash'],
    }),
    requirements: admitFoundationConsumerRequirements(input['requirements']),
  });
}

/**
 * Strictly admit the pure source-contract observation returned by an injected
 * producer or consumer source observer.
 *
 * @param {unknown} value
 * @returns {{ readonly closureIdentity: string; readonly foundationContractHash: string }}
 */
function admitFoundationSourceContract(value) {
  const snapshot = snapshotDataTree(value, 'Foundation source contract snapshot');
  const contract = requireExactKeys(snapshot, SOURCE_CONTRACT_KEYS, 'Foundation source contract');
  const closureIdentity = parseSha256(contract['closureIdentity'], 'Foundation closure identity');
  if (closureIdentity !== FOUNDATION_CONTRACT_CLOSURE_IDENTITY) {
    throw new Error('Foundation source contract closure identity is not current');
  }
  const foundationContractHash = parseSha256(contract['foundationContractHash'], 'Foundation contract hash');
  return deepFreeze({ closureIdentity, foundationContractHash });
}
