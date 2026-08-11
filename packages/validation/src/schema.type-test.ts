import { s, type Infer } from './schema';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Expect<Value extends true> = Value;
type Extends<Left, Right> = [Left] extends [Right] ? true : false;

const objectSchema = s.object({
  required: s.string(),
  optional: s.number().optional(),
  nested: s.object({
    nullable: s.string().nullable(),
    withDefault: s.string().optional().default('fallback'),
  }),
});

const transformedQuerySchema = s.object({
  limit: s.string().transform((value) => Number(value)),
  includeData: s.union([s.literal('true'), s.literal('false')]).transform((value) => value === 'true'),
});

const arrayUnionSchema = s.array(s.union([s.string(), s.number()]));

const discriminatedUnionSchema = new s.DiscriminatedUnionSchema([
  s.object({ kind: s.literal('text'), value: s.string() }),
  s.object({ kind: s.literal('count'), value: s.number() }),
]);

const intersectionSchema = s.intersection(s.object({ left: s.string() }), s.object({ right: s.number() }));
const rightWinsIntersectionSchema = s.intersection(
  s.unknown().transform(() => ({ value: 'left' })),
  s.unknown().transform(() => ({ value: 2 })),
);

const strictObjectSchema = s.object({ known: s.string() }).strict();
const emptyStrictObjectSchema = s.object({}).strict();
const passthroughObjectSchema = s.object({ known: s.string() }).passthrough();
const catchallObjectSchema = s.object({}).catchall(s.number()).strict();
const shapedCatchallObjectSchema = s.object({ known: s.string() }).catchall(s.number()).strict();
const extendedObjectSchema = s.object({ replaced: s.string() }).extend({
  added: s.boolean(),
  replaced: s.number(),
});

const refinedSchema = s.string().refine((value) => value.length > 0);
const superRefinedSchema = s.string().superRefine((value, context) => {
  if (value.length === 0) {
    context.addIssue({ message: 'Expected non-empty string' });
  }
});
const transformedSchema = s.string().transform((value) => value.length);

export type SchemaInferenceAssertions = [
  Expect<
    Equal<
      Infer<typeof objectSchema>,
      {
        required: string;
        optional?: number | undefined;
        nested: {
          nullable: string | null;
          withDefault: string;
        };
      }
    >
  >,
  Expect<
    Equal<
      Infer<typeof transformedQuerySchema>,
      {
        limit: number;
        includeData: boolean;
      }
    >
  >,
  Expect<Equal<Infer<typeof arrayUnionSchema>, (string | number)[]>>,
  Expect<
    Equal<Infer<typeof discriminatedUnionSchema>, { kind: 'text'; value: string } | { kind: 'count'; value: number }>
  >,
  Expect<Equal<Infer<typeof intersectionSchema>, { left: string; right: number }>>,
  Expect<Equal<Infer<typeof rightWinsIntersectionSchema>, { value: number }>>,
  Expect<Equal<Infer<typeof strictObjectSchema>, { known: string }>>,
  Expect<Equal<Infer<typeof emptyStrictObjectSchema>, Record<string, never>>>,
  Expect<Extends<Infer<typeof passthroughObjectSchema>, { known: string } & Record<string, unknown>>>,
  Expect<Equal<Infer<typeof catchallObjectSchema>, Record<string, number>>>,
  Expect<Equal<Infer<typeof shapedCatchallObjectSchema>, { known: string } & Record<string, string | number>>>,
  Expect<Equal<Infer<typeof extendedObjectSchema>, { added: boolean; replaced: number }>>,
  Expect<Equal<Infer<typeof refinedSchema>, string>>,
  Expect<Equal<Infer<typeof superRefinedSchema>, string>>,
  Expect<Equal<Infer<typeof transformedSchema>, number>>,
];

void [
  objectSchema,
  transformedQuerySchema,
  arrayUnionSchema,
  discriminatedUnionSchema,
  intersectionSchema,
  rightWinsIntersectionSchema,
  strictObjectSchema,
  emptyStrictObjectSchema,
  passthroughObjectSchema,
  catchallObjectSchema,
  shapedCatchallObjectSchema,
  extendedObjectSchema,
  refinedSchema,
  superRefinedSchema,
  transformedSchema,
];
