import { s, type Infer } from '@stark-ballot/validation/schema';
import { documentOpenApiRefinement } from '@stark-ballot/validation/schema-openapi';
import {
  finalizationIdSchema,
  publicObject,
  requestIdSchema,
  timestampMsSchema,
  treeSizeSchema,
  voteIndexSchema,
} from './primitives';
import { verificationStatusSchema } from './verification';

// Reviewed catchall: field names are schema issue paths supplied by the
// validated request, while every value remains a closed array of strings.
export const flattenedSchemaErrorSchema = publicObject({
  formErrors: s.array(s.string()),
  fieldErrors: s.object({}).catchall(s.array(s.string())).strict(),
});

export const validationErrorDetailSchema = publicObject({
  kind: s.literal('validation'),
  issues: flattenedSchemaErrorSchema,
});

export const rateLimitErrorDetailSchema = publicObject({
  kind: s.literal('rateLimit'),
  retryAfterSeconds: s.number().nonnegative().optional(),
  nextAvailableAtMs: timestampMsSchema.optional(),
  remainingExecutions: s.number().int().nonnegative().optional(),
});

export const bodyLimitErrorDetailSchema = publicObject({
  kind: s.literal('bodyLimit'),
  limitBytes: s.number().int().nonnegative(),
  receivedBytes: s.number().int().nonnegative().optional(),
});

export const verificationStateErrorDetailSchema = publicObject({
  kind: s.literal('verificationState'),
  status: verificationStatusSchema,
  finalizationId: finalizationIdSchema.optional(),
  errorCodes: documentOpenApiRefinement(
    s
      .array(s.string().min(1).max(128))
      .refine((values) => values.length <= 20, { message: 'Expected at most 20 error codes' }),
    'At most 20 verifier error codes are exposed.',
    { maxItems: 20 },
  ).optional(),
});

export const proofRangeErrorDetailSchema = publicObject({
  kind: s.literal('proofRange'),
  voteIndex: voteIndexSchema,
  expectedTreeSize: treeSizeSchema,
  actualTreeSize: treeSizeSchema.optional(),
});

export const publicErrorDetailSchema = s.union([
  validationErrorDetailSchema,
  rateLimitErrorDetailSchema,
  bodyLimitErrorDetailSchema,
  verificationStateErrorDetailSchema,
  proofRangeErrorDetailSchema,
]);

export const StandardErrorResponseSchema = publicObject({
  error: publicObject({
    code: s.string().min(1),
    message: s.string().min(1),
    details: publicErrorDetailSchema.optional(),
  }),
  meta: publicObject({
    requestId: requestIdSchema,
  }),
});

export type FlattenedSchemaError = Infer<typeof flattenedSchemaErrorSchema>;
export type ValidationErrorDetail = Infer<typeof validationErrorDetailSchema>;
export type RateLimitErrorDetail = Infer<typeof rateLimitErrorDetailSchema>;
export type BodyLimitErrorDetail = Infer<typeof bodyLimitErrorDetailSchema>;
export type VerificationStateErrorDetail = Infer<typeof verificationStateErrorDetailSchema>;
export type ProofRangeErrorDetail = Infer<typeof proofRangeErrorDetailSchema>;
export type PublicErrorDetail = Infer<typeof publicErrorDetailSchema>;
export type StandardErrorResponse = Infer<typeof StandardErrorResponseSchema>;
