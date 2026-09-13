type ParseSuccess<T> = {
  success: true;
  data: T;
};

type ParseFailure = {
  success: false;
  issues: SchemaIssue[];
};

type ParseResult<T> = ParseSuccess<T> | ParseFailure;

type IssueInput = {
  path?: (string | number)[];
  message: string;
};

type RefinementContext = {
  path: (string | number)[];
  addIssue: (issue: IssueInput) => void;
};

export type SchemaIssue = {
  path: (string | number)[];
  message: string;
};

export type FlattenedSchemaError = {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
};

export type SafeParseResult<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      error: SchemaError;
    };

declare const schemaOutput: unique symbol;

interface SchemaLike<TOutput = unknown> {
  readonly [schemaOutput]: TOutput;
  parseInternal(input: unknown, path: (string | number)[]): ParseResult<this[typeof schemaOutput]>;
}

export type Infer<TSchema extends AnySchema> = TSchema[typeof schemaOutput];
export type AnySchema = Schema<unknown>;
export type SchemaShape = Record<string, AnySchema>;
export type UnknownKeyPolicy = 'strip' | 'strict' | 'passthrough';

type LeafSchemaDescriptorKind = 'NeverSchema' | 'BooleanSchema' | 'UnknownSchema' | 'UndefinedSchema';

export type StringSchemaConstraint =
  | Readonly<{ kind: 'minLength'; value: number }>
  | Readonly<{ kind: 'maxLength'; value: number }>
  | Readonly<{ kind: 'pattern'; source: string; flags: string }>
  | Readonly<{ kind: 'format'; value: 'uuid' }>;

export type NumberSchemaConstraint =
  | Readonly<{ kind: 'integer' }>
  | Readonly<{ kind: 'minimum'; value: number; exclusive: boolean }>
  | Readonly<{ kind: 'maximum'; value: number; exclusive: boolean }>;

export type ArraySchemaConstraint =
  | Readonly<{ kind: 'minItems'; value: number }>
  | Readonly<{ kind: 'maxItems'; value: number }>;

type StringRule = StringSchemaConstraint & Readonly<{ message: string }>;
type NumberRule = NumberSchemaConstraint & Readonly<{ message: string }>;
type ArrayRule = (ArraySchemaConstraint | Readonly<{ kind: 'length'; value: number }>) & Readonly<{ message: string }>;

const UUID_PATTERN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-5][0-9A-Fa-f]{3}-[89AaBb][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$/;

export type SchemaDescriptor =
  | Readonly<{ kind: LeafSchemaDescriptorKind }>
  | Readonly<{ kind: 'StringSchema'; constraints: readonly StringSchemaConstraint[] }>
  | Readonly<{ kind: 'NumberSchema'; constraints: readonly NumberSchemaConstraint[] }>
  | Readonly<{ kind: 'LiteralSchema'; value: string | number | boolean | null | undefined }>
  | Readonly<{ kind: 'EnumSchema'; values: readonly string[] }>
  | Readonly<{ kind: 'OptionalSchema' | 'NullableSchema'; inner: AnySchema }>
  | Readonly<{ kind: 'EffectsSchema'; inner: AnySchema; effect: 'refinement' | 'transform' }>
  | Readonly<{ kind: 'ArraySchema'; item: AnySchema; constraints: readonly ArraySchemaConstraint[] }>
  | Readonly<{ kind: 'TupleSchema'; items: readonly AnySchema[] }>
  | Readonly<{
      kind: 'ObjectSchema';
      shape: Readonly<Record<string, AnySchema>>;
      unknownKeys: UnknownKeyPolicy;
      catchall: AnySchema;
    }>
  | Readonly<{ kind: 'UnionSchema'; options: readonly AnySchema[] }>
  | Readonly<{ kind: 'CustomSchema'; name: string }>;

function freezeConstraints<TConstraint extends Readonly<Record<string, unknown>>>(
  constraints: readonly TConstraint[],
): readonly TConstraint[] {
  return Object.freeze(constraints.map((constraint) => Object.freeze({ ...constraint })));
}

type Simplify<TValue> = { [TKey in keyof TValue]: TValue[TKey] };

type OptionalShapeKey<TShape extends SchemaShape> = {
  [TKey in keyof TShape]-?: undefined extends Infer<TShape[TKey]> ? TKey : never;
}[keyof TShape];

type RequiredShapeKey<TShape extends SchemaShape> = Exclude<keyof TShape, OptionalShapeKey<TShape>>;

type ObjectShapeOutput<TShape extends SchemaShape> = Simplify<
  { [TKey in RequiredShapeKey<TShape>]: Infer<TShape[TKey]> } & {
    [TKey in OptionalShapeKey<TShape>]?: Infer<TShape[TKey]>;
  }
>;

type ExactObjectShapeOutput<TShape extends SchemaShape> = keyof TShape extends never
  ? Record<string, never>
  : ObjectShapeOutput<TShape>;

type ObjectOutput<
  TShape extends SchemaShape,
  TUnknownKeys extends UnknownKeyPolicy,
  TCatchall extends AnySchema,
> = TCatchall extends NeverSchema
  ? TUnknownKeys extends 'passthrough'
    ? ObjectShapeOutput<TShape> & Record<string, unknown>
    : ExactObjectShapeOutput<TShape>
  : keyof TShape extends never
    ? Record<string, Infer<TCatchall>>
    : ObjectShapeOutput<TShape> & Record<string, Infer<TCatchall> | Infer<TShape[keyof TShape]>>;

type ExtendedShape<TShape extends SchemaShape, TExtension extends SchemaShape> = Omit<TShape, keyof TExtension> &
  TExtension;

type TupleOutput<TItems extends readonly AnySchema[]> = {
  -readonly [TIndex in keyof TItems]: TItems[TIndex] extends AnySchema ? Infer<TItems[TIndex]> : never;
};

export class SchemaError extends Error {
  public readonly issues: SchemaIssue[];

  public constructor(issues: SchemaIssue[]) {
    super(
      issues
        .map((issue) => {
          const path = issue.path.join('.');
          return path ? `${path}: ${issue.message}` : issue.message;
        })
        .join('; ') || 'Invalid input',
    );
    this.name = 'SchemaError';
    this.issues = issues;
  }

  public flatten(): FlattenedSchemaError {
    const formErrors: string[] = [];
    const fieldErrors: Record<string, string[]> = {};

    for (const issue of this.issues) {
      if (issue.path.length === 0) {
        formErrors.push(issue.message);
        continue;
      }
      const key = String(issue.path[0]);
      fieldErrors[key] = [...(fieldErrors[key] ?? []), issue.message];
    }

    return { formErrors, fieldErrors };
  }
}

function ok<T>(data: T): ParseSuccess<T> {
  return { success: true, data };
}

function fail(message: string, path: (string | number)[] = []): ParseFailure {
  return { success: false, issues: [{ path, message }] };
}

function failIssues(issues: SchemaIssue[]): ParseFailure {
  return { success: false, issues };
}

function mergeIssues(failures: ParseFailure[]): SchemaIssue[] {
  return failures.flatMap((failure) => failure.issues);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export abstract class Schema<TOutput = unknown> implements SchemaLike<TOutput> {
  declare public readonly [schemaOutput]: TOutput;
  public readonly description?: string;

  public safeParse(input: unknown): SafeParseResult<TOutput> {
    const result = this.parseInternal(input, []);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: new SchemaError(result.issues) };
  }

  public parse(input: unknown): TOutput {
    const result = this.safeParse(input);
    if (result.success) {
      return result.data;
    }
    throw result.error;
  }

  public optional(): OptionalSchema<this> {
    return new OptionalSchema(this);
  }

  public nullable(): NullableSchema<this> {
    return new NullableSchema(this);
  }

  public refine(predicate: (value: TOutput) => boolean, options?: { message?: string }): EffectsSchema<TOutput> {
    return new EffectsSchema(this, {
      kind: 'refinement',
      refine: (value, ctx) => {
        if (!predicate(value)) {
          ctx.addIssue({ message: options?.message ?? 'Invalid input' });
        }
      },
      output: (value) => value,
    });
  }

  public superRefine(refine: (value: TOutput, ctx: RefinementContext) => void): EffectsSchema<TOutput> {
    return new EffectsSchema(this, {
      kind: 'refinement',
      refine,
      output: (value) => value,
    });
  }

  public transform<TNext>(transform: (value: TOutput) => TNext): EffectsSchema<TNext, TOutput> {
    return new EffectsSchema(this, {
      kind: 'transform',
      transform,
    });
  }

  public describe(description: string): this {
    Object.defineProperty(this, 'description', { value: description, configurable: true });
    return this;
  }

  /** Implementation hook for the stable `getSchemaDescriptor` API. */
  public getStructuralDescriptor(): SchemaDescriptor {
    return Object.freeze({ kind: 'CustomSchema', name: this.constructor.name || 'Schema' });
  }

  public abstract parseInternal(input: unknown, path: (string | number)[]): ParseResult<TOutput>;
}

function parseWithSchema<TSchema extends AnySchema>(
  schema: TSchema,
  input: unknown,
  path: (string | number)[],
): ParseResult<Infer<TSchema>> {
  return schema.parseInternal(input, path);
}

export class NeverSchema extends Schema<never> {
  public constructor() {
    super();
  }

  public parseInternal(_input: unknown, path: (string | number)[]): ParseResult<never> {
    return fail('Expected never', path);
  }

  public override getStructuralDescriptor(): SchemaDescriptor {
    return Object.freeze({ kind: 'NeverSchema' });
  }
}

export class StringSchema extends Schema<string> {
  private readonly rules: readonly StringRule[];
  private readonly requiredError?: string;

  public constructor(rules: readonly StringRule[] = [], requiredError?: string) {
    super();
    this.rules = freezeConstraints(rules);
    if (requiredError !== undefined) {
      this.requiredError = requiredError;
    }
  }

  public min(length: number, message?: string): StringSchema {
    return new StringSchema(
      [
        ...this.rules,
        { kind: 'minLength', value: length, message: message ?? `String must contain at least ${length} character(s)` },
      ],
      this.requiredError,
    );
  }

  public max(length: number, message?: string): StringSchema {
    return new StringSchema(
      [
        ...this.rules,
        { kind: 'maxLength', value: length, message: message ?? `String must contain at most ${length} character(s)` },
      ],
      this.requiredError,
    );
  }

  public regex(pattern: RegExp, message?: string): StringSchema {
    return new StringSchema(
      [
        ...this.rules,
        { kind: 'pattern', source: pattern.source, flags: pattern.flags, message: message ?? 'Invalid string' },
      ],
      this.requiredError,
    );
  }

  public uuid(message?: string): StringSchema {
    return new StringSchema(
      [...this.rules, { kind: 'format', value: 'uuid', message: message ?? 'Invalid UUID' }],
      this.requiredError,
    );
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<string> {
    if (input === undefined) {
      return fail(this.requiredError ?? 'Expected string', path);
    }
    if (typeof input !== 'string') {
      return fail('Expected string', path);
    }
    const issues = this.rules
      .filter((rule) => !matchesStringRule(input, rule))
      .map((rule) => ({ path, message: rule.message }));
    return issues.length === 0 ? ok(input) : failIssues(issues);
  }

  public override getStructuralDescriptor(): SchemaDescriptor {
    const constraints = this.rules.flatMap(({ message, ...constraint }): StringSchemaConstraint[] => {
      void message;
      return constraint.kind === 'format'
        ? [constraint, { kind: 'pattern', source: UUID_PATTERN.source, flags: UUID_PATTERN.flags }]
        : [constraint];
    });
    return Object.freeze({ kind: 'StringSchema', constraints: freezeConstraints(constraints) });
  }
}

function matchesStringRule(value: string, rule: StringRule): boolean {
  switch (rule.kind) {
    case 'minLength':
      return value.length >= rule.value;
    case 'maxLength':
      return value.length <= rule.value;
    case 'pattern':
      // Each admission starts at index zero, including global and sticky patterns.
      return new RegExp(rule.source, rule.flags).test(value);
    case 'format':
      return UUID_PATTERN.test(value);
  }
}

export class NumberSchema extends Schema<number> {
  private readonly rules: readonly NumberRule[];

  public constructor(rules: readonly NumberRule[] = []) {
    super();
    this.rules = freezeConstraints(rules);
  }

  public int(message?: string): NumberSchema {
    return new NumberSchema([...this.rules, { kind: 'integer', message: message ?? 'Expected integer' }]);
  }

  public nonnegative(message?: string): NumberSchema {
    return this.min(0, message ?? 'Expected non-negative number');
  }

  public positive(message?: string): NumberSchema {
    return new NumberSchema([
      ...this.rules,
      { kind: 'minimum', value: 0, exclusive: true, message: message ?? 'Expected positive number' },
    ]);
  }

  public min(minimum: number, message?: string): NumberSchema {
    return new NumberSchema([
      ...this.rules,
      {
        kind: 'minimum',
        value: minimum,
        exclusive: false,
        message: message ?? `Number must be greater than or equal to ${minimum}`,
      },
    ]);
  }

  public max(maximum: number, message?: string): NumberSchema {
    return new NumberSchema([
      ...this.rules,
      {
        kind: 'maximum',
        value: maximum,
        exclusive: false,
        message: message ?? `Number must be less than or equal to ${maximum}`,
      },
    ]);
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<number> {
    if (typeof input !== 'number' || !Number.isFinite(input)) {
      return fail('Expected number', path);
    }
    const issues = this.rules
      .filter((rule) => !matchesNumberRule(input, rule))
      .map((rule) => ({ path, message: rule.message }));
    return issues.length === 0 ? ok(input) : failIssues(issues);
  }

  public override getStructuralDescriptor(): SchemaDescriptor {
    return Object.freeze({
      kind: 'NumberSchema',
      constraints: freezeConstraints(
        this.rules.map(({ message, ...constraint }) => {
          void message;
          return constraint;
        }),
      ),
    });
  }
}

function matchesNumberRule(value: number, rule: NumberRule): boolean {
  switch (rule.kind) {
    case 'integer':
      return Number.isInteger(value);
    case 'minimum':
      return rule.exclusive ? value > rule.value : value >= rule.value;
    case 'maximum':
      return rule.exclusive ? value < rule.value : value <= rule.value;
  }
}

export class BooleanSchema extends Schema<boolean> {
  public constructor() {
    super();
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<boolean> {
    return typeof input === 'boolean' ? ok(input) : fail('Expected boolean', path);
  }

  public override getStructuralDescriptor(): SchemaDescriptor {
    return Object.freeze({ kind: 'BooleanSchema' });
  }
}

export class UnknownSchema extends Schema<unknown> {
  public constructor() {
    super();
  }

  public parseInternal(input: unknown): ParseResult<unknown> {
    return ok(input);
  }

  public override getStructuralDescriptor(): SchemaDescriptor {
    return Object.freeze({ kind: 'UnknownSchema' });
  }
}

export class UndefinedSchema extends Schema<undefined> {
  public constructor() {
    super();
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<undefined> {
    return input === undefined ? ok(undefined) : fail('Expected undefined', path);
  }

  public override getStructuralDescriptor(): SchemaDescriptor {
    return Object.freeze({ kind: 'UndefinedSchema' });
  }
}

export class LiteralSchema<TValue extends string | number | boolean | null | undefined> extends Schema<TValue> {
  private readonly value: TValue;

  public constructor(value: TValue) {
    super();
    this.value = value;
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<TValue> {
    return input === this.value ? ok(this.value) : fail(`Expected literal ${String(this.value)}`, path);
  }

  public override getStructuralDescriptor(): SchemaDescriptor {
    return Object.freeze({ kind: 'LiteralSchema', value: this.value });
  }
}

function snapshotTuple<TItems extends readonly unknown[]>(items: TItems): Readonly<TItems> {
  return Object.freeze([...items]) as Readonly<TItems>;
}

export class EnumSchema<TValues extends readonly string[]> extends Schema<TValues[number]> {
  private readonly values: Readonly<TValues>;

  public constructor(values: TValues) {
    super();
    this.values = snapshotTuple(values);
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<TValues[number]> {
    if (typeof input === 'string' && this.values.includes(input)) {
      return ok(input as TValues[number]);
    }
    return fail(`Expected one of: ${this.values.join(', ')}`, path);
  }

  public override getStructuralDescriptor(): SchemaDescriptor {
    return Object.freeze({ kind: 'EnumSchema', values: Object.freeze([...this.values]) });
  }
}

export class OptionalSchema<TInner extends AnySchema = AnySchema> extends Schema<Infer<TInner> | undefined> {
  private readonly _def: Readonly<{ innerType: TInner }>;

  public constructor(innerType: TInner) {
    super();
    this._def = Object.freeze({ innerType });
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<Infer<TInner> | undefined> {
    return input === undefined ? ok(undefined) : parseWithSchema(this._def.innerType, input, path);
  }

  public override getStructuralDescriptor(): SchemaDescriptor {
    return Object.freeze({ kind: 'OptionalSchema', inner: this._def.innerType });
  }
}

export class NullableSchema<TInner extends AnySchema = AnySchema> extends Schema<Infer<TInner> | null> {
  private readonly _def: Readonly<{ innerType: TInner }>;

  public constructor(innerType: TInner) {
    super();
    this._def = Object.freeze({ innerType });
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<Infer<TInner> | null> {
    return input === null ? ok(null) : parseWithSchema(this._def.innerType, input, path);
  }

  public override getStructuralDescriptor(): SchemaDescriptor {
    return Object.freeze({ kind: 'NullableSchema', inner: this._def.innerType });
  }
}

type EffectDefinition<TInput, TOutput> =
  | {
      readonly kind: 'transform';
      readonly transform: (value: TInput) => TOutput;
    }
  | {
      readonly kind: 'refinement';
      readonly refine: (value: TInput, ctx: RefinementContext) => void;
      readonly output: (value: TInput) => TOutput;
    };

export class EffectsSchema<TOutput = unknown, TInput = TOutput> extends Schema<TOutput> {
  private readonly inner: AnySchema;
  private readonly effectKind: 'transform' | 'refinement';
  private readonly parseEffect: (input: unknown, path: (string | number)[]) => ParseResult<TOutput>;

  public constructor(schema: Schema<TInput>, effect: EffectDefinition<NoInfer<TInput>, TOutput>) {
    super();
    this.inner = schema;
    this.effectKind = effect.kind;
    const capturedEffect = Object.freeze({ ...effect });
    this.parseEffect = (input, path) => {
      const inner = schema.parseInternal(input, path);
      if (!inner.success) {
        return inner;
      }
      if (capturedEffect.kind === 'transform') {
        return ok(capturedEffect.transform(inner.data));
      }
      const issues: SchemaIssue[] = [];
      capturedEffect.refine(inner.data, {
        path,
        addIssue: (issue) => {
          issues.push({ path: issue.path ?? path, message: issue.message });
        },
      });
      return issues.length === 0 ? ok(capturedEffect.output(inner.data)) : failIssues(issues);
    };
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<TOutput> {
    return this.parseEffect(input, path);
  }

  public override getStructuralDescriptor(): SchemaDescriptor {
    return Object.freeze({
      kind: 'EffectsSchema',
      inner: this.inner,
      effect: this.effectKind,
    });
  }
}

export class ArraySchema<TItem extends AnySchema = AnySchema> extends Schema<Infer<TItem>[]> {
  private readonly _def: Readonly<{ type: TItem }>;
  private readonly rules: readonly ArrayRule[];

  public constructor(type: TItem, rules: readonly ArrayRule[] = []) {
    super();
    this._def = Object.freeze({ type });
    this.rules = freezeConstraints(rules);
  }

  public min(length: number, message?: string): ArraySchema<TItem> {
    return new ArraySchema(this._def.type, [
      ...this.rules,
      { kind: 'minItems', value: length, message: message ?? `Array must contain at least ${length} element(s)` },
    ]);
  }

  public length(length: number, message?: string): ArraySchema<TItem> {
    return new ArraySchema(this._def.type, [
      ...this.rules,
      { kind: 'length', value: length, message: message ?? `Array must contain exactly ${length} element(s)` },
    ]);
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<Infer<TItem>[]> {
    if (!Array.isArray(input)) {
      return fail('Expected array', path);
    }

    const issues = this.rules
      .filter((rule) => !matchesArrayRule(input, rule))
      .map((rule) => ({ path, message: rule.message }));
    const parsed: Infer<TItem>[] = [];
    input.forEach((item, index) => {
      const result = parseWithSchema(this._def.type, item, [...path, index]);
      if (result.success) {
        parsed.push(result.data);
      } else {
        issues.push(...result.issues);
      }
    });

    return issues.length === 0 ? ok(parsed) : failIssues(issues);
  }

  public override getStructuralDescriptor(): SchemaDescriptor {
    const constraints = this.rules.flatMap(({ message, ...constraint }): ArraySchemaConstraint[] => {
      void message;
      return constraint.kind === 'length'
        ? [
            { kind: 'minItems', value: constraint.value },
            { kind: 'maxItems', value: constraint.value },
          ]
        : [constraint];
    });
    return Object.freeze({
      kind: 'ArraySchema',
      item: this._def.type,
      constraints: freezeConstraints(constraints),
    });
  }
}

function matchesArrayRule(value: readonly unknown[], rule: ArrayRule): boolean {
  switch (rule.kind) {
    case 'minItems':
      return value.length >= rule.value;
    case 'maxItems':
      return value.length <= rule.value;
    case 'length':
      return value.length === rule.value;
  }
}

export class TupleSchema<TItems extends readonly AnySchema[] = readonly AnySchema[]> extends Schema<
  TupleOutput<TItems>
> {
  private readonly _def: Readonly<{ items: Readonly<TItems> }>;

  public constructor(items: TItems) {
    super();
    this._def = Object.freeze({ items: snapshotTuple(items) });
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<TupleOutput<TItems>> {
    if (!Array.isArray(input)) {
      return fail('Expected tuple', path);
    }
    if (input.length !== this._def.items.length) {
      return fail(`Tuple must contain exactly ${this._def.items.length} element(s)`, path);
    }

    const parsed: unknown[] = [];
    const issues: SchemaIssue[] = [];
    this._def.items.forEach((itemSchema, index) => {
      const result = parseWithSchema(itemSchema, input[index], [...path, index]);
      if (result.success) {
        parsed.push(result.data);
      } else {
        issues.push(...result.issues);
      }
    });

    return issues.length === 0 ? ok(parsed as TupleOutput<TItems>) : failIssues(issues);
  }

  public override getStructuralDescriptor(): SchemaDescriptor {
    return Object.freeze({ kind: 'TupleSchema', items: Object.freeze([...this._def.items]) });
  }
}

export class ObjectSchema<
  TShape extends SchemaShape = SchemaShape,
  TUnknownKeys extends UnknownKeyPolicy = UnknownKeyPolicy,
  TCatchall extends AnySchema = AnySchema,
> extends Schema<ObjectOutput<TShape, TUnknownKeys, TCatchall>> {
  private readonly _def: Readonly<{
    shape: Readonly<TShape>;
    unknownKeys: TUnknownKeys;
    catchall: TCatchall;
  }>;

  public constructor(shape: TShape, unknownKeys: TUnknownKeys, catchall: TCatchall) {
    super();
    this._def = Object.freeze({ shape: Object.freeze({ ...shape }), unknownKeys, catchall });
  }

  public get shape(): Readonly<TShape> {
    return this._def.shape;
  }

  public strict(): ObjectSchema<TShape, 'strict', TCatchall> {
    return new ObjectSchema(this.shape, 'strict', this._def.catchall);
  }

  public passthrough(): ObjectSchema<TShape, 'passthrough', TCatchall> {
    return new ObjectSchema(this.shape, 'passthrough', this._def.catchall);
  }

  public catchall<TNextCatchall extends AnySchema>(
    schema: TNextCatchall,
  ): ObjectSchema<TShape, TUnknownKeys, TNextCatchall> {
    return new ObjectSchema(this.shape, this._def.unknownKeys, schema);
  }

  public extend<TExtension extends SchemaShape>(
    extension: TExtension,
  ): ObjectSchema<ExtendedShape<TShape, TExtension>, TUnknownKeys, TCatchall> {
    const shape = { ...this.shape, ...extension } as ExtendedShape<TShape, TExtension>;
    return new ObjectSchema(shape, this._def.unknownKeys, this._def.catchall);
  }

  public parseInternal(
    input: unknown,
    path: (string | number)[],
  ): ParseResult<ObjectOutput<TShape, TUnknownKeys, TCatchall>> {
    if (!isPlainRecord(input)) {
      return fail('Expected object', path);
    }

    const output: Record<string, unknown> = {};
    const issues: SchemaIssue[] = [];

    for (const [key, schema] of Object.entries(this.shape)) {
      const result = parseWithSchema(schema, input[key], [...path, key]);
      if (result.success) {
        if (result.data !== undefined || Object.hasOwn(input, key)) {
          output[key] = result.data;
        }
      } else {
        issues.push(...result.issues);
      }
    }

    for (const key of Object.keys(input)) {
      if (Object.hasOwn(this.shape, key)) {
        continue;
      }
      if (!(this._def.catchall instanceof NeverSchema)) {
        const result = parseWithSchema(this._def.catchall, input[key], [...path, key]);
        if (result.success) {
          output[key] = result.data;
        } else {
          issues.push(...result.issues);
        }
        continue;
      }
      if (this._def.unknownKeys === 'strict') {
        issues.push({ path: [...path, key], message: 'Unrecognized key' });
      } else if (this._def.unknownKeys === 'passthrough') {
        output[key] = input[key];
      }
    }

    return issues.length === 0 ? ok(output as ObjectOutput<TShape, TUnknownKeys, TCatchall>) : failIssues(issues);
  }

  public override getStructuralDescriptor(): SchemaDescriptor {
    return Object.freeze({
      kind: 'ObjectSchema',
      shape: Object.freeze({ ...this.shape }),
      unknownKeys: this._def.unknownKeys,
      catchall: this._def.catchall,
    });
  }
}

export class UnionSchema<TOptions extends readonly AnySchema[] = readonly AnySchema[]> extends Schema<
  Infer<TOptions[number]>
> {
  private readonly _def: Readonly<{ options: Readonly<TOptions> }>;

  public constructor(options: TOptions) {
    super();
    this._def = Object.freeze({ options: snapshotTuple(options) });
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<Infer<TOptions[number]>> {
    const failures: ParseFailure[] = [];
    for (const option of this._def.options) {
      const result = parseWithSchema(option, input, path);
      if (result.success) {
        return ok(result.data as Infer<TOptions[number]>);
      }
      failures.push(result);
    }
    const issues = mergeIssues(failures);
    return failIssues(issues.length > 0 ? issues : [{ path, message: 'Invalid union' }]);
  }

  public override getStructuralDescriptor(): SchemaDescriptor {
    return Object.freeze({ kind: 'UnionSchema', options: Object.freeze([...this._def.options]) });
  }
}

/**
 * Return the stable, read-only structural view used by repository tooling.
 * Admission behavior remains owned by `safeParse`; callbacks and mutable
 * implementation details are intentionally excluded from this descriptor.
 */
export function getSchemaDescriptor(schema: AnySchema): SchemaDescriptor {
  return schema.getStructuralDescriptor();
}

function string(options?: { required_error?: string }): StringSchema {
  return new StringSchema([], options?.required_error);
}

function number(): NumberSchema {
  return new NumberSchema();
}

function boolean(): BooleanSchema {
  return new BooleanSchema();
}

function unknown(): UnknownSchema {
  return new UnknownSchema();
}

function undefinedSchema(): UndefinedSchema {
  return new UndefinedSchema();
}

function literal<TValue extends string | number | boolean | null | undefined>(value: TValue): LiteralSchema<TValue> {
  return new LiteralSchema(value);
}

function enumSchema<const TValues extends readonly string[]>(values: TValues): EnumSchema<TValues> {
  return new EnumSchema(values);
}

function object<const TShape extends SchemaShape>(shape: TShape): ObjectSchema<TShape, 'strip', NeverSchema> {
  return new ObjectSchema(shape, 'strip', new NeverSchema());
}

function array<TItem extends AnySchema>(item: TItem): ArraySchema<TItem> {
  return new ArraySchema(item);
}

function tuple<const TItems extends readonly AnySchema[]>(items: TItems): TupleSchema<TItems> {
  return new TupleSchema(items);
}

function union<const TOptions extends readonly [AnySchema, AnySchema, ...AnySchema[]]>(
  options: TOptions,
): UnionSchema<TOptions> {
  return new UnionSchema(options);
}

export const s = {
  ArraySchema,
  BooleanSchema,
  EffectsSchema,
  EnumSchema,
  LiteralSchema,
  NeverSchema,
  NullableSchema,
  NumberSchema,
  ObjectSchema,
  OptionalSchema,
  StringSchema,
  TupleSchema,
  Schema,
  UndefinedSchema,
  UnionSchema,
  UnknownSchema,
  array,
  boolean,
  enum: enumSchema,
  literal,
  number,
  object,
  string,
  tuple,
  undefined: undefinedSchema,
  union,
  unknown,
};
