import { requireRecord, requireExactKeys, requireString } from '../validation/manifest-admission';
export interface FormalReportTheorem {
  readonly name: string;
  readonly source: string;
  readonly claim: string;
}

export interface FormalVectorArtifactReference {
  readonly path: string;
  readonly kind: string;
}

export interface FormalReport {
  readonly schema: 'stark-ballot:formal-report|v1';
  readonly leanToolchain: string;
  readonly reportKind: string;
  readonly generatedVectorEnvelopeType: string;
  readonly modelModules: readonly string[];
  readonly theorems: readonly FormalReportTheorem[];
  readonly generatedVectorArtifacts: readonly FormalVectorArtifactReference[];
  readonly formalAuditArtifact: string;
  readonly assumptions: readonly string[];
  readonly nonClaims: readonly string[];
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry, index) => requireString(entry, `${label}[${index}]`));
}

export function parseFormalReport(value: unknown): FormalReport {
  const report = requireRecord(value, 'formal report');
  requireExactKeys(
    report,
    [
      'assumptions',
      'formalAuditArtifact',
      'generatedVectorArtifacts',
      'generatedVectorEnvelopeType',
      'leanToolchain',
      'modelModules',
      'nonClaims',
      'reportKind',
      'schema',
      'theorems',
    ],
    'formal report',
  );
  if (report['schema'] !== 'stark-ballot:formal-report|v1') {
    throw new Error('formal report schema is unsupported');
  }
  if (!Array.isArray(report['theorems']) || !Array.isArray(report['generatedVectorArtifacts'])) {
    throw new Error('formal report theorem and vector inventories must be arrays');
  }

  const theorems = report['theorems'].map((entry, index): FormalReportTheorem => {
    const theorem = requireRecord(entry, `formal report theorem[${index}]`);
    requireExactKeys(theorem, ['claim', 'name', 'source'], `formal report theorem[${index}]`);
    return {
      name: requireString(theorem['name'], `formal report theorem[${index}].name`),
      source: requireString(theorem['source'], `formal report theorem[${index}].source`),
      claim: requireString(theorem['claim'], `formal report theorem[${index}].claim`),
    };
  });
  const generatedVectorArtifacts = report['generatedVectorArtifacts'].map(
    (entry, index): FormalVectorArtifactReference => {
      const artifact = requireRecord(entry, `formal report vector[${index}]`);
      requireExactKeys(artifact, ['kind', 'path'], `formal report vector[${index}]`);
      return {
        path: requireString(artifact['path'], `formal report vector[${index}].path`),
        kind: requireString(artifact['kind'], `formal report vector[${index}].kind`),
      };
    },
  );

  return {
    schema: report['schema'],
    leanToolchain: requireString(report['leanToolchain'], 'formal report.leanToolchain'),
    reportKind: requireString(report['reportKind'], 'formal report.reportKind'),
    generatedVectorEnvelopeType: requireString(
      report['generatedVectorEnvelopeType'],
      'formal report.generatedVectorEnvelopeType',
    ),
    modelModules: requireStringArray(report['modelModules'], 'formal report.modelModules'),
    theorems,
    generatedVectorArtifacts,
    formalAuditArtifact: requireString(report['formalAuditArtifact'], 'formal report.formalAuditArtifact'),
    assumptions: requireStringArray(report['assumptions'], 'formal report.assumptions'),
    nonClaims: requireStringArray(report['nonClaims'], 'formal report.nonClaims'),
  };
}
