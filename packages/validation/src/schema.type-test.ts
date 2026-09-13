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
    optional: s.string().optional(),
  }),
});

const transformedQuerySchema = s.object({
  limit: s.string().transform((value) => Number(value)),
  includeData: s.union([s.literal('true'), s.literal('false')]).transform((value) => value === 'true'),
});

const arrayUnionSchema = s.array(s.union([s.string(), s.number()]));
const tupleSchema = s.tuple([s.string(), s.number(), s.boolean()]);

const discriminatedUnionSchema = s.union([
  s.object({ kind: s.literal('text'), value: s.string() }),
  s.object({ kind: s.literal('count'), value: s.number() }),
]);

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
const optionalTransformSchema = s.string().transform((value) => (value === '' ? undefined : value));

// @ts-expect-error runtime checks and structural constraints cannot be supplied independently
new s.NumberSchema([], [{ kind: 'minimum', value: 100, exclusive: false }]);
// @ts-expect-error runtime checks and structural constraints cannot be supplied independently
new s.StringSchema([], undefined, [{ kind: 'minLength', value: 100 }]);
// @ts-expect-error runtime checks and structural constraints cannot be supplied independently
new s.ArraySchema(s.string(), [], [{ kind: 'minItems', value: 100 }]);
// @ts-expect-error arbitrary callback constraints belong to EffectsSchema
new s.NumberSchema([() => null]);

new s.EffectsSchema<string, string | number>(s.union([s.string(), s.number()]), {
  kind: 'transform',
  // @ts-expect-error the input schema also admits numbers
  transform: (value: string) => value.toUpperCase(),
});
new s.EffectsSchema(s.union([s.string(), s.number()]), {
  kind: 'transform',
  // @ts-expect-error callback inference must not narrow the admitted schema input
  transform: (value: string) => value.toUpperCase(),
});
new s.EffectsSchema<string | number, string | number>(s.union([s.string(), s.number()]), {
  kind: 'refinement',
  // @ts-expect-error refinements must handle every admitted input
  refine: (value: string) => {
    void value;
  },
  output: (value) => value,
});
new s.EffectsSchema<string, string | number>(s.union([s.string(), s.number()]), {
  kind: 'refinement',
  refine: () => {},
  // @ts-expect-error refinement projections must handle every admitted input
  output: (value: string) => value,
});

const immutableObjectSchema = s.object({ tag: s.literal('one') });
// @ts-expect-error admitted schema members cannot be replaced through their public view
immutableObjectSchema.shape.tag = s.literal('one');
// @ts-expect-error the complete shape is a getter-only admission view
immutableObjectSchema.shape = { tag: s.literal('one') };
// @ts-expect-error implementation definitions are not a public mutation boundary
void immutableObjectSchema._def;

export type SchemaInferenceAssertions = [
  Expect<
    Equal<
      Infer<typeof objectSchema>,
      {
        required: string;
        optional?: number | undefined;
        nested: {
          nullable: string | null;
          optional?: string | undefined;
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
  Expect<Equal<Infer<typeof tupleSchema>, [string, number, boolean]>>,
  Expect<
    Equal<Infer<typeof discriminatedUnionSchema>, { kind: 'text'; value: string } | { kind: 'count'; value: number }>
  >,
  Expect<Equal<Infer<typeof strictObjectSchema>, { known: string }>>,
  Expect<Equal<Infer<typeof emptyStrictObjectSchema>, Record<string, never>>>,
  Expect<Extends<Infer<typeof passthroughObjectSchema>, { known: string } & Record<string, unknown>>>,
  Expect<Equal<Infer<typeof catchallObjectSchema>, Record<string, number>>>,
  Expect<Equal<Infer<typeof shapedCatchallObjectSchema>, { known: string } & Record<string, string | number>>>,
  Expect<Equal<Infer<typeof extendedObjectSchema>, { added: boolean; replaced: number }>>,
  Expect<Equal<Infer<typeof refinedSchema>, string>>,
  Expect<Equal<Infer<typeof superRefinedSchema>, string>>,
  Expect<Equal<Infer<typeof transformedSchema>, number>>,
  Expect<Equal<Infer<typeof optionalTransformSchema>, string | undefined>>,
];

void [
  objectSchema,
  transformedQuerySchema,
  arrayUnionSchema,
  tupleSchema,
  discriminatedUnionSchema,
  strictObjectSchema,
  emptyStrictObjectSchema,
  passthroughObjectSchema,
  catchallObjectSchema,
  shapedCatchallObjectSchema,
  extendedObjectSchema,
  refinedSchema,
  superRefinedSchema,
  transformedSchema,
  optionalTransformSchema,
];
