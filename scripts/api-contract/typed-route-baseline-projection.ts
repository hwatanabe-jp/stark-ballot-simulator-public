import type {
  ApiRouteContract,
  ApiContractBodySize,
  ApiContractDataClassification,
  ApiContractErrorEnvelope,
  ApiContractLifecycle,
  ApiContractMethod,
  ApiContractProductionBypassPosture,
  ApiContractPublicErrors,
  ApiContractRateLimit,
  ApiContractSourceIp,
  ApiContractTargetAdmission,
  ApiContractTurnstile,
  ApiRouteVariantContract,
} from '@stark-ballot/api-contract/routes';
import { fingerprintSchemaSemantics, type SchemaSemanticEvidence } from './schema-semantic-fingerprint';

export interface BaselineRequestEvidence {
  params?: SchemaSemanticEvidence;
  query?: SchemaSemanticEvidence;
  headers?: SchemaSemanticEvidence;
  body?: SchemaSemanticEvidence;
}

export interface BaselineResponseEvidence {
  status: number;
  content: 'json' | 'binary' | 'text';
  schema?: SchemaSemanticEvidence;
  exemptReason?: string;
}

interface BaselineBodySize {
  applies: boolean;
  limitPath?: 'API_REQUEST_BODY_LIMIT_BYTES' | 'FINALIZE_CALLBACK_BODY_LIMIT_BYTES';
}

/** Serializable route evidence used by the reviewed public-contract comparator. */
export interface BaselineApiRouteContract {
  routeId: string;
  method: ApiContractMethod;
  path: string;
  kind: 'readonly' | 'mutation';
  lifecycle: ApiContractLifecycle;
  authScope: ApiRouteContract['authScope'];
  capabilityScope: ApiRouteContract['capabilityScope'];
  request: BaselineRequestEvidence;
  responses: BaselineResponseEvidence[];
  publicErrorShape: ApiContractErrorEnvelope;
  publicErrors: ApiContractPublicErrors;
  dataClassification: ApiContractDataClassification;
  admissionControls: readonly string[];
  bodySize: BaselineBodySize;
  sourceIp: ApiContractSourceIp;
  rateLimit?: ApiContractRateLimit;
  turnstile?: ApiContractTurnstile;
  productionBypass: ApiContractProductionBypassPosture;
  targetAdmission?: ApiContractTargetAdmission;
  variants?: readonly ApiRouteVariantContract[];
}

function projectRequest(route: ApiRouteContract): BaselineRequestEvidence {
  const request: BaselineRequestEvidence = {};
  if (route.request.params) {
    request.params = fingerprintSchemaSemantics(route.request.params);
  }
  if (route.request.query) {
    request.query = fingerprintSchemaSemantics(route.request.query);
  }
  if (route.request.headers) {
    request.headers = fingerprintSchemaSemantics(route.request.headers);
  }
  if (route.request.body) {
    request.body = fingerprintSchemaSemantics(route.request.body);
  }
  return request;
}

function projectResponses(route: ApiRouteContract): BaselineResponseEvidence[] {
  return route.responses.map((response) => {
    if ('schema' in response) {
      return {
        status: response.status,
        content: response.content,
        schema: fingerprintSchemaSemantics(response.schema),
      };
    }
    return {
      status: response.status,
      content: response.content,
      exemptReason: response.exemptReason,
    };
  });
}

function projectBodySize(bodySize: ApiContractBodySize): BaselineBodySize {
  if (!bodySize.applies || bodySize.limitPath === undefined) {
    return { applies: bodySize.applies };
  }
  return {
    applies: true,
    limitPath:
      bodySize.limitPath === 'finalization-callback-body' ? 'FINALIZE_CALLBACK_BODY_LIMIT_BYTES' : bodySize.limitPath,
  };
}

export function projectTypedRouteForBaseline(route: ApiRouteContract): BaselineApiRouteContract {
  return {
    routeId: route.routeId,
    method: route.method,
    path: route.path,
    kind: route.kind,
    lifecycle: route.lifecycle,
    authScope: route.authScope,
    capabilityScope: route.capabilityScope,
    request: projectRequest(route),
    responses: projectResponses(route),
    publicErrorShape: route.publicErrorShape,
    publicErrors: route.publicErrors,
    dataClassification: route.dataClassification,
    admissionControls: route.admissionControls,
    bodySize: projectBodySize(route.bodySize),
    sourceIp: route.sourceIp,
    ...(route.rateLimit === undefined ? {} : { rateLimit: route.rateLimit }),
    ...(route.turnstile === undefined ? {} : { turnstile: route.turnstile }),
    productionBypass: route.productionBypass,
    ...(route.targetAdmission === undefined ? {} : { targetAdmission: route.targetAdmission }),
    ...(route.variants === undefined ? {} : { variants: route.variants }),
  };
}

export function projectTypedRoutesForBaseline(routes: readonly ApiRouteContract[]): BaselineApiRouteContract[] {
  return routes.map((route) => projectTypedRouteForBaseline(route));
}
