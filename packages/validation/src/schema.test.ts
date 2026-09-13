import { describe, expect, it } from 'vitest';
import { getSchemaDescriptor, s, type AnySchema } from './schema';
import { documentOpenApiRefinement, getOpenApiEffectMetadata } from './schema-openapi';

describe('schema wrapper behavior', () => {
  it('derives number admission and descriptors from the same captured constructor rules', () => {
    const rule = { kind: 'minimum' as const, value: 100, exclusive: false, message: 'At least 100' };
    const rules = [rule];
    const schema = new s.NumberSchema(rules);
    rule.value = 0;
    rule.message = 'Changed';
    rules.splice(0);

    expect(schema.safeParse(0)).toMatchObject({
      success: false,
      error: { issues: [{ path: [], message: 'At least 100' }] },
    });
    expect(schema.parse(100)).toBe(100);
    expect(getSchemaDescriptor(schema)).toEqual({
      kind: 'NumberSchema',
      constraints: [{ kind: 'minimum', value: 100, exclusive: false }],
    });
  });

  it.each([
    { schema: s.number().min(2).max(4), accepted: [2, 3.5, 4], rejected: [1.9, 4.1] },
    { schema: s.number().int().min(2).min(3).max(4), accepted: [3, 4], rejected: [2, 3.5, 5] },
    { schema: s.number().positive().max(1), accepted: [0.1, 1], rejected: [0, -1, 1.1] },
    { schema: s.number().nonnegative(), accepted: [0, 0.1], rejected: [-0.1] },
  ])('retains number boundary admission for $schema', ({ schema, accepted, rejected }) => {
    for (const value of accepted) expect(schema.safeParse(value).success).toBe(true);
    for (const value of [...rejected, NaN, Infinity, -Infinity]) expect(schema.safeParse(value).success).toBe(false);
  });

  it('preserves string rules, UTF-16 bounds, and required and optional admission', () => {
    const schema = s.string({ required_error: 'Required text' }).min(2).max(3).regex(/^A/);
    expect(getSchemaDescriptor(schema)).toEqual({
      kind: 'StringSchema',
      constraints: [
        { kind: 'minLength', value: 2 },
        { kind: 'maxLength', value: 3 },
        { kind: 'pattern', source: '^A', flags: '' },
      ],
    });
    for (const value of ['AB', 'ABC', 'A𠀀']) expect(schema.safeParse(value).success).toBe(true);
    for (const value of ['A', 'ABCD', 'BC', 'A𠀀𠀀']) expect(schema.safeParse(value).success).toBe(false);
    expect(schema.safeParse(undefined)).toMatchObject({
      success: false,
      error: { issues: [{ path: [], message: 'Required text' }] },
    });
    expect(schema.optional().parse(undefined)).toBeUndefined();
  });

  it.each(['g', 'y'])('captures patterns independently of mutable lastIndex with the %s flag', (flags) => {
    const pattern = new RegExp('^A', flags);
    pattern.lastIndex = 1;
    const schema = s.string().regex(pattern);
    expect(schema.parse('AB')).toBe('AB');
    pattern.lastIndex = 10;
    expect(schema.parse('AB')).toBe('AB');
    expect(schema.parse('AB')).toBe('AB');
    expect(schema.safeParse('BA').success).toBe(false);
    expect(pattern.lastIndex).toBe(10);
    expect(getSchemaDescriptor(schema)).toMatchObject({ constraints: [{ kind: 'pattern', source: '^A', flags }] });
  });

  it('keeps UUID runtime admission and its exact version and variant pattern aligned', () => {
    const schema = s.string().uuid();
    const descriptor = getSchemaDescriptor(schema);
    if (descriptor.kind !== 'StringSchema') throw new Error('Expected string descriptor');
    const pattern = descriptor.constraints.find((constraint) => constraint.kind === 'pattern');
    if (pattern?.kind !== 'pattern') throw new Error('Expected UUID pattern');
    expect(descriptor.constraints).toHaveLength(2);
    for (const value of [
      '123e4567-e89b-12d3-a456-426614174000',
      '123E4567-E89B-52D3-B456-426614174000',
      '123e4567-e89b-62d3-a456-426614174000',
      '123e4567-e89b-12d3-c456-426614174000',
      '00000000-0000-0000-0000-000000000000',
    ]) {
      expect(schema.safeParse(value).success).toBe(new RegExp(pattern.source, pattern.flags).test(value));
    }
  });

  it('preserves every built-in issue in fluent order, followed by array item issues', () => {
    const schema = s.object({
      text: s.string().min(5, 'short').max(1, 'long').regex(/^Z/, 'prefix').uuid('uuid'),
      values: s.array(s.number().int('integer').min(3, 'minimum')).min(3, 'items').length(2, 'length'),
    });
    expect(schema.safeParse({ text: 'ab', values: [0.5] })).toMatchObject({
      success: false,
      error: {
        issues: [
          { path: ['text'], message: 'short' },
          { path: ['text'], message: 'long' },
          { path: ['text'], message: 'prefix' },
          { path: ['text'], message: 'uuid' },
          { path: ['values'], message: 'items' },
          { path: ['values'], message: 'length' },
          { path: ['values', 0], message: 'integer' },
          { path: ['values', 0], message: 'minimum' },
        ],
      },
    });
  });

  it('derives exact array length bounds without duplicating its runtime issue', () => {
    const schema = s.array(s.boolean()).min(1).length(2);
    expect(getSchemaDescriptor(schema)).toMatchObject({
      constraints: [
        { kind: 'minItems', value: 1 },
        { kind: 'minItems', value: 2 },
        { kind: 'maxItems', value: 2 },
      ],
    });
    expect(schema.parse([true, false])).toEqual([true, false]);
    for (const value of [[true], [true, false, true]]) {
      expect(schema.safeParse(value)).toMatchObject({
        success: false,
        error: { issues: [{ path: [], message: 'Array must contain exactly 2 element(s)' }] },
      });
    }
  });

  it('parses required and optional object keys without materializing an absent optional key', () => {
    const schema = s.object({
      required: s.string(),
      optional: s.number().optional(),
    });

    expect(schema.parse({ required: 'present', ignored: true })).toEqual({
      required: 'present',
    });
    expect(schema.safeParse({ optional: 1 })).toMatchObject({
      success: false,
      error: {
        issues: [{ path: ['required'], message: 'Expected string' }],
      },
    });
  });

  it('preserves nested nullable and optional parsing', () => {
    const schema = s.object({
      nested: s.object({
        nullable: s.string().nullable(),
        optional: s.string().optional(),
      }),
    });

    expect(schema.parse({ nested: { nullable: null } })).toEqual({
      nested: {
        nullable: null,
      },
    });
  });

  it('runs transforms before later refinements', () => {
    const schema = s
      .string()
      .transform((value) => Number(value))
      .refine((value) => Number.isInteger(value), { message: 'Expected transformed integer' });

    expect(schema.parse('42')).toBe(42);
    expect(schema.safeParse('4.2')).toMatchObject({
      success: false,
      error: {
        issues: [{ path: [], message: 'Expected transformed integer' }],
      },
    });
  });

  it('preserves undefined transform outputs', () => {
    const schema = s.string().transform((value) => (value === '' ? undefined : value));

    expect(schema.parse('')).toBeUndefined();
    expect(schema.parse('value')).toBe('value');
  });

  it('retains the shape admitted at construction through source and widened references', () => {
    const shape = { tag: s.string() };
    const schema = s.object(shape);
    shape.tag = s.string().min(5);
    expect(schema.parse({ tag: 'one' })).toEqual({ tag: 'one' });

    const literalSchema = s.object({ tag: s.literal('one') });
    const widened: { shape: { tag: AnySchema } } = literalSchema;
    expect(() => {
      widened.shape.tag = s.string();
    }).toThrow(TypeError);
    expect(() => {
      widened.shape = { tag: s.string() };
    }).toThrow(TypeError);
    expect(literalSchema.parse({ tag: 'one' })).toEqual({ tag: 'one' });
    expect(literalSchema.safeParse({ tag: 'two' }).success).toBe(false);
  });

  it('captures enum, tuple, and union members before source collections change', () => {
    const values: ['A' | 'B', 'C'] = ['A', 'C'];
    const enumSchema = s.enum(values);
    values[0] = 'B';
    expect(enumSchema.parse('A')).toBe('A');
    expect(enumSchema.safeParse('B').success).toBe(false);

    const members: [AnySchema, AnySchema] = [s.string(), s.boolean()];
    const tuple = s.tuple(members);
    const union = s.union(members);
    members[0] = s.number();
    expect(tuple.parse(['value', true])).toEqual(['value', true]);
    expect(tuple.safeParse([1, true]).success).toBe(false);
    expect(union.parse('value')).toBe('value');
    expect(union.safeParse(1).success).toBe(false);
  });

  it('captures the admitted effect without retaining a mutable callback definition', () => {
    const effect = { kind: 'transform' as const, transform: (value: string) => value.toUpperCase() };
    const schema = new s.EffectsSchema(s.string(), effect);
    effect.transform = () => 'replacement';

    expect(schema.parse('value')).toBe('VALUE');
  });

  it('parses arrays and unions of scalar or discriminated object schemas', () => {
    const arrayUnion = s.array(s.union([s.string(), s.number()]));
    const discriminated = s.union([
      s.object({ kind: s.literal('text'), value: s.string() }),
      s.object({ kind: s.literal('count'), value: s.number() }),
    ]);

    expect(arrayUnion.parse(['one', 2])).toEqual(['one', 2]);
    expect(discriminated.parse({ kind: 'count', value: 3 })).toEqual({
      kind: 'count',
      value: 3,
    });
  });

  it('parses fixed-length tuples without widening them to arrays', () => {
    const tuple = s.tuple([s.string(), s.number().int(), s.boolean()]);

    expect(tuple.parse(['value', 2, true])).toEqual(['value', 2, true]);
    expect(tuple.safeParse(['value', 2])).toMatchObject({
      success: false,
      error: {
        issues: [{ path: [], message: 'Tuple must contain exactly 3 element(s)' }],
      },
    });
    expect(tuple.safeParse(['value', 2, true, false])).toMatchObject({
      success: false,
      error: {
        issues: [{ path: [], message: 'Tuple must contain exactly 3 element(s)' }],
      },
    });
    expect(tuple.safeParse(['value', 2.5, true])).toMatchObject({
      success: false,
      error: {
        issues: [{ path: [1], message: 'Expected integer' }],
      },
    });
  });

  it('preserves strict, passthrough, and typed catchall behavior', () => {
    const base = s.object({ known: s.string() });
    const strict = base.strict();
    const passthrough = base.passthrough();
    const catchall = base.catchall(s.number());

    expect(strict.safeParse({ known: 'value', extra: 1 })).toMatchObject({
      success: false,
      error: {
        issues: [{ path: ['extra'], message: 'Unrecognized key' }],
      },
    });
    expect(passthrough.parse({ known: 'value', extra: 1 })).toEqual({
      known: 'value',
      extra: 1,
    });
    expect(catchall.parse({ known: 'value', extra: 1 })).toEqual({
      known: 'value',
      extra: 1,
    });
    expect(catchall.safeParse({ known: 'value', extra: 'wrong' })).toMatchObject({
      success: false,
      error: {
        issues: [{ path: ['extra'], message: 'Expected number' }],
      },
    });
  });

  it('preserves refinement and super-refinement issue ordering and paths', () => {
    const schema = s
      .string()
      .refine((value) => value.length >= 3, { message: 'Too short' })
      .superRefine((value, context) => {
        if (!value.startsWith('A')) {
          context.addIssue({ path: ['prefix'], message: 'Expected A prefix' });
        }
      });

    expect(schema.safeParse('x')).toMatchObject({
      success: false,
      error: {
        issues: [{ path: [], message: 'Too short' }],
      },
    });
    expect(schema.safeParse('xyz')).toMatchObject({
      success: false,
      error: {
        issues: [{ path: ['prefix'], message: 'Expected A prefix' }],
      },
    });
  });

  it('exposes frozen structural descriptors without private definition access', () => {
    const item = s.string().transform((value) => value.length);
    const schema = s.object({
      fixed: s.tuple([item, s.boolean()]),
      optional: s.number().optional(),
    });
    const descriptor = getSchemaDescriptor(schema);

    expect(descriptor.kind).toBe('ObjectSchema');
    expect(Object.isFrozen(descriptor)).toBe(true);
    if (descriptor.kind !== 'ObjectSchema') {
      throw new Error('Expected an object schema descriptor');
    }
    expect(Object.isFrozen(descriptor.shape)).toBe(true);
    expect(descriptor.unknownKeys).toBe('strip');
    const fixed = descriptor.shape['fixed'];
    const optional = descriptor.shape['optional'];
    if (fixed === undefined || optional === undefined) {
      throw new Error('Expected fixed and optional schema descriptors');
    }
    expect(getSchemaDescriptor(fixed).kind).toBe('TupleSchema');
    expect(getSchemaDescriptor(optional).kind).toBe('OptionalSchema');
    expect(getSchemaDescriptor(item)).toMatchObject({ kind: 'EffectsSchema', effect: 'transform' });
  });

  it('deep-freezes descriptor constraints and declarative OpenAPI metadata', () => {
    const constrained = s.string().min(2);
    const descriptor = getSchemaDescriptor(constrained);
    if (descriptor.kind !== 'StringSchema') throw new Error('Expected string descriptor');
    expect(Object.isFrozen(descriptor.constraints[0])).toBe(true);
    expect(() => {
      (descriptor.constraints[0] as { value: number }).value = 0;
    }).toThrow(TypeError);
    expect(constrained.safeParse('x').success).toBe(false);

    const overlay = { anyOf: [{ type: 'string' }] };
    const documented = documentOpenApiRefinement(
      s.string().refine(() => true),
      'Reviewed constraint.',
      overlay,
    );
    const metadata = getOpenApiEffectMetadata(documented);
    if (metadata?.kind !== 'refinement') throw new Error('Expected refinement metadata');
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.overlay)).toBe(true);
    expect(Object.isFrozen(metadata.overlay['anyOf'])).toBe(true);
    overlay.anyOf[0] = { type: 'number' };
    expect(metadata.overlay['anyOf']).toEqual([{ type: 'string' }]);
  });
});
