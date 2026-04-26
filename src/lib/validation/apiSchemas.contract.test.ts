import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  SessionResponseSchema,
  VoteResponseSchema,
  ProgressResponseSchema,
  FinalizeAcceptedResponseSchema,
  FinalizeCancelResponseSchema,
  FinalizeSyncResponseSchema,
  SessionStatusResponseSchema,
  VerifyResponseSchema,
  VerificationRunResponseSchema,
  BotDataResponseSchema,
  BulletinProofResponseSchema,
} from './apiSchemas';
import sessionFixture from '@/lib/mock-api/fixtures/json/session.post.json';
import voteFixture from '@/lib/mock-api/fixtures/json/vote.post.json';
import progressFixture from '@/lib/mock-api/fixtures/json/progress.get.json';
import finalizeAcceptedFixture from '@/lib/mock-api/fixtures/json/finalize.post.accepted.json';
import finalizeSyncFixture from '@/lib/mock-api/fixtures/json/finalize.post.sync.json';
import statusPendingFixture from '@/lib/mock-api/fixtures/json/sessions.status.pending.json';
import statusRunningFixture from '@/lib/mock-api/fixtures/json/sessions.status.running.json';
import statusSucceededFixture from '@/lib/mock-api/fixtures/json/sessions.status.succeeded.json';
import verifyS0Fixture from '@/lib/mock-api/fixtures/json/verify.get.S0.json';
import verifyS1Fixture from '@/lib/mock-api/fixtures/json/verify.get.S1.json';
import verifyS2Fixture from '@/lib/mock-api/fixtures/json/verify.get.S2.json';
import verifyS3Fixture from '@/lib/mock-api/fixtures/json/verify.get.S3.json';
import verifyS4Fixture from '@/lib/mock-api/fixtures/json/verify.get.S4.json';
import verifyS5Fixture from '@/lib/mock-api/fixtures/json/verify.get.S5.json';
import verificationRunFixture from '@/lib/mock-api/fixtures/json/verification.run.post.json';
import botdataFixture from '@/lib/mock-api/fixtures/json/botdata.get.json';

type ContractFixture = {
  name: string;
  schema: AnyZod;
  fixture: unknown;
};

type SchemaCase = {
  name: string;
  schema: AnyZod;
  fixtures: unknown[];
};

type AnyZod = z.ZodType<unknown, z.ZodTypeDef, unknown>;
type AnyZodObject = z.ZodObject<Record<string, AnyZod>, 'strip' | 'strict' | 'passthrough', AnyZod, unknown, unknown>;
type AnyZodUnion = z.ZodUnion<[AnyZod, ...AnyZod[]]>;
type AnyZodArray = z.ZodArray<AnyZod, 'many'> | z.ZodArray<AnyZod, 'atleastone'>;
type AnyZodIntersection = z.ZodIntersection<AnyZod, AnyZod>;
type AnyDiscriminatedUnion = z.ZodDiscriminatedUnion<string, z.ZodDiscriminatedUnionOption<string>[]>;

const HEX32_NORMALIZED = /^0x[0-9a-f]{64}$/;

const statusUnsupportedArtifactFixture = {
  ...statusRunningFixture,
  artifactState: 'unsupported_current_artifact' as const,
};

const CONTRACT_FIXTURES: ContractFixture[] = [
  { name: 'session', schema: SessionResponseSchema, fixture: sessionFixture },
  { name: 'vote', schema: VoteResponseSchema, fixture: voteFixture },
  { name: 'progress', schema: ProgressResponseSchema, fixture: progressFixture },
  { name: 'finalize-accepted', schema: FinalizeAcceptedResponseSchema, fixture: finalizeAcceptedFixture },
  { name: 'finalize-sync', schema: FinalizeSyncResponseSchema, fixture: finalizeSyncFixture },
  { name: 'session-status-pending', schema: SessionStatusResponseSchema, fixture: statusPendingFixture },
  { name: 'session-status-running', schema: SessionStatusResponseSchema, fixture: statusRunningFixture },
  { name: 'session-status-succeeded', schema: SessionStatusResponseSchema, fixture: statusSucceededFixture },
  {
    name: 'session-status-unsupported-artifact',
    schema: SessionStatusResponseSchema,
    fixture: statusUnsupportedArtifactFixture,
  },
  { name: 'verify-s0', schema: VerifyResponseSchema, fixture: verifyS0Fixture },
  { name: 'verify-s1', schema: VerifyResponseSchema, fixture: verifyS1Fixture },
  { name: 'verify-s2', schema: VerifyResponseSchema, fixture: verifyS2Fixture },
  { name: 'verify-s3', schema: VerifyResponseSchema, fixture: verifyS3Fixture },
  { name: 'verify-s4', schema: VerifyResponseSchema, fixture: verifyS4Fixture },
  { name: 'verify-s5', schema: VerifyResponseSchema, fixture: verifyS5Fixture },
  { name: 'verification-run', schema: VerificationRunResponseSchema, fixture: verificationRunFixture },
  { name: 'botdata', schema: BotDataResponseSchema, fixture: botdataFixture },
];

const SCHEMA_CASES: SchemaCase[] = [
  { name: 'SessionResponse', schema: SessionResponseSchema, fixtures: [sessionFixture] },
  { name: 'VoteResponse', schema: VoteResponseSchema, fixtures: [voteFixture] },
  { name: 'ProgressResponse', schema: ProgressResponseSchema, fixtures: [progressFixture] },
  { name: 'FinalizeAcceptedResponse', schema: FinalizeAcceptedResponseSchema, fixtures: [finalizeAcceptedFixture] },
  { name: 'FinalizeSyncResponse', schema: FinalizeSyncResponseSchema, fixtures: [finalizeSyncFixture] },
  {
    name: 'SessionStatusResponse',
    schema: SessionStatusResponseSchema,
    fixtures: [statusPendingFixture, statusRunningFixture, statusSucceededFixture, statusUnsupportedArtifactFixture],
  },
  {
    name: 'VerifyResponse',
    schema: VerifyResponseSchema,
    fixtures: [verifyS0Fixture, verifyS1Fixture, verifyS2Fixture, verifyS3Fixture, verifyS4Fixture, verifyS5Fixture],
  },
  { name: 'VerificationRunResponse', schema: VerificationRunResponseSchema, fixtures: [verificationRunFixture] },
  { name: 'BotDataResponse', schema: BotDataResponseSchema, fixtures: [botdataFixture] },
];

const OPTIONAL_COVERAGE_EXCEPTIONS: Record<string, string[]> = {
  FinalizeAcceptedResponse: [
    'state.startedAt',
    'state.completedAt',
    'state.failedAt',
    'state.timeoutAt',
    'state.error.details',
    'state.stepFunctionsArn',
  ],
  FinalizeSyncResponse: [
    'data.receipt.metadata',
    'data.verificationReport.dev_mode_receipt',
    'data.verificationReport.expected_image_id',
    'data.verificationReport.receipt_image_id',
    'data.verificationReport.verified_at',
    'data.verificationReport.verifier_version',
  ],
  SessionStatusResponse: [
    'finalizationState.error.details',
    'finalizationState.stepFunctionsArn',
    'finalizationResult.journal.imageId',
    'finalizationResult.closeStatement',
    'finalizationResult.electionManifest',
    'finalizationResult.verificationResult.report.errors[]',
  ],
  VerifyResponse: [
    'data.journal',
    'data.journal.imageId',
    'data.verificationReport.dev_mode_receipt',
    'data.verificationReport.expected_image_id',
    'data.verificationReport.receipt_image_id',
    'data.verificationReport.verified_at',
    'data.verificationReport.verifier_version',
  ],
};

const RETIRED_PUBLIC_BOUNDARY_KEYS = new Set([
  'missingIndices',
  'invalidIndices',
  'countedIndices',
  'excludedCount',
  'verificationBundleUrl',
  'verificationReportUrl',
  's3BundleUrl',
  's3BundleExpiresAt',
  's3BundleKey',
  's3ReportKey',
  's3UploadedAt',
  'refreshS3',
  'proofMode',
]);

const getInnerType = (schema: z.ZodOptional<AnyZod> | z.ZodNullable<AnyZod> | z.ZodDefault<AnyZod>): AnyZod =>
  schema._def.innerType;

const getEffectSchema = (schema: z.ZodEffects<AnyZod>): AnyZod => schema._def.schema;

const getArrayItem = (schema: AnyZodArray): AnyZod => schema._def.type;

const getObjectShape = (schema: AnyZodObject): Record<string, AnyZod> => schema.shape;

const getUnionOptions = (schema: AnyZodUnion): AnyZod[] => schema._def.options;

const getIntersectionMembers = (schema: AnyZodIntersection): [AnyZod, AnyZod] => [schema._def.left, schema._def.right];

const buildUnionSchema = (options: AnyZod[]): AnyZod => {
  if (options.length === 0) {
    throw new Error('Expected at least one union option');
  }
  if (options.length === 1) {
    return options[0];
  }
  return z.union(options as [AnyZod, AnyZod, ...AnyZod[]]);
};

const getDiscriminatedOptions = (schema: AnyDiscriminatedUnion): Iterable<AnyZod> => {
  const rawOptions = (schema as unknown as { _def?: { options?: unknown } })._def?.options;
  if (rawOptions instanceof Map) {
    return rawOptions.values() as Iterable<AnyZod>;
  }
  if (Array.isArray(rawOptions)) {
    return rawOptions as AnyZod[];
  }
  return [];
};

const unwrapSchema = (schema: AnyZod): AnyZod => {
  let current: AnyZod = schema;
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable || current instanceof z.ZodDefault) {
      current = getInnerType(current as z.ZodOptional<AnyZod> | z.ZodNullable<AnyZod> | z.ZodDefault<AnyZod>);
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = getEffectSchema(current as z.ZodEffects<AnyZod>);
      continue;
    }
    return current;
  }
};

const hasHex32Description = (schema: AnyZod): boolean => {
  const described = schema as { description?: string; _def?: { description?: string } };
  return described.description === 'hex32' || described._def?.description === 'hex32';
};

const isHex32Schema = (schema: AnyZod): boolean => {
  if (hasHex32Description(schema)) {
    return true;
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
    return isHex32Schema(getInnerType(schema as z.ZodOptional<AnyZod> | z.ZodNullable<AnyZod> | z.ZodDefault<AnyZod>));
  }
  if (schema instanceof z.ZodEffects) {
    return hasHex32Description(schema) || isHex32Schema(getEffectSchema(schema as z.ZodEffects<AnyZod>));
  }
  return false;
};

type HexPath = { segments: string[] };

const collectHex32Paths = (schema: AnyZod, base: string[] = []): HexPath[] => {
  if (isHex32Schema(schema)) {
    return [{ segments: base }];
  }
  const unwrapped = unwrapSchema(schema);
  if (unwrapped instanceof z.ZodObject) {
    const shape = getObjectShape(unwrapped as AnyZodObject);
    return Object.keys(shape).flatMap((key) => collectHex32Paths(shape[key], [...base, key]));
  }
  if (unwrapped instanceof z.ZodArray) {
    return collectHex32Paths(getArrayItem(unwrapped as AnyZodArray), [...base, '*']);
  }
  if (unwrapped instanceof z.ZodUnion) {
    return getUnionOptions(unwrapped as AnyZodUnion).flatMap((option) => collectHex32Paths(option, base));
  }
  if (unwrapped instanceof z.ZodIntersection) {
    const [left, right] = getIntersectionMembers(unwrapped as AnyZodIntersection);
    return [...collectHex32Paths(left, base), ...collectHex32Paths(right, base)];
  }
  if (unwrapped instanceof z.ZodDiscriminatedUnion) {
    return Array.from(getDiscriminatedOptions(unwrapped as AnyDiscriminatedUnion)).flatMap((option) =>
      collectHex32Paths(option, base),
    );
  }
  return [];
};

const collectValues = (value: unknown, segments: string[]): unknown[] => {
  if (segments.length === 0) {
    return [value];
  }
  const [head, ...rest] = segments;
  if (head === '*') {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.flatMap((entry) => collectValues(entry, rest));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (!(head in record)) {
      return [];
    }
    return collectValues(record[head], rest);
  }
  return [];
};

const formatHexPath = (segments: string[]): string =>
  segments.reduce((acc, seg) => {
    if (seg === '*') {
      return `${acc}[]`;
    }
    if (!acc) {
      return seg;
    }
    return `${acc}.${seg}`;
  }, '');

const formatPath = (segments: string[]): string =>
  segments.reduce((acc, seg) => {
    if (seg === '[]') {
      return `${acc}[]`;
    }
    if (!acc) {
      return seg;
    }
    return `${acc}.${seg}`;
  }, '');

type LeafPathInfo = {
  path: string;
  optional: boolean;
};

const collectLeafPathsWithOptionality = (
  schema: AnyZod,
  base: string[] = [],
  parentOptional = false,
): LeafPathInfo[] => {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return collectLeafPathsWithOptionality(
      getInnerType(schema as z.ZodOptional<AnyZod> | z.ZodDefault<AnyZod>),
      base,
      true,
    );
  }
  if (schema instanceof z.ZodNullable) {
    return collectLeafPathsWithOptionality(getInnerType(schema as z.ZodNullable<AnyZod>), base, parentOptional);
  }
  if (schema instanceof z.ZodEffects) {
    return collectLeafPathsWithOptionality(getEffectSchema(schema as z.ZodEffects<AnyZod>), base, parentOptional);
  }
  if (isHex32Schema(schema)) {
    return [{ path: formatPath(base), optional: parentOptional }];
  }
  if (schema instanceof z.ZodObject) {
    const shape = getObjectShape(schema as AnyZodObject);
    return Object.keys(shape).flatMap((key) =>
      collectLeafPathsWithOptionality(shape[key], [...base, key], parentOptional),
    );
  }
  if (schema instanceof z.ZodArray) {
    return collectLeafPathsWithOptionality(getArrayItem(schema as AnyZodArray), [...base, '[]'], parentOptional);
  }
  if (schema instanceof z.ZodUnion) {
    return getUnionOptions(schema as AnyZodUnion).flatMap((option) =>
      collectLeafPathsWithOptionality(option, base, parentOptional),
    );
  }
  if (schema instanceof z.ZodIntersection) {
    const [left, right] = getIntersectionMembers(schema as AnyZodIntersection);
    return [
      ...collectLeafPathsWithOptionality(left, base, parentOptional),
      ...collectLeafPathsWithOptionality(right, base, parentOptional),
    ];
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return Array.from(getDiscriminatedOptions(schema as AnyDiscriminatedUnion)).flatMap((option) =>
      collectLeafPathsWithOptionality(option, base, parentOptional),
    );
  }
  return [{ path: formatPath(base), optional: parentOptional }];
};

const collectLeafValuePaths = (value: unknown, base: string[] = []): string[] => {
  if (Array.isArray(value)) {
    const path = formatPath([...base, '[]']);
    const nested = value.flatMap((entry) => collectLeafValuePaths(entry, [...base, '[]']));
    return nested.length > 0 ? nested : [path];
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record).flatMap((key) => collectLeafValuePaths(record[key], [...base, key]));
  }
  return [formatPath(base)];
};

const collectRetiredPublicBoundaryPaths = (value: unknown, base: string[] = []): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectRetiredPublicBoundaryPaths(entry, [...base, '[]']));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  return Object.keys(record).flatMap((key) => {
    const path = [...base, key];
    const nested = collectRetiredPublicBoundaryPaths(record[key], path);
    return RETIRED_PUBLIC_BOUNDARY_KEYS.has(key) ? [formatPath(path), ...nested] : nested;
  });
};

const mergeStrictObjectSchemas = (leftSchema: AnyZodObject, rightSchema: AnyZodObject): AnyZodObject => {
  const leftShape = getObjectShape(leftSchema);
  const rightShape = getObjectShape(rightSchema);
  const mergedShape: Record<string, AnyZod> = {};
  const keys = new Set([...Object.keys(leftShape), ...Object.keys(rightShape)]);

  for (const key of keys) {
    const hasLeftField = Object.hasOwn(leftShape, key);
    const hasRightField = Object.hasOwn(rightShape, key);
    if (hasLeftField && hasRightField) {
      const leftField = leftShape[key];
      const rightField = rightShape[key];
      mergedShape[key] = z.intersection(makeDeepStrict(leftField), makeDeepStrict(rightField));
      continue;
    }
    mergedShape[key] = makeDeepStrict(hasLeftField ? leftShape[key] : rightShape[key]);
  }

  return z.object(mergedShape).strict() as AnyZodObject;
};

const makeDeepStrictIntersection = (left: AnyZod, right: AnyZod): AnyZod => {
  const leftUnwrapped = unwrapSchema(left);
  const rightUnwrapped = unwrapSchema(right);

  if (leftUnwrapped instanceof z.ZodObject && rightUnwrapped instanceof z.ZodObject) {
    return mergeStrictObjectSchemas(leftUnwrapped as AnyZodObject, rightUnwrapped as AnyZodObject);
  }
  if (leftUnwrapped instanceof z.ZodObject && rightUnwrapped instanceof z.ZodUnion) {
    const options = getUnionOptions(rightUnwrapped as AnyZodUnion).map((option) =>
      makeDeepStrictIntersection(left, option),
    );
    return buildUnionSchema(options);
  }
  if (leftUnwrapped instanceof z.ZodUnion && rightUnwrapped instanceof z.ZodObject) {
    const options = getUnionOptions(leftUnwrapped as AnyZodUnion).map((option) =>
      makeDeepStrictIntersection(option, right),
    );
    return buildUnionSchema(options);
  }
  if (leftUnwrapped instanceof z.ZodObject && rightUnwrapped instanceof z.ZodDiscriminatedUnion) {
    const options = Array.from(getDiscriminatedOptions(rightUnwrapped as AnyDiscriminatedUnion)).map((option) =>
      makeDeepStrictIntersection(left, option),
    );
    return buildUnionSchema(options);
  }
  if (leftUnwrapped instanceof z.ZodDiscriminatedUnion && rightUnwrapped instanceof z.ZodObject) {
    const options = Array.from(getDiscriminatedOptions(leftUnwrapped as AnyDiscriminatedUnion)).map((option) =>
      makeDeepStrictIntersection(option, right),
    );
    return buildUnionSchema(options);
  }
  return z.intersection(makeDeepStrict(left), makeDeepStrict(right));
};

const makeDeepStrict = (schema: AnyZod): AnyZod => {
  if (schema instanceof z.ZodOptional) {
    return makeDeepStrict(getInnerType(schema as z.ZodOptional<AnyZod>)).optional();
  }
  if (schema instanceof z.ZodNullable) {
    return makeDeepStrict(getInnerType(schema as z.ZodNullable<AnyZod>)).nullable();
  }
  if (schema instanceof z.ZodDefault) {
    const inner = makeDeepStrict(getInnerType(schema as z.ZodDefault<AnyZod>));
    return inner.default(schema._def.defaultValue());
  }
  if (schema instanceof z.ZodEffects) {
    return schema;
  }
  if (schema instanceof z.ZodArray) {
    return z.array(makeDeepStrict(getArrayItem(schema as AnyZodArray)));
  }
  if (schema instanceof z.ZodIntersection) {
    const [left, right] = getIntersectionMembers(schema as AnyZodIntersection);
    return makeDeepStrictIntersection(left, right);
  }
  if (schema instanceof z.ZodObject) {
    const shape = getObjectShape(schema as AnyZodObject);
    const strictShape: Record<string, AnyZod> = {};
    for (const key of Object.keys(shape)) {
      strictShape[key] = makeDeepStrict(shape[key]);
    }
    const base = z.object(strictShape) as AnyZodObject;
    let next = base;
    const def = schema._def;
    if (!(def.catchall instanceof z.ZodNever)) {
      next = next.catchall(makeDeepStrict(def.catchall as AnyZod));
    }
    if (def.unknownKeys === 'passthrough') {
      next = next.passthrough();
    } else {
      next = next.strict();
    }
    return next;
  }
  return schema;
};

describe('api response schemas', () => {
  it('validates session response fixture', () => {
    expect(SessionResponseSchema.safeParse(sessionFixture).success).toBe(true);
  });

  it('validates vote response fixture', () => {
    expect(VoteResponseSchema.safeParse(voteFixture).success).toBe(true);
  });

  it('validates progress response fixture', () => {
    expect(ProgressResponseSchema.safeParse(progressFixture).success).toBe(true);
  });

  it('validates finalize accepted fixture', () => {
    expect(FinalizeAcceptedResponseSchema.safeParse(finalizeAcceptedFixture).success).toBe(true);
  });

  it('validates finalize sync fixture', () => {
    expect(FinalizeSyncResponseSchema.safeParse(finalizeSyncFixture).success).toBe(true);
  });

  it('requires error details when finalize state is failed', () => {
    const result = FinalizeCancelResponseSchema.safeParse({
      state: {
        status: 'failed',
        executionId: 'exec-123',
        queuedAt: 1730000000000,
        failedAt: 1730000005000,
      },
    });
    expect(result.success).toBe(false);
  });

  it('validates session status fixtures', () => {
    expect(SessionStatusResponseSchema.safeParse(statusPendingFixture).success).toBe(true);
    expect(SessionStatusResponseSchema.safeParse(statusRunningFixture).success).toBe(true);
    expect(SessionStatusResponseSchema.safeParse(statusSucceededFixture).success).toBe(true);
    expect(SessionStatusResponseSchema.safeParse(statusUnsupportedArtifactFixture).success).toBe(true);
  });

  it('validates verify fixtures', () => {
    expect(VerifyResponseSchema.safeParse(verifyS0Fixture).success).toBe(true);
    expect(VerifyResponseSchema.safeParse(verifyS1Fixture).success).toBe(true);
    expect(VerifyResponseSchema.safeParse(verifyS2Fixture).success).toBe(true);
    expect(VerifyResponseSchema.safeParse(verifyS3Fixture).success).toBe(true);
    expect(VerifyResponseSchema.safeParse(verifyS4Fixture).success).toBe(true);
    expect(VerifyResponseSchema.safeParse(verifyS5Fixture).success).toBe(true);
  });

  it('traverses VerifyResponseSchema intersections in contract helpers', () => {
    const hexPaths = collectHex32Paths(VerifyResponseSchema).map((path) => formatHexPath(path.segments));
    expect(hexPaths).toContain('data.imageId');

    const leafPaths = collectLeafPathsWithOptionality(VerifyResponseSchema).map(
      (entry) => `${entry.path}:${entry.optional}`,
    );
    expect(leafPaths).toContain('data.imageId:false');
    expect(leafPaths).toContain('data.verificationExecutionId:true');

    const strictSchema = makeDeepStrict(VerifyResponseSchema);
    const result = strictSchema.safeParse({
      ...verifyS0Fixture,
      data: {
        ...verifyS0Fixture.data,
        unexpectedCurrentContractField: true,
      },
    });
    expect(result.success).toBe(false);
  });

  it('validates verification run fixture', () => {
    expect(VerificationRunResponseSchema.safeParse(verificationRunFixture).success).toBe(true);
  });

  it('validates botdata fixture', () => {
    expect(BotDataResponseSchema.safeParse(botdataFixture).success).toBe(true);
  });

  it('rejects retired proofMode on bulletin proof responses', () => {
    const result = BulletinProofResponseSchema.safeParse({
      voteId: 'vote-1',
      proof: {
        leafIndex: 0,
        treeSize: 1,
        merklePath: [],
        bulletinRootAtCast: `0x${'1'.repeat(64)}`,
        proofMode: 'rfc6962',
      },
    });

    expect(result.success).toBe(false);
  });

  it('enforces normalized hex32 fields in fixtures', () => {
    const failures: string[] = [];
    for (const { name, schema, fixture } of CONTRACT_FIXTURES) {
      const paths = collectHex32Paths(schema);
      const uniquePaths = Array.from(new Map(paths.map((path) => [path.segments.join('.'), path])).values());
      for (const path of uniquePaths) {
        const values = collectValues(fixture, path.segments);
        if (values.length === 0) {
          continue;
        }
        for (const value of values) {
          if (typeof value !== 'string') {
            failures.push(`${name}:${formatHexPath(path.segments)} expected string, got ${typeof value}`);
            continue;
          }
          if (!HEX32_NORMALIZED.test(value)) {
            failures.push(`${name}:${formatHexPath(path.segments)} not normalized (${value})`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('rejects unknown keys in fixtures', () => {
    const failures: string[] = [];
    for (const { name, schema, fixture } of CONTRACT_FIXTURES) {
      const strictSchema = makeDeepStrict(schema);
      const result = strictSchema.safeParse(fixture);
      if (!result.success) {
        failures.push(`${name}: ${result.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('does not expose retired public boundary fields in fixtures', () => {
    const failures = CONTRACT_FIXTURES.flatMap(({ name, fixture }) =>
      collectRetiredPublicBoundaryPaths(fixture).map((path) => `${name}: ${path}`),
    );

    expect(failures).toEqual([]);
  });

  it('requires optional schema fields to appear in fixtures', () => {
    const failures: string[] = [];
    for (const { name, schema, fixtures } of SCHEMA_CASES) {
      const schemaPaths = collectLeafPathsWithOptionality(schema);
      const fixturePaths = new Set(fixtures.flatMap((fixture) => Array.from(new Set(collectLeafValuePaths(fixture)))));
      const exceptions = new Set(OPTIONAL_COVERAGE_EXCEPTIONS[name] ?? []);
      const missingOptional = Array.from(
        new Set(
          schemaPaths
            .filter((entry) => entry.optional)
            .filter((entry) => entry.path && !fixturePaths.has(entry.path) && !exceptions.has(entry.path))
            .map((entry) => entry.path),
        ),
      );
      if (missingOptional.length > 0) {
        failures.push(`${name}: ${missingOptional.sort().join(', ')}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
