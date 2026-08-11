import { s, type Infer } from '@stark-ballot/validation/schema';
import {
  apiResponseSchema,
  bulletinLimitQuerySchema,
  hex32Schema,
  nonNegativeIntegerQuerySchema,
  publicObject,
  sessionIdSchema,
  timestampMsSchema,
  treeSizeSchema,
  voteIdSchema,
} from './primitives';
import { inclusionProofSchema } from './votes';

export const SessionBulletinParamsSchema = publicObject({
  sessionId: sessionIdSchema,
});
export type SessionBulletinParams = Infer<typeof SessionBulletinParamsSchema>;

export const BulletinQuerySchema = publicObject({
  offset: nonNegativeIntegerQuerySchema.optional(),
  limit: bulletinLimitQuerySchema.optional(),
});
export type BulletinQuery = Infer<typeof BulletinQuerySchema>;

export const ConsistencyProofQuerySchema = publicObject({
  fromTreeSize: nonNegativeIntegerQuerySchema,
  toTreeSize: nonNegativeIntegerQuerySchema,
});
export type ConsistencyProofQuery = Infer<typeof ConsistencyProofQuerySchema>;

export const SessionVoteInclusionProofParamsSchema = publicObject({
  sessionId: sessionIdSchema,
  voteId: voteIdSchema,
});
export type SessionVoteInclusionProofParams = Infer<typeof SessionVoteInclusionProofParamsSchema>;

export const SthQuerySchema = publicObject({
  auditorId: s
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
});
export type SthQuery = Infer<typeof SthQuerySchema>;

export const bulletinRootHistorySchema = publicObject({
  recordedAtMs: timestampMsSchema,
  treeSize: treeSizeSchema,
  bulletinRoot: hex32Schema,
  signature: s.string().optional(),
});
export type BulletinRootHistory = Infer<typeof bulletinRootHistorySchema>;

export const bulletinPageSchema = publicObject({
  nextOffset: s.number().int().nonnegative().nullable(),
  hasMore: s.boolean(),
});
export type BulletinPage = Infer<typeof bulletinPageSchema>;

export const BulletinResponseSchema = apiResponseSchema(
  publicObject({
    commitments: s.array(hex32Schema),
    bulletinRoot: hex32Schema,
    treeSize: treeSizeSchema,
    generatedAtMs: timestampMsSchema,
    rootHistory: s.array(bulletinRootHistorySchema).optional(),
  }),
  {
    // Pagination continuation state is present only for paginated requests.
    page: bulletinPageSchema.optional(),
  },
);
export type BulletinResponse = Infer<typeof BulletinResponseSchema>;

export const BulletinProofResponseSchema = apiResponseSchema(
  publicObject({
    voteId: voteIdSchema,
    proof: inclusionProofSchema,
  }),
);
export type BulletinProofResponse = Infer<typeof BulletinProofResponseSchema>;

export const ConsistencyProofResponseSchema = apiResponseSchema(
  publicObject({
    fromTreeSize: treeSizeSchema,
    toTreeSize: treeSizeSchema,
    rootAtFromTreeSize: hex32Schema,
    rootAtToTreeSize: hex32Schema,
    proofNodes: s.array(hex32Schema),
    oldSubtreeHashes: s.array(hex32Schema).optional(),
    appendSubtreeHashes: s.array(hex32Schema).optional(),
    generatedAtMs: timestampMsSchema,
  }),
);
export type ConsistencyProofResponse = Infer<typeof ConsistencyProofResponseSchema>;

export const SthResponseSchema = apiResponseSchema(
  publicObject({
    sth: publicObject({
      sthDigest: hex32Schema,
      bulletinRoot: hex32Schema,
      treeSize: treeSizeSchema,
      timestamp: timestampMsSchema,
      logId: s.string(),
    }),
  }),
);
export type SthResponse = Infer<typeof SthResponseSchema>;
