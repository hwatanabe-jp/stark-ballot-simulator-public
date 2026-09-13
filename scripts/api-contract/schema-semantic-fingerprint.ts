import { createHash } from 'node:crypto';
import { Schema, getSchemaDescriptor, type AnySchema } from '@stark-ballot/validation/schema';

export const SCHEMA_SEMANTIC_ALGORITHM = 'json-wire-admission' as const;

export interface SchemaSemanticEvidence {
  algorithm: typeof SCHEMA_SEMANTIC_ALGORITHM;
  fingerprint: string;
}

interface JsonWireProbe {
  id: string;
  value: unknown;
}

const JSON_WIRE_PROBES: readonly JsonWireProbe[] = [
  { id: 'null', value: null },
  { id: 'false', value: false },
  { id: 'true', value: true },
  { id: 'number.negative', value: -1 },
  { id: 'number.zero', value: 0 },
  { id: 'number.fraction', value: 0.5 },
  { id: 'number.one', value: 1 },
  { id: 'number.method-version', value: 14 },
  { id: 'number.limit', value: 1000 },
  { id: 'number.over-limit', value: 1001 },
  { id: 'number.uint32-max', value: 0xffffffff },
  { id: 'number.uint32-overflow', value: 0x100000000 },
  { id: 'string.empty', value: '' },
  { id: 'string.zero', value: '0' },
  { id: 'string.one', value: '1' },
  { id: 'string.leading-zero', value: '01' },
  { id: 'string.negative', value: '-1' },
  { id: 'string.limit', value: '1000' },
  { id: 'string.over-limit', value: '1001' },
  { id: 'string.choice', value: 'A' },
  { id: 'string.scenario', value: 'S0' },
  { id: 'string.status', value: 'success' },
  { id: 'string.safe-segment', value: 'execution-123' },
  { id: 'string.dot-segment', value: 'audit.name' },
  { id: 'string.unsafe-segment', value: 'bad/segment' },
  { id: 'string.hex32', value: `0x${'a'.repeat(64)}` },
  { id: 'string.hex32-unprefixed', value: 'a'.repeat(64) },
  { id: 'string.hex31', value: `0x${'a'.repeat(62)}` },
  { id: 'string.non-hex-32-bytes', value: `0x${'z'.repeat(64)}` },
  { id: 'string.auditor-max', value: 'a'.repeat(64) },
  { id: 'string.auditor-over', value: 'a'.repeat(65) },
  { id: 'string.reason-max', value: 'a'.repeat(256) },
  { id: 'string.reason-over', value: 'a'.repeat(257) },
  { id: 'array.empty', value: [] },
  { id: 'array.one-number', value: [0] },
  { id: 'array.tally', value: [0, 0, 0, 0, 0] },
  { id: 'array.tally-short', value: [0, 0, 0, 0] },
  { id: 'array.strings', value: ['a'] },
  { id: 'object.empty', value: {} },
  { id: 'object.unknown', value: { unexpectedPublicField: true } },
] as const;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRuntimeSchema(value: unknown): value is AnySchema {
  return value instanceof Schema;
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableNormalize);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableNormalize(record[key])]),
    );
  }
  return value;
}

function normalizeSchemaIssues(result: Record<string, unknown>): unknown {
  const error = result['error'];
  if (!isUnknownRecord(error) || !Array.isArray(error['issues'])) {
    return [];
  }
  return error['issues'].map((issue) => {
    if (!isUnknownRecord(issue)) {
      return stableNormalize(issue);
    }
    return {
      path: Array.isArray(issue['path']) ? issue['path'] : [],
      message: typeof issue['message'] === 'string' ? issue['message'] : String(issue['message']),
    };
  });
}

function describeSchemaAdmission(schema: AnySchema): Record<string, unknown> {
  const admission: Record<string, unknown> = {};
  for (const { id, value } of JSON_WIRE_PROBES) {
    try {
      const result = schema.safeParse(value);
      if (!isUnknownRecord(result) || typeof result['success'] !== 'boolean') {
        throw new Error('safeParse returned an invalid result');
      }
      admission[id] = result['success']
        ? {
            accepted: true,
            data: stableNormalize(result['data']),
          }
        : {
            accepted: false,
            issues: normalizeSchemaIssues(result),
          };
    } catch (error: unknown) {
      admission[id] = {
        threw: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
  }
  return admission;
}

function isUndefinedOnlySchema(schema: unknown): boolean {
  if (!isRuntimeSchema(schema)) {
    return false;
  }
  const descriptor = getSchemaDescriptor(schema);
  if (descriptor.kind === 'UndefinedSchema') {
    return true;
  }
  return descriptor.kind === 'OptionalSchema' && isUndefinedOnlySchema(descriptor.inner);
}

export function describeSchemaSemantics(schema: unknown, cache = new WeakMap<object, unknown>()): unknown {
  if (!isRuntimeSchema(schema)) {
    return {
      kind: 'OpaqueSchemaExport',
      value: stableNormalize(schema),
    };
  }

  const schemaObject = schema as unknown as object;
  const cached = cache.get(schemaObject);
  if (cached !== undefined) {
    return cached;
  }

  const definition = getSchemaDescriptor(schema);
  const kind = definition.kind === 'CustomSchema' ? definition.name : definition.kind;

  const descriptor: Record<string, unknown> = {
    kind,
    admission: describeSchemaAdmission(schema),
  };
  cache.set(schemaObject, descriptor);

  if (definition.kind === 'ObjectSchema') {
    descriptor['unknownKeys'] = definition.unknownKeys;
    descriptor['shape'] = Object.fromEntries(
      Object.entries(definition.shape)
        .filter(([, fieldSchema]) => !isUndefinedOnlySchema(fieldSchema))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([fieldName, fieldSchema]) => [fieldName, describeSchemaSemantics(fieldSchema, cache)]),
    );
    descriptor['catchall'] = describeSchemaSemantics(definition.catchall, cache);
  } else if (definition.kind === 'ArraySchema') {
    descriptor['item'] = describeSchemaSemantics(definition.item, cache);
  } else if (definition.kind === 'TupleSchema') {
    descriptor['items'] = definition.items.map((item) => describeSchemaSemantics(item, cache));
  } else if (definition.kind === 'OptionalSchema' || definition.kind === 'NullableSchema') {
    descriptor['inner'] = describeSchemaSemantics(definition.inner, cache);
  } else if (definition.kind === 'EffectsSchema') {
    descriptor['inner'] = describeSchemaSemantics(definition.inner, cache);
  } else if (definition.kind === 'UnionSchema') {
    descriptor['options'] = definition.options.map((option) => describeSchemaSemantics(option, cache));
  } else if (definition.kind === 'EnumSchema') {
    descriptor['values'] = definition.values;
  } else if (definition.kind === 'LiteralSchema') {
    descriptor['value'] = definition.value;
  }

  return descriptor;
}

export function fingerprintSchemaSemantics(schema: AnySchema): SchemaSemanticEvidence {
  const normalized = `${JSON.stringify(stableNormalize(describeSchemaSemantics(schema)), null, 2)}\n`;
  return {
    algorithm: SCHEMA_SEMANTIC_ALGORITHM,
    fingerprint: createHash('sha256').update(normalized).digest('hex'),
  };
}
