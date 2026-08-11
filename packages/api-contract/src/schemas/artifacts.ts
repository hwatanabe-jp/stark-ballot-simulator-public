import { s, type Infer } from '@stark-ballot/validation/schema';
import {
  apiResponseSchema,
  finalizationIdSchema,
  hex32Schema,
  nonNegativeIntegerQuerySchema,
  publicObject,
  sessionIdSchema,
} from './primitives';

export const BITMAP_KIND_VALUES = ['included', 'seen'] as const;

export const bitmapKindSchema = s.enum(BITMAP_KIND_VALUES);
export type BitmapKind = Infer<typeof bitmapKindSchema>;

export const FinalizationArtifactParamsSchema = publicObject({
  sessionId: sessionIdSchema,
  finalizationId: finalizationIdSchema,
});
export type FinalizationArtifactParams = Infer<typeof FinalizationArtifactParamsSchema>;

export const CurrentFinalizationBitmapProofParamsSchema = publicObject({
  sessionId: sessionIdSchema,
  kind: bitmapKindSchema,
  voteIndex: nonNegativeIntegerQuerySchema,
});
export type CurrentFinalizationBitmapProofParams = Infer<typeof CurrentFinalizationBitmapProofParamsSchema>;

export const CurrentFinalizationInputCommitmentParamsSchema = publicObject({
  sessionId: sessionIdSchema,
});
export type CurrentFinalizationInputCommitmentParams = Infer<typeof CurrentFinalizationInputCommitmentParamsSchema>;

export const BitmapProofResponseSchema = apiResponseSchema(
  publicObject({
    leafChunk: hex32Schema,
    auditPath: s.array(
      publicObject({
        hash: hex32Schema,
        position: s.enum(['left', 'right']),
      }),
    ),
  }),
);
export type BitmapProofResponse = Infer<typeof BitmapProofResponseSchema>;

export const InputCommitmentResponseSchema = apiResponseSchema(
  publicObject({
    inputCommitment: hex32Schema,
  }),
);
export type InputCommitmentResponse = Infer<typeof InputCommitmentResponseSchema>;
