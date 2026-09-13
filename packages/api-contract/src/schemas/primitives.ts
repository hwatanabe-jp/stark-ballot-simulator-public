import { SAFE_VERIFIER_SEGMENT_PATTERN } from '@stark-ballot/validation/safe-verifier-segment';
import {
  s,
  type Infer,
  type NeverSchema,
  type ObjectSchema,
  type SchemaShape,
  type AnySchema,
  type StringSchema,
} from '@stark-ballot/validation/schema';
import { documentOpenApiRefinement, documentOpenApiTransform } from '@stark-ballot/validation/schema-openapi';
import { UINT32_MAX } from '@stark-ballot/zkvm-contract/zkvm/types';

export const VOTE_CHOICES = ['A', 'B', 'C', 'D', 'E'] as const;
export const SCENARIO_IDS = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'] as const;

export const SESSION_CAPABILITY_HEADER = 'X-Session-Capability';

function isValidHexString(value: string, byteLength?: number): boolean {
  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  return /^[0-9a-fA-F]+$/.test(normalized) && (byteLength === undefined || normalized.length === byteLength * 2);
}

export function publicObject<const TShape extends SchemaShape>(
  shape: TShape,
): ObjectSchema<TShape, 'strict', NeverSchema> {
  return s.object(shape).strict();
}

export const requestIdSchema = s.string().min(1);

export const apiResponseMetaSchema = publicObject({
  requestId: requestIdSchema,
});

type ApiResponseMetaShape<TAdditionalMetaShape extends SchemaShape> = Omit<TAdditionalMetaShape, 'requestId'> & {
  requestId: typeof requestIdSchema;
};

type ResponseSchema<TSchema extends AnySchema, TAdditionalMetaShape extends SchemaShape> = ObjectSchema<
  {
    data: TSchema;
    meta: ObjectSchema<ApiResponseMetaShape<TAdditionalMetaShape>, 'strict', NeverSchema>;
  },
  'strict',
  NeverSchema
>;

export function apiResponseSchema<TSchema extends AnySchema>(
  schema: TSchema,
): ResponseSchema<TSchema, Record<never, never>>;
export function apiResponseSchema<TSchema extends AnySchema, const TAdditionalMetaShape extends SchemaShape>(
  schema: TSchema,
  additionalMetaShape: TAdditionalMetaShape &
    Required<TAdditionalMetaShape> &
    (string extends keyof TAdditionalMetaShape ? never : keyof TAdditionalMetaShape extends string ? unknown : never),
): ResponseSchema<TSchema, TAdditionalMetaShape>;
export function apiResponseSchema<
  TSchema extends AnySchema,
  const TAdditionalMetaShape extends SchemaShape = Record<never, never>,
>(schema: TSchema, additionalMetaShape?: TAdditionalMetaShape): ResponseSchema<TSchema, TAdditionalMetaShape> {
  const metaShape = {
    ...additionalMetaShape,
    requestId: requestIdSchema,
  } as ApiResponseMetaShape<TAdditionalMetaShape>;
  const meta = publicObject(metaShape);
  return publicObject({
    data: schema,
    meta,
  });
}

export const sessionIdSchema = s.string().min(1);
export const voteIdSchema = s.string().min(1);
export const finalizationIdSchema = s
  .string()
  .regex(SAFE_VERIFIER_SEGMENT_PATTERN, 'Expected a safe single path segment');
export const capabilityTokenSchema = s.string().min(1);

export const hex32Schema = documentOpenApiRefinement(
  s
    .string()
    .refine((value) => isValidHexString(value, 32), {
      message: 'Expected 32-byte hex string',
    })
    .describe('hex32'),
  'The value is exactly 32 bytes of hexadecimal, with an optional lowercase 0x prefix.',
  { pattern: '^(?:0x)?[0-9A-Fa-f]{64}$' },
);

export const timestampMsSchema = s.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const durationMsSchema = s.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const treeSizeSchema = s.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const positiveTreeSizeSchema = treeSizeSchema.min(1);
export const voteIndexSchema = s.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const uint32Schema = s.number().int().nonnegative().max(UINT32_MAX);
export const positiveUint32Schema = uint32Schema.min(1);

export const voteChoiceSchema = s.enum(VOTE_CHOICES);
export const scenarioIdSchema = s.enum(SCENARIO_IDS);

const nonNegativeIntegerQueryTextSchema = s.string().regex(/^(0|[1-9]\d*)$/);
const positiveIntegerQueryTextSchema = s.string().regex(/^[1-9]\d*$/);

function integerQuerySchema(textSchema: StringSchema, minimum: 0 | 1) {
  const boundedTextSchema = documentOpenApiRefinement(
    textSchema.refine((value) => Number.isSafeInteger(Number(value)), {
      message: 'Expected a safe integer',
    }),
    `The decimal wire value is at most ${Number.MAX_SAFE_INTEGER} and converts without rounding or overflow.`,
    { maxLength: String(Number.MAX_SAFE_INTEGER).length },
  );
  return documentOpenApiTransform(
    boundedTextSchema.transform((value) => Number(value)),
    {},
    { type: 'integer', minimum, maximum: Number.MAX_SAFE_INTEGER },
  );
}

export const nonNegativeIntegerQuerySchema = integerQuerySchema(nonNegativeIntegerQueryTextSchema, 0);
export const positiveIntegerQuerySchema = integerQuerySchema(positiveIntegerQueryTextSchema, 1);
const bulletinLimitQueryTextSchema = documentOpenApiRefinement(
  positiveIntegerQueryTextSchema.refine((value) => Number(value) <= 1000, {
    message: 'Expected integer <= 1000',
  }),
  'The decimal wire value is between 1 and 1000 with no leading zero.',
  { pattern: '^(?:[1-9]\\d{0,2}|1000)$' },
);
export const bulletinLimitQuerySchema = documentOpenApiTransform(
  bulletinLimitQueryTextSchema.transform((value) => Number(value)),
  {},
  { type: 'integer', minimum: 1, maximum: 1000 },
);

export const tallyCountsSchema = publicObject({
  A: uint32Schema,
  B: uint32Schema,
  C: uint32Schema,
  D: uint32Schema,
  E: uint32Schema,
});

const tallyBaseShape = {
  counts: tallyCountsSchema,
  totalVotes: uint32Schema,
} as const;

function addTallyChoiceCounts(counts: Infer<typeof tallyCountsSchema>): number | undefined {
  const total = VOTE_CHOICES.reduce((sum, choice) => sum + counts[choice], 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

function refineTallyTotal(
  tally: { counts: Infer<typeof tallyCountsSchema>; totalVotes: number },
  context: { addIssue(issue: { message: string }): void },
): void {
  if (addTallyChoiceCounts(tally.counts) !== tally.totalVotes) {
    context.addIssue({ message: 'Tally totalVotes must equal the sum of all choice counts' });
  }
}

export const tallySchema = documentOpenApiRefinement(
  publicObject({
    ...tallyBaseShape,
    tamperedCount: uint32Schema.optional(),
  }).superRefine(refineTallyTotal),
  'totalVotes equals the sum of the A, B, C, D, and E counts.',
);

export const tallyWithRequiredTamperedCountSchema = documentOpenApiRefinement(
  publicObject({
    ...tallyBaseShape,
    tamperedCount: uint32Schema,
  }).superRefine(refineTallyTotal),
  'totalVotes equals the sum of the A, B, C, D, and E counts.',
);

export const journalTallySchema = s.tuple([uint32Schema, uint32Schema, uint32Schema, uint32Schema, uint32Schema]);

export const turnstileTokenFields = {
  turnstileToken: s.string().min(1).optional(),
};

export type VoteChoice = Infer<typeof voteChoiceSchema>;
export type ScenarioId = Infer<typeof scenarioIdSchema>;
export type SessionIdWire = Infer<typeof sessionIdSchema>;
export type VoteId = Infer<typeof voteIdSchema>;
export type FinalizationIdWire = Infer<typeof finalizationIdSchema>;
export type CapabilityTokenWire = Infer<typeof capabilityTokenSchema>;
export type RequestId = Infer<typeof requestIdSchema>;
export type Hex32 = Infer<typeof hex32Schema>;
export type TimestampMs = Infer<typeof timestampMsSchema>;
export type DurationMs = Infer<typeof durationMsSchema>;
export type TreeSize = Infer<typeof treeSizeSchema>;
export type PositiveTreeSize = Infer<typeof positiveTreeSizeSchema>;
export type VoteIndex = Infer<typeof voteIndexSchema>;
export type Uint32 = Infer<typeof uint32Schema>;
export type PositiveUint32 = Infer<typeof positiveUint32Schema>;
export type PaginationOffset = Infer<typeof nonNegativeIntegerQuerySchema>;
export type PaginationLimit = Infer<typeof bulletinLimitQuerySchema>;
export type TallyCounts = Infer<typeof tallyCountsSchema>;
export type Tally = Infer<typeof tallySchema>;
export type JournalTally = Infer<typeof journalTallySchema>;
