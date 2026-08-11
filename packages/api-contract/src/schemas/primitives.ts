import { SAFE_VERIFIER_SEGMENT_PATTERN } from '@stark-ballot/validation/safe-verifier-segment';
import {
  s,
  type Infer,
  type NeverSchema,
  type ObjectSchema,
  type SchemaShape,
  type SchemaTypeAny,
} from '@stark-ballot/validation/schema';
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

type ApiResponseMetaShape<TAdditionalMetaShape extends SchemaShape> = TAdditionalMetaShape & {
  requestId: typeof requestIdSchema;
};

export function apiResponseSchema<
  TSchema extends SchemaTypeAny,
  const TAdditionalMetaShape extends SchemaShape = Record<never, never>,
>(
  schema: TSchema,
  additionalMetaShape?: TAdditionalMetaShape,
): ObjectSchema<
  {
    data: TSchema;
    meta: ObjectSchema<ApiResponseMetaShape<TAdditionalMetaShape>, 'strict', NeverSchema>;
  },
  'strict',
  NeverSchema
> {
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

export const hex32Schema = s
  .string()
  .refine((value) => isValidHexString(value, 32), {
    message: 'Expected 32-byte hex string',
  })
  .describe('hex32');

export const timestampMsSchema = s.number().int().nonnegative();
export const durationMsSchema = s.number().int().nonnegative();
export const treeSizeSchema = s.number().int().nonnegative();
export const positiveTreeSizeSchema = treeSizeSchema.min(1);
export const voteIndexSchema = s.number().int().nonnegative();
export const uint32Schema = s.number().int().nonnegative().max(UINT32_MAX);
export const positiveUint32Schema = uint32Schema.min(1);

export const voteChoiceSchema = s.enum(VOTE_CHOICES);
export const scenarioIdSchema = s.enum(SCENARIO_IDS);

const nonNegativeIntegerQueryTextSchema = s.string().regex(/^(0|[1-9]\d*)$/);
const positiveIntegerQueryTextSchema = s.string().regex(/^[1-9]\d*$/);

export const nonNegativeIntegerQuerySchema = nonNegativeIntegerQueryTextSchema.transform((value) => Number(value));
export const positiveIntegerQuerySchema = positiveIntegerQueryTextSchema.transform((value) => Number(value));
export const bulletinLimitQuerySchema = positiveIntegerQueryTextSchema
  .refine((value) => Number(value) <= 1000, {
    message: 'Expected integer <= 1000',
  })
  .transform((value) => Number(value));

export const tallyCountsSchema = publicObject({
  A: s.number().int().nonnegative(),
  B: s.number().int().nonnegative(),
  C: s.number().int().nonnegative(),
  D: s.number().int().nonnegative(),
  E: s.number().int().nonnegative(),
});

export const tallySchema = publicObject({
  counts: tallyCountsSchema,
  totalVotes: s.number().int().nonnegative(),
  tamperedCount: s.number().int().nonnegative().optional(),
});

export const journalTallySchema = s.array(uint32Schema).length(VOTE_CHOICES.length);

export const turnstileTokenFields = {
  turnstileToken: s.string().min(1).optional(),
};

export type VoteChoice = Infer<typeof voteChoiceSchema>;
export type ScenarioId = Infer<typeof scenarioIdSchema>;
export type SessionId = Infer<typeof sessionIdSchema>;
export type VoteId = Infer<typeof voteIdSchema>;
export type FinalizationId = Infer<typeof finalizationIdSchema>;
export type CapabilityToken = Infer<typeof capabilityTokenSchema>;
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
