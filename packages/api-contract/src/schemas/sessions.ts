import { s, type Infer } from '@stark-ballot/validation/schema';
import {
  apiResponseSchema,
  capabilityTokenSchema,
  hex32Schema,
  publicObject,
  SESSION_CAPABILITY_HEADER,
  turnstileTokenFields,
  sessionIdSchema,
} from './primitives';

export const PathSessionCapabilityHeadersSchema = publicObject({
  [SESSION_CAPABILITY_HEADER]: capabilityTokenSchema,
});

export const SessionParamsSchema = publicObject({
  sessionId: sessionIdSchema,
});

export const SessionCreateRequestSchema = publicObject({
  ...turnstileTokenFields,
});

export const SessionResponseSchema = apiResponseSchema(
  publicObject({
    sessionId: sessionIdSchema,
    electionId: s.string().min(1),
    electionConfigHash: hex32Schema,
    logId: s.string().min(1),
    capabilityToken: capabilityTokenSchema,
  }),
);

export type PathSessionCapabilityHeaders = Infer<typeof PathSessionCapabilityHeadersSchema>;
export type SessionParams = Infer<typeof SessionParamsSchema>;
export type SessionCreateRequest = Infer<typeof SessionCreateRequestSchema>;
export type SessionResponse = Infer<typeof SessionResponseSchema>;
