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
  FinalizationResponseSchema,
  FinalizationCancelRequestSchema,
  FinalizationCancelParamsSchema,
  CurrentFinalizationResponseSchema,
  StandardErrorResponseSchema,
  VerificationResourceResponseSchema,
  VerificationObservationResponseSchema,
  VerificationRunResponseSchema,
  BulletinResponseSchema,
  BulletinProofResponseSchema,
  ConsistencyProofResponseSchema,
  BitmapProofResponseSchema,
  SthResponseSchema,
  InputCommitmentResponseSchema,
  PUBLIC_VERIFICATION_CHECK_NOTE_KEY_VALUES,
  type BitmapProofResponse,
  type BulletinProofResponse,
  type BulletinResponse,
  type ConsistencyProofResponse,
  type FinalizationResponse,
  type CurrentFinalizationResponse,
  type ProgressResponse,
  type SessionResponse,
  type SthResponse,
  type InputCommitmentResponse,
  type VerificationRunResponse,
  type VerificationObservationResponse,
  type VerificationResourceResponse,
  type VoteResponse,
} from './index';
import { TARGET_API_ROUTE_CONTRACTS } from '@stark-ballot/api-contract/routes';
import sessionFixture from './fixtures/json/session.post.json';
import voteFixture from './fixtures/json/vote.post.json';
import progressFixture from './fixtures/json/progress.get.json';
import finalizeAcceptedFixture from './fixtures/json/finalizations.post.accepted.json';
import finalizeSyncFixture from './fixtures/json/finalizations.post.succeeded.json';
import statusPendingFixture from './fixtures/json/finalizations.current.pending.json';
import statusRunningFixture from './fixtures/json/finalizations.current.running.json';
import statusSucceededFixture from './fixtures/json/finalizations.current.succeeded.json';
import verifyS0Fixture from './fixtures/json/verification.get.S0.json';
import verifyS1Fixture from './fixtures/json/verification.get.S1.json';
import verifyS2Fixture from './fixtures/json/verification.get.S2.json';
import verifyS3Fixture from './fixtures/json/verification.get.S3.json';
import verifyS4Fixture from './fixtures/json/verification.get.S4.json';
import verifyS5Fixture from './fixtures/json/verification.get.S5.json';
import verificationRunFixture from './fixtures/json/verification.post.json';
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
      result: {
        ...finalizeSyncFixture.data.result,
        authority: {
          ...finalizeSyncFixture.data.result.authority,
          journal: {
            ...finalizeSyncFixture.data.result.authority.journal,
            [field]: value,
          },
        },
      },
    },
  };
}

function finalizeSyncWithDirectField(field: string, value: unknown): unknown {
  return {
    ...finalizeSyncFixture,
    data: {
      ...finalizeSyncFixture.data,
      result: {
        ...finalizeSyncFixture.data.result,
        presentation: {
          ...finalizeSyncFixture.data.result.presentation,
          [field]: value,
        },
      },
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

const isObjectSchema = (schema: AnySchema): schema is AnyObjectSchema =>
  Object.prototype.isPrototypeOf.call(s.ObjectSchema.prototype, schema);
const isArraySchema = (schema: AnySchema): schema is AnyArraySchema =>
  Object.prototype.isPrototypeOf.call(s.ArraySchema.prototype, schema);
const isUnionSchema = (schema: AnySchema): schema is AnyUnionSchema =>
  Object.prototype.isPrototypeOf.call(s.UnionSchema.prototype, schema);
const isIntersectionSchema = (schema: AnySchema): schema is AnyIntersectionSchema =>
  Object.prototype.isPrototypeOf.call(s.IntersectionSchema.prototype, schema);
type HasStringIndex<T> = string extends keyof T ? true : false;
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
type ConcreteResponseTypeChecks = [
  HasStringIndex<SessionResponse>,
  HasStringIndex<VoteResponse>,
  HasStringIndex<ProgressResponse>,
  HasStringIndex<FinalizationResponse>,
  HasStringIndex<FinalizationResponse['data']>,
  HasStringIndex<CurrentFinalizationResponse>,
  HasStringIndex<NonNullable<CurrentFinalizationResponse['data']>>,
  HasStringIndex<VerificationResourceResponse>,
  HasStringIndex<VerificationResourceResponse['data']>,
  HasStringIndex<VerificationRunResponse>,
  HasStringIndex<VerificationObservationResponse>,
  HasStringIndex<BulletinResponse>,
  HasStringIndex<BulletinProofResponse>,
  HasStringIndex<ConsistencyProofResponse>,
  HasStringIndex<BitmapProofResponse>,
  HasStringIndex<SthResponse>,
  HasStringIndex<InputCommitmentResponse>,
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
  HasKey<VerificationResourceResponse['data'], 'electionManifest'>,
  HasKey<VerificationResourceResponse['data'], 'closeStatement'>,
  HasKey<VerificationResourceResponse['data'], 'bitmapProofSource'>,
  HasKey<VerificationResourceResponse['data'], 'scenarios'>,
  HasKey<VerificationResourceResponse['data'], 'verificationResult'>,
  HasKey<FinalizationResponse['data'], 'electionManifest'>,
  HasKey<FinalizationResponse['data'], 'closeStatement'>,
  HasKey<FinalizationResponse['data'], 'bitmapProofSource'>,
  HasKey<FinalizationResponse['data'], 'scenarios'>,
  HasKey<FinalizationResponse['data'], 'verificationResult'>,
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
const RESPONSE_META = { requestId: 'schema-contract-test-request' } as const;

const currentFinalizationEmptyFixture = {
  data: null,
  meta: RESPONSE_META,
};
const finalizationFailedFixture = {
  data: {
    status: 'failed' as const,
    finalizationId: 'mock-finalization-failed',
    queuedAtMs: 1730000000000,
    startedAtMs: 1730000001000,
    failedAtMs: 1730000005000,
    error: {
      code: 'FINALIZATION_FAILED',
      message: 'Finalization failed',
    },
    runtimeDiagnostics: {
      asyncMode: 'enabled' as const,
    },
  },
  meta: RESPONSE_META,
};
const finalizationTimeoutFixture = {
  data: {
    status: 'timeout' as const,
    finalizationId: 'mock-finalization-timeout',
    queuedAtMs: 1730000000000,
    startedAtMs: 1730000001000,
    timeoutAtMs: 1730000005000,
    runtimeDiagnostics: {
      asyncMode: 'enabled' as const,
    },
  },
  meta: RESPONSE_META,
};
const verifyFailClosedFixture = {
  data: {
    availability: 'unavailable' as const,
    finalizationId: 'mock-verification-001',
    message: 'Requested finalization is not the current finalized authority',
    reason: 'finalization_not_current' as const,
  },
  meta: RESPONSE_META,
};

const CONTRACT_FIXTURES: ContractFixture[] = [
  { name: 'session', schemaName: 'SessionResponseSchema', schema: SessionResponseSchema, fixture: sessionFixture },
  { name: 'vote', schemaName: 'VoteResponseSchema', schema: VoteResponseSchema, fixture: voteFixture },
  { name: 'progress', schemaName: 'ProgressResponseSchema', schema: ProgressResponseSchema, fixture: progressFixture },
  {
    name: 'finalization-accepted',
    schemaName: 'FinalizationResponseSchema',
    schema: FinalizationResponseSchema,
    fixture: finalizeAcceptedFixture,
  },
  {
    name: 'finalization-succeeded',
    schemaName: 'FinalizationResponseSchema',
    schema: FinalizationResponseSchema,
    fixture: finalizeSyncFixture,
  },
  {
    name: 'current-finalization-pending',
    schemaName: 'CurrentFinalizationResponseSchema',
    schema: CurrentFinalizationResponseSchema,
    fixture: statusPendingFixture,
  },
  {
    name: 'current-finalization-running',
    schemaName: 'CurrentFinalizationResponseSchema',
    schema: CurrentFinalizationResponseSchema,
    fixture: statusRunningFixture,
  },
  {
    name: 'current-finalization-succeeded',
    schemaName: 'CurrentFinalizationResponseSchema',
    schema: CurrentFinalizationResponseSchema,
    fixture: statusSucceededFixture,
  },
  {
    name: 'current-finalization-empty',
    schemaName: 'CurrentFinalizationResponseSchema',
    schema: CurrentFinalizationResponseSchema,
    fixture: currentFinalizationEmptyFixture,
  },
  {
    name: 'verification-s0',
    schemaName: 'VerificationResourceResponseSchema',
    schema: VerificationResourceResponseSchema,
    fixture: verifyS0Fixture,
  },
  {
    name: 'verification-s1',
    schemaName: 'VerificationResourceResponseSchema',
    schema: VerificationResourceResponseSchema,
    fixture: verifyS1Fixture,
  },
  {
    name: 'verification-s2',
    schemaName: 'VerificationResourceResponseSchema',
    schema: VerificationResourceResponseSchema,
    fixture: verifyS2Fixture,
  },
  {
    name: 'verification-s3',
    schemaName: 'VerificationResourceResponseSchema',
    schema: VerificationResourceResponseSchema,
    fixture: verifyS3Fixture,
  },
  {
    name: 'verification-s4',
    schemaName: 'VerificationResourceResponseSchema',
    schema: VerificationResourceResponseSchema,
    fixture: verifyS4Fixture,
  },
  {
    name: 'verification-s5',
    schemaName: 'VerificationResourceResponseSchema',
    schema: VerificationResourceResponseSchema,
    fixture: verifyS5Fixture,
  },
  {
    name: 'verification-fail-closed',
    schemaName: 'VerificationResourceResponseSchema',
    schema: VerificationResourceResponseSchema,
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
      meta: RESPONSE_META,
    },
  },
  {
    name: 'verification-run',
    schemaName: 'VerificationRunResponseSchema',
    schema: VerificationRunResponseSchema,
    fixture: verificationRunFixture,
  },
  {
    name: 'finalization-cancel',
    schemaName: 'FinalizationResponseSchema',
    schema: FinalizationResponseSchema,
    fixture: {
      data: {
        status: 'failed',
        finalizationId: 'finalization-123',
        queuedAtMs: 1730000000000,
        failedAtMs: 1730000001000,
        error: {
          code: 'USER_CANCELLED',
          message: 'Cancelled by user request',
        },
        runtimeDiagnostics: {
          asyncMode: 'enabled',
        },
      },
      meta: RESPONSE_META,
    },
  },
  {
    name: 'bulletin',
    schemaName: 'BulletinResponseSchema',
    schema: BulletinResponseSchema,
    fixture: {
      data: {
        commitments: [HEX_A],
        bulletinRoot: HEX_B,
        treeSize: 1,
        generatedAtMs: 1730000000000,
        rootHistory: [{ recordedAtMs: 1730000000000, treeSize: 1, bulletinRoot: HEX_B }],
      },
      meta: {
        ...RESPONSE_META,
        page: {
          nextOffset: null,
          hasMore: false,
        },
      },
    },
  },
  {
    name: 'bulletin-consistency-proof',
    schemaName: 'ConsistencyProofResponseSchema',
    schema: ConsistencyProofResponseSchema,
    fixture: {
      data: {
        fromTreeSize: 1,
        toTreeSize: 2,
        rootAtFromTreeSize: HEX_A,
        rootAtToTreeSize: HEX_B,
        proofNodes: [HEX_C],
        oldSubtreeHashes: [HEX_A],
        appendSubtreeHashes: [HEX_B],
        generatedAtMs: 1730000000000,
      },
      meta: RESPONSE_META,
    },
  },
  {
    name: 'bulletin-vote-proof',
    schemaName: 'BulletinProofResponseSchema',
    schema: BulletinProofResponseSchema,
    fixture: {
      data: {
        voteId: '550e8400-e29b-41d4-a716-446655440000',
        proof: {
          leafIndex: 0,
          treeSize: 1,
          merklePath: [],
          bulletinRootAtCast: HEX_A,
        },
      },
      meta: RESPONSE_META,
    },
  },
  {
    name: 'bitmap-proof',
    schemaName: 'BitmapProofResponseSchema',
    schema: BitmapProofResponseSchema,
    fixture: {
      data: {
        leafChunk: HEX_A,
        auditPath: [{ hash: HEX_B, position: 'left' }],
      },
      meta: RESPONSE_META,
    },
  },
  {
    name: 'sth',
    schemaName: 'SthResponseSchema',
    schema: SthResponseSchema,
    fixture: {
      data: {
        sth: {
          sthDigest: HEX_A,
          bulletinRoot: HEX_B,
          treeSize: 1,
          timestamp: 1730000000000,
          logId: HEX_C,
        },
      },
      meta: RESPONSE_META,
    },
  },
  {
    name: 'input-commitment',
    schemaName: 'InputCommitmentResponseSchema',
    schema: InputCommitmentResponseSchema,
    fixture: {
      data: {
        inputCommitment: HEX_A,
      },
      meta: RESPONSE_META,
    },
  },
];

const SCHEMA_CASES: SchemaCase[] = [
  { name: 'SessionResponse', schema: SessionResponseSchema, fixtures: [sessionFixture] },
  { name: 'VoteResponse', schema: VoteResponseSchema, fixtures: [voteFixture] },
  { name: 'ProgressResponse', schema: ProgressResponseSchema, fixtures: [progressFixture] },
  {
    name: 'FinalizationResponse',
    schema: FinalizationResponseSchema,
    fixtures: [
      finalizeAcceptedFixture,
      statusRunningFixture,
      finalizeSyncFixture,
      statusSucceededFixture,
      finalizationFailedFixture,
      finalizationTimeoutFixture,
    ],
  },
  {
    name: 'CurrentFinalizationResponse',
    schema: CurrentFinalizationResponseSchema,
    fixtures: [
      statusPendingFixture,
      statusRunningFixture,
      statusSucceededFixture,
      finalizeSyncFixture,
      finalizationFailedFixture,
      finalizationTimeoutFixture,
      currentFinalizationEmptyFixture,
    ],
  },
  {
    name: 'VerificationResourceResponse',
    schema: VerificationResourceResponseSchema,
    fixtures: [
      verifyS0Fixture,
      verifyS1Fixture,
      verifyS2Fixture,
      verifyS3Fixture,
      verifyS4Fixture,
      verifyS5Fixture,
      verifyFailClosedFixture,
    ],
  },
  {
    name: 'VerificationObservationResponse',
    schema: VerificationObservationResponseSchema,
    fixtures: [
      { data: { status: 'recorded' }, meta: RESPONSE_META },
      { data: { status: 'idempotent' }, meta: RESPONSE_META },
    ],
  },
  { name: 'VerificationRunResponse', schema: VerificationRunResponseSchema, fixtures: [verificationRunFixture] },
];

const OPTIONAL_COVERAGE_EXCEPTIONS: Record<string, string[]> = {
  FinalizationResponse: [],
  CurrentFinalizationResponse: ['data.result.presentation.verificationReport.errors[]'],
  VerificationResourceResponse: [
    'data.journal.value.imageId',
    'data.verifierResult.report.dev_mode_receipt',
    'data.verifierResult.report.expected_image_id',
    'data.verifierResult.report.receipt_image_id',
    'data.verifierResult.report.verified_at',
    'data.verifierResult.report.verifier_version',
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
  if (isObjectSchema(unwrapped)) {
    const shape = getObjectShape(unwrapped);
    return Object.keys(shape).flatMap((key) => collectHex32Paths(strictDefined(shape[key]), [...base, key]));
  }
  if (isArraySchema(unwrapped)) {
    return collectHex32Paths(getArrayItem(unwrapped), [...base, '*']);
  }
  if (isUnionSchema(unwrapped)) {
    return getUnionOptions(unwrapped).flatMap((option) => collectHex32Paths(option, base));
  }
  if (isIntersectionSchema(unwrapped)) {
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
  if (isObjectSchema(schema)) {
    const shape = getObjectShape(schema);
    return Object.keys(shape).flatMap((key) =>
      collectLeafPathsWithOptionality(strictDefined(shape[key]), [...base, key], parentOptional),
    );
  }
  if (isArraySchema(schema)) {
    return collectLeafPathsWithOptionality(getArrayItem(schema), [...base, '[]'], parentOptional);
  }
  if (isUnionSchema(schema)) {
    return getUnionOptions(schema).flatMap((option) => collectLeafPathsWithOptionality(option, base, parentOptional));
  }
  if (isIntersectionSchema(schema)) {
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

  if (isObjectSchema(leftUnwrapped) && isObjectSchema(rightUnwrapped)) {
    return mergeStrictObjectSchemas(leftUnwrapped, rightUnwrapped);
  }
  if (isObjectSchema(leftUnwrapped) && isUnionSchema(rightUnwrapped)) {
    const options = getUnionOptions(rightUnwrapped).map((option) => makeDeepStrictIntersection(left, option));
    return buildUnionSchema(options);
  }
  if (isUnionSchema(leftUnwrapped) && isObjectSchema(rightUnwrapped)) {
    const options = getUnionOptions(leftUnwrapped).map((option) => makeDeepStrictIntersection(option, right));
    return buildUnionSchema(options);
  }
  if (isObjectSchema(leftUnwrapped) && rightUnwrapped instanceof s.DiscriminatedUnionSchema) {
    const options = Array.from(getDiscriminatedOptions(rightUnwrapped)).map((option) =>
      makeDeepStrictIntersection(left, option),
    );
    return buildUnionSchema(options);
  }
  if (leftUnwrapped instanceof s.DiscriminatedUnionSchema && isObjectSchema(rightUnwrapped)) {
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
  if (isArraySchema(schema)) {
    return s.array(makeDeepStrict(getArrayItem(schema)));
  }
  if (isIntersectionSchema(schema)) {
    const [left, right] = getIntersectionMembers(schema);
    return makeDeepStrictIntersection(left, right);
  }
  if (isObjectSchema(schema)) {
    const shape = getObjectShape(schema);
    const strictShape: Record<string, AnySchema> = {};
    for (const key of Object.keys(shape)) {
      strictShape[key] = makeDeepStrict(strictDefined(shape[key]));
    }
    const base = s.object(strictShape);
    let next: AnyObjectSchema = base;
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
    expect(FinalizationResponseSchema.safeParse(finalizeAcceptedFixture).success).toBe(true);
  });

  it('accepts queue estimates without positional fields in finalize and status responses', () => {
    const queue = {
      concurrencyLimit: 2,
      estimatedDurationMs: 360000,
    };
    const state = {
      status: 'pending' as const,
      finalizationId: 'exec-123',
      queuedAtMs: 1730000000000,
    };

    expect(
      FinalizationResponseSchema.safeParse({
        data: {
          ...state,
          runtimeDiagnostics: { asyncMode: 'enabled', queue },
        },
        meta: RESPONSE_META,
      }).success,
    ).toBe(true);
    expect(
      CurrentFinalizationResponseSchema.safeParse({
        data: {
          ...state,
          runtimeDiagnostics: { asyncMode: 'enabled', queue },
        },
        meta: RESPONSE_META,
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
      finalizationId: 'exec-123',
      queuedAtMs: 1730000000000,
    };

    expect(
      FinalizationResponseSchema.safeParse({
        data: {
          ...state,
          runtimeDiagnostics: { asyncMode: 'enabled', queue: legacyQueue },
        },
        meta: RESPONSE_META,
      }).success,
    ).toBe(false);
    expect(
      CurrentFinalizationResponseSchema.safeParse({
        data: {
          ...state,
          runtimeDiagnostics: { asyncMode: 'enabled', queue: legacyQueue },
        },
        meta: RESPONSE_META,
      }).success,
    ).toBe(false);
  });

  it('validates the finalize cancel request contract', () => {
    expect(
      FinalizationCancelRequestSchema.safeParse({
        reason: 'user cancelled',
      }).success,
    ).toBe(true);
    expect(FinalizationCancelRequestSchema.safeParse({ finalizationId: 'unexpected' }).success).toBe(false);
  });

  it.each(['bad/segment-123', 'bad.segment-123', 'https://example.invalid/execution'])(
    'rejects unsafe finalize cancel finalizationId %s',
    (finalizationId) => {
      expect(
        FinalizationCancelParamsSchema.safeParse({
          sessionId: 'session-123',
          finalizationId,
        }).success,
      ).toBe(false);
    },
  );

  it('rejects Step Functions ARNs in public finalize responses', () => {
    const validPendingResource = {
      status: 'pending' as const,
      finalizationId: 'exec-123',
      queuedAtMs: 1730000000000,
      runtimeDiagnostics: {
        asyncMode: 'enabled' as const,
      },
    };
    const stepFunctionsArn = 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-123';

    expect(
      FinalizationResponseSchema.safeParse({
        data: validPendingResource,
        meta: RESPONSE_META,
      }).success,
    ).toBe(true);
    expect(
      FinalizationResponseSchema.safeParse({
        data: { ...validPendingResource, stepFunctionsArn },
        meta: RESPONSE_META,
      }).success,
    ).toBe(false);
    expect(
      FinalizationResponseSchema.safeParse({
        data: {
          ...validPendingResource,
          runtimeDiagnostics: {
            ...validPendingResource.runtimeDiagnostics,
            stepFunctionsArn,
          },
        },
        meta: RESPONSE_META,
      }).success,
    ).toBe(false);
  });

  it('validates finalize sync fixture', () => {
    expect(FinalizationResponseSchema.safeParse(finalizeSyncFixture).success).toBe(true);
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
    expect(FinalizationResponseSchema.safeParse(finalizeSyncWithJournalField(field, value)).success).toBe(false);
  });

  it('rejects current journal tally entries outside the Rust u32 output contract', () => {
    expect(
      FinalizationResponseSchema.safeParse(
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
    expect(FinalizationResponseSchema.safeParse(finalizeSyncWithDirectField(field, value)).success).toBe(false);
  });

  it('validates the standard error envelope allowlist', () => {
    const representativeError = {
      error: {
        code: 'INVALID_REQUEST',
        message: 'Invalid request payload',
        details: {
          kind: 'validation',
          issues: {
            formErrors: [],
            fieldErrors: {
              vote: ['Expected string'],
            },
          },
        },
      },
      meta: RESPONSE_META,
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
        error: {
          ...representativeError.error,
          details: {
            kind: 'validation',
            issues: {
              formErrors: [],
              fieldErrors: {},
            },
            stack: 'private stack',
          },
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

  it('models finalize ImageID mismatches without untagged diagnostic details', () => {
    expect(
      StandardErrorResponseSchema.safeParse({
        error: {
          code: 'INVALID_IMAGE_ID',
          message: 'zkVMイメージIDが一致しません',
        },
        meta: RESPONSE_META,
      }).success,
    ).toBe(true);

    expect(
      StandardErrorResponseSchema.safeParse({
        error: {
          code: 'INVALID_IMAGE_ID',
          message: 'zkVMイメージIDが一致しません',
          details: 'Finalization receipt ImageID did not match the expected ImageID',
        },
        meta: RESPONSE_META,
      }).success,
    ).toBe(false);
  });

  it('rejects private fields inside public finalize receipts', () => {
    const privateReceiptFields = {
      ...finalizeSyncFixture,
      data: {
        ...finalizeSyncFixture.data,
        result: {
          ...finalizeSyncFixture.data.result,
          authority: {
            ...finalizeSyncFixture.data.result.authority,
            receipt: {
              ...finalizeSyncFixture.data.result.authority.receipt,
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
        },
      },
    };

    expect(FinalizationResponseSchema.safeParse(privateReceiptFields).success).toBe(false);
  });

  it('keeps public receipt metadata on a narrow allowlist', () => {
    const result = FinalizationResponseSchema.safeParse({
      ...finalizeSyncFixture,
      data: {
        ...finalizeSyncFixture.data,
        result: {
          ...finalizeSyncFixture.data.result,
          authority: {
            ...finalizeSyncFixture.data.result.authority,
            receipt: {
              ...finalizeSyncFixture.data.result.authority.receipt,
              metadata: {
                isFake: false,
                verifierPath: '/tmp/verifier/receipt.json',
              },
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('requires error details when finalize state is failed', () => {
    const result = FinalizationResponseSchema.safeParse({
      data: {
        status: 'failed',
        finalizationId: 'exec-123',
        queuedAtMs: 1730000000000,
        failedAtMs: 1730000005000,
        runtimeDiagnostics: { asyncMode: 'enabled' },
      },
      meta: RESPONSE_META,
    });
    expect(result.success).toBe(false);
  });

  it('rejects raw finalization error details in public state responses', () => {
    const failedState = {
      status: 'failed' as const,
      finalizationId: 'exec-123',
      queuedAtMs: 1730000000000,
      failedAtMs: 1730000005000,
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
      FinalizationResponseSchema.safeParse({
        data: {
          ...failedState,
          runtimeDiagnostics: { asyncMode: 'enabled' },
          statusUrl: '/api/sessions/session-123/finalizations/current',
        },
        meta: RESPONSE_META,
      }).success,
    ).toBe(false);
    expect(
      FinalizationResponseSchema.safeParse({
        data: { ...failedState, runtimeDiagnostics: { asyncMode: 'enabled' } },
        meta: RESPONSE_META,
      }).success,
    ).toBe(false);
    expect(
      CurrentFinalizationResponseSchema.safeParse({
        ...statusRunningFixture,
        data: {
          ...statusRunningFixture.data,
          ...failedState,
        },
      }).success,
    ).toBe(false);
  });

  it('rejects internal finalization failure categories in public state responses', () => {
    const failedState = {
      status: 'failed' as const,
      finalizationId: 'exec-123',
      queuedAtMs: 1730000000000,
      failedAtMs: 1730000005000,
      error: {
        code: 'PROVER_TASK_FAILED',
        message: 'Target prover task failed',
        category: 'prover_execution',
      },
    };

    expect(
      FinalizationResponseSchema.safeParse({
        data: {
          ...failedState,
          runtimeDiagnostics: { asyncMode: 'enabled' },
          statusUrl: '/api/sessions/session-123/finalizations/current',
        },
        meta: RESPONSE_META,
      }).success,
    ).toBe(false);
    expect(
      FinalizationResponseSchema.safeParse({
        data: { ...failedState, runtimeDiagnostics: { asyncMode: 'enabled' } },
        meta: RESPONSE_META,
      }).success,
    ).toBe(false);
    expect(
      CurrentFinalizationResponseSchema.safeParse({
        ...statusRunningFixture,
        data: {
          ...statusRunningFixture.data,
          ...failedState,
        },
      }).success,
    ).toBe(false);
  });

  it('keeps internal callback state fields outside the public finalization schema', () => {
    const internalFailedState = {
      status: 'failed' as const,
      finalizationId: 'exec-123456',
      queuedAtMs: 1730000000000,
      failedAtMs: 1730000005000,
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
      FinalizationResponseSchema.safeParse({
        data: { ...internalFailedState, runtimeDiagnostics: { asyncMode: 'enabled' } },
        meta: RESPONSE_META,
      }).success,
    ).toBe(false);
    expect(
      CurrentFinalizationResponseSchema.safeParse({
        ...statusRunningFixture,
        data: {
          ...statusRunningFixture.data,
          ...internalFailedState,
        },
      }).success,
    ).toBe(false);
  });

  it('rejects infrastructure interruption details from the public finalization resource', () => {
    const response = {
      status: 'failed',
      finalizationId: 'exec-interrupted',
      queuedAtMs: 1730000000000,
      failedAtMs: 1730000005000,
      runtimeDiagnostics: { asyncMode: 'enabled' },
      error: {
        code: 'PROVER_INTERRUPTED',
        message: 'The prover task was interrupted by the infrastructure',
        category: 'infrastructure_interruption',
      },
    };

    expect(FinalizationResponseSchema.safeParse({ data: response, meta: RESPONSE_META }).success).toBe(false);
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
  ])('rejects the internal prover failure marker category %s from public resources', (category) => {
    const internalFailedState = {
      status: 'failed' as const,
      finalizationId: 'exec-123456',
      queuedAtMs: 1730000000000,
      failedAtMs: 1730000005000,
      error: {
        code: 'PROVER_TASK_FAILED',
        message: 'Target prover task failed',
        category,
      },
    };

    expect(
      FinalizationResponseSchema.safeParse({
        data: { ...internalFailedState, runtimeDiagnostics: { asyncMode: 'enabled' } },
        meta: RESPONSE_META,
      }).success,
    ).toBe(false);
  });

  it('rejects internal runtime locator fields from public finalization resources', () => {
    const baseState = {
      status: 'succeeded' as const,
      finalizationId: 'exec-123456',
      queuedAtMs: 1730000000000,
      startedAtMs: 1730000000100,
      completedAtMs: 1730000005000,
      stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-123456',
      bundleMetadata: {
        s3BundleKey: 'sessions/550e8400-e29b-41d4-a716-446655440000/exec-123456/bundle.zip',
        s3UploadedAtMs: 1781481600000,
      },
    };

    expect(
      FinalizationResponseSchema.safeParse({
        data: {
          ...baseState,
          runtimeDiagnostics: { asyncMode: 'enabled' },
          unexpectedStateField: true,
        },
        meta: RESPONSE_META,
      }).success,
    ).toBe(false);
    expect(
      FinalizationResponseSchema.safeParse({
        data: {
          ...baseState,
          runtimeDiagnostics: { asyncMode: 'enabled' },
          bundleMetadata: {
            ...baseState.bundleMetadata,
            rawReportKey: 'private/reports/verification.json',
          },
        },
        meta: RESPONSE_META,
      }).success,
    ).toBe(false);
  });

  it('validates current finalization fixtures', () => {
    expect(CurrentFinalizationResponseSchema.safeParse(statusPendingFixture).success).toBe(true);
    expect(CurrentFinalizationResponseSchema.safeParse(statusRunningFixture).success).toBe(true);
    expect(CurrentFinalizationResponseSchema.safeParse(statusSucceededFixture).success).toBe(true);
    expect(CurrentFinalizationResponseSchema.safeParse(currentFinalizationEmptyFixture).success).toBe(true);
  });

  it('rejects Step Functions locators from current finalization responses', () => {
    const result = CurrentFinalizationResponseSchema.safeParse({
      ...statusRunningFixture,
      data: {
        ...statusRunningFixture.data,
        runtimeDiagnostics: {
          ...statusRunningFixture.data.runtimeDiagnostics,
          orchestrator: {
            status: 'FAILED',
            startTimeMs: 1730000001000,
            stopTimeMs: 1730000009000,
            executionArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-001',
          },
        },
        stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-001',
      },
    });

    expect(result.success).toBe(false);
  });

  it.each([
    ['S0', verifyS0Fixture, false, 0, 0, 'missing_evidence', false],
    ['S1', verifyS1Fixture, true, 1, 1, 'user_vote_excluded', false],
    ['S2', verifyS2Fixture, true, 0, 0, 'published_tally_mismatch', true],
    ['S3', verifyS3Fixture, true, 1, 1, 'votes_excluded', false],
    ['S4', verifyS4Fixture, true, 0, 0, 'published_tally_mismatch', true],
    ['S5', verifyS5Fixture, true, 4, 4, 'votes_excluded', false],
  ] as const)(
    'validates grouped %s verification fixture without changing its fail-closed outcome',
    (scenarioId, fixture, tamperDetected, missingSlots, excludedSlots, summaryStatus, publishedTallyMismatch) => {
      const response = VerificationResourceResponseSchema.parse(fixture);
      expect(response.data.availability).toBe('available');
      if (response.data.availability !== 'available') {
        throw new Error(`Expected ${scenarioId} verification fixture to be available`);
      }

      expect(response.data.presentation).toMatchObject({
        scenarioId,
        tamperDetected,
        policy: {
          summary: {
            status: summaryStatus,
          },
          evidenceFullyVerified: false,
          fullyVerifiedLabelEligible: false,
          publishedTallyMismatch,
        },
      });
      expect(response.data.proofAuthority).toMatchObject({
        missingSlots,
        excludedSlots,
      });
      expect(response.data.verifierResult.status).toBe('not_run');
      expect(response.data.voterEvidence.availability).toBe('available');
      expect(response.data.journal).toEqual({ representation: 'omitted' });
    },
  );

  it('accepts the current verification check note keys in verification resources', () => {
    const baseCheck = strictDefined(verifyS0Fixture.data.verification.checks[0], 'verification check fixture');

    for (const noteKey of PUBLIC_VERIFICATION_CHECK_NOTE_KEY_VALUES) {
      const result = VerificationResourceResponseSchema.safeParse({
        ...verifyS0Fixture,
        data: {
          ...verifyS0Fixture.data,
          verification: {
            ...verifyS0Fixture.data.verification,
            checks: [
              {
                ...baseCheck,
                noteKey,
              },
            ],
          },
        },
      });

      expect(result.success).toBe(true);
    }
  });

  it('rejects unknown verification check note keys and extra check fields', () => {
    const baseCheck = strictDefined(verifyS0Fixture.data.verification.checks[0], 'verification check fixture');

    expect(
      VerificationResourceResponseSchema.safeParse({
        ...verifyS0Fixture,
        data: {
          ...verifyS0Fixture.data,
          verification: {
            ...verifyS0Fixture.data.verification,
            checks: [
              {
                ...baseCheck,
                noteKey: 'pages.verify.stepsCard.notes.myVoteIncluded.future',
              },
            ],
          },
        },
      }).success,
    ).toBe(false);

    expect(
      VerificationResourceResponseSchema.safeParse({
        ...verifyS0Fixture,
        data: {
          ...verifyS0Fixture.data,
          verification: {
            ...verifyS0Fixture.data.verification,
            checks: [
              {
                ...baseCheck,
                noteKey: strictDefined(PUBLIC_VERIFICATION_CHECK_NOTE_KEY_VALUES[0], 'verification check note key'),
                debugShape: true,
              },
            ],
          },
        },
      }).success,
    ).toBe(false);
  });

  it('validates the unavailable verification resource without success-shaped fields', () => {
    expect(VerificationResourceResponseSchema.safeParse(verifyFailClosedFixture).success).toBe(true);
    expect(VerificationResourceResponseSchema.safeParse({ data: verifyFailClosedFixture }).success).toBe(false);
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...verifyFailClosedFixture,
        data: {
          ...verifyFailClosedFixture.data,
          reason: 'invalid_artifact',
        },
      }).success,
    ).toBe(false);
  });

  it('requires seenIndicesCount in verification proof authority', () => {
    const proofAuthorityWithoutSeenIndicesCount = {
      ...verifyS0Fixture.data.proofAuthority,
    } as Partial<typeof verifyS0Fixture.data.proofAuthority>;
    delete proofAuthorityWithoutSeenIndicesCount.seenIndicesCount;

    expect(
      VerificationResourceResponseSchema.safeParse({
        ...verifyS0Fixture,
        data: {
          ...verifyS0Fixture.data,
          proofAuthority: proofAuthorityWithoutSeenIndicesCount,
        },
      }).success,
    ).toBe(false);
  });

  it('rejects raw verification report errors in public responses', () => {
    const result = VerificationResourceResponseSchema.safeParse({
      ...verifyS0Fixture,
      data: {
        ...verifyS0Fixture.data,
        verifierResult: {
          ...verifyS0Fixture.data.verifierResult,
          report: {
            ...verifyS0Fixture.data.verifierResult.report,
            errors: ['failed to read /tmp/verifier-work/input.json'],
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('traverses grouped verification resource unions in contract helpers', () => {
    const hexPaths = collectHex32Paths(VerificationResourceResponseSchema).map((path) => formatHexPath(path.segments));
    expect(hexPaths).toContain('data.proofAuthority.imageId');

    const leafPaths = collectLeafPathsWithOptionality(VerificationResourceResponseSchema).map(
      (entry) => `${entry.path}:${entry.optional}`,
    );
    expect(leafPaths).toContain('data.proofAuthority.imageId:false');
    expect(leafPaths).toContain('data.finalizationId:false');

    const strictSchema = makeDeepStrict(VerificationResourceResponseSchema);
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
      data: {
        voteId: 'vote-1',
        proof: {
          leafIndex: 0,
          treeSize: 1,
          merklePath: [],
          bulletinRootAtCast: `0x${'1'.repeat(64)}`,
          proofMode: 'rfc6962',
        },
      },
      meta: RESPONSE_META,
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
    const coveredSchemas = new Set(CONTRACT_FIXTURES.map((fixture) => fixture.schema));
    const missing = TARGET_API_ROUTE_CONTRACTS.filter(
      (route) =>
        route.dataClassification === 'public-session-issued' ||
        route.dataClassification === 'owner-scoped-public-projection',
    )
      .flatMap((route) =>
        route.responses.flatMap((response) =>
          response.content === 'json' && 'schema' in response && !coveredSchemas.has(response.schema)
            ? [`${route.routeId}: ${response.status}`]
            : [],
        ),
      )
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
