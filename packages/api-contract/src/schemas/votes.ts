import { s, type Infer } from '@stark-ballot/validation/schema';
import {
  apiResponseSchema,
  hex32Schema,
  publicObject,
  timestampMsSchema,
  treeSizeSchema,
  turnstileTokenFields,
  voteChoiceSchema,
  voteIdSchema,
  voteIndexSchema,
} from './primitives';

export const inclusionProofSchema = publicObject({
  leafIndex: voteIndexSchema,
  treeSize: treeSizeSchema,
  merklePath: s.array(hex32Schema),
  bulletinRootAtCast: hex32Schema,
});

export const voteReceiptBaseSchema = publicObject({
  voteId: voteIdSchema,
  commitment: hex32Schema,
  bulletinIndex: voteIndexSchema,
  bulletinRootAtCast: hex32Schema,
  castAtMs: timestampMsSchema,
});

export const voteReceiptSchema = voteReceiptBaseSchema.extend({
  inputCommitment: hex32Schema.optional(),
});

export const receiptPublicationSchema = publicObject({
  receiptHash: hex32Schema,
  boardIndex: voteIndexSchema,
});

export const publicReceiptPublicationSchema = receiptPublicationSchema.extend({
  timestamp: timestampMsSchema.optional(),
});

export const VoteRequestSchema = publicObject({
  commitment: hex32Schema,
  vote: voteChoiceSchema,
  rand: hex32Schema,
  ...turnstileTokenFields,
});

export const VoteResponseSchema = apiResponseSchema(voteReceiptBaseSchema);

export type InclusionProof = Infer<typeof inclusionProofSchema>;
export type VoteReceiptBase = Infer<typeof voteReceiptBaseSchema>;
export type VoteReceipt = Infer<typeof voteReceiptSchema>;
export type ReceiptPublication = Infer<typeof receiptPublicationSchema>;
export type PublicReceiptPublication = Infer<typeof publicReceiptPublicationSchema>;
export type VoteRequest = Infer<typeof VoteRequestSchema>;
export type VoteResponse = Infer<typeof VoteResponseSchema>;
