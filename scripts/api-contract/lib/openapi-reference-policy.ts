import { getSchemaDescriptor, type AnySchema, type SchemaDescriptor } from '@stark-ballot/validation/schema';
import { getOpenApiEffectMetadata } from '@stark-ballot/validation/schema-openapi';

export type OpenApiSchema = Readonly<Record<string, unknown>>;

function maximumConstraint(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : Math.max(...values);
}

function minimumConstraint(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : Math.min(...values);
}

function withDescription(schema: AnySchema, projection: Record<string, unknown>): OpenApiSchema {
  return schema.description === undefined ? projection : { ...projection, description: schema.description };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function openApiSchemaAcceptsUndefined(schema: AnySchema, path: string): boolean {
  const descriptor = getSchemaDescriptor(schema);
  switch (descriptor.kind) {
    case 'UndefinedSchema':
      return true;
    case 'LiteralSchema':
      return descriptor.value === undefined;
    case 'OptionalSchema':
      return true;
    case 'NullableSchema':
      return openApiSchemaAcceptsUndefined(descriptor.inner, path);
    case 'UnionSchema':
      return descriptor.options.some((option, index) => openApiSchemaAcceptsUndefined(option, `${path}|${index}`));
    case 'EffectsSchema':
      if (!openApiSchemaAcceptsUndefined(descriptor.inner, path)) return false;
      throw new Error(`${path} has runtime ${descriptor.effect} behavior whose undefined admission is not declarative`);
    case 'ArraySchema':
    case 'BooleanSchema':
    case 'CustomSchema':
    case 'EnumSchema':
    case 'NeverSchema':
    case 'NumberSchema':
    case 'ObjectSchema':
    case 'StringSchema':
    case 'TupleSchema':
    case 'UnknownSchema':
      return false;
  }
}

function isUndefinedOnlySchema(schema: AnySchema): boolean {
  const descriptor = getSchemaDescriptor(schema);
  if (descriptor.kind === 'UndefinedSchema') {
    return true;
  }
  return descriptor.kind === 'OptionalSchema' && isUndefinedOnlySchema(descriptor.inner);
}

function appendRuntimeStringLengthConstraints(
  projection: Record<string, unknown>,
  minimumCodeUnits: number | undefined,
  maximumCodeUnits: number | undefined,
): void {
  const runtimeConstraints: string[] = [];
  if (minimumCodeUnits !== undefined) {
    runtimeConstraints.push(`The runtime requires at least ${minimumCodeUnits} UTF-16 code units.`);
  }
  if (maximumCodeUnits !== undefined) {
    runtimeConstraints.push(`The runtime permits at most ${maximumCodeUnits} UTF-16 code units.`);
  }
  if (runtimeConstraints.length > 0) projection['x-runtime-constraints'] = runtimeConstraints;
}

function projectStringSchema(schema: AnySchema, path: string): OpenApiSchema {
  const descriptor = getSchemaDescriptor(schema);
  if (descriptor.kind !== 'StringSchema') {
    throw new Error(`${path} is not a string schema`);
  }
  const minimumCodeUnits = maximumConstraint(
    descriptor.constraints
      .filter((constraint) => constraint.kind === 'minLength')
      .map((constraint) => constraint.value),
  );
  const maximumCodeUnits = minimumConstraint(
    descriptor.constraints
      .filter((constraint) => constraint.kind === 'maxLength')
      .map((constraint) => constraint.value),
  );
  const patterns = descriptor.constraints.filter((constraint) => constraint.kind === 'pattern');
  const formats = descriptor.constraints.filter((constraint) => constraint.kind === 'format');
  const unsupportedPattern = patterns.find((constraint) => constraint.flags.length > 0);
  if (unsupportedPattern) {
    throw new Error(`${path} uses regular-expression flags that OpenAPI cannot represent exactly`);
  }

  const projection: Record<string, unknown> = { type: 'string' };
  appendRuntimeStringLengthConstraints(projection, minimumCodeUnits, maximumCodeUnits);
  if (patterns.length === 1) projection['pattern'] = patterns[0]?.source;
  if (patterns.length > 1) {
    projection['allOf'] = patterns.map((constraint) => ({ pattern: constraint.source }));
  }
  if (formats.length > 1) {
    throw new Error(`${path} declares multiple string formats`);
  }
  if (formats.length === 1) projection['format'] = formats[0]?.value;
  return withDescription(schema, projection);
}

function projectNumberSchema(schema: AnySchema): OpenApiSchema {
  const descriptor = getSchemaDescriptor(schema);
  if (descriptor.kind !== 'NumberSchema') {
    throw new Error('Expected a number schema descriptor');
  }
  const integer = descriptor.constraints.some((constraint) => constraint.kind === 'integer');
  const minimumConstraints = descriptor.constraints.filter((constraint) => constraint.kind === 'minimum');
  const maximumConstraints = descriptor.constraints.filter((constraint) => constraint.kind === 'maximum');
  const inclusiveMinimum = maximumConstraint(
    minimumConstraints.filter((constraint) => !constraint.exclusive).map((constraint) => constraint.value),
  );
  const exclusiveMinimum = maximumConstraint(
    minimumConstraints.filter((constraint) => constraint.exclusive).map((constraint) => constraint.value),
  );
  const inclusiveMaximum = minimumConstraint(
    maximumConstraints.filter((constraint) => !constraint.exclusive).map((constraint) => constraint.value),
  );
  const exclusiveMaximum = minimumConstraint(
    maximumConstraints.filter((constraint) => constraint.exclusive).map((constraint) => constraint.value),
  );
  const projection: Record<string, unknown> = { type: integer ? 'integer' : 'number' };
  if (inclusiveMinimum !== undefined) projection['minimum'] = inclusiveMinimum;
  if (exclusiveMinimum !== undefined) projection['exclusiveMinimum'] = exclusiveMinimum;
  if (inclusiveMaximum !== undefined) projection['maximum'] = inclusiveMaximum;
  if (exclusiveMaximum !== undefined) projection['exclusiveMaximum'] = exclusiveMaximum;
  return withDescription(schema, projection);
}

function projectArraySchema(schema: AnySchema, path: string, direction: 'input' | 'output'): OpenApiSchema {
  const descriptor = getSchemaDescriptor(schema);
  if (descriptor.kind !== 'ArraySchema') {
    throw new Error(`${path} is not an array schema`);
  }
  const minItems = maximumConstraint(
    descriptor.constraints.filter((constraint) => constraint.kind === 'minItems').map((constraint) => constraint.value),
  );
  const maxItems = minimumConstraint(
    descriptor.constraints.filter((constraint) => constraint.kind === 'maxItems').map((constraint) => constraint.value),
  );
  const projection: Record<string, unknown> = {
    type: 'array',
    items: projectSchemaForOpenApi(descriptor.item, `${path}[]`, direction),
  };
  if (minItems !== undefined) projection['minItems'] = minItems;
  if (maxItems !== undefined) projection['maxItems'] = maxItems;
  return withDescription(schema, projection);
}

function projectObjectSchema(schema: AnySchema, path: string, direction: 'input' | 'output'): OpenApiSchema {
  const descriptor = getSchemaDescriptor(schema);
  if (descriptor.kind !== 'ObjectSchema') {
    throw new Error(`${path} is not an object schema`);
  }
  const properties: Record<string, OpenApiSchema> = {};
  const required: string[] = [];
  for (const [fieldName, fieldSchema] of Object.entries(descriptor.shape).sort(([left], [right]) =>
    compareText(left, right),
  )) {
    if (isUndefinedOnlySchema(fieldSchema)) {
      continue;
    }
    properties[fieldName] = projectSchemaForOpenApi(fieldSchema, `${path}.${fieldName}`, direction);
    if (!openApiSchemaAcceptsUndefined(fieldSchema, `${path}.${fieldName}`)) {
      required.push(fieldName);
    }
  }
  const catchallDescriptor = getSchemaDescriptor(descriptor.catchall);
  const additionalProperties =
    catchallDescriptor.kind === 'NeverSchema'
      ? descriptor.unknownKeys !== 'strict'
      : projectSchemaForOpenApi(descriptor.catchall, `${path}.*`, direction);
  return withDescription(schema, {
    type: 'object',
    additionalProperties,
    properties,
    ...(required.length === 0 ? {} : { required }),
  });
}

function projectLeafSchema(
  schema: AnySchema,
  descriptor: Extract<
    SchemaDescriptor,
    {
      kind:
        | 'BooleanSchema'
        | 'UnknownSchema'
        | 'NeverSchema'
        | 'UndefinedSchema'
        | 'LiteralSchema'
        | 'EnumSchema'
        | 'CustomSchema';
    }
  >,
  path: string,
): OpenApiSchema {
  switch (descriptor.kind) {
    case 'BooleanSchema':
      return withDescription(schema, { type: 'boolean' });
    case 'UnknownSchema':
      return withDescription(schema, {});
    case 'NeverSchema':
      return withDescription(schema, { not: {} });
    case 'UndefinedSchema':
      throw new Error(`${path} cannot represent undefined on the JSON wire`);
    case 'LiteralSchema':
      if (descriptor.value === undefined) {
        throw new Error(`${path} cannot represent an undefined literal on the JSON wire`);
      }
      return withDescription(schema, { const: descriptor.value });
    case 'EnumSchema':
      return withDescription(schema, { type: 'string', enum: [...descriptor.values] });
    case 'CustomSchema':
      throw new Error(`${path} uses unsupported custom schema ${descriptor.name}`);
  }
}

function projectWrappedSchema(
  schema: AnySchema,
  descriptor: Extract<SchemaDescriptor, { kind: 'OptionalSchema' | 'NullableSchema' | 'EffectsSchema' }>,
  path: string,
  direction: 'input' | 'output',
): OpenApiSchema {
  switch (descriptor.kind) {
    case 'OptionalSchema':
      return withDescription(schema, { ...projectSchemaForOpenApi(descriptor.inner, path, direction) });
    case 'NullableSchema':
      return withDescription(schema, {
        anyOf: [projectSchemaForOpenApi(descriptor.inner, path, direction), { type: 'null' }],
      });
    case 'EffectsSchema': {
      const metadata = getOpenApiEffectMetadata(schema);
      if (metadata === undefined) {
        throw new Error(`${path} contains a runtime ${descriptor.effect} without reviewed OpenAPI metadata`);
      }
      if (metadata.kind === 'transform' && direction === 'output') {
        return withDescription(schema, { ...metadata.output });
      }
      const inner = projectSchemaForOpenApi(descriptor.inner, path, direction);
      const overlay = metadata.kind === 'transform' ? metadata.inputOverlay : metadata.overlay;
      return withDescription(schema, { ...inner, ...overlay });
    }
  }
}

export function projectSchemaForOpenApi(
  schema: AnySchema,
  path: string,
  direction: 'input' | 'output' = 'output',
): OpenApiSchema {
  const descriptor = getSchemaDescriptor(schema);
  switch (descriptor.kind) {
    case 'BooleanSchema':
    case 'UnknownSchema':
    case 'NeverSchema':
    case 'UndefinedSchema':
    case 'LiteralSchema':
    case 'EnumSchema':
    case 'CustomSchema':
      return projectLeafSchema(schema, descriptor, path);
    case 'OptionalSchema':
    case 'NullableSchema':
    case 'EffectsSchema':
      return projectWrappedSchema(schema, descriptor, path, direction);
    case 'StringSchema':
      return projectStringSchema(schema, path);
    case 'NumberSchema':
      return projectNumberSchema(schema);
    case 'ArraySchema':
      return projectArraySchema(schema, path, direction);
    case 'TupleSchema':
      return withDescription(schema, {
        type: 'array',
        prefixItems: descriptor.items.map((item, index) =>
          projectSchemaForOpenApi(item, `${path}[${index}]`, direction),
        ),
        minItems: descriptor.items.length,
        maxItems: descriptor.items.length,
      });
    case 'ObjectSchema':
      return projectObjectSchema(schema, path, direction);
    case 'UnionSchema':
      return withDescription(schema, {
        anyOf: descriptor.options.map((option, index) =>
          projectSchemaForOpenApi(option, `${path}|${index}`, direction),
        ),
      });
  }
}
