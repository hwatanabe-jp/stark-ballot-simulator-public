import type { RouteLike } from './route';

export type ApiContractRouteKind = 'readonly' | 'mutation';
export type ApiContractLifecycle = 'active' | 'internal-operator-only';
export type ApiContractAuthScope = 'public-mutation' | 'path-session-capability' | 'callback-authenticity' | 'none';
export type ApiContractDataClassification =
  'public-session-issued' | 'owner-scoped-public-projection' | 'owner-scoped-private-report' | 'internal-operator';
export type ApiContractBodySizeLimitPolicy = 'API_REQUEST_BODY_LIMIT_BYTES' | 'finalization-callback-body';
export type ApiContractProductionBypassPosture =
  'not-applicable' | 'deny-outside-approved-non-production' | 'operator-gated-develop-only' | 'internal-operator-only';
export type ApiContractErrorEnvelope =
  'standard-error-envelope' | 'route-specific-error-envelope' | 'mixed-error-envelopes' | 'plain-text';
export type ApiContractPublicErrorStatus = number | 'upstream-response-status';
export type ApiContractPublicErrorContentType = 'application/json' | 'text/plain; charset=UTF-8';
export type ApiContractConcreteErrorEnvelope = Exclude<ApiContractErrorEnvelope, 'mixed-error-envelopes'>;

export type ApiContractPublicErrorResponse =
  | {
      code: string;
      case?: string;
      status: ApiContractPublicErrorStatus;
      contentType: ApiContractPublicErrorContentType;
      envelope: Exclude<ApiContractConcreteErrorEnvelope, 'plain-text'>;
    }
  | {
      code?: never;
      case: string;
      status: ApiContractPublicErrorStatus;
      contentType: ApiContractPublicErrorContentType;
      envelope: 'route-specific-error-envelope' | 'plain-text';
    };

export interface ApiContractPublicErrors {
  envelope: ApiContractErrorEnvelope;
  codes: readonly string[];
  responses: readonly ApiContractPublicErrorResponse[];
}

export interface ApiContractBodySize {
  applies: boolean;
  limitPath?: ApiContractBodySizeLimitPolicy;
}

export interface ApiContractSourceIp {
  dependency: 'not-required' | 'trusted-proxy-required-for-target-runtime';
  runtimeEnforcementHandoff: 'none' | 'plans-07-and-11';
}

export interface ApiContractRateLimit {
  required: boolean;
  scope: 'none' | 'client-ip' | 'session' | 'session-and-client-ip' | 'callback-authenticity';
  sourceIpDependency: ApiContractSourceIp['dependency'];
}

export interface ApiContractTurnstile {
  required: boolean;
  action?: 'session' | 'vote' | 'finalize';
  tokenLocations?: readonly ['body.turnstileToken'];
  hostnameValidation?: 'required';
  productionBypass: 'not-applicable' | 'deny-outside-approved-non-production';
}

export interface ApiContractTargetAdmission {
  nonOperatorDevelop: 'blocked-by-outer-operator-gate';
  operatorGatedDevelop: 'enabled-for-production-equivalent-smoke';
  ungatedPublic: 'requires-explicit-public-enable-and-server-turnstile';
  runtimeEnforcementHandoff: 'plans-07-and-11';
}

export interface ApiRouteVariantContract {
  selector: string;
  lifecycle: ApiContractLifecycle;
  dataClassification: ApiContractDataClassification;
  admissionControls: readonly string[];
}

export interface ApiRouteContract extends RouteLike {
  readonly kind: ApiContractRouteKind;
  readonly lifecycle: ApiContractLifecycle;
  readonly authScope: ApiContractAuthScope;
  readonly capabilityScope: 'none' | 'header' | 'path' | 'query';
  readonly publicErrorShape: ApiContractErrorEnvelope;
  readonly publicErrors: ApiContractPublicErrors;
  readonly dataClassification: ApiContractDataClassification;
  readonly admissionControls: readonly string[];
  readonly bodySize: ApiContractBodySize;
  readonly sourceIp: ApiContractSourceIp;
  readonly rateLimit?: ApiContractRateLimit;
  readonly turnstile?: ApiContractTurnstile;
  readonly productionBypass: ApiContractProductionBypassPosture;
  readonly targetAdmission?: ApiContractTargetAdmission;
  readonly variants?: readonly ApiRouteVariantContract[];
}

export const TURNSTILE_BODY_TOKEN_LOCATIONS = ['body.turnstileToken'] as const;

export const noBodySize: ApiContractBodySize = { applies: false };
export const apiBodySize: ApiContractBodySize = {
  applies: true,
  limitPath: 'API_REQUEST_BODY_LIMIT_BYTES',
};
export const callbackBodySize: ApiContractBodySize = {
  applies: true,
  limitPath: 'finalization-callback-body',
};
export const noSourceIp: ApiContractSourceIp = {
  dependency: 'not-required',
  runtimeEnforcementHandoff: 'none',
};
export const trustedProxySourceIp: ApiContractSourceIp = {
  dependency: 'trusted-proxy-required-for-target-runtime',
  runtimeEnforcementHandoff: 'plans-07-and-11',
};
export const noRateLimit: ApiContractRateLimit = {
  required: false,
  scope: 'none',
  sourceIpDependency: 'not-required',
};
export const clientIpRateLimit: ApiContractRateLimit = {
  required: true,
  scope: 'client-ip',
  sourceIpDependency: 'trusted-proxy-required-for-target-runtime',
};
export const sessionRateLimit: ApiContractRateLimit = {
  required: true,
  scope: 'session-and-client-ip',
  sourceIpDependency: 'trusted-proxy-required-for-target-runtime',
};
export const noTurnstile: ApiContractTurnstile = {
  required: false,
  productionBypass: 'not-applicable',
};

export function publicErrors(
  envelope: ApiContractErrorEnvelope,
  responses: readonly ApiContractPublicErrorResponse[],
): ApiContractPublicErrors {
  return {
    envelope,
    codes: Array.from(
      new Set(responses.map((response) => response.code).filter((code): code is string => typeof code === 'string')),
    ),
    responses,
  };
}

export function standardJsonError(
  code: string,
  status: ApiContractPublicErrorStatus,
  errorCase?: string,
): ApiContractPublicErrorResponse {
  return {
    code,
    ...(errorCase ? { case: errorCase } : {}),
    status,
    contentType: 'application/json',
    envelope: 'standard-error-envelope',
  };
}

export function routeSpecificJsonError(
  code: string,
  status: ApiContractPublicErrorStatus,
  errorCase?: string,
): ApiContractPublicErrorResponse {
  return {
    code,
    ...(errorCase ? { case: errorCase } : {}),
    status,
    contentType: 'application/json',
    envelope: 'route-specific-error-envelope',
  };
}

export function uncodedRouteSpecificJsonError(errorCase: string, status: number): ApiContractPublicErrorResponse {
  return {
    case: errorCase,
    status,
    contentType: 'application/json',
    envelope: 'route-specific-error-envelope',
  };
}

export const MOUNTED_ROUTE_ERROR_RESPONSES = [
  standardJsonError('INVALID_REQUEST', 400, 'contract-request-validation'),
  standardJsonError('SAME_ORIGIN_REQUIRED', 403, 'target-origin-verification'),
  standardJsonError('INTERNAL_ERROR', 500, 'unhandled-route-error'),
] as const;
export const PATH_SESSION_CAPABILITY_ERROR_RESPONSES = [
  standardJsonError('SESSION_CAPABILITY_REQUIRED', 401),
  standardJsonError('SESSION_CAPABILITY_INVALID', 401),
  standardJsonError('SESSION_CAPABILITY_EXPIRED', 401),
] as const;
export const BODY_ERROR_RESPONSES = [standardJsonError('PAYLOAD_TOO_LARGE', 413)] as const;
export const TURNSTILE_ERROR_RESPONSES = [
  standardJsonError('CAPTCHA_FAILED', 403),
  standardJsonError('CAPTCHA_FAILED', 'upstream-response-status', 'turnstile-upstream-rejection'),
] as const;
export const FINALIZE_RATE_LIMIT_ERROR_RESPONSES = [
  standardJsonError('GLOBAL_LIMIT_EXCEEDED', 503),
  standardJsonError('ZKVM_RATE_LIMIT_EXCEEDED', 429),
] as const;

export function turnstile(action: 'session' | 'vote' | 'finalize'): ApiContractTurnstile {
  return {
    required: true,
    action,
    tokenLocations: TURNSTILE_BODY_TOKEN_LOCATIONS,
    hostnameValidation: 'required',
    productionBypass: 'deny-outside-approved-non-production',
  };
}
