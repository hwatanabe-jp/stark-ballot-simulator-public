import { describe, expect, it } from 'vitest';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import { assertAppInitializationObjectNeverPublished } from './app-verifier-initialization.js';
import {
  assertFoundationInitialStateObjectNeverPublished,
  foundationInitialStateObjects,
} from './saved-plan-review.js';

const targetKey = 'stark-prod/main';
const app = resolveDeploymentLaneAuthority(resolveAllowedDeploymentTarget(targetKey), 'app');
const scopes = [
  ...foundationInitialStateObjects(targetKey).map((scope) => ({
    ...scope,
    lane: 'foundation',
    admit: assertFoundationInitialStateObjectNeverPublished,
  })),
  ...(['state', 'acceptance'] as const).map((kind) => ({
    kind,
    lane: 'app',
    bucket: kind === 'state' ? app.names.terraformStateBucket : app.names.appRetainedArtifactBucket,
    key: kind === 'state' ? app.backendKey : app.names.acceptedDeploymentPointerKey,
    admit: assertAppInitializationObjectNeverPublished,
  })),
];

describe.each(scopes)('$lane $kind first-publication inventory encoding', (scope) => {
  const versions = {
    Name: scope.bucket,
    Prefix: scope.key,
    IsTruncated: false,
    KeyMarker: '',
    VersionIdMarker: '',
    MaxKeys: 1,
    ...(scope.kind === 'state' ? { Delimiter: '.', CommonPrefixes: [{ Prefix: `${scope.key}.` }] } : {}),
  };
  function admit(overrides: Record<string, unknown>) {
    return scope.admit(
      { versioning: { Status: 'Enabled' }, versions: { ...versions, ...overrides } },
      scope.kind,
      targetKey,
    );
  }

  it.each([{}, { EncodingType: '' }, { EncodingType: 'url' }])(
    'admits native empty inventory metadata %j',
    (encoding) => {
      expect(admit(encoding)).toMatchObject({ bucket: scope.bucket, key: scope.key });
    },
  );

  it('rejects malformed encoding, changed coordinates, history and pagination even with URL encoding', () => {
    for (const overrides of [
      { EncodingType: null },
      { EncodingType: 'URL' },
      { EncodingType: 'unknown' },
      { EncodingType: 1 },
      { Prefix: encodeURIComponent(scope.key) },
      { Name: 'another-bucket' },
      { Delimiter: '%2E' },
      { CommonPrefixes: [{ Prefix: encodeURIComponent(`${scope.key}.`) }] },
      { IsTruncated: true },
      { Versions: [{ Key: scope.key, VersionId: 'retained' }] },
      { DeleteMarkers: [{ Key: scope.key, VersionId: 'deleted' }] },
      { KeyMarker: 'skipped' },
      { VersionIdMarker: 'skipped' },
      { NextKeyMarker: 'more' },
      { NextVersionIdMarker: 'more' },
      { NextToken: 'more' },
      { ContinuationToken: 'more' },
    ]) {
      expect(() => admit({ EncodingType: 'url', ...overrides })).toThrow('empty inventory');
    }
  });
});
