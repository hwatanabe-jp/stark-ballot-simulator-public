import type { FlattenedSchemaError, PublicErrorDetail } from '@stark-ballot/api-contract/schemas/errors';
import type { ErrorDetails, VerificationStatus } from './apiErrors';
import { ErrorCode, getErrorMessage } from './apiErrors';
import { standardJsonError } from '../routes/contract';

const admittedDetails = {
  voteIndex: 1,
  expectedTreeSize: 2,
  actualTreeSize: 3,
} satisfies ErrorDetails;

void admittedDetails;

// @ts-expect-error Public error detail input is a closed safe-field catalog.
const unclassifiedDetails = { privateVerifierPath: '/tmp/private/report.json' } satisfies ErrorDetails;

void unclassifiedDetails;

standardJsonError(ErrorCode.INVALID_REQUEST, 400);
getErrorMessage(ErrorCode.INVALID_REQUEST);

// @ts-expect-error Message lookup accepts only the closed public error catalog.
getErrorMessage('UNKNOWN_ERROR_CODE');

// @ts-expect-error Route declarations must use the closed public error catalog.
standardJsonError('NOT_CATALOGED', 418);

type RuntimeErrorDetailsProjection = {
  message?: string;
  details?: string | PublicErrorDetail;
  issues?: FlattenedSchemaError;
  reason?: string;
  retryAfter?: number;
  retryAfterSeconds?: number;
  limitBytes?: number;
  receivedBytes?: number;
  nextAvailableAt?: string;
  nextAvailableAtMs?: number;
  remainingExecutions?: number;
  status?: VerificationStatus;
  finalizationId?: string;
  verificationReport?: unknown;
  voteIndex?: number;
  expectedTreeSize?: number;
  actualTreeSize?: number;
  errorCodes?: string[];
};

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Expect<Value extends true> = Value;

export type ErrorDetailsProjectionAssertion = Expect<
  Equal<Pick<ErrorDetails, keyof RuntimeErrorDetailsProjection>, RuntimeErrorDetailsProjection>
>;
