declare module '@aws-amplify/backend' {
  type FieldBuilder = {
    required(): FieldBuilder;
    default(value: string | number | boolean): FieldBuilder;
  };

  type ModelBuilder = {
    authorization(builder: unknown): ModelBuilder;
    secondaryIndexes(builder: unknown): ModelBuilder;
  };

  type SchemaBuilder = {
    schema(schema: Record<string, unknown>): Record<string, unknown>;
    model(fields: Record<string, unknown>): ModelBuilder;
    id(): FieldBuilder;
    string(): FieldBuilder;
    integer(): FieldBuilder;
    boolean(): FieldBuilder;
    datetime(): FieldBuilder;
    json(): FieldBuilder;
    hasMany(model: string, field: string): unknown;
    belongsTo(model: string, field: string): unknown;
  };

  export const a: SchemaBuilder;
  export const defineData: (input: { schema: unknown; authorizationModes?: unknown }) => unknown;
  export type ClientSchema<TSchema> = TSchema;
}
