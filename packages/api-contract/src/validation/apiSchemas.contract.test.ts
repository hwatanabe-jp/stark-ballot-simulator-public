import { describe, expect, it } from 'vitest';
import {
  s,
  type ArraySchema,
  type DefaultSchema,
  type EffectsSchema,
  type IntersectionSchema,
  type NullableSchema,
  type ObjectSchema,
  type OptionalSchema,
  type SchemaTypeAny,
  type UnionSchema,
} from '@stark-ballot/validation/schema';
import {
  SessionResponseSchema,
  VoteResponseSchema,
  ProgressResponseSchema,
  FinalizeAcceptedResponseSchema,
  FinalizeCancelRequestSchema,
  FinalizeCallbackResponseSchema,
  FinalizeCancelResponseSchema,
  FinalizeSyncResponseSchema,
  StandardErrorResponseSchema,
  SessionStatusResponseSchema,
  VerifyResponseSchema,
  VerifyFailClosedResponseSchema,
  VerificationObservationResponseSchema,
  VerificationRunResponseSchema,
  BulletinResponseSchema,
  BulletinProofResponseSchema,
  ConsistencyProofResponseSchema,
  BitmapProofResponseSchema,
  SthResponseSchema,
  ZkVMInputHashResponseSchema,
  PUBLIC_VERIFICATION_CHECK_NOTE_KEY_VALUES,
  type BitmapProofResponse,
  type BulletinProofResponse,
  type BulletinResponse,
  type ConsistencyProofResponse,
  type FinalizeCallbackResponse,
  type FinalizeSyncResponse,
  type ProgressResponse,
  type SessionResponse,
  type SessionStatusResponse,
  type SthResponse,
  type VerificationRunResponse,
  type VerificationObservationResponse,
  type VerifyResponse,
  type VoteResponse,
  type ZkVMInputHashResponse,
} from './apiSchemas';
import { TARGET_API_ROUTE_CONTRACTS } from '@stark-ballot/api-contract/api-contract/routes';
import sessionFixture from './fixtures/json/session.post.json';
import voteFixture from './fixtures/json/vote.post.json';
import progressFixture from './fixtures/json/progress.get.json';
import finalizeAcceptedFixture from './fixtures/json/finalize.post.accepted.json';
import finalizeSyncFixture from './fixtures/json/finalize.post.sync.json';
import statusPendingFixture from './fixtures/json/sessions.status.pending.json';
import statusRunningFixture from './fixtures/json/sessions.status.running.json';
import statusSucceededFixture from './fixtures/json/sessions.status.succeeded.json';
import verifyS0Fixture from './fixtures/json/verify.get.S0.json';
import verifyS1Fixture from './fixtures/json/verify.get.S1.json';
import verifyS2Fixture from './fixtures/json/verify.get.S2.json';
import verifyS3Fixture from './fixtures/json/verify.get.S3.json';
import verifyS4Fixture from './fixtures/json/verify.get.S4.json';
import verifyS5Fixture from './fixtures/json/verify.get.S5.json';
import verificationRunFixture from './fixtures/json/verification.run.post.json';
import {
  collectPublicBoundaryViolationPaths,
  collectRetiredPublicBoundaryPaths,
} from '../../../../scripts/security/public-boundary-scan';

const CURRENT_JOURNAL_UINT32_MAX = 0xffffffff;

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

function finalizeSyncWithJournalField(field: string, value: unknown): unknown {
  return {
    ...finalizeSyncFixture,
    data: {
      ...finalizeSyncFixture.data,
      journal: {
        ...finalizeSyncFixture.data.journal,
        [field]: value,
      },
    },
  };
}

function finalizeSyncWithDirectField(field: string, value: unknown): unknown {
  return {
    ...finalizeSyncFixture,
    data: {
      ...finalizeSyncFixture.data,
      [field]: value,
    },
  };
}

type ContractFixture = {
  name: string;
  schemaName: string;
  schema: AnySchema;
  fixture: unknown;
};

type SchemaCase = {
  name: string;
  schema: AnySchema;
  fixtures: unknown[];
};

type AnySchema = SchemaTypeAny;
type AnyObjectSchema = ObjectSchema;
type AnyUnionSchema = UnionSchema;
type AnyArraySchema = ArraySchema;
type AnyIntersectionSchema = IntersectionSchema;
type AnyDiscriminatedUnionSchema = UnionSchema;
type HasStringIndex<T> = string extends keyof T ? true : false;
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
type ConcreteResponseTypeChecks = [
  HasStringIndex<SessionResponse>,
  HasStringIndex<VoteResponse>,
  HasStringIndex<ProgressResponse>,
  HasStringIndex<FinalizeSyncResponse>,
  HasStringIndex<FinalizeSyncResponse['data']>,
  HasStringIndex<SessionStatusResponse>,
  HasStringIndex<NonNullable<SessionStatusResponse['finalizationResult']>>,
  HasStringIndex<VerifyResponse>,
  HasStringIndex<VerifyResponse['data']>,
  HasStringIndex<VerificationRunResponse>,
  HasStringIndex<VerificationObservationResponse>,
  HasStringIndex<BulletinResponse>,
  HasStringIndex<BulletinProofResponse>,
  HasStringIndex<ConsistencyProofResponse>,
  HasStringIndex<BitmapProofResponse>,
  HasStringIndex<SthResponse>,
  HasStringIndex<ZkVMInputHashResponse>,
];
const concreteResponseTypeChecks: ConcreteResponseTypeChecks = [
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
];

type PublicResponseBoundaryKeyChecks = [
  HasKey<VerifyResponse['data'], 'electionManifest'>,
  HasKey<VerifyResponse['data'], 'closeStatement'>,
  HasKey<VerifyResponse['data'], 'bitmapProofSource'>,
  HasKey<VerifyResponse['data'], 'scenarios'>,
  HasKey<VerifyResponse['data'], 'verificationResult'>,
  HasKey<FinalizeSyncResponse['data'], 'electionManifest'>,
  HasKey<FinalizeSyncResponse['data'], 'closeStatement'>,
  HasKey<FinalizeSyncResponse['data'], 'bitmapProofSource'>,
  HasKey<FinalizeSyncResponse['data'], 'scenarios'>,
  HasKey<FinalizeSyncResponse['data'], 'verificationResult'>,
];
const publicResponseBoundaryKeyChecks: PublicResponseBoundaryKeyChecks = [
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
];

const HEX32_NORMALIZED = /^0x[0-9a-f]{64}$/;
const HEX_A = `0x${'a'.repeat(64)}`;
const HEX_B = `0x${'b'.repeat(64)}`;
const HEX_C = `0x${'c'.repeat(64)}`;

const statusUnsupportedArtifactFixture = {
  ...statusRunningFixture,
  artifactState: 'unsupported_current_artifact' as const,
};
const verifyFailClosedFixture = {
  error: 'UNSUPPORTED_CURRENT_ARTIFACT' as const,
  message: '現在のコントラクト世代ではサポートされていない確定済み状態です',
  artifactState: 'unsupported_current_artifact' as const,
};

const CONTRACT_FIXTURES: ContractFixture[] = [
  { name: 'session', schemaName: 'SessionResponseSchema', schema: SessionResponseSchema, fixture: sessionFixture },
  { name: 'vote', schemaName: 'VoteResponseSchema', schema: VoteResponseSchema, fixture: voteFixture },
  { name: 'progress', schemaName: 'ProgressResponseSchema', schema: ProgressResponseSchema, fixture: progressFixture },
  {
    name: 'finalize-accepted',
    schemaName: 'FinalizeAcceptedResponseSchema',
    schema: FinalizeAcceptedResponseSchema,
    fixture: finalizeAcceptedFixture,
  },
  {
    name: 'finalize-sync',
    schemaName: 'FinalizeSyncResponseSchema',
    schema: FinalizeSyncResponseSchema,
    fixture: finalizeSyncFixture,
  },
  {
    name: 'session-status-pending',
    schemaName: 'SessionStatusResponseSchema',
    schema: SessionStatusResponseSchema,
    fixture: statusPendingFixture,
  },
  {
    name: 'session-status-running',
    schemaName: 'SessionStatusResponseSchema',
    schema: SessionStatusResponseSchema,
    fixture: statusRunningFixture,
  },
  {
    name: 'session-status-succeeded',
    schemaName: 'SessionStatusResponseSchema',
    schema: SessionStatusResponseSchema,
    fixture: statusSucceededFixture,
  },
  {
    name: 'session-status-unsupported-artifact',
    schemaName: 'SessionStatusResponseSchema',
    schema: SessionStatusResponseSchema,
    fixture: statusUnsupportedArtifactFixture,
  },
  { name: 'verify-s0', schemaName: 'VerifyResponseSchema', schema: VerifyResponseSchema, fixture: verifyS0Fixture },
  { name: 'verify-s1', schemaName: 'VerifyResponseSchema', schema: VerifyResponseSchema, fixture: verifyS1Fixture },
  { name: 'verify-s2', schemaName: 'VerifyResponseSchema', schema: VerifyResponseSchema, fixture: verifyS2Fixture },
  { name: 'verify-s3', schemaName: 'VerifyResponseSchema', schema: VerifyResponseSchema, fixture: verifyS3Fixture },
  { name: 'verify-s4', schemaName: 'VerifyResponseSchema', schema: VerifyResponseSchema, fixture: verifyS4Fixture },
  { name: 'verify-s5', schemaName: 'VerifyResponseSchema', schema: VerifyResponseSchema, fixture: verifyS5Fixture },
  {
    name: 'verify-fail-closed',
    schemaName: 'VerifyFailClosedResponseSchema',
    schema: VerifyFailClosedResponseSchema,
    fixture: verifyFailClosedFixture,
  },
  {
    name: 'verification-observation',
    schemaName: 'VerificationObservationResponseSchema',
    schema: VerificationObservationResponseSchema,
    fixture: {
      data: {
        status: 'recorded',
      },
    },
  },
  {
    name: 'verification-run',
    schemaName: 'VerificationRunResponseSchema',
    schema: VerificationRunResponseSchema,
    fixture: verificationRunFixture,
  },
  {
    name: 'finalize-cancel',
    schemaName: 'FinalizeCancelResponseSchema',
    schema: FinalizeCancelResponseSchema,
    fixture: {
      state: {
        status: 'pending',
        executionId: 'exec-123',
        queuedAt: 1730000000000,
      },
    },
  },
  {
    name: 'bulletin',
    schemaName: 'BulletinResponseSchema',
    schema: BulletinResponseSchema,
    fixture: {
      commitments: [HEX_A],
      bulletinRoot: HEX_B,
      treeSize: 1,
      timestamp: 1730000000000,
      rootHistory: [{ timestamp: 1730000000000, treeSize: 1, bulletinRoot: HEX_B }],
      nextOffset: null,
      hasMore: false,
    },
  },
  {
    name: 'bulletin-consistency-proof',
    schemaName: 'ConsistencyProofResponseSchema',
    schema: ConsistencyProofResponseSchema,
    fixture: {
      oldSize: 1,
      newSize: 2,
      rootAtOldSize: HEX_A,
      rootAtNewSize: HEX_B,
      proofNodes: [HEX_C],
      timestamp: 1730000000000,
    },
  },
  {
    name: 'bulletin-vote-proof',
    schemaName: 'BulletinProofResponseSchema',
    schema: BulletinProofResponseSchema,
    fixture: {
      voteId: '550e8400-e29b-41d4-a716-446655440000',
      proof: {
        leafIndex: 0,
        treeSize: 1,
        merklePath: [],
        bulletinRootAtCast: HEX_A,
      },
    },
  },
  {
    name: 'bitmap-proof',
    schemaName: 'BitmapProofResponseSchema',
    schema: BitmapProofResponseSchema,
    fixture: {
      leafChunk: HEX_A,
      auditPath: [{ hash: HEX_B, position: 'left' }],
    },
  },
  {
    name: 'sth',
    schemaName: 'SthResponseSchema',
    schema: SthResponseSchema,
    fixture: {
      sth: {
        sthDigest: HEX_A,
        bulletinRoot: HEX_B,
        treeSize: 1,
        timestamp: 1730000000000,
        logId: HEX_C,
      },
    },
  },
  {
    name: 'zkvm-input-hash',
    schemaName: 'ZkVMInputHashResponseSchema',
    schema: ZkVMInputHashResponseSchema,
    fixture: {
      inputCommitment: HEX_A,
    },
  },
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
  { name: 'VerifyFailClosedResponse', schema: VerifyFailClosedResponseSchema, fixtures: [verifyFailClosedFixture] },
  {
    name: 'VerificationObservationResponse',
    schema: VerificationObservationResponseSchema,
    fixtures: [{ data: { status: 'recorded' } }, { data: { status: 'idempotent' } }],
  },
  { name: 'VerificationRunResponse', schema: VerificationRunResponseSchema, fixtures: [verificationRunFixture] },
];

const OPTIONAL_COVERAGE_EXCEPTIONS: Record<string, string[]> = {
  FinalizeAcceptedResponse: ['state.startedAt', 'state.completedAt', 'state.failedAt', 'state.timeoutAt'],
  FinalizeSyncResponse: [
    'data.receipt.metadata',
    'data.verificationReport.dev_mode_receipt',
    'data.verificationReport.expected_image_id',
    'data.verificationReport.receipt_image_id',
    'data.verificationReport.verified_at',
    'data.verificationReport.verifier_version',
  ],
  SessionStatusResponse: [
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

const getInnerType = (schema: OptionalSchema | NullableSchema | DefaultSchema): AnySchema => schema._def.innerType;

const getEffectSchema = (schema: EffectsSchema): AnySchema => schema._def.schema;

const getArrayItem = (schema: AnyArraySchema): AnySchema => schema._def.type;

const getObjectShape = (schema: AnyObjectSchema): Record<string, AnySchema> => schema.shape;

const getUnionOptions = (schema: AnyUnionSchema): readonly AnySchema[] => schema._def.options;

const getIntersectionMembers = (schema: AnyIntersectionSchema): [AnySchema, AnySchema] => [
  schema._def.left,
  schema._def.right,
];

const buildUnionSchema = (options: AnySchema[]): AnySchema => {
  if (options.length === 0) {
    throw new Error('Expected at least one union option');
  }
  if (options.length === 1) {
    return strictDefined(options[0]);
  }
  return s.union(options as unknown as [SchemaTypeAny, SchemaTypeAny, ...SchemaTypeAny[]]);
};

const getDiscriminatedOptions = (schema: AnyDiscriminatedUnionSchema): Iterable<AnySchema> => {
  const rawOptions = (schema as unknown as { _def?: { options?: unknown } })._def?.options;
  if (rawOptions instanceof Map) {
    return rawOptions.values() as Iterable<AnySchema>;
  }
  if (Array.isArray(rawOptions)) {
    return rawOptions as AnySchema[];
  }
  return [];
};

const unwrapSchema = (schema: AnySchema): AnySchema => {
  let current: AnySchema = schema;
  for (;;) {
    if (
      current instanceof s.OptionalSchema ||
      current instanceof s.NullableSchema ||
      current instanceof s.DefaultSchema
    ) {
      current = getInnerType(current);
      continue;
    }
    if (current instanceof s.EffectsSchema) {
      current = getEffectSchema(current as EffectsSchema);
      continue;
    }
    return current;
  }
};

const hasHex32Description = (schema: AnySchema): boolean => {
  const described = schema as { description?: string; _def?: { description?: string } };
  return described.description === 'hex32' || described._def?.description === 'hex32';
};

const isHex32Schema = (schema: AnySchema): boolean => {
  if (hasHex32Description(schema)) {
    return true;
  }
  if (schema instanceof s.OptionalSchema || schema instanceof s.NullableSchema || schema instanceof s.DefaultSchema) {
    return isHex32Schema(getInnerType(schema));
  }
  if (schema instanceof s.EffectsSchema) {
    return hasHex32Description(schema) || isHex32Schema(getEffectSchema(schema as EffectsSchema));
  }
  return false;
};

type HexPath = { segments: string[] };

const collectHex32Paths = (schema: AnySchema, base: string[] = []): HexPath[] => {
  if (isHex32Schema(schema)) {
    return [{ segments: base }];
  }
  const unwrapped = unwrapSchema(schema);
  if (unwrapped instanceof s.ObjectSchema) {
    const shape = getObjectShape(unwrapped);
    return Object.keys(shape).flatMap((key) => collectHex32Paths(strictDefined(shape[key]), [...base, key]));
  }
  if (unwrapped instanceof s.ArraySchema) {
    return collectHex32Paths(getArrayItem(unwrapped), [...base, '*']);
  }
  if (unwrapped instanceof s.UnionSchema) {
    return getUnionOptions(unwrapped).flatMap((option) => collectHex32Paths(option, base));
  }
  if (unwrapped instanceof s.IntersectionSchema) {
    const [left, right] = getIntersectionMembers(unwrapped);
    return [...collectHex32Paths(left, base), ...collectHex32Paths(right, base)];
  }
  if (unwrapped instanceof s.DiscriminatedUnionSchema) {
    return Array.from(getDiscriminatedOptions(unwrapped)).flatMap((option) => collectHex32Paths(option, base));
  }
  return [];
};

const collectValues = (value: unknown, segments: string[]): unknown[] => {
  if (segments.length === 0) {
    return [value];
  }
  const [head, ...rest] = segments;
  if (!head) {
    return [];
  }
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
  schema: AnySchema,
  base: string[] = [],
  parentOptional = false,
): LeafPathInfo[] => {
  if (schema instanceof s.OptionalSchema || schema instanceof s.DefaultSchema) {
    return collectLeafPathsWithOptionality(getInnerType(schema), base, true);
  }
  if (schema instanceof s.NullableSchema) {
    return collectLeafPathsWithOptionality(getInnerType(schema), base, parentOptional);
  }
  if (schema instanceof s.EffectsSchema) {
    return collectLeafPathsWithOptionality(getEffectSchema(schema as EffectsSchema), base, parentOptional);
  }
  if (isHex32Schema(schema)) {
    return [{ path: formatPath(base), optional: parentOptional }];
  }
  if (schema instanceof s.ObjectSchema) {
    const shape = getObjectShape(schema);
    return Object.keys(shape).flatMap((key) =>
      collectLeafPathsWithOptionality(strictDefined(shape[key]), [...base, key], parentOptional),
    );
  }
  if (schema instanceof s.ArraySchema) {
    return collectLeafPathsWithOptionality(getArrayItem(schema), [...base, '[]'], parentOptional);
  }
  if (schema instanceof s.UnionSchema) {
    return getUnionOptions(schema).flatMap((option) => collectLeafPathsWithOptionality(option, base, parentOptional));
  }
  if (schema instanceof s.IntersectionSchema) {
    const [left, right] = getIntersectionMembers(schema);
    return [
      ...collectLeafPathsWithOptionality(left, base, parentOptional),
      ...collectLeafPathsWithOptionality(right, base, parentOptional),
    ];
  }
  if (schema instanceof s.DiscriminatedUnionSchema) {
    return Array.from(getDiscriminatedOptions(schema)).flatMap((option) =>
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

const mergeStrictObjectSchemas = (leftSchema: AnyObjectSchema, rightSchema: AnyObjectSchema): AnyObjectSchema => {
  const leftShape = getObjectShape(leftSchema);
  const rightShape = getObjectShape(rightSchema);
  const mergedShape: Record<string, AnySchema> = {};
  const keys = new Set([...Object.keys(leftShape), ...Object.keys(rightShape)]);

  for (const key of keys) {
    const hasLeftField = Object.hasOwn(leftShape, key);
    const hasRightField = Object.hasOwn(rightShape, key);
    if (hasLeftField && hasRightField) {
      const leftField = strictDefined(leftShape[key]);
      const rightField = strictDefined(rightShape[key]);
      mergedShape[key] = s.intersection(makeDeepStrict(leftField), makeDeepStrict(rightField));
      continue;
    }
    mergedShape[key] = makeDeepStrict(hasLeftField ? strictDefined(leftShape[key]) : strictDefined(rightShape[key]));
  }

  return s.object(mergedShape).strict();
};

const makeDeepStrictIntersection = (left: AnySchema, right: AnySchema): AnySchema => {
  const leftUnwrapped = unwrapSchema(left);
  const rightUnwrapped = unwrapSchema(right);

  if (leftUnwrapped instanceof s.ObjectSchema && rightUnwrapped instanceof s.ObjectSchema) {
    return mergeStrictObjectSchemas(leftUnwrapped, rightUnwrapped);
  }
  if (leftUnwrapped instanceof s.ObjectSchema && rightUnwrapped instanceof s.UnionSchema) {
    const options = getUnionOptions(rightUnwrapped).map((option) => makeDeepStrictIntersection(left, option));
    return buildUnionSchema(options);
  }
  if (leftUnwrapped instanceof s.UnionSchema && rightUnwrapped instanceof s.ObjectSchema) {
    const options = getUnionOptions(leftUnwrapped).map((option) => makeDeepStrictIntersection(option, right));
    return buildUnionSchema(options);
  }
  if (leftUnwrapped instanceof s.ObjectSchema && rightUnwrapped instanceof s.DiscriminatedUnionSchema) {
    const options = Array.from(getDiscriminatedOptions(rightUnwrapped)).map((option) =>
      makeDeepStrictIntersection(left, option),
    );
    return buildUnionSchema(options);
  }
  if (leftUnwrapped instanceof s.DiscriminatedUnionSchema && rightUnwrapped instanceof s.ObjectSchema) {
    const options = Array.from(getDiscriminatedOptions(leftUnwrapped)).map((option) =>
      makeDeepStrictIntersection(option, right),
    );
    return buildUnionSchema(options);
  }
  return s.intersection(makeDeepStrict(left), makeDeepStrict(right));
};

const makeDeepStrict = (schema: AnySchema): AnySchema => {
  if (schema instanceof s.OptionalSchema) {
    return makeDeepStrict(getInnerType(schema)).optional();
  }
  if (schema instanceof s.NullableSchema) {
    return makeDeepStrict(getInnerType(schema)).nullable();
  }
  if (schema instanceof s.DefaultSchema) {
    const inner = makeDeepStrict(getInnerType(schema));
    return inner.default(schema._def.defaultValue());
  }
  if (schema instanceof s.EffectsSchema) {
    return schema;
  }
  if (schema instanceof s.ArraySchema) {
    return s.array(makeDeepStrict(getArrayItem(schema)));
  }
  if (schema instanceof s.IntersectionSchema) {
    const [left, right] = getIntersectionMembers(schema);
    return makeDeepStrictIntersection(left, right);
  }
  if (schema instanceof s.ObjectSchema) {
    const shape = getObjectShape(schema);
    const strictShape: Record<string, AnySchema> = {};
    for (const key of Object.keys(shape)) {
      strictShape[key] = makeDeepStrict(strictDefined(shape[key]));
    }
    const base = s.object(strictShape);
    let next = base;
    const def = schema._def;
    if (!(def.catchall instanceof s.NeverSchema)) {
      next = next.catchall(makeDeepStrict(def.catchall));
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

  it('accepts queue estimates without positional fields in finalize and status responses', () => {
    const queue = {
      concurrencyLimit: 2,
      estimatedDurationMs: 360000,
    };
    const state = {
      status: 'pending' as const,
      executionId: 'exec-123',
      queuedAt: 1730000000000,
    };

    expect(
      FinalizeAcceptedResponseSchema.safeParse({
        executionId: 'exec-123',
        statusUrl: '/api/sessions/session-123/status',
        state,
        queue,
      }).success,
    ).toBe(true);
    expect(
      SessionStatusResponseSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        finalizationState: state,
        queue,
        finalizationResult: null,
        stepFunctions: null,
        asyncFinalizationMode: 'enabled',
      }).success,
    ).toBe(true);
  });

  it('rejects legacy positional queue fields in public finalization responses', () => {
    const legacyQueue = {
      position: 3,
      depth: 8,
      concurrencyLimit: 2,
      estimatedStartAt: 1730000020000,
      estimatedDurationMs: 360000,
      estimatedCompletionAt: 1730000260000,
    };
    const state = {
      status: 'pending' as const,
      executionId: 'exec-123',
      queuedAt: 1730000000000,
    };

    expect(
      FinalizeAcceptedResponseSchema.safeParse({
        executionId: 'exec-123',
        statusUrl: '/api/sessions/session-123/status',
        state,
        queue: legacyQueue,
      }).success,
    ).toBe(false);
    expect(
      SessionStatusResponseSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        finalizationState: state,
        queue: legacyQueue,
        finalizationResult: null,
        stepFunctions: null,
        asyncFinalizationMode: 'enabled',
      }).success,
    ).toBe(false);
  });

  it('validates the finalize cancel request contract', () => {
    expect(
      FinalizeCancelRequestSchema.safeParse({
        executionId: 'execution-123',
        reason: 'user cancelled',
      }).success,
    ).toBe(true);
    expect(FinalizeCancelRequestSchema.safeParse({ executionId: 'short' }).success).toBe(false);
  });

  it.each(['bad/segment-123', 'bad.segment-123', 'https://example.invalid/execution'])(
    'rejects unsafe finalize cancel executionId %s',
    (executionId) => {
      expect(
        FinalizeCancelRequestSchema.safeParse({
          executionId,
          reason: 'user cancelled',
        }).success,
      ).toBe(false);
    },
  );

  it('rejects Step Functions ARNs in public finalize responses', () => {
    const stateWithArn = {
      status: 'pending' as const,
      executionId: 'exec-123',
      queuedAt: 1730000000000,
      stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-123',
    };

    expect(
      FinalizeAcceptedResponseSchema.safeParse({
        executionId: 'exec-123',
        statusUrl: '/api/sessions/session-123/status',
        state: stateWithArn,
      }).success,
    ).toBe(false);
    expect(FinalizeCancelResponseSchema.safeParse({ state: stateWithArn }).success).toBe(false);
  });

  it('validates finalize sync fixture', () => {
    expect(FinalizeSyncResponseSchema.safeParse(finalizeSyncFixture).success).toBe(true);
  });

  it.each([
    ['treeSize', 0],
    ['totalExpected', -1],
    ['totalVotes', 1.5],
    ['validVotes', Number.POSITIVE_INFINITY],
    ['invalidVotes', Number.NaN],
    ['seenIndicesCount', Number.MAX_SAFE_INTEGER + 1],
    ['missingSlots', CURRENT_JOURNAL_UINT32_MAX + 1],
    ['invalidPresentedSlots', CURRENT_JOURNAL_UINT32_MAX + 1],
    ['rejectedRecords', CURRENT_JOURNAL_UINT32_MAX + 1],
    ['excludedSlots', CURRENT_JOURNAL_UINT32_MAX + 1],
  ])('rejects impossible current journal %s=%s in finalize sync responses', (field, value) => {
    expect(FinalizeSyncResponseSchema.safeParse(finalizeSyncWithJournalField(field, value)).success).toBe(false);
  });

  it('rejects current journal tally entries outside the Rust u32 output contract', () => {
    expect(
      FinalizeSyncResponseSchema.safeParse(
        finalizeSyncWithJournalField('verifiedTally', [CURRENT_JOURNAL_UINT32_MAX + 1, 0, 0, 0, 0]),
      ).success,
    ).toBe(false);
  });

  it.each([
    ['treeSize', 0],
    ['totalExpected', CURRENT_JOURNAL_UINT32_MAX + 1],
    ['seenIndicesCount', 1.5],
    ['excludedSlots', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects impossible direct current journal field %s=%s in finalize sync responses', (field, value) => {
    expect(FinalizeSyncResponseSchema.safeParse(finalizeSyncWithDirectField(field, value)).success).toBe(false);
  });

  it('validates the standard error envelope allowlist', () => {
    const representativeError = {
      error: 'INVALID_REQUEST',
      message: 'Invalid request payload',
      statusCode: 400,
      details: 'Response schema validation failed',
      issues: {
        formErrors: [],
        fieldErrors: {
          vote: ['Expected string'],
        },
      },
      reason: 'client_ip_missing',
      retryAfter: 30,
      limitBytes: 1024,
      receivedBytes: 2048,
      nextAvailableAt: '2026-06-15T00:00:00.000Z',
      remainingExecutions: 0,
      artifactState: 'unsupported_current_artifact',
      runtimeContractGeneration: '2026-04-zkvm-current-v1',
      persistedContractGeneration: null,
      carriedContractGeneration: '2026-04-zkvm-current-v1',
      status: 'failed',
      verificationExecutionId: 'exec-123456',
      verificationReport: {
        status: 'failed',
        errors: ['Verification failed'],
      },
      voteIndex: 0,
      expectedTreeSize: 100,
      actualTreeSize: 99,
      errorCodes: ['timeout-or-duplicate'],
    };

    expect(StandardErrorResponseSchema.safeParse(representativeError).success).toBe(true);
    expect(
      StandardErrorResponseSchema.safeParse({
        ...representativeError,
        privateArtifact: 'input.json',
      }).success,
    ).toBe(false);
    expect(
      StandardErrorResponseSchema.safeParse({
        ...representativeError,
        details: {
          stack: 'private stack',
        },
      }).success,
    ).toBe(false);
    expect(
      StandardErrorResponseSchema.safeParse({
        ...representativeError,
        cause: 'Unexpected token',
      }).success,
    ).toBe(false);
  });

  it('models finalize ImageID mismatches as standard string-detail errors', () => {
    expect(
      StandardErrorResponseSchema.safeParse({
        error: 'INVALID_IMAGE_ID',
        message: 'zkVMイメージIDが一致しません',
        statusCode: 400,
        details: 'Finalization receipt ImageID did not match the expected ImageID',
      }).success,
    ).toBe(true);

    expect(
      StandardErrorResponseSchema.safeParse({
        error: 'INVALID_IMAGE_ID',
        message: 'zkVMイメージIDが一致しません',
        statusCode: 400,
        details: {
          expected: '0xexpected',
          actual: '0xactual',
        },
      }).success,
    ).toBe(false);
  });

  it('rejects private fields inside public finalize receipts', () => {
    const privateReceiptFields = {
      ...finalizeSyncFixture,
      data: {
        ...finalizeSyncFixture.data,
        receipt: {
          ...finalizeSyncFixture.data.receipt,
          bundleKey: 'private/proofs/input.json',
          random: `0x${'a'.repeat(64)}`,
          capabilityToken: 'capability-token-must-not-leak',
          metadata: {
            isFake: false,
            reportKey: 'private/reports/verification.json',
            privateArtifact: 'included-bitmap.json',
          },
        },
      },
    };

    expect(FinalizeSyncResponseSchema.safeParse(privateReceiptFields).success).toBe(false);
  });

  it('keeps public receipt metadata on a narrow allowlist', () => {
    const result = FinalizeSyncResponseSchema.safeParse({
      ...finalizeSyncFixture,
      data: {
        ...finalizeSyncFixture.data,
        receipt: {
          ...finalizeSyncFixture.data.receipt,
          metadata: {
            isFake: false,
            verifierPath: '/tmp/verifier/receipt.json',
          },
        },
      },
    });

    expect(result.success).toBe(false);
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

  it('rejects raw finalization error details in public state responses', () => {
    const failedState = {
      status: 'failed' as const,
      executionId: 'exec-123',
      queuedAt: 1730000000000,
      failedAt: 1730000005000,
      error: {
        code: 'FINALIZATION_FAILED',
        message: 'Finalization failed',
        details: {
          bundleKey: 'private/proofs/input.json',
          stack: 'Error: private failure\n    at run (/var/task/index.js:1:1)',
          capabilityToken: 'capability-token-must-not-leak',
        },
      },
    };

    expect(
      FinalizeAcceptedResponseSchema.safeParse({
        executionId: 'exec-123',
        statusUrl: '/api/sessions/session-123/status',
        state: failedState,
      }).success,
    ).toBe(false);
    expect(FinalizeCancelResponseSchema.safeParse({ state: failedState }).success).toBe(false);
    expect(
      SessionStatusResponseSchema.safeParse({
        ...statusRunningFixture,
        finalizationState: failedState,
      }).success,
    ).toBe(false);
  });

  it('rejects internal finalization failure categories in public state responses', () => {
    const failedState = {
      status: 'failed' as const,
      executionId: 'exec-123',
      queuedAt: 1730000000000,
      failedAt: 1730000005000,
      error: {
        code: 'PROVER_TASK_FAILED',
        message: 'Target prover task failed',
        category: 'prover_execution',
      },
    };

    expect(
      FinalizeAcceptedResponseSchema.safeParse({
        executionId: 'exec-123',
        statusUrl: '/api/sessions/session-123/status',
        state: failedState,
      }).success,
    ).toBe(false);
    expect(FinalizeCancelResponseSchema.safeParse({ state: failedState }).success).toBe(false);
    expect(
      SessionStatusResponseSchema.safeParse({
        ...statusRunningFixture,
        finalizationState: failedState,
      }).success,
    ).toBe(false);
  });

  it('allows internal callback state fields only in the callback response schema', () => {
    const internalFailedState = {
      status: 'failed' as const,
      executionId: 'exec-123456',
      queuedAt: 1730000000000,
      failedAt: 1730000005000,
      stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-123456',
      error: {
        code: 'FINALIZATION_FAILED',
        message: 'Finalization failed',
        category: 'unknown',
        details: {
          bundleKey: 'private/proofs/input.json',
        },
      },
    };

    expect(
      FinalizeCallbackResponseSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        state: internalFailedState,
      }).success,
    ).toBe(true);
    expect(FinalizeCancelResponseSchema.safeParse({ state: internalFailedState }).success).toBe(false);
    expect(
      SessionStatusResponseSchema.safeParse({
        ...statusRunningFixture,
        finalizationState: internalFailedState,
      }).success,
    ).toBe(false);
  });

  it('types infrastructure interruptions as valid internal callback failures', () => {
    const response: FinalizeCallbackResponse = {
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      state: {
        status: 'failed',
        executionId: 'exec-interrupted',
        queuedAt: 1730000000000,
        failedAt: 1730000005000,
        error: {
          code: 'PROVER_INTERRUPTED',
          message: 'The prover task was interrupted by the infrastructure',
          category: 'infrastructure_interruption',
        },
      },
    };

    expect(FinalizeCallbackResponseSchema.safeParse(response).success).toBe(true);
  });

  it.each([
    'configuration',
    'input',
    'prover_execution',
    'infrastructure_interruption',
    'artifact',
    'upload',
    'timeout',
    'unknown',
  ])('admits the closed prover failure marker category %s only in the internal callback response', (category) => {
    const internalFailedState = {
      status: 'failed' as const,
      executionId: 'exec-123456',
      queuedAt: 1730000000000,
      failedAt: 1730000005000,
      error: {
        code: 'PROVER_TASK_FAILED',
        message: 'Target prover task failed',
        category,
      },
    };

    expect(
      FinalizeCallbackResponseSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        state: internalFailedState,
      }).success,
    ).toBe(true);
    expect(FinalizeCancelResponseSchema.safeParse({ state: internalFailedState }).success).toBe(false);
  });

  it('rejects unexpected internal callback state fields', () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const baseState = {
      status: 'succeeded' as const,
      executionId: 'exec-123456',
      queuedAt: 1730000000000,
      startedAt: 1730000000100,
      completedAt: 1730000005000,
      stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-123456',
      bundleMetadata: {
        s3BundleKey: 'sessions/550e8400-e29b-41d4-a716-446655440000/exec-123456/bundle.zip',
        s3UploadedAt: '2026-06-15T00:00:00.000Z',
      },
    };

    expect(FinalizeCallbackResponseSchema.safeParse({ sessionId, state: baseState }).success).toBe(true);
    expect(
      FinalizeCallbackResponseSchema.safeParse({
        sessionId,
        state: {
          ...baseState,
          unexpectedStateField: true,
        },
      }).success,
    ).toBe(false);
    expect(
      FinalizeCallbackResponseSchema.safeParse({
        sessionId,
        state: {
          ...baseState,
          bundleMetadata: {
            ...baseState.bundleMetadata,
            rawReportKey: 'private/reports/verification.json',
          },
        },
      }).success,
    ).toBe(false);
  });

  it('validates session status fixtures', () => {
    expect(SessionStatusResponseSchema.safeParse(statusPendingFixture).success).toBe(true);
    expect(SessionStatusResponseSchema.safeParse(statusRunningFixture).success).toBe(true);
    expect(SessionStatusResponseSchema.safeParse(statusSucceededFixture).success).toBe(true);
    expect(SessionStatusResponseSchema.safeParse(statusUnsupportedArtifactFixture).success).toBe(true);
  });

  it('rejects Step Functions operational details in session status responses', () => {
    const result = SessionStatusResponseSchema.safeParse({
      ...statusRunningFixture,
      finalizationState: {
        ...statusRunningFixture.finalizationState,
        stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-001',
      },
      stepFunctions: {
        executionArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-001',
        status: 'FAILED',
        startTime: 1730000001000,
        stopTime: 1730000009000,
        error: 'TaskFailed',
        cause: 'Lambda timed out',
      },
    });

    expect(result.success).toBe(false);
  });

  it('validates verify fixtures', () => {
    expect(VerifyResponseSchema.safeParse(verifyS0Fixture).success).toBe(true);
    expect(VerifyResponseSchema.safeParse(verifyS1Fixture).success).toBe(true);
    expect(VerifyResponseSchema.safeParse(verifyS2Fixture).success).toBe(true);
    expect(VerifyResponseSchema.safeParse(verifyS3Fixture).success).toBe(true);
    expect(VerifyResponseSchema.safeParse(verifyS4Fixture).success).toBe(true);
    expect(VerifyResponseSchema.safeParse(verifyS5Fixture).success).toBe(true);
  });

  it('accepts the current verification check note keys in verify responses', () => {
    const baseCheck = strictDefined(verifyS0Fixture.data.verificationChecks[0], 'verification check fixture');

    for (const noteKey of PUBLIC_VERIFICATION_CHECK_NOTE_KEY_VALUES) {
      const result = VerifyResponseSchema.safeParse({
        ...verifyS0Fixture,
        data: {
          ...verifyS0Fixture.data,
          verificationChecks: [
            {
              ...baseCheck,
              noteKey,
            },
          ],
        },
      });

      expect(result.success).toBe(true);
    }
  });

  it('rejects unknown verification check note keys and extra check fields', () => {
    const baseCheck = strictDefined(verifyS0Fixture.data.verificationChecks[0], 'verification check fixture');

    expect(
      VerifyResponseSchema.safeParse({
        ...verifyS0Fixture,
        data: {
          ...verifyS0Fixture.data,
          verificationChecks: [
            {
              ...baseCheck,
              noteKey: 'pages.verify.stepsCard.notes.myVoteIncluded.future',
            },
          ],
        },
      }).success,
    ).toBe(false);

    expect(
      VerifyResponseSchema.safeParse({
        ...verifyS0Fixture,
        data: {
          ...verifyS0Fixture.data,
          verificationChecks: [
            {
              ...baseCheck,
              noteKey: strictDefined(PUBLIC_VERIFICATION_CHECK_NOTE_KEY_VALUES[0], 'verification check note key'),
              debugShape: true,
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it('validates the verify fail-closed 200 response variant', () => {
    expect(VerifyFailClosedResponseSchema.safeParse(verifyFailClosedFixture).success).toBe(true);
    expect(VerifyFailClosedResponseSchema.safeParse({ data: verifyFailClosedFixture }).success).toBe(false);
    expect(
      VerifyFailClosedResponseSchema.safeParse({
        ...verifyFailClosedFixture,
        artifactState: 'supported',
      }).success,
    ).toBe(false);
  });

  it('requires seenIndicesCount in verify responses', () => {
    const dataWithoutSeenIndicesCount = { ...verifyS0Fixture.data } as Partial<typeof verifyS0Fixture.data>;
    delete dataWithoutSeenIndicesCount.seenIndicesCount;

    expect(
      VerifyResponseSchema.safeParse({
        ...verifyS0Fixture,
        data: dataWithoutSeenIndicesCount,
      }).success,
    ).toBe(false);
  });

  it('rejects raw verification report errors in public responses', () => {
    const result = VerifyResponseSchema.safeParse({
      ...verifyS0Fixture,
      data: {
        ...verifyS0Fixture.data,
        verificationReport: {
          ...verifyS0Fixture.data.verificationReport,
          errors: ['failed to read /tmp/verifier-work/input.json'],
        },
      },
    });

    expect(result.success).toBe(false);
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

  it('rejects unknown public response fields with exported schemas', () => {
    const failures: string[] = [];
    for (const { name, schema, fixture } of CONTRACT_FIXTURES) {
      const rootResult = schema.safeParse({
        ...(fixture as Record<string, unknown>),
        unexpectedPublicField: true,
      });
      if (rootResult.success) {
        failures.push(`${name}: accepted unexpected root field`);
      }

      if (
        fixture &&
        typeof fixture === 'object' &&
        'data' in fixture &&
        fixture.data &&
        typeof fixture.data === 'object' &&
        !Array.isArray(fixture.data)
      ) {
        const dataResult = schema.safeParse({
          ...(fixture as Record<string, unknown>),
          data: {
            ...(fixture.data as Record<string, unknown>),
            unexpectedPublicDataField: true,
          },
        });
        if (dataResult.success) {
          failures.push(`${name}: accepted unexpected data field`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps exported schema-derived response types concrete', () => {
    expect(concreteResponseTypeChecks).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('keeps retired public/private boundary fields out of exported response data types', () => {
    expect(publicResponseBoundaryKeyChecks).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('covers every active public JSON response schema with public-boundary fixtures', () => {
    const expectedSchemaNames = new Set(
      TARGET_API_ROUTE_CONTRACTS.filter(
        (route) =>
          route.lifecycle === 'active' &&
          (route.dataClassification === 'public-session-issued' ||
            route.dataClassification === 'owner-scoped-public-projection'),
      ).flatMap((route) =>
        route.responseSchemas.flatMap((response) =>
          response.content === 'json' && response.schema ? [response.schema] : [],
        ),
      ),
    );
    const coveredSchemaNames = new Set(CONTRACT_FIXTURES.map((fixture) => fixture.schemaName));

    const missing = Array.from(expectedSchemaNames)
      .filter((schemaName) => !coveredSchemaNames.has(schemaName))
      .sort();

    expect(missing).toEqual([]);
  });

  it('does not expose retired public boundary fields in fixtures', () => {
    const failures = CONTRACT_FIXTURES.flatMap(({ name, fixture }) =>
      collectRetiredPublicBoundaryPaths(fixture).map((path) => `${name}: ${path}`),
    );

    expect(failures).toEqual([]);
  });

  it('does not expose private locators, private artifact names, or vote openings in public fixtures', () => {
    const failures = CONTRACT_FIXTURES.flatMap(({ name, fixture }) =>
      collectPublicBoundaryViolationPaths(
        fixture,
        [],
        name === 'session' ? { allowedCapabilityTokenPaths: new Set(['data.capabilityToken']) } : {},
      ).map((path) => `${name}: ${path}`),
    );

    expect(failures).toEqual([]);
  });

  it('allows capabilityToken only in the session issuance fixture', () => {
    expect(
      collectPublicBoundaryViolationPaths(sessionFixture, [], {
        allowedCapabilityTokenPaths: new Set(['data.capabilityToken']),
      }),
    ).toEqual([]);

    expect(
      collectPublicBoundaryViolationPaths({
        data: {
          nested: {
            capabilityToken: 'v1.mock-session-capability-token',
          },
        },
      }),
    ).toEqual(['data.nested.capabilityToken']);
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
