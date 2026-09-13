import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertGuestSafePortalText, checkCatalogInputs } from './catalog-policy';

describe('account-free Backstage inputs', () => {
  it('validates the exact catalog graph and isolated TechDocs source', async () => {
    const result = await checkCatalogInputs(path.resolve(process.cwd()));

    expect(result.entityRefs).toEqual([
      'api:default/stark-ballot-api',
      'component:default/api',
      'component:default/prover',
      'component:default/release-ledger',
      'component:default/verifier-service',
      'component:default/web',
      'component:default/zkvm-guest',
      'system:default/stark-ballot-simulator',
      'user:default/hwatanabe-jp',
    ]);
    expect(result.techDocsPages).toEqual([
      'architecture.md',
      'exact-source-releases.md',
      'index.md',
      'release-lanes.md',
      'verification-honesty.md',
    ]);
    expect(result.apiDefinitionPath).toBe('openapi/stark-ballot-api.openapi.json');
    expect(result.catalogGraph).toMatchObject({
      'api:default/stark-ballot-api': {
        spec: {
          owner: 'user:default/hwatanabe-jp',
          system: 'system:default/stark-ballot-simulator',
        },
      },
      'component:default/api': {
        spec: {
          dependsOn: [
            'component:default/prover',
            'component:default/release-ledger',
            'component:default/verifier-service',
          ],
          providesApis: ['api:default/stark-ballot-api'],
        },
      },
      'component:default/prover': {
        spec: { dependsOn: ['component:default/release-ledger', 'component:default/zkvm-guest'] },
      },
      'component:default/release-ledger': {
        spec: {
          owner: 'user:default/hwatanabe-jp',
          system: 'system:default/stark-ballot-simulator',
          type: 'library',
        },
      },
      'component:default/web': { spec: { consumesApis: ['api:default/stark-ballot-api'] } },
      'system:default/stark-ballot-simulator': {
        spec: { owner: 'user:default/hwatanabe-jp', type: 'product' },
      },
      'user:default/hwatanabe-jp': { spec: { memberOf: [] } },
    });
  });

  it.each([
    ['AWS ARN', ['arn', 'aws', 's3', '', '', 'private-bucket'].join(':')],
    ['AWS account ID', `account ${['1234', '5678', '9012'].join('')}`],
    ['deployment target', ['stark-dev', 'develop'].join('/')],
    ['AWS resource URL', ['https://bucket', 's3', 'ap-northeast-1', 'amazonaws', 'com/object'].join('.')],
    ['private hostname', ['https://portal', 'internal/path'].join('.')],
    ['approval coordinate', ['pipeline', 'execution', 'id=example'].join('_')],
  ])('rejects a concrete %s from guest-safe portal text', (label, value) => {
    expect(() => assertGuestSafePortalText(value, 'fixture')).toThrow(`prohibited ${label}`);
  });
});
