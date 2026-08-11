export interface PollAttemptContext<T> {
  readonly attempt: number;
  readonly previousResult: T | undefined;
}

export interface PollDelayContext<T> {
  readonly attempt: number;
  readonly result: T | undefined;
}

export interface PollTimeoutContext<T> {
  readonly attempts: number;
  readonly lastResult: T | undefined;
}

interface PollUntilBaseOptions<T> {
  readonly operation: (context: PollAttemptContext<T>) => Promise<T>;
  readonly isTerminal: (result: T, context: PollAttemptContext<T>) => boolean;
  readonly delay: (context: PollDelayContext<T>) => Promise<void>;
  readonly delayPosition?: 'after-attempt' | 'before-attempt';
  readonly createTimeoutError: (context: PollTimeoutContext<T>) => Error;
}

interface PollUntilAttemptOptions<T> extends PollUntilBaseOptions<T> {
  readonly maxAttempts: number;
  readonly deadlineMs?: never;
  readonly clock?: never;
}

interface PollUntilDeadlineOptions<T> extends PollUntilBaseOptions<T> {
  readonly deadlineMs: number;
  readonly clock: () => number;
  readonly maxAttempts?: never;
}

export type PollUntilOptions<T> = PollUntilAttemptOptions<T> | PollUntilDeadlineOptions<T>;

function assertValidLimit<T>(options: PollUntilOptions<T>): void {
  if ('maxAttempts' in options) {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 0) {
      throw new Error('maxAttempts must be a non-negative integer');
    }
    return;
  }

  if (Number.isNaN(options.deadlineMs)) {
    throw new Error('deadlineMs must not be NaN');
  }
}

function hasRemainingAttempt<T>(options: PollUntilOptions<T>, attempt: number): boolean {
  if ('maxAttempts' in options) {
    return attempt < options.maxAttempts;
  }
  return options.clock() <= options.deadlineMs;
}

export async function pollUntil<T>(options: PollUntilOptions<T>): Promise<T> {
  assertValidLimit(options);

  const delayPosition = options.delayPosition ?? 'after-attempt';
  let attempt = 0;
  let previousResult: T | undefined;

  while (hasRemainingAttempt(options, attempt)) {
    const context = { attempt, previousResult };
    if (delayPosition === 'before-attempt') {
      await options.delay({ attempt, result: previousResult });
    }

    const result = await options.operation(context);
    if (options.isTerminal(result, context)) {
      return result;
    }

    previousResult = result;
    if (delayPosition === 'after-attempt') {
      await options.delay({ attempt, result });
    }
    attempt += 1;
  }

  throw options.createTimeoutError({ attempts: attempt, lastResult: previousResult });
}
