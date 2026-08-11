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

type BaseDef = {
  description?: string;
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

export type Infer<TSchema extends SchemaTypeAny> = TSchema[typeof schemaOutput];
export type SchemaTypeAny = Schema<unknown>;
export type SchemaShape = Record<string, SchemaTypeAny>;
export type UnknownKeyPolicy = 'strip' | 'strict' | 'passthrough';

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
  TCatchall extends SchemaTypeAny,
> = TCatchall extends NeverSchema
  ? TUnknownKeys extends 'passthrough'
    ? ObjectShapeOutput<TShape> & Record<string, unknown>
    : ExactObjectShapeOutput<TShape>
  : keyof TShape extends never
    ? Record<string, Infer<TCatchall>>
    : ObjectShapeOutput<TShape> & Record<string, Infer<TCatchall> | Infer<TShape[keyof TShape]>>;

type ExtendedShape<TShape extends SchemaShape, TExtension extends SchemaShape> = Omit<TShape, keyof TExtension> &
  TExtension;

type DefaultOutput<TSchema extends SchemaTypeAny> = Exclude<Infer<TSchema>, undefined>;

type BivariantCallback<TArgs extends unknown[], TResult> = {
  bivarianceHack(...args: TArgs): TResult;
}['bivarianceHack'];

type IntersectionOutput<TLeft extends SchemaTypeAny, TRight extends SchemaTypeAny> =
  Infer<TLeft> extends Record<string, unknown>
    ? Infer<TRight> extends Record<string, unknown>
      ? Simplify<Omit<Infer<TLeft>, keyof Infer<TRight>> & Infer<TRight>>
      : Infer<TRight>
    : Infer<TRight>;

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

function isCloneablePlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function cloneDefaultValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneDefaultValue(item));
  }
  if (isCloneablePlainRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneDefaultValue(item)]));
  }
  return value;
}

export abstract class Schema<TOutput = unknown> implements SchemaLike<TOutput> {
  declare public readonly [schemaOutput]: TOutput;
  public readonly _def: BaseDef;
  public readonly description?: string;

  protected constructor(def: BaseDef = {}) {
    this._def = def;
    if (def.description !== undefined) {
      this.description = def.description;
    }
  }

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

  public default(defaultValue: Exclude<TOutput, undefined>): DefaultSchema<Schema<TOutput>> {
    return new DefaultSchema<Schema<TOutput>>(this, () => defaultValue);
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
    Object.assign(this._def, { description });
    Object.defineProperty(this, 'description', { value: description, configurable: true });
    return this;
  }

  public and<TRight extends SchemaTypeAny>(right: TRight): IntersectionSchema<this, TRight> {
    return new IntersectionSchema(this, right);
  }

  public abstract parseInternal(input: unknown, path: (string | number)[]): ParseResult<TOutput>;
}

function parseWithSchema<TSchema extends SchemaTypeAny>(
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
}

export class StringSchema extends Schema<string> {
  private readonly checks: ((value: string, path: (string | number)[]) => ParseFailure | null)[];
  private readonly requiredError?: string;

  public constructor(
    checks: ((value: string, path: (string | number)[]) => ParseFailure | null)[] = [],
    requiredError?: string,
  ) {
    super();
    this.checks = checks;
    if (requiredError !== undefined) {
      this.requiredError = requiredError;
    }
  }

  public min(length: number, message?: string): StringSchema {
    return new StringSchema(
      [
        ...this.checks,
        (value, path) =>
          value.length >= length ? null : fail(message ?? `String must contain at least ${length} character(s)`, path),
      ],
      this.requiredError,
    );
  }

  public max(length: number, message?: string): StringSchema {
    return new StringSchema(
      [
        ...this.checks,
        (value, path) =>
          value.length <= length ? null : fail(message ?? `String must contain at most ${length} character(s)`, path),
      ],
      this.requiredError,
    );
  }

  public regex(pattern: RegExp, message?: string): StringSchema {
    return new StringSchema(
      [...this.checks, (value, path) => (pattern.test(value) ? null : fail(message ?? 'Invalid string', path))],
      this.requiredError,
    );
  }

  public uuid(message?: string): StringSchema {
    return this.regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      message ?? 'Invalid UUID',
    );
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<string> {
    if (input === undefined) {
      return fail(this.requiredError ?? 'Expected string', path);
    }
    if (typeof input !== 'string') {
      return fail('Expected string', path);
    }
    const failures = this.checks
      .map((check) => check(input, path))
      .filter((result): result is ParseFailure => result !== null);
    return failures.length === 0 ? ok(input) : failIssues(mergeIssues(failures));
  }
}

export class NumberSchema extends Schema<number> {
  private readonly checks: ((value: number, path: (string | number)[]) => ParseFailure | null)[];

  public constructor(checks: ((value: number, path: (string | number)[]) => ParseFailure | null)[] = []) {
    super();
    this.checks = checks;
  }

  public int(message?: string): NumberSchema {
    return new NumberSchema([
      ...this.checks,
      (value, path) => (Number.isInteger(value) ? null : fail(message ?? 'Expected integer', path)),
    ]);
  }

  public nonnegative(message?: string): NumberSchema {
    return this.min(0, message ?? 'Expected non-negative number');
  }

  public positive(message?: string): NumberSchema {
    return new NumberSchema([
      ...this.checks,
      (value, path) => (value > 0 ? null : fail(message ?? 'Expected positive number', path)),
    ]);
  }

  public min(minimum: number, message?: string): NumberSchema {
    return new NumberSchema([
      ...this.checks,
      (value, path) =>
        value >= minimum ? null : fail(message ?? `Number must be greater than or equal to ${minimum}`, path),
    ]);
  }

  public max(maximum: number, message?: string): NumberSchema {
    return new NumberSchema([
      ...this.checks,
      (value, path) =>
        value <= maximum ? null : fail(message ?? `Number must be less than or equal to ${maximum}`, path),
    ]);
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<number> {
    if (typeof input !== 'number' || !Number.isFinite(input)) {
      return fail('Expected number', path);
    }
    const failures = this.checks
      .map((check) => check(input, path))
      .filter((result): result is ParseFailure => result !== null);
    return failures.length === 0 ? ok(input) : failIssues(mergeIssues(failures));
  }
}

export class BooleanSchema extends Schema<boolean> {
  public constructor() {
    super();
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<boolean> {
    return typeof input === 'boolean' ? ok(input) : fail('Expected boolean', path);
  }
}

export class UnknownSchema extends Schema<unknown> {
  public constructor() {
    super();
  }

  public parseInternal(input: unknown): ParseResult<unknown> {
    return ok(input);
  }
}

export class UndefinedSchema extends Schema<undefined> {
  public constructor() {
    super();
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<undefined> {
    return input === undefined ? ok(undefined) : fail('Expected undefined', path);
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
}

export class EnumSchema<TValues extends readonly string[]> extends Schema<TValues[number]> {
  private readonly values: readonly string[];

  public constructor(values: TValues) {
    super();
    this.values = values;
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<TValues[number]> {
    if (typeof input === 'string' && this.values.includes(input)) {
      return ok(input as TValues[number]);
    }
    return fail(`Expected one of: ${this.values.join(', ')}`, path);
  }
}

export class OptionalSchema<TInner extends SchemaTypeAny = SchemaTypeAny> extends Schema<Infer<TInner> | undefined> {
  public readonly _def: BaseDef & { innerType: TInner };

  public constructor(innerType: TInner) {
    super({ innerType } as BaseDef & { innerType: TInner });
    this._def = { innerType };
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<Infer<TInner> | undefined> {
    return input === undefined ? ok(undefined) : parseWithSchema(this._def.innerType, input, path);
  }
}

export class NullableSchema<TInner extends SchemaTypeAny = SchemaTypeAny> extends Schema<Infer<TInner> | null> {
  public readonly _def: BaseDef & { innerType: TInner };

  public constructor(innerType: TInner) {
    super({ innerType } as BaseDef & { innerType: TInner });
    this._def = { innerType };
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<Infer<TInner> | null> {
    return input === null ? ok(null) : parseWithSchema(this._def.innerType, input, path);
  }
}

export class DefaultSchema<TInner extends SchemaTypeAny = SchemaTypeAny> extends Schema<DefaultOutput<TInner>> {
  public readonly _def: BaseDef & { innerType: TInner; defaultValue: () => DefaultOutput<TInner> };

  public constructor(innerType: TInner, defaultValue: () => DefaultOutput<TInner>) {
    super({ innerType, defaultValue } as BaseDef & {
      innerType: TInner;
      defaultValue: () => DefaultOutput<TInner>;
    });
    this._def = { innerType, defaultValue };
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<DefaultOutput<TInner>> {
    const value = input === undefined ? cloneDefaultValue(this._def.defaultValue()) : input;
    return parseWithSchema(this._def.innerType, value, path) as ParseResult<DefaultOutput<TInner>>;
  }
}

type EffectDefinition<TInput, TOutput> =
  | {
      kind: 'transform';
      transform: BivariantCallback<[value: TInput], TOutput>;
    }
  | {
      kind: 'refinement';
      refine: BivariantCallback<[value: TInput, ctx: RefinementContext], void>;
      output: BivariantCallback<[value: TInput], TOutput>;
    };

export class EffectsSchema<TOutput = unknown, TInput = TOutput> extends Schema<TOutput> {
  public readonly _def: BaseDef & { schema: Schema<TInput>; effect: EffectDefinition<TInput, TOutput> };

  public constructor(schema: Schema<TInput>, effect: EffectDefinition<TInput, TOutput>) {
    super({ schema, effect } as BaseDef & {
      schema: Schema<TInput>;
      effect: EffectDefinition<TInput, TOutput>;
    });
    this._def = { schema, effect };
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<TOutput> {
    const inner = this._def.schema.parseInternal(input, path);
    if (!inner.success) {
      return inner;
    }
    if (this._def.effect.kind === 'transform') {
      return ok(this._def.effect.transform(inner.data));
    }

    const issues: SchemaIssue[] = [];
    this._def.effect.refine(inner.data, {
      path,
      addIssue: (issue) => {
        issues.push({ path: issue.path ?? path, message: issue.message });
      },
    });
    return issues.length === 0 ? ok(this._def.effect.output(inner.data)) : failIssues(issues);
  }
}

export class ArraySchema<TItem extends SchemaTypeAny = SchemaTypeAny> extends Schema<Infer<TItem>[]> {
  public readonly _def: BaseDef & { type: TItem };
  private readonly checks: ((value: unknown[], path: (string | number)[]) => ParseFailure | null)[];

  public constructor(
    type: TItem,
    checks: ((value: unknown[], path: (string | number)[]) => ParseFailure | null)[] = [],
  ) {
    super({ type } as BaseDef & { type: TItem });
    this._def = { type };
    this.checks = checks;
  }

  public min(length: number, message?: string): ArraySchema<TItem> {
    return new ArraySchema(this._def.type, [
      ...this.checks,
      (value, path) =>
        value.length >= length ? null : fail(message ?? `Array must contain at least ${length} element(s)`, path),
    ]);
  }

  public length(length: number, message?: string): ArraySchema<TItem> {
    return new ArraySchema(this._def.type, [
      ...this.checks,
      (value, path) =>
        value.length === length ? null : fail(message ?? `Array must contain exactly ${length} element(s)`, path),
    ]);
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<Infer<TItem>[]> {
    if (!Array.isArray(input)) {
      return fail('Expected array', path);
    }

    const issues = mergeIssues(
      this.checks.map((check) => check(input, path)).filter((result): result is ParseFailure => result !== null),
    );
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
}

export class ObjectSchema<
  TShape extends SchemaShape = SchemaShape,
  TUnknownKeys extends UnknownKeyPolicy = UnknownKeyPolicy,
  TCatchall extends SchemaTypeAny = SchemaTypeAny,
> extends Schema<ObjectOutput<TShape, TUnknownKeys, TCatchall>> {
  public readonly _def: BaseDef & {
    shape: TShape;
    unknownKeys: TUnknownKeys;
    catchall: TCatchall;
  };
  public readonly shape: TShape;

  public constructor(shape: TShape, unknownKeys: TUnknownKeys, catchall: TCatchall) {
    super({ shape, unknownKeys, catchall } as BaseDef & {
      shape: TShape;
      unknownKeys: TUnknownKeys;
      catchall: TCatchall;
    });
    this.shape = shape;
    this._def = { shape, unknownKeys, catchall };
  }

  public strict(): ObjectSchema<TShape, 'strict', TCatchall> {
    return new ObjectSchema(this.shape, 'strict', this._def.catchall);
  }

  public passthrough(): ObjectSchema<TShape, 'passthrough', TCatchall> {
    return new ObjectSchema(this.shape, 'passthrough', this._def.catchall);
  }

  public catchall<TNextCatchall extends SchemaTypeAny>(
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
}

export class UnionSchema<TOptions extends readonly SchemaTypeAny[] = readonly SchemaTypeAny[]> extends Schema<
  Infer<TOptions[number]>
> {
  public readonly _def: BaseDef & { options: TOptions };

  public constructor(options: TOptions) {
    super({ options } as BaseDef & { options: TOptions });
    this._def = { options };
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
}

export class DiscriminatedUnionSchema<
  TOptions extends readonly SchemaTypeAny[] = readonly SchemaTypeAny[],
> extends UnionSchema<TOptions> {}

export class IntersectionSchema<
  TLeft extends SchemaTypeAny = SchemaTypeAny,
  TRight extends SchemaTypeAny = SchemaTypeAny,
> extends Schema<IntersectionOutput<TLeft, TRight>> {
  public readonly _def: BaseDef & { left: TLeft; right: TRight };

  public constructor(left: TLeft, right: TRight) {
    super({ left, right } as BaseDef & { left: TLeft; right: TRight });
    this._def = { left, right };
  }

  public parseInternal(input: unknown, path: (string | number)[]): ParseResult<IntersectionOutput<TLeft, TRight>> {
    const left = parseWithSchema(this._def.left, input, path);
    const right = parseWithSchema(this._def.right, input, path);
    if (!left.success || !right.success) {
      const failures: ParseFailure[] = [];
      if (!left.success) {
        failures.push(left);
      }
      if (!right.success) {
        failures.push(right);
      }
      return failIssues(mergeIssues(failures));
    }
    if (isPlainRecord(left.data) && isPlainRecord(right.data)) {
      return ok({ ...left.data, ...right.data } as IntersectionOutput<TLeft, TRight>);
    }
    return ok(right.data as IntersectionOutput<TLeft, TRight>);
  }
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

function array<TItem extends SchemaTypeAny>(item: TItem): ArraySchema<TItem> {
  return new ArraySchema(item);
}

function union<const TOptions extends readonly [SchemaTypeAny, SchemaTypeAny, ...SchemaTypeAny[]]>(
  options: TOptions,
): UnionSchema<TOptions> {
  return new UnionSchema(options);
}

function intersection<TLeft extends SchemaTypeAny, TRight extends SchemaTypeAny>(
  left: TLeft,
  right: TRight,
): IntersectionSchema<TLeft, TRight> {
  return new IntersectionSchema(left, right);
}

export const s = {
  ArraySchema,
  BooleanSchema,
  DefaultSchema,
  DiscriminatedUnionSchema,
  EffectsSchema,
  EnumSchema,
  IntersectionSchema,
  LiteralSchema,
  NeverSchema,
  NullableSchema,
  NumberSchema,
  ObjectSchema,
  OptionalSchema,
  StringSchema,
  Schema,
  UndefinedSchema,
  UnionSchema,
  UnknownSchema,
  array,
  boolean,
  enum: enumSchema,
  intersection,
  literal,
  number,
  object,
  string,
  undefined: undefinedSchema,
  union,
  unknown,
};
