import { describe, expect, it } from 'vitest';
import { s } from './schema';

describe('schema wrapper behavior', () => {
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

  it('preserves nested nullable and default parsing', () => {
    const schema = s.object({
      nested: s.object({
        nullable: s.string().nullable(),
        withDefault: s.string().optional().default('fallback'),
      }),
    });

    expect(schema.parse({ nested: { nullable: null } })).toEqual({
      nested: {
        nullable: null,
        withDefault: 'fallback',
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

  it('parses arrays, unions, discriminated unions, and object intersections', () => {
    const arrayUnion = s.array(s.union([s.string(), s.number()]));
    const discriminated = new s.DiscriminatedUnionSchema([
      s.object({ kind: s.literal('text'), value: s.string() }),
      s.object({ kind: s.literal('count'), value: s.number() }),
    ]);
    const intersection = s.intersection(s.object({ left: s.string() }), s.object({ right: s.number() }));

    expect(arrayUnion.parse(['one', 2])).toEqual(['one', 2]);
    expect(discriminated.parse({ kind: 'count', value: 3 })).toEqual({
      kind: 'count',
      value: 3,
    });
    expect(intersection.parse({ left: 'one', right: 2 })).toEqual({
      left: 'one',
      right: 2,
    });

    expect(
      s
        .intersection(
          s.unknown().transform(() => 'left'),
          s.unknown().transform(() => 2),
        )
        .parse(null),
    ).toBe(2);
    expect(
      s
        .intersection(
          s.unknown().transform(() => ({ value: 'left' })),
          s.unknown().transform(() => ({ value: 2 })),
        )
        .parse(null),
    ).toEqual({ value: 2 });
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
});
