import type { CapabilityTokenWire, FinalizationIdWire, SessionIdWire } from '@stark-ballot/api-contract/schemas';
import { s, type Infer, type NumberSchema } from '@stark-ballot/validation/schema';
import { apiResponseSchema } from './primitives';
import type {
  CapabilityTokenWire as PublicCapabilityTokenWire,
  FinalizationIdWire as PublicFinalizationIdWire,
  SessionIdWire as PublicSessionIdWire,
} from '@stark-ballot/api-contract';
// @ts-expect-error the unqualified name collided with the domain SessionId brand and was retired
import type { SessionId } from './primitives';
// @ts-expect-error the unqualified name collided with the application FinalizationId brand and was retired
import type { FinalizationId } from './primitives';
// @ts-expect-error the unqualified name collided with the domain CapabilityToken brand and was retired
import type { CapabilityToken } from './primitives';

const sessionId: SessionIdWire = 'session-wire-value';
const finalizationId: FinalizationIdWire = 'finalization-wire-value';
const capabilityToken: CapabilityTokenWire = 'capability-token-wire-value';

void (sessionId satisfies PublicSessionIdWire);
void (finalizationId satisfies PublicFinalizationIdWire);
void (capabilityToken satisfies PublicCapabilityTokenWire);

void (undefined as unknown as SessionId);
void (undefined as unknown as FinalizationId);
void (undefined as unknown as CapabilityToken);

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Expect<Value extends true> = Value;

const overlappingMetaSchema = apiResponseSchema(s.string(), { requestId: s.number(), page: s.number() });
const noAdditionalMetaSchema = apiResponseSchema(s.string());
const optionalPageMetaSchema = apiResponseSchema(s.string(), { page: s.number().optional() });
void overlappingMetaSchema;
void noAdditionalMetaSchema;
void optionalPageMetaSchema;

declare const indexedMeta: Record<string, NumberSchema>;
// @ts-expect-error Index signatures cannot exclude the canonical string requestId field.
apiResponseSchema(s.string(), indexedMeta);
// @ts-expect-error Spreading indexed metadata cannot retain an unsafe numeric requestId inference.
apiResponseSchema(s.string(), { ...indexedMeta });
// @ts-expect-error Explicit generic arguments cannot admit an index signature for metadata.
apiResponseSchema<ReturnType<typeof s.string>, Record<string, NumberSchema>>(s.string(), indexedMeta);

declare const numericMeta: Record<number, NumberSchema>;
// @ts-expect-error Response metadata is declared through finite named string keys.
apiResponseSchema(s.string(), numericMeta);
declare const symbolMeta: Record<symbol, NumberSchema>;
// @ts-expect-error Symbol metadata cannot be represented by the JSON response parser.
apiResponseSchema(s.string(), symbolMeta);

declare const maybeMeta: { page: NumberSchema } | undefined;
// @ts-expect-error Metadata presence must be established before declaring its required fields.
apiResponseSchema(s.string(), maybeMeta);
// @ts-expect-error A second argument cannot be undefined; omit it to construct the base response.
apiResponseSchema(s.string(), undefined);
// @ts-expect-error Explicit metadata type arguments cannot invent a shape that was never provided.
apiResponseSchema<ReturnType<typeof s.string>, { page: NumberSchema }>(s.string());

declare const optionalMetaMembers: { page?: NumberSchema };
// @ts-expect-error Optional schema members are not optional values; use an optional schema instead.
apiResponseSchema(s.string(), { ...optionalMetaMembers });

export type ResponseMetaAssertions = [
  Expect<Equal<Infer<typeof overlappingMetaSchema>, { data: string; meta: { requestId: string; page: number } }>>,
  Expect<Equal<Infer<typeof noAdditionalMetaSchema>, { data: string; meta: { requestId: string } }>>,
  Expect<
    Equal<
      Infer<typeof optionalPageMetaSchema>,
      { data: string; meta: { requestId: string; page?: number | undefined } }
    >
  >,
];
