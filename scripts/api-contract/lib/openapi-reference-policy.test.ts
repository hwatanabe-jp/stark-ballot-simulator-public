import { describe, expect, it } from 'vitest';
import { s } from '@stark-ballot/validation/schema';
import {
  nonNegativeIntegerQuerySchema,
  positiveIntegerQuerySchema,
} from '@stark-ballot/api-contract/schemas/primitives';
import { projectSchemaForOpenApi } from './openapi-reference-policy';

describe('OpenAPI schema projection policy', () => {
  it.each([
    [nonNegativeIntegerQuerySchema, 0],
    [positiveIntegerQuerySchema, 1],
  ] as const)('documents exact integer bounds for decimal query admission', (schema, minimum) => {
    expect(projectSchemaForOpenApi(schema, 'test.query', 'output')).toEqual({
      type: 'integer',
      minimum,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(projectSchemaForOpenApi(schema, 'test.query', 'input')).toMatchObject({
      type: 'string',
      maxLength: 16,
      'x-runtime-constraints': [
        'The decimal wire value is at most 9007199254740991 and converts without rounding or overflow.',
      ],
    });
  });

  it('projects exact built-in string, number, and array constraints', () => {
    const schema = s
      .object({
        code: s
          .string()
          .min(2)
          .max(8)
          .regex(/^[A-Z]+$/)
          .describe('Upper-case code'),
        count: s.number().int().min(1).max(5),
        values: s.array(s.boolean()).min(1).length(2),
      })
      .strict();

    expect(projectSchemaForOpenApi(schema, 'test.schema')).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        code: {
          type: 'string',
          description: 'Upper-case code',
          pattern: '^[A-Z]+$',
          'x-runtime-constraints': [
            'The runtime requires at least 2 UTF-16 code units.',
            'The runtime permits at most 8 UTF-16 code units.',
          ],
        },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
        },
        values: {
          type: 'array',
          items: { type: 'boolean' },
          minItems: 2,
          maxItems: 2,
        },
      },
      required: ['code', 'count', 'values'],
    });
  });

  it('fails closed when an executable refinement has no reviewed projection', () => {
    const schema = s.string().refine((value) => value.length === 3);

    expect(() => projectSchemaForOpenApi(schema, 'test.unreviewed')).toThrow(
      'test.unreviewed contains a runtime refinement without reviewed OpenAPI metadata',
    );
  });

  it('keeps omission admissible through nullable and other schema wrappers', () => {
    const schema = s
      .object({
        direct: s.string().optional(),
        nullableOutside: s.string().optional().nullable(),
        nullableInside: s.string().nullable().optional(),
        requiredNullable: s.string().nullable(),
      })
      .strict();

    expect(projectSchemaForOpenApi(schema, 'test.optionality')).toMatchObject({
      required: ['requiredNullable'],
    });
  });

  it('uses runtime OR semantics for ordinary unions', () => {
    const projection = projectSchemaForOpenApi(s.union([s.string(), s.string().min(1)]), 'test.union');

    expect(projection).toHaveProperty('anyOf');
    expect(projection).not.toHaveProperty('oneOf');
  });

  it('retains the exact UUID version and variant pattern', () => {
    const projection = projectSchemaForOpenApi(s.string().uuid(), 'test.uuid');

    expect(projection).toMatchObject({ format: 'uuid' });
    const pattern = new RegExp(String(projection['pattern']));
    expect(pattern.test('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(pattern.test('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(pattern.test('123e4567-e89b-62d3-a456-426614174000')).toBe(false);
  });

  it('documents JavaScript UTF-16 length without claiming JSON Schema code-point length', () => {
    const schema = s.string().max(2);

    expect(schema.safeParse('𠀀𠀀').success).toBe(false);
    expect(projectSchemaForOpenApi(schema, 'test.codeUnits')).toEqual({
      type: 'string',
      'x-runtime-constraints': ['The runtime permits at most 2 UTF-16 code units.'],
    });
  });
});
