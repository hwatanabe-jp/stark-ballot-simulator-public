/** OpenAPI annotations describe runtime effects; schema admission remains authoritative.
 * Keep this metadata outside the parser so tooling concerns do not control validation.
 */
import type { AnySchema } from './schema';

export type OpenApiEffectMetadata =
  | Readonly<{
      kind: 'refinement';
      overlay: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      kind: 'transform';
      inputOverlay: Readonly<Record<string, unknown>>;
      output: Readonly<Record<string, unknown>>;
    }>;

const openApiEffectMetadata = new WeakMap<AnySchema, OpenApiEffectMetadata>();

function freezeOpenApiValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item, index) => freezeOpenApiValue(item, `${path}[${index}]`)));
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${path} must contain only JSON-compatible values`);
  }
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeOpenApiValue(item, `${path}.${key}`)])),
  );
}

function freezeOpenApiObject(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error('OpenAPI metadata must be a JSON object');
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, freezeOpenApiValue(item, `OpenAPI metadata.${key}`)]),
    ),
  );
}

function freezeOpenApiEffectMetadata(metadata: OpenApiEffectMetadata): OpenApiEffectMetadata {
  switch (metadata.kind) {
    case 'refinement':
      return Object.freeze({ kind: metadata.kind, overlay: freezeOpenApiObject(metadata.overlay) });
    case 'transform':
      return Object.freeze({
        kind: metadata.kind,
        inputOverlay: freezeOpenApiObject(metadata.inputOverlay),
        output: freezeOpenApiObject(metadata.output),
      });
  }
}

function documentOpenApiEffect<TSchema extends AnySchema>(schema: TSchema, metadata: OpenApiEffectMetadata): TSchema {
  const descriptor = schema.getStructuralDescriptor();
  if (descriptor.kind !== 'EffectsSchema' || descriptor.effect !== metadata.kind) {
    throw new Error(`OpenAPI metadata kind ${metadata.kind} does not match ${descriptor.kind}`);
  }
  openApiEffectMetadata.set(schema, freezeOpenApiEffectMetadata(metadata));
  return schema;
}

export function documentOpenApiRefinement<TSchema extends AnySchema>(
  schema: TSchema,
  runtimeConstraint: string,
  overlay: Readonly<Record<string, unknown>> = {},
): TSchema {
  return documentOpenApiEffect(schema, {
    kind: 'refinement',
    overlay: {
      ...overlay,
      'x-runtime-constraints': [runtimeConstraint],
    },
  });
}

export function documentOpenApiTransform<TSchema extends AnySchema>(
  schema: TSchema,
  inputOverlay: Readonly<Record<string, unknown>>,
  output: Readonly<Record<string, unknown>>,
): TSchema {
  return documentOpenApiEffect(schema, { kind: 'transform', inputOverlay, output });
}

export function getOpenApiEffectMetadata(schema: AnySchema): OpenApiEffectMetadata | undefined {
  return openApiEffectMetadata.get(schema);
}
