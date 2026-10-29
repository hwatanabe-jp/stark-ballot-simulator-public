import { describe, expect, it } from 'vitest';
import {
  FOUNDATION_CONSUMER_REQUIREMENTS,
  FOUNDATION_CONTRACT_CLOSURE_IDENTITY,
  admitFoundationConsumerContract,
  computeFoundationSourceContract,
} from './foundation-contract.js';

const NONSECRET_INPUTS = Object.freeze({
  accountAlias: 'stark-dev',
  awsAccountId: '123456789012',
  awsRegion: 'ap-northeast-1',
  deploymentEnvironment: 'develop',
  deploymentTargetKey: 'stark-dev/develop',
  projectName: 'stark-ballot-simulator',
  publicHostnameDisposition: 'external-dns-acm',
  stateBackendKey: 'terraform/stark-dev/develop/foundation.tfstate',
  stateScope: 'foundation',
});

describe('Foundation explicit consumer contract', () => {
  const input = { nonsecretInputs: NONSECRET_INPUTS, requirements: FOUNDATION_CONSUMER_REQUIREMENTS };
  it('binds explicit requirements and target inputs without implementation-file inputs', () => {
    const contract = computeFoundationSourceContract(input);
    expect(admitFoundationConsumerContract(JSON.parse(JSON.stringify(contract)))).toEqual(contract);
    expect(contract.closureIdentity).toBe(FOUNDATION_CONTRACT_CLOSURE_IDENTITY);
    expect(
      computeFoundationSourceContract({
        ...input,
        nonsecretInputs: { ...NONSECRET_INPUTS, awsAccountId: '999999999999' },
      }).foundationContractHash,
    ).not.toBe(contract.foundationContractHash);
    expect(() => computeFoundationSourceContract({ ...input, files: [] })).toThrow();
  });
  it.each([
    {
      ...FOUNDATION_CONSUMER_REQUIREMENTS,
      networking: { ...FOUNDATION_CONSUMER_REQUIREMENTS.networking, ingress: ['tcp'] },
    },
    {
      ...FOUNDATION_CONSUMER_REQUIREMENTS,
      networking: { ...FOUNDATION_CONSUMER_REQUIREMENTS.networking, subnetsInVpc: false },
    },
    {
      ...FOUNDATION_CONSUMER_REQUIREMENTS,
      images: { ...FOUNDATION_CONSUMER_REQUIREMENTS.images, tagMutability: 'MUTABLE' },
    },
    { ...FOUNDATION_CONSUMER_REQUIREMENTS, extra: true },
    {},
    null,
  ])('rejects incompatible resource requirements', (requirements) => {
    expect(() => computeFoundationSourceContract({ ...input, requirements })).toThrow();
  });
  it('rejects the removed source-closure record and changed contract identity', () => {
    const contract = computeFoundationSourceContract(input);
    expect(() =>
      admitFoundationConsumerContract({
        closureIdentity: contract.closureIdentity,
        foundationContractHash: contract.foundationContractHash,
      }),
    ).toThrow();
    expect(() => admitFoundationConsumerContract({ ...contract, closureIdentity: 'a'.repeat(64) })).toThrow();
  });
});
