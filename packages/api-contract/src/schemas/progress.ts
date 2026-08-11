import { s, type Infer } from '@stark-ballot/validation/schema';
import { apiResponseSchema, tallyCountsSchema, timestampMsSchema } from './primitives';

export const ProgressResponseSchema = apiResponseSchema(
  s
    .object({
      count: s.number().int().nonnegative(),
      total: s.number().int().nonnegative(),
      completed: s.boolean(),
      userVoted: s.boolean(),
      finalized: s.boolean(),
      distribution: tallyCountsSchema.optional(),
      distributionKind: s.literal('simulated').optional(),
      updatedAtMs: timestampMsSchema.optional(),
      animationSeed: s.string().optional(),
    })
    .strict(),
);

export type ProgressResponse = Infer<typeof ProgressResponseSchema>;
