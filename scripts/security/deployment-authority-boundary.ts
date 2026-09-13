import type * as ESTree from 'oxc-parser';
import {
  forEachChild,
  isBinaryOperation,
  isComputedMember,
  isNode,
  isNumericLiteral,
  isStaticMember,
  isStringLiteral,
  lineAt,
  nodeText,
  parseSource,
  sourceLine,
  sourceText,
  staticText,
} from '../source-analysis/source';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  renderDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
  type DeploymentLane,
} from '@stark-ballot/deployment-authority';

export type DeploymentAuthorityBoundaryRule =
  | 'alternate-authority-reader'
  | 'broad-authority-fallback'
  | 'context-secret-field'
  | 'context-unbounded-extension'
  | 'duplicate-canonical-json'
  | 'duplicate-context-renderer'
  | 'duplicate-first-write-classification'
  | 'duplicate-immutable-authority'
  | 'duplicate-immutable-reference'
  | 'duplicate-pointer-cas'
  | 'duplicate-s3-version-id-parser'
  | 'duplicate-sha256-parser'
  | 'duplicate-source-sha-parser'
  | 'duplicate-terraform-action-classifier'
  | 'duplicate-terraform-address-redactor'
  | 'duplicate-terraform-baseline-validator'
  | 'duplicate-terraform-drift-result-mapper'
  | 'governed-target-reconstruction';

export interface DeploymentAuthorityBoundaryViolation {
  readonly path: string;
  readonly line: number;
  readonly rule: DeploymentAuthorityBoundaryRule;
  readonly token?: string;
}

interface FunctionImplementation {
  readonly body: ESTree.Node;
  readonly declaration: ESTree.Node;
  readonly name: string;
}

interface SemanticImplementation {
  readonly endLine: number;
  readonly line: number;
  readonly name: string;
  readonly text: string;
}

const AUTHORITY_OWNER_PREFIX = 'packages/deployment-authority/src/';
const CANONICAL_CONTEXT_RENDERER_PATH = 'packages/deployment-authority/src/index.js';
const CANONICAL_CONTEXT_RENDERER_NAME = 'renderDeploymentLaneContext';
const FRAMEWORK_CONTEXT_RENDERER_PATH = 'packages/deployment-authority/src/framework.js';
const FRAMEWORK_CONTEXT_RENDERER_NAME = 'renderFrameworkLaneContext';
const CANONICAL_TERRAFORM_AUTHORITY_PATH = 'packages/deployment-authority/src/terraform-authority.js';
const CANONICAL_TERRAFORM_DRIFT_PATH = 'packages/deployment-authority/src/terraform-drift.js';
// The packages/test-support workspace is runtime source; only local helper directories are fixtures.
const TEST_PATH_PATTERN = /(?:^|\/)(?:(?<!^packages\/)test-support|tests)\/|(?:\.test|\.spec)\.[cm]?[jt]sx?$/u;
const JAVASCRIPT_LIKE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const ACTIVE_SCRIPT_PREFIXES = [
  '.github/workflows/',
  'scripts/aws/',
  'scripts/terraform/',
  'infra/terraform/bootstrap/app-pipeline-scripts/',
  'infra/terraform/bootstrap/app-signature-preflight-scripts/',
  'infra/terraform/bootstrap/foundation-pipeline-scripts/',
  'infra/terraform/bootstrap/terraform-drift-scripts/',
] as const;
const ACTIVE_EXTENSIONS = new Set([
  '.cjs',
  '.hcl',
  '.js',
  '.jsx',
  '.mjs',
  '.sh',
  '.tf',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

const CONTEXT_RENDERER_NAME_PATTERN = /^(?:render|build|create|compose|generate|make).*(?:deployment|lane).*context$/iu;
const LEXICAL_FUNCTION_DECLARATION_PATTERN =
  /(?:\bfunction\s+|\b(?:const|let|var)\s+)([A-Za-z_$][A-Za-z0-9_$]*)(?=\s*(?:\(|=))|^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(.*\)\s*\{/u;
const SEMANTIC_FUNCTION_DECLARATION_PATTERN =
  /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(|^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(.*\)\s*\{|\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)/u;
const GENERIC_IMMUTABLE_AUTHORITY_NAME_PATTERN =
  /^(?:(?:parse|validate|assert|check|enforce|classify|normalize|require|admit).*(?:immutable.*(?:object|reference|publication)|pointer.*(?:compareAndSwap|cas)|compareAndSwap.*pointer|firstPublication)|(?:parse|same|require|validate)(?:Immutable)?Reference|requirePublication)$/iu;

const SECRET_FIELD_PATTERN =
  /(?:secret|password|credential|privatekey|token|presignedurl|terraformstate|savedplan|approvalpayload|decrypted)/iu;
const SECRET_REFERENCE_SUFFIX_PATTERN = /(?:ref|reference|references)$/iu;
const ALWAYS_FORBIDDEN_CONTEXT_FIELD_PATTERN = /(?:presignedurl|terraformstate|savedplan|approvalpayload|decrypted)/iu;
const UNBOUNDED_CONTEXT_FIELDS = new Set([
  'additionaldata',
  'contextdata',
  'custom',
  'extension',
  'extensiondata',
  'extensions',
  'extra',
  'extras',
  'metadata',
  'payload',
  'raw',
]);

const CLOSED_TARGET_SELECTOR_PATTERN =
  /(?:resolveAllowedDeploymentTarget\(\s*['"]stark-dev\/develop['"]\s*\)|--target\s+stark-dev\/develop|allowedTargets\s*\[\s*['"]stark-dev\/develop['"]\s*\]|keys\([^\n)]*allowedTargets\)\s*==\s*\[\s*['"]stark-dev\/develop['"]\s*\])/u;
const CANONICAL_AUTHORITY_REFERENCE_PATTERN =
  /^(?:(?:[A-Z][A-Z0-9_]*_LANE_AUTHORITY|DEPLOYMENT_TARGET|LANE_AUTHORITY|deploymentContext|laneContext|parsedContext|targetContext)(?:(?:\??\.)[A-Za-z_$][A-Za-z0-9_$]*|\[['"][A-Za-z_$][A-Za-z0-9_$]*['"]\])*|context\.(?:names|project|root|source|target)(?:(?:\??\.)[A-Za-z_$][A-Za-z0-9_$]*|\[['"][A-Za-z_$][A-Za-z0-9_$]*['"]\])*|local\.(?:deployment_target|deployment_shared_names|[a-z0-9_]*lane_authority)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)$/u;
const SHELL_DEFAULT_PATTERN = /\$\{([A-Z][A-Z0-9_]*):-(.*?)\}/gu;

function normalizeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
}

const REVIEWED_TARGET_KEY = 'stark-dev/develop';
const DEPLOYMENT_LANES = [
  'app',
  'bootstrap',
  'foundation',
  'prover',
  'static-fast',
  'toolchain',
] as const satisfies readonly DeploymentLane[];
const BOUNDARY_SOURCE_SHA = '0'.repeat(40);
const REVIEWED_TARGET = resolveAllowedDeploymentTarget(REVIEWED_TARGET_KEY);
const REVIEWED_CONTEXTS = DEPLOYMENT_LANES.map((lane) =>
  renderDeploymentLaneContext({
    target: REVIEWED_TARGET,
    lane,
    accountId: REVIEWED_TARGET.accountId,
    requestedControlSourceSha: BOUNDARY_SOURCE_SHA,
    selectedApplicationSourceSha: BOUNDARY_SOURCE_SHA,
    frameworkSourceSha: BOUNDARY_SOURCE_SHA,
  }),
);

function collectStringLeaves(value: unknown, values: Set<string>): void {
  if (typeof value === 'string') {
    values.add(value);
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  for (const nestedValue of Object.values(value)) {
    collectStringLeaves(nestedValue, values);
  }
}

function governedTargetLiteralValues(): readonly string[] {
  const values = new Set<string>([
    REVIEWED_TARGET.targetKey,
    REVIEWED_TARGET.accountId,
    REVIEWED_TARGET.resourcePrefix,
    REVIEWED_TARGET.stateNamespace,
    REVIEWED_TARGET.artifactNamespace,
    REVIEWED_TARGET.region,
    REVIEWED_TARGET.repository,
    REVIEWED_TARGET.repositoryUrl,
  ]);
  for (const context of REVIEWED_CONTEXTS) {
    collectStringLeaves(context.root, values);
    collectStringLeaves(context.names, values);
  }
  for (const genericValue of [
    REVIEWED_TARGET.projectId,
    REVIEWED_TARGET.accountLabel,
    REVIEWED_TARGET.environmentId,
    REVIEWED_TARGET.environmentTier,
    REVIEWED_TARGET.partition,
    REVIEWED_TARGET.sourceAction,
    REVIEWED_TARGET.sourceBranch,
    REVIEWED_TARGET.sourceProvider,
    ...DEPLOYMENT_LANES,
    'foundation',
    'bootstrap',
  ]) {
    values.delete(genericValue);
  }
  return [...values].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

const GOVERNED_TARGET_LITERAL_VALUES = governedTargetLiteralValues();
const GOVERNED_CONTEXT_IDENTIFIERS = (() => {
  const keys = new Set(
    [
      'accountId',
      'accountLabel',
      'artifactNamespace',
      'backendKey',
      'deploymentEnvironment',
      'environmentId',
      'pipeline',
      'projectId',
      'region',
      'repository',
      'repositoryName',
      'repositoryUrl',
      'resourcePrefix',
      'sourceAction',
      'sourceBranch',
      'stateIdentity',
      'stateNamespace',
      'stateScope',
      'targetKey',
    ].map(normalizeIdentifier),
  );
  for (const context of REVIEWED_CONTEXTS) {
    for (const key of Object.keys(context.names)) {
      if (key !== 'targetLambdaFunctions' && key !== 'targetLogGroups') {
        keys.add(normalizeIdentifier(key));
      }
    }
  }
  return keys;
})();
const CANONICAL_EXTENSION_FIELD_IDENTIFIERS = new Set([
  ...Object.keys(REVIEWED_CONTEXTS[0]?.names ?? {})
    .filter((key) => key !== 'targetLambdaFunctions' && key !== 'targetLogGroups')
    .map(normalizeIdentifier),
  'approvalevidencekeyprefix',
  'backendkey',
  'stateidentity',
]);

function isAuthorityOwnerPath(relativePath: string): boolean {
  return relativePath.startsWith(AUTHORITY_OWNER_PREFIX);
}

function isActiveTerraformHclPath(relativePath: string): boolean {
  return (
    /^infra\/terraform\/(?:app|bootstrap|foundation)\//u.test(relativePath) &&
    ['.hcl', '.tf'].includes(path.extname(relativePath))
  );
}

function isGovernedTargetConsumerPath(relativePath: string): boolean {
  return (
    isAuthorityOwnerPath(relativePath) ||
    /^buildspec[^/]*\.ya?ml$/u.test(relativePath) ||
    isActiveTerraformHclPath(relativePath) ||
    relativePath.startsWith('scripts/aws/') ||
    ACTIVE_SCRIPT_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
  );
}

function isContextRenderer(name: string, bodyText: string): boolean {
  return (
    CONTEXT_RENDERER_NAME_PATTERN.test(name) ||
    (/\bcontextType\s*:\s*['"]deployment-lane-context['"]/u.test(bodyText) && /\btarget\s*:/u.test(bodyText))
  );
}

function isCanonicalContextRenderer(relativePath: string, name: string): boolean {
  return (
    (relativePath === CANONICAL_CONTEXT_RENDERER_PATH && name === CANONICAL_CONTEXT_RENDERER_NAME) ||
    (relativePath === FRAMEWORK_CONTEXT_RENDERER_PATH && name === FRAMEWORK_CONTEXT_RENDERER_NAME)
  );
}

function isGenericImmutableAuthority(name: string): boolean {
  return GENERIC_IMMUTABLE_AUTHORITY_NAME_PATTERN.test(name);
}

function propertyNameText(name: ESTree.Node): string | undefined {
  if (isNode(name, 'Identifier') || isNode(name, 'PrivateIdentifier')) {
    return staticText(name);
  }
  if (isStringLiteral(name) || isNumericLiteral(name)) {
    return staticText(name);
  }
  return undefined;
}

function implementationFunctions(sourceFile: ESTree.Program): readonly FunctionImplementation[] {
  const implementations: FunctionImplementation[] = [];
  const visit = (node: ESTree.Node): void => {
    if (isNode(node, 'FunctionDeclaration') && node.id !== null && node.body !== null) {
      implementations.push({ body: node.body, declaration: node, name: staticText(node.id) });
    } else if (isNode(node, 'MethodDefinition') && node.value.body !== null) {
      const name = propertyNameText(node.key);
      if (name !== undefined) {
        implementations.push({ body: node.value.body, declaration: node, name });
      }
    } else if (
      isNode(node, 'VariableDeclarator') &&
      isNode(node.id, 'Identifier') &&
      node.init !== null &&
      (isNode(node.init, 'ArrowFunctionExpression') || isNode(node.init, 'FunctionExpression')) &&
      node.init.body !== null
    ) {
      implementations.push({ body: node.init.body, declaration: node, name: staticText(node.id) });
    } else if (
      isNode(node, 'Property') &&
      !node.shorthand &&
      (isNode(node.value, 'ArrowFunctionExpression') || isNode(node.value, 'FunctionExpression')) &&
      node.value.body !== null
    ) {
      const name = propertyNameText(node.key);
      if (name !== undefined) {
        implementations.push({ body: node.value.body, declaration: node, name });
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return implementations;
}

function semanticImplementationsFromSourceFile(
  sourceFile: ESTree.Program,
  implementations: readonly FunctionImplementation[],
): readonly SemanticImplementation[] {
  return implementations.map((implementation) => ({
    endLine: lineAt(sourceFile, implementation.declaration.end),
    line: sourceLine(implementation.declaration),
    name: implementation.name,
    text: nodeText(implementation.declaration),
  }));
}

function lexicalSemanticImplementations(contents: string): readonly SemanticImplementation[] {
  const lines = contents.split(/\r?\n/u);
  const declarations: Array<{
    readonly lineIndex: number;
    readonly name: string;
  }> = [];
  for (const [lineIndex, line] of lines.entries()) {
    const declaration = line.match(SEMANTIC_FUNCTION_DECLARATION_PATTERN);
    const name = declaration?.[1] ?? declaration?.[2] ?? declaration?.[3];
    if (name !== undefined && !['catch', 'for', 'if', 'switch', 'while', 'with'].includes(name)) {
      declarations.push({ lineIndex, name });
    }
  }
  return declarations.map((declaration, index) => {
    const nextDeclarationLine = declarations[index + 1]?.lineIndex ?? lines.length;
    const maximumEndLineIndex = Math.min(nextDeclarationLine, declaration.lineIndex + 80);
    let endLineIndex = maximumEndLineIndex;
    let braceDepth = 0;
    let sawOpeningBrace = false;
    for (let lineIndex = declaration.lineIndex; lineIndex < maximumEndLineIndex; lineIndex += 1) {
      const line = lines[lineIndex] ?? '';
      for (const character of line) {
        if (character === '{') {
          braceDepth += 1;
          sawOpeningBrace = true;
        } else if (character === '}') {
          braceDepth -= 1;
        }
      }
      if (sawOpeningBrace && braceDepth <= 0) {
        endLineIndex = lineIndex + 1;
        break;
      }
    }
    return {
      endLine: endLineIndex,
      line: declaration.lineIndex + 1,
      name: declaration.name,
      text: lines.slice(declaration.lineIndex, endLineIndex).join('\n'),
    };
  });
}

function hasExactImmutableReferenceKeySet(text: string): boolean {
  for (const match of text.matchAll(/\[([^\]]{0,320})\]/gsu)) {
    const body = match[1];
    if (body === undefined) {
      continue;
    }
    const keys = [...body.matchAll(/['"](key|sha256|versionId)['"]/gu)].map((keyMatch) => keyMatch[1]);
    if (keys.length === 3 && new Set(keys).size === 3) {
      const otherString = [...body.matchAll(/['"]([^'"]+)['"]/gu)].some(
        (keyMatch) => !['key', 'sha256', 'versionId'].includes(keyMatch[1] ?? ''),
      );
      if (!otherString) {
        return true;
      }
    }
  }
  return false;
}

function referenceFieldRoots(text: string, field: 'key' | 'sha256' | 'versionId'): ReadonlySet<string> {
  const roots = new Set<string>();
  const pattern = new RegExp(`\\b([A-Za-z_$][A-Za-z0-9_$]*)\\s*(?:\\.${field}\\b|\\[['"]${field}['"]\\])`, 'gu');
  for (const match of text.matchAll(pattern)) {
    if (match[1] !== undefined) {
      roots.add(match[1]);
    }
  }
  return roots;
}

function comparesReferenceFieldBetweenRoots(
  text: string,
  leftRoot: string,
  rightRoot: string,
  field: 'key' | 'sha256' | 'versionId',
): boolean {
  const left = `${leftRoot}\\s*(?:\\.${field}\\b|\\[['"]${field}['"]\\])`;
  const right = `${rightRoot}\\s*(?:\\.${field}\\b|\\[['"]${field}['"]\\])`;
  return new RegExp(`(?:${left}\\s*(?:===|==|!==|!=)\\s*${right}|${right}\\s*(?:===|==|!==|!=)\\s*${left})`, 'u').test(
    text,
  );
}

function comparesImmutableReferences(text: string): boolean {
  const roots = new Set([
    ...referenceFieldRoots(text, 'key'),
    ...referenceFieldRoots(text, 'versionId'),
    ...referenceFieldRoots(text, 'sha256'),
  ]);
  for (const leftRoot of roots) {
    for (const rightRoot of roots) {
      if (
        leftRoot !== rightRoot &&
        comparesReferenceFieldBetweenRoots(text, leftRoot, rightRoot, 'key') &&
        comparesReferenceFieldBetweenRoots(text, leftRoot, rightRoot, 'versionId') &&
        comparesReferenceFieldBetweenRoots(text, leftRoot, rightRoot, 'sha256')
      ) {
        return true;
      }
    }
  }
  return false;
}

function looksLikeImmutableReferenceValidation(text: string): boolean {
  if (/\bparseImmutableObjectReference\s*\(/u.test(text)) {
    return false;
  }
  if (
    hasExactImmutableReferenceKeySet(text) &&
    /\b(?:requireExactKeys|Object\.keys|throw\s+new\s+Error)\b/u.test(text)
  ) {
    return true;
  }
  return comparesImmutableReferences(text);
}

function looksLikeS3VersionIdParser(text: string): boolean {
  if (/\b(?:parseS3VersionId|parseImmutableObjectReference)\s*\(/u.test(text)) {
    return false;
  }
  const versionField = '(?:versionId|VersionId|version_id|VERSION_ID|s3_object_version)';
  const directIndicators = [
    new RegExp(`typeof\\s+[^;\\n]{0,100}${versionField}[^;\\n]{0,100}['"]string['"]`, 'u'),
    new RegExp(`${versionField}[^;\\n]{0,80}\\.length\\s*(?:===?|!==?|<=?)\\s*0`, 'u'),
    new RegExp(`${versionField}[^;\\n]{0,80}\\.trim\\s*\\(`, 'u'),
    new RegExp(`${versionField}[^;\\n]{0,80}(?:===?|!==?|==)\\s*['"]null['"]`, 'u'),
    new RegExp(`(?:Buffer\\.byteLength|TextEncoder)[^;\\n]{0,80}${versionField}`, 'u'),
    new RegExp(`\\\\s[^;\\n]{0,40}\\.test\\s*\\([^;\\n]{0,80}${versionField}`, 'u'),
    new RegExp(`(?:\\[\\[|\\[)\\s+-z\\s+[^;\\n]{0,80}${versionField}`, 'u'),
    new RegExp(`${versionField}[^;\\n]{0,80}==\\s*['"]null['"]`, 'u'),
    new RegExp(`${versionField}[^;\\n]{0,80}\\[\\[:space:\\]\\]`, 'u'),
  ];
  if (directIndicators.some((pattern) => pattern.test(text))) {
    return true;
  }
  if (!/S3\s+VersionId/iu.test(text)) {
    return false;
  }
  const genericIndicators = [
    /\btypeof\b[\s\S]{0,100}?['"]string['"]/u,
    /\.length\s*(?:===?|!==?|<=?)\s*0/u,
    /\.trim\s*\(/u,
    /(?:===?|!==?)\s*['"]null['"]/u,
    /\\s[\s\S]{0,20}\.test\s*\(/u,
    /(?:\[\[|\[)\s+-z\s+/u,
    /\[\[:space:\]\]/u,
  ];
  return genericIndicators.filter((pattern) => pattern.test(text)).length >= 2;
}

function looksLikeFirstWriteClassification(text: string): boolean {
  if (/\bclassifyImmutablePublication\s*\(/u.test(text)) {
    return false;
  }
  const comparesBodyHashes =
    /\b[A-Za-z_$][A-Za-z0-9_$]*sha256\b\s*(?:===|!==|==|!=)\s*\b[A-Za-z_$][A-Za-z0-9_$]*sha256\b/iu.test(text);
  const classifiesOutcome =
    /(?:idempotent(?:[ -]retry)?|publication[ -]conflict|same[ -](?:body|content)|different[ -](?:body|content))/iu.test(
      text,
    );
  if (comparesBodyHashes && classifiesOutcome) {
    return true;
  }
  return (
    /(?:--if-none-match|IfNoneMatch)/iu.test(text) &&
    /(?:PreconditionFailed|\b412\b)/u.test(text) &&
    /(?:\bcmp\s+-s\b|existing[A-Za-z0-9_$]*sha256|observed[A-Za-z0-9_$]*sha256|same[ -]body|different[ -]body)/iu.test(
      text,
    )
  );
}

function comparesExpectedAndObservedField(text: string, field: 'etag' | 'versionId'): boolean {
  const expected = `(?:expected|prior|previous)[A-Za-z0-9_$.]*${field}`;
  const observed = `(?:observed|current)[A-Za-z0-9_$.]*${field}`;
  const comparison = '(?:===|!==|==|!=)';
  return new RegExp(
    `(?:${expected}[\\s\\S]{0,100}?${comparison}[\\s\\S]{0,100}?${observed}|${observed}[\\s\\S]{0,100}?${comparison}[\\s\\S]{0,100}?${expected})`,
    'iu',
  ).test(text);
}

function looksLikePointerCompareAndSwap(text: string): boolean {
  if (/\bassertPointerCompareAndSwap\s*\(/u.test(text)) {
    return false;
  }
  return comparesExpectedAndObservedField(text, 'etag') && comparesExpectedAndObservedField(text, 'versionId');
}

function looksLikeCanonicalJsonImplementation(name: string, text: string): boolean {
  if (/\bcanonicalRecordJson\s*\(/u.test(text)) {
    return false;
  }
  if (/^(?:canonicalJson|stableJson|stableStringify)$/iu.test(name) && /\bJSON\.stringify\s*\(/u.test(text)) {
    return true;
  }
  return (
    /\bObject\.keys\s*\(/u.test(text) &&
    /\.sort\s*\(/u.test(text) &&
    /(?:\bJSON\.stringify\s*\(|\bObject\.fromEntries\s*\()/u.test(text) &&
    (new RegExp(`\\b${name}\\s*\\(`, 'u').test(text.slice(text.indexOf('{') + 1)) || /\bcanonical/iu.test(name))
  );
}

function isTerraformBaselineValidator(name: string, text: string): boolean {
  if (
    /^(?:parse|select|validate).*(?:acceptedterraformbaseline|currentterraformbaselinepointer|terraformbaseline)/iu.test(
      name,
    )
  ) {
    return true;
  }
  return (
    /accepted-terraform-baseline/u.test(text) &&
    /current-terraform-baseline/u.test(text) &&
    /(?:Object\.keys|requireExactKeys|exactRecord|exactKeys)/u.test(text)
  );
}

function isTerraformActionClassifier(name: string, text: string): boolean {
  if (/^(?:classify|map).*(?:terraform)?actions?(?:equence)?$/iu.test(name)) {
    return true;
  }
  const closedActionVocabulary = ['no-op', 'create', 'update', 'delete', 'read'];
  return (
    closedActionVocabulary.every((action) => text.includes(`'${action}'`) || text.includes(`"${action}"`)) &&
    /\.join\s*\(\s*['"]\\0['"]\s*\)/u.test(text)
  );
}

function isTerraformAddressRedactor(name: string, text: string): boolean {
  if (/^(?:redact|sanitize).*(?:terraform).*(?:address)$/iu.test(name)) {
    return true;
  }
  return (
    /\[\*\]/u.test(text) && /(?:address|resource)/iu.test(name) && /(?:replace|closingIndex|indexContent)/u.test(text)
  );
}

function isTerraformDriftResultMapper(name: string, text: string): boolean {
  if (/^(?:classify|map).*(?:terraform)?(?:detailed)?exitcode$/iu.test(name)) {
    return true;
  }
  return (
    /['"]no-drift['"]/u.test(text) &&
    /['"]drift-detected['"]/u.test(text) &&
    /['"]check-failed['"]/u.test(text) &&
    /(?:===?|!==?)\s*0/u.test(text) &&
    /(?:===?|!==?)\s*2/u.test(text)
  );
}

function terraformContractOwnerViolations(
  relativePath: string,
  implementation: SemanticImplementation,
): readonly DeploymentAuthorityBoundaryViolation[] {
  const violations: DeploymentAuthorityBoundaryViolation[] = [];
  if (
    relativePath !== CANONICAL_TERRAFORM_AUTHORITY_PATH &&
    isTerraformBaselineValidator(implementation.name, implementation.text)
  ) {
    violations.push({
      path: relativePath,
      line: implementation.line,
      rule: 'duplicate-terraform-baseline-validator',
      token: implementation.name,
    });
  }
  if (relativePath !== CANONICAL_TERRAFORM_DRIFT_PATH) {
    if (isTerraformActionClassifier(implementation.name, implementation.text)) {
      violations.push({
        path: relativePath,
        line: implementation.line,
        rule: 'duplicate-terraform-action-classifier',
        token: implementation.name,
      });
    }
    if (isTerraformAddressRedactor(implementation.name, implementation.text)) {
      violations.push({
        path: relativePath,
        line: implementation.line,
        rule: 'duplicate-terraform-address-redactor',
        token: implementation.name,
      });
    }
    if (isTerraformDriftResultMapper(implementation.name, implementation.text)) {
      violations.push({
        path: relativePath,
        line: implementation.line,
        rule: 'duplicate-terraform-drift-result-mapper',
        token: implementation.name,
      });
    }
  }
  return violations;
}

function semanticImplementationViolations(
  relativePath: string,
  implementation: SemanticImplementation,
): readonly DeploymentAuthorityBoundaryViolation[] {
  const contractViolations = terraformContractOwnerViolations(relativePath, implementation);
  if (isAuthorityOwnerPath(relativePath)) {
    return contractViolations;
  }
  const violations: DeploymentAuthorityBoundaryViolation[] = [...contractViolations];
  if (looksLikeCanonicalJsonImplementation(implementation.name, implementation.text)) {
    violations.push({
      path: relativePath,
      line: implementation.line,
      rule: 'duplicate-canonical-json',
      token: implementation.name,
    });
  }
  if (looksLikeImmutableReferenceValidation(implementation.text)) {
    violations.push({
      path: relativePath,
      line: implementation.line,
      rule: 'duplicate-immutable-reference',
      token: implementation.name,
    });
  }
  if (looksLikeS3VersionIdParser(implementation.text)) {
    violations.push({
      path: relativePath,
      line: implementation.line,
      rule: 'duplicate-s3-version-id-parser',
      token: implementation.name,
    });
  }
  if (looksLikeFirstWriteClassification(implementation.text)) {
    violations.push({
      path: relativePath,
      line: implementation.line,
      rule: 'duplicate-first-write-classification',
      token: implementation.name,
    });
  }
  if (looksLikePointerCompareAndSwap(implementation.text)) {
    violations.push({
      path: relativePath,
      line: implementation.line,
      rule: 'duplicate-pointer-cas',
      token: implementation.name,
    });
  }
  return violations;
}

function contextFieldViolations(
  relativePath: string,
  _sourceFile: ESTree.Program,
  implementation: FunctionImplementation,
): readonly DeploymentAuthorityBoundaryViolation[] {
  const violations: DeploymentAuthorityBoundaryViolation[] = [];
  const visit = (node: ESTree.Node): void => {
    if (isNode(node, 'SpreadElement') && node.parent?.type === 'ObjectExpression') {
      violations.push({
        path: relativePath,
        line: sourceLine(node),
        rule: 'context-unbounded-extension',
        token: 'object-spread',
      });
    } else if (
      ((isNode(node, 'Property') && !node.shorthand) ||
        (isNode(node, 'Property') && node.shorthand) ||
        isNode(node, 'MethodDefinition')) &&
      node.computed
    ) {
      violations.push({
        path: relativePath,
        line: sourceLine(node),
        rule: 'context-unbounded-extension',
        token: 'computed-property',
      });
    } else if ((isNode(node, 'Property') && !node.shorthand) || (isNode(node, 'Property') && node.shorthand)) {
      const field = propertyNameText(node.key);
      if (field !== undefined) {
        const normalizedField = normalizeIdentifier(field);
        if (
          SECRET_FIELD_PATTERN.test(normalizedField) &&
          (ALWAYS_FORBIDDEN_CONTEXT_FIELD_PATTERN.test(normalizedField) ||
            !SECRET_REFERENCE_SUFFIX_PATTERN.test(normalizedField))
        ) {
          violations.push({
            path: relativePath,
            line: sourceLine(node),
            rule: 'context-secret-field',
            token: field,
          });
        }
        if (UNBOUNDED_CONTEXT_FIELDS.has(normalizedField)) {
          violations.push({
            path: relativePath,
            line: sourceLine(node),
            rule: 'context-unbounded-extension',
            token: field,
          });
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(implementation.body);
  return violations;
}

function isGovernedAuthorityIdentifier(identifier: string): boolean {
  const normalized = normalizeIdentifier(identifier);
  return (
    GOVERNED_CONTEXT_IDENTIFIERS.has(normalized) ||
    normalized === 'account' ||
    normalized === 'awsaccount' ||
    normalized === 'targetaccount' ||
    normalized.endsWith('pipelinename') ||
    normalized.endsWith('backendkey') ||
    normalized.endsWith('stateidentity') ||
    normalized.endsWith('resourceprefix') ||
    normalized.endsWith('region') ||
    normalized.endsWith('accountid') ||
    normalized.endsWith('accountlabel') ||
    normalized.endsWith('accountalias') ||
    normalized.endsWith('pointerkey') ||
    normalized.endsWith('backendkey') ||
    normalized.endsWith('statescope') ||
    normalized.endsWith('sourceaction') ||
    normalized.endsWith('sourcebranch') ||
    normalized.endsWith('deploymentenvironment') ||
    normalized.endsWith('nameprefix') ||
    normalized.endsWith('runtimeprefix') ||
    normalized.endsWith('evidenceprefix') ||
    normalized.endsWith('recordprefix') ||
    normalized.endsWith('manifestprefix') ||
    normalized.endsWith('repository') ||
    normalized.endsWith('repositoryname')
  );
}

function isBroadFallbackAuthorityIdentifier(identifier: string): boolean {
  const normalized = normalizeIdentifier(identifier);
  return (
    isGovernedAuthorityIdentifier(identifier) ||
    normalized === 'target' ||
    normalized === 'arn' ||
    normalized.endsWith('arn') ||
    identifier === 'etag' ||
    identifier === 'ETag' ||
    identifier.endsWith('ETag') ||
    /_etag$/iu.test(identifier) ||
    normalized.endsWith('versionid') ||
    normalized.endsWith('sourcesha') ||
    normalized.endsWith('checksum')
  );
}

function assignmentOnLine(line: string):
  | {
      readonly name: string;
      readonly right: string;
    }
  | undefined {
  const codeAssignment = line.match(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:[^=;]+)?\s*=\s*(.+)$/u);
  if (codeAssignment?.[1] !== undefined && codeAssignment[2] !== undefined) {
    return { name: codeAssignment[1], right: codeAssignment[2] };
  }
  const shellAssignment = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
  if (shellAssignment?.[1] !== undefined && shellAssignment[2] !== undefined) {
    const nextAssignment = shellAssignment[2].match(/\s+[A-Za-z_][A-Za-z0-9_]*=/u);
    return {
      name: shellAssignment[1],
      right:
        nextAssignment?.index === undefined ? shellAssignment[2] : shellAssignment[2].slice(0, nextAssignment.index),
    };
  }
  const yamlAssignment = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*(.*)$/u);
  if (yamlAssignment?.[1] !== undefined && yamlAssignment[2] !== undefined) {
    return { name: yamlAssignment[1], right: yamlAssignment[2] };
  }
  const hclAssignment = line.match(/^\s*([a-z][a-z0-9_]*)\s*=\s*(.*)$/u);
  if (hclAssignment?.[1] !== undefined && hclAssignment[2] !== undefined) {
    return { name: hclAssignment[1], right: hclAssignment[2] };
  }
  return undefined;
}

function indentationWidth(line: string): number {
  return line.match(/^\s*/u)?.[0].length ?? 0;
}

function delimiterDelta(value: string): number {
  let delta = 0;
  for (const character of value) {
    if (character === '(' || character === '[' || character === '{') {
      delta += 1;
    } else if (character === ')' || character === ']' || character === '}') {
      delta -= 1;
    }
  }
  return delta;
}

function expandedAssignmentRight(lines: readonly string[], lineIndex: number, right: string): string {
  const trimmed = right.trim();
  if (isSimpleRuntimeValue(right)) {
    return right;
  }
  const baseIndent = indentationWidth(lines[lineIndex] ?? '');
  const yamlBlock = /^(?:>|\|)[+-]?$/u.test(trimmed);
  const indentationContinuation = yamlBlock || trimmed === '';
  const balancedContinuation = usesAssemblyOperation(trimmed) || /(?:\$\(|^\s*[([{]|(?:\\|\+)\s*$)/u.test(trimmed);
  if (!indentationContinuation && !balancedContinuation) {
    return right;
  }
  if (!indentationContinuation && delimiterDelta(right) <= 0 && !/(?:\\|\+)\s*$/u.test(right)) {
    return right;
  }

  const parts = [right];
  let balance = delimiterDelta(right);
  for (let nextIndex = lineIndex + 1; nextIndex < Math.min(lines.length, lineIndex + 40); nextIndex += 1) {
    const nextLine = lines[nextIndex] ?? '';
    if (indentationContinuation && nextLine.trim() !== '' && indentationWidth(nextLine) <= baseIndent) {
      break;
    }
    parts.push(nextLine);
    balance += delimiterDelta(nextLine);
    if (!indentationContinuation && balance <= 0 && !/(?:\\|\+)\s*$/u.test(nextLine)) {
      break;
    }
  }
  return parts.join('\n');
}

function isCanonicalAuthorityReference(value: string): boolean {
  return CANONICAL_AUTHORITY_REFERENCE_PATTERN.test(value.trim().replace(/;$/u, ''));
}

function isSimpleRuntimeValue(value: string): boolean {
  const trimmed = value
    .trim()
    .replace(/[;\\]$/u, '')
    .trim();
  return (
    /^(?:''|"")$/u.test(trimmed) ||
    /^(?:['"])?\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*(?::\?[^}]*)?\})(?:['"])?$/u.test(trimmed) ||
    /^\$?[1-9][0-9]*$/u.test(trimmed) ||
    /^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\??\.)[A-Za-z_$][A-Za-z0-9_$]*|\[['"][^'"]+['"]\])*$/u.test(trimmed)
  );
}

function isPureRuntimeValue(value: string): boolean {
  const trimmed = value
    .trim()
    .replace(/[;\\]$/u, '')
    .trim();
  return isSimpleRuntimeValue(trimmed) || /^(?:['"])?\$\(/u.test(trimmed);
}

function isCanonicalAuthorityCarrier(value: string): boolean {
  const trimmed = value.trim();
  if (isCanonicalAuthorityReference(trimmed)) {
    const identifiers = trimmed.match(/[A-Za-z_$][A-Za-z0-9_$]*/gu) ?? [];
    return CANONICAL_EXTENSION_FIELD_IDENTIFIERS.has(normalizeIdentifier(identifiers.at(-1) ?? ''));
  }
  const environmentName =
    trimmed.match(/^requireEnv\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)$/u)?.[1] ??
    trimmed.match(/^process\.env\.([A-Z][A-Z0-9_]*)$/u)?.[1] ??
    trimmed.match(/^([A-Z][A-Z0-9_]*)$/u)?.[1];
  if (environmentName === undefined) {
    return false;
  }
  const normalized = normalizeIdentifier(environmentName);
  return [...CANONICAL_EXTENSION_FIELD_IDENTIFIERS].some(
    (identifier) =>
      normalized === identifier ||
      (/^(?:app|deploymentcontextnames|foundation|prover|release|staticfast|toolchain)/u.test(normalized) &&
        normalized.endsWith(identifier)),
  );
}

function isCanonicalAuthorityExtension(value: string): boolean {
  const trimmed = value.trim().replace(/;$/u, '').trim();
  const quoted = trimmed.match(/^([`"])([\s\S]*)\1$/u);
  if (quoted?.[2] !== undefined) {
    const interpolations = [...quoted[2].matchAll(/\$\{([^}]+)\}/gu)];
    return interpolations.length === 1 && isCanonicalAuthorityCarrier(interpolations[0]?.[1] ?? '');
  }
  const concatenatedParts = trimmed.split(/\s*\+\s*/u);
  if (concatenatedParts.length < 2) {
    return false;
  }
  let carrierCount = 0;
  for (const part of concatenatedParts) {
    if (isCanonicalAuthorityCarrier(part)) {
      carrierCount += 1;
    } else if (!/^(?:'[^']*'|"[^"]*")$/u.test(part)) {
      return false;
    }
  }
  return carrierCount === 1;
}

function usesAssemblyOperation(value: string): boolean {
  return /(?:\b(?:format|join|concat)\s*\(|\.join\s*\(|\bprintf\b)/u.test(value);
}

function isGovernedComponentAssembly(value: string): boolean {
  if (!usesAssemblyOperation(value)) {
    return false;
  }
  const governedComponents = new Set<string>();
  for (const match of value.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/gu)) {
    const identifier = normalizeIdentifier(match[0]);
    if (
      /^(?:account(?:alias|id|label)|artifactnamespace|awsaccountid|deploymentenvironment|environmentid|project(?:id|name)|region|repository|resourceprefix|source(?:action|branch)|statenamespace|statescope|targetkey)$/u.test(
        identifier,
      )
    ) {
      governedComponents.add(identifier);
    }
  }
  return governedComponents.size >= 2;
}

function looksLikeGovernedReconstruction(right: string): boolean {
  if (isCanonicalAuthorityReference(right) || /resolveAllowedDeploymentTarget\s*\(/u.test(right)) {
    return false;
  }
  if (GOVERNED_TARGET_LITERAL_VALUES.some((value) => right.includes(value))) {
    return true;
  }
  if (isCanonicalAuthorityExtension(right)) {
    return false;
  }
  if (isGovernedComponentAssembly(right)) {
    return true;
  }
  if (isPureRuntimeValue(right)) {
    return false;
  }
  const trimmed = right
    .trim()
    .replace(/[;\\]$/u, '')
    .trim();
  return /^['"`]/u.test(trimmed) || /\$\{/u.test(trimmed) || /(?:['"`]\s*\+|\+\s*['"`])/u.test(trimmed);
}

function authorityNameFromExpression(expression: ESTree.Node): string | undefined {
  if (isNode(expression, 'Identifier')) {
    return staticText(expression);
  }
  if (isStaticMember(expression)) {
    return staticText(expression.property);
  }
  if (isComputedMember(expression) && isStringLiteral(expression.property)) {
    return staticText(expression.property);
  }
  return undefined;
}

function assignedAuthorityName(
  expression: ESTree.BinaryExpression | ESTree.LogicalExpression | ESTree.AssignmentExpression,
): string | undefined {
  if (isNode(expression.parent, 'VariableDeclarator') && isNode(expression.parent.id, 'Identifier')) {
    return staticText(expression.parent.id);
  }
  if (isNode(expression.parent, 'Property') && !expression.parent.shorthand) {
    return propertyNameText(expression.parent.key);
  }
  return authorityNameFromExpression(expression.left);
}

function isAllowedFallbackRight(right: ESTree.Node): boolean {
  if (
    (right.type === 'Literal' && right.value === null) ||
    (isNode(right, 'Identifier') && staticText(right) === 'undefined') ||
    (isStringLiteral(right) && staticText(right) === '')
  ) {
    return true;
  }
  return isCanonicalAuthorityReference(nodeText(right));
}

function authorityProperty(expression: ESTree.Node):
  | {
      readonly name: string;
      readonly root: string;
    }
  | undefined {
  if (isStaticMember(expression)) {
    return { name: staticText(expression.property), root: nodeText(expression.object) };
  }
  if (isComputedMember(expression) && isStringLiteral(expression.property)) {
    return { name: staticText(expression.property), root: nodeText(expression.object) };
  }
  return undefined;
}

function codeFallbackViolations(
  relativePath: string,
  sourceFile: ESTree.Program,
): readonly DeploymentAuthorityBoundaryViolation[] {
  const violations: DeploymentAuthorityBoundaryViolation[] = [];
  const visit = (node: ESTree.Node): void => {
    if (isBinaryOperation(node) && (node.operator === '??' || node.operator === '||')) {
      const authorityName = assignedAuthorityName(node);
      const leftProperty = authorityProperty(node.left);
      const rightProperty = authorityProperty(node.right);
      if (
        leftProperty !== undefined &&
        rightProperty !== undefined &&
        leftProperty.root === rightProperty.root &&
        leftProperty.name !== rightProperty.name &&
        normalizeIdentifier(leftProperty.name) === normalizeIdentifier(rightProperty.name)
      ) {
        violations.push({
          path: relativePath,
          line: sourceLine(node),
          rule: 'alternate-authority-reader',
          token: `${leftProperty.name}|${rightProperty.name}`,
        });
      }
      if (
        authorityName !== undefined &&
        isBroadFallbackAuthorityIdentifier(authorityName) &&
        !isAllowedFallbackRight(node.right)
      ) {
        violations.push({
          path: relativePath,
          line: sourceLine(node),
          rule: 'broad-authority-fallback',
          token: authorityName,
        });
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

function isProtectedProductionContractLine(line: string): boolean {
  return /(?:protected_production|protectedProduction)/u.test(line);
}

function isCommentOrErrorLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^(?:#|\/\/|\/\*|\*)/u.test(trimmed) ||
    /\berror_message\s*=/u.test(line) ||
    /\b(?:throw\s+new|new\s+[A-Za-z_$][A-Za-z0-9_$]*Error\s*\()/u.test(line) ||
    /(?:process\.stderr\.write|console\.error)\s*\(/u.test(line) ||
    (/^\s*(?:echo|printf)\b/u.test(line) && /(?:>&2|\/dev\/stderr)/u.test(line))
  );
}

function configuredLiteralOnLine(line: string): string | undefined {
  for (const value of GOVERNED_TARGET_LITERAL_VALUES) {
    let offset = 0;
    while (offset <= line.length - value.length) {
      const index = line.indexOf(value, offset);
      if (index === -1) {
        break;
      }
      const before = line[index - 1] ?? '';
      const after = line[index + value.length] ?? '';
      if (!/[A-Za-z0-9_-]/u.test(before) && !/[A-Za-z0-9_.-]/u.test(after)) {
        return value;
      }
      offset = index + value.length;
    }
  }
  return undefined;
}

function isLocalLegacyTerraformDefault(relativePath: string, line: string): boolean {
  return (
    relativePath.startsWith('scripts/terraform/') &&
    (/(?:^|\s)backend_key=['"]terraform\.tfstate['"](?:\s|$)/u.test(line) ||
      /\$\{[A-Za-z_][A-Za-z0-9_]*:-[^}]+\}/u.test(line)) &&
    !/(?:target|reviewed|expected|deploy(?:ment)?_authority)/iu.test(line)
  );
}

function isCanonicalTargetKeySelector(relativePath: string, contents: string, name: string, right: string): boolean {
  if (!relativePath.startsWith('scripts/terraform/') || normalizeIdentifier(name) !== 'targetkey') {
    return false;
  }
  if (!/\brequire_canonical_deployment_target_admission\b/u.test(contents)) {
    return false;
  }
  return /^['"]\$\{(?:target_)?account_alias\}\/\$\{(?:target_)?(?:deployment_)?environment\}['"]$/u.test(right.trim());
}

function isExternallyDocumentedAwsFieldShape(relativePath: string, line: string): boolean {
  return isActiveTerraformHclPath(relativePath) && /\bs3_object_version\b/u.test(line);
}

function ignoredLiteralLines(
  sourceFile: ESTree.Program | undefined,
  implementations: readonly SemanticImplementation[],
): ReadonlySet<number> {
  const ignored = new Set<number>();
  const addRange = (start: number, end: number): void => {
    for (let line = start; line <= end; line += 1) {
      ignored.add(line);
    }
  };
  for (const implementation of implementations) {
    if (/^(?:help|renderHelp|renderUsage|usage|usageText)$/u.test(implementation.name)) {
      addRange(implementation.line, implementation.endLine);
    }
  }
  if (sourceFile === undefined) {
    return ignored;
  }
  const visit = (node: ESTree.Node): void => {
    const isErrorConstruction = isNode(node, 'NewExpression') && /Error$/u.test(nodeText(node.callee));
    const isErrorOutput =
      isNode(node, 'CallExpression') && /^(?:console\.error|process\.stderr\.write)$/u.test(nodeText(node.callee));
    if (isNode(node, 'ThrowStatement') || isErrorConstruction || isErrorOutput) {
      addRange(sourceLine(node), lineAt(sourceFile, node.end));
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return ignored;
}

function governedTargetLiteralViolations(
  relativePath: string,
  contents: string,
  ignoredLines: ReadonlySet<number>,
): readonly DeploymentAuthorityBoundaryViolation[] {
  if (isAuthorityOwnerPath(relativePath)) {
    return [];
  }
  const violations: DeploymentAuthorityBoundaryViolation[] = [];
  const lines = contents.split(/\r?\n/u);
  for (const [lineIndex, line] of lines.entries()) {
    const lineNumber = lineIndex + 1;
    if (
      ignoredLines.has(lineNumber) ||
      isCommentOrErrorLine(line) ||
      isProtectedProductionContractLine(line) ||
      CLOSED_TARGET_SELECTOR_PATTERN.test(line) ||
      isLocalLegacyTerraformDefault(relativePath, line)
    ) {
      continue;
    }
    const governedValue = configuredLiteralOnLine(line);
    if (governedValue !== undefined) {
      violations.push({
        path: relativePath,
        line: lineNumber,
        rule: 'governed-target-reconstruction',
        token: governedValue,
      });
    }
  }
  return violations;
}

function hasTopLevelFallback(expression: ESTree.Node): boolean {
  return isBinaryOperation(expression) && (expression.operator === '??' || expression.operator === '||');
}

function codeGovernedTargetViolations(
  relativePath: string,
  sourceFile: ESTree.Program,
): readonly DeploymentAuthorityBoundaryViolation[] {
  if (isAuthorityOwnerPath(relativePath)) {
    return [];
  }
  const violations: DeploymentAuthorityBoundaryViolation[] = [];
  const inspect = (name: string | undefined, initializer: ESTree.Node): void => {
    const initializerLine = sourceText(sourceFile).split(/\r?\n/u)[sourceLine(initializer) - 1] ?? '';
    if (
      name !== undefined &&
      isGovernedAuthorityIdentifier(name) &&
      !hasTopLevelFallback(initializer) &&
      !CLOSED_TARGET_SELECTOR_PATTERN.test(nodeText(initializer)) &&
      !isProtectedProductionContractLine(initializerLine) &&
      looksLikeGovernedReconstruction(nodeText(initializer))
    ) {
      violations.push({
        path: relativePath,
        line: sourceLine(initializer),
        rule: 'governed-target-reconstruction',
        token: name,
      });
    }
  };
  const visit = (node: ESTree.Node): void => {
    if (isNode(node, 'VariableDeclarator') && isNode(node.id, 'Identifier') && node.init !== null) {
      inspect(staticText(node.id), node.init);
    } else if (isNode(node, 'Property') && !node.shorthand) {
      inspect(propertyNameText(node.key), node.value);
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

function lineFallbackViolations(
  relativePath: string,
  contents: string,
): readonly DeploymentAuthorityBoundaryViolation[] {
  const violations: DeploymentAuthorityBoundaryViolation[] = [];
  for (const [lineIndex, line] of contents.split(/\r?\n/u).entries()) {
    if (
      isCommentOrErrorLine(line) ||
      isProtectedProductionContractLine(line) ||
      isLocalLegacyTerraformDefault(relativePath, line)
    ) {
      continue;
    }
    for (const match of line.matchAll(SHELL_DEFAULT_PATTERN)) {
      const authorityName = match[1];
      const fallbackValue = match[2];
      if (
        authorityName !== undefined &&
        fallbackValue !== undefined &&
        fallbackValue.length > 0 &&
        isBroadFallbackAuthorityIdentifier(authorityName)
      ) {
        violations.push({
          path: relativePath,
          line: lineIndex + 1,
          rule: 'broad-authority-fallback',
          token: authorityName,
        });
      }
    }
  }
  return violations;
}

function governedTargetViolations(
  relativePath: string,
  contents: string,
  fallbackLines: ReadonlySet<number>,
): readonly DeploymentAuthorityBoundaryViolation[] {
  if (isAuthorityOwnerPath(relativePath)) {
    return [];
  }
  const violations: DeploymentAuthorityBoundaryViolation[] = [];
  const lines = contents.split(/\r?\n/u);
  for (const [lineIndex, line] of lines.entries()) {
    const lineNumber = lineIndex + 1;
    if (
      fallbackLines.has(lineNumber) ||
      CLOSED_TARGET_SELECTOR_PATTERN.test(line) ||
      isProtectedProductionContractLine(line) ||
      isLocalLegacyTerraformDefault(relativePath, line)
    ) {
      continue;
    }
    const assignment = assignmentOnLine(line);
    const expandedRight =
      assignment === undefined ? undefined : expandedAssignmentRight(lines, lineIndex, assignment.right);
    if (
      assignment !== undefined &&
      expandedRight !== undefined &&
      isGovernedAuthorityIdentifier(assignment.name) &&
      !isCanonicalTargetKeySelector(relativePath, contents, assignment.name, assignment.right) &&
      looksLikeGovernedReconstruction(expandedRight)
    ) {
      violations.push({
        path: relativePath,
        line: lineNumber,
        rule: 'governed-target-reconstruction',
        token: assignment.name,
      });
    }
  }
  return violations;
}

function hexWidthsInParserLine(line: string): ReadonlyArray<{
  readonly index: number;
  readonly width: 40 | 64;
}> {
  if (!/(?:\/|grep\s+-[^\n]*E|=~|RegExp|pattern|\.test\s*\(|\.match\s*\()/iu.test(line)) {
    return [];
  }
  const widths: Array<{
    readonly index: number;
    readonly width: 40 | 64;
  }> = [];
  for (const match of line.matchAll(/\[([0-9A-Fa-f-]+)\]\{(40|64)\}/gu)) {
    const characterClass = match[1]?.toLowerCase();
    const widthText = match[2];
    if (
      characterClass === undefined ||
      !characterClass.includes('0-9') ||
      !characterClass.includes('a-f') ||
      (widthText !== '40' && widthText !== '64')
    ) {
      continue;
    }
    widths.push({ index: match.index, width: widthText === '40' ? 40 : 64 });
  }
  return widths;
}

function externalHexTokenPrefix(line: string, index: number): boolean {
  const prefix = line.slice(Math.max(0, index - 24), index).toLowerCase();
  return /(?:sha256:|0x)$/.test(prefix);
}

function hexParserViolations(relativePath: string, contents: string): readonly DeploymentAuthorityBoundaryViolation[] {
  if (isAuthorityOwnerPath(relativePath)) {
    return [];
  }
  const violations: DeploymentAuthorityBoundaryViolation[] = [];
  for (const [lineIndex, line] of contents.split(/\r?\n/u).entries()) {
    const widths = hexWidthsInParserLine(line);
    if (widths.some((entry) => entry.width === 40)) {
      violations.push({
        path: relativePath,
        line: lineIndex + 1,
        rule: 'duplicate-source-sha-parser',
        token: 'lowercase-source-sha-regex',
      });
      continue;
    }
    if (widths.some((entry) => entry.width === 64 && !externalHexTokenPrefix(line, entry.index))) {
      violations.push({
        path: relativePath,
        line: lineIndex + 1,
        rule: 'duplicate-sha256-parser',
        token: 'lowercase-sha256-regex',
      });
    }
  }
  return violations;
}

function implementationCoveredLines(implementations: readonly SemanticImplementation[]): ReadonlySet<number> {
  const lines = new Set<number>();
  for (const implementation of implementations) {
    for (let line = implementation.line; line <= implementation.endLine; line += 1) {
      lines.add(line);
    }
  }
  return lines;
}

function lineWindow(lines: readonly string[], lineIndex: number, before: number, after: number): string {
  return lines.slice(Math.max(0, lineIndex - before), Math.min(lines.length, lineIndex + after + 1)).join('\n');
}

function inlineSemanticViolations(
  relativePath: string,
  contents: string,
  implementations: readonly SemanticImplementation[],
): readonly DeploymentAuthorityBoundaryViolation[] {
  if (isAuthorityOwnerPath(relativePath)) {
    return [];
  }
  const violations: DeploymentAuthorityBoundaryViolation[] = [];
  const lines = contents.split(/\r?\n/u);
  const coveredLines = implementationCoveredLines(implementations);
  let lastInlineVersionIdViolationLine = Number.NEGATIVE_INFINITY;
  for (const [lineIndex, line] of lines.entries()) {
    const lineNumber = lineIndex + 1;
    if (!coveredLines.has(lineNumber)) {
      const localWindow = lineWindow(lines, lineIndex, 8, 6);
      if (
        lineNumber > lastInlineVersionIdViolationLine + 6 &&
        /(?:S3\s+VersionId|versionId|VersionId|version_id|VERSION_ID|s3_object_version)/u.test(line) &&
        !isExternallyDocumentedAwsFieldShape(relativePath, line) &&
        looksLikeS3VersionIdParser(localWindow)
      ) {
        violations.push({
          path: relativePath,
          line: lineNumber,
          rule: 'duplicate-s3-version-id-parser',
          token: 'inline-version-id-validation',
        });
        lastInlineVersionIdViolationLine = lineNumber;
      }
      if (looksLikeImmutableReferenceValidation(line)) {
        violations.push({
          path: relativePath,
          line: lineNumber,
          rule: 'duplicate-immutable-reference',
          token: 'inline-immutable-reference',
        });
      }
      if (looksLikePointerCompareAndSwap(line)) {
        violations.push({
          path: relativePath,
          line: lineNumber,
          rule: 'duplicate-pointer-cas',
          token: 'inline-pointer-cas',
        });
      }
    }
    if (/(?:--if-none-match|IfNoneMatch)/iu.test(line)) {
      const publicationWindow = lineWindow(lines, lineIndex, 8, 80);
      if (looksLikeFirstWriteClassification(publicationWindow)) {
        violations.push({
          path: relativePath,
          line: lineNumber,
          rule: 'duplicate-first-write-classification',
          token: 'conditional-publication',
        });
      }
    }
    if (/(?:--if-match|IfMatch)/u.test(line)) {
      const pointerWindow = lineWindow(lines, lineIndex, 40, 40);
      if (looksLikePointerCompareAndSwap(pointerWindow)) {
        violations.push({
          path: relativePath,
          line: lineNumber,
          rule: 'duplicate-pointer-cas',
          token: 'conditional-pointer-update',
        });
      }
    }
  }
  return violations;
}

function lexicalFunctionViolations(
  relativePath: string,
  contents: string,
): readonly DeploymentAuthorityBoundaryViolation[] {
  const violations: DeploymentAuthorityBoundaryViolation[] = [];
  for (const [lineIndex, line] of contents.split(/\r?\n/u).entries()) {
    const declaration = line.match(LEXICAL_FUNCTION_DECLARATION_PATTERN);
    const name = declaration?.[1] ?? declaration?.[2];
    if (name === undefined) {
      continue;
    }
    if (CONTEXT_RENDERER_NAME_PATTERN.test(name) && !isCanonicalContextRenderer(relativePath, name)) {
      violations.push({
        path: relativePath,
        line: lineIndex + 1,
        rule: 'duplicate-context-renderer',
        token: name,
      });
    }
    if (isGenericImmutableAuthority(name) && !isAuthorityOwnerPath(relativePath)) {
      violations.push({
        path: relativePath,
        line: lineIndex + 1,
        rule: 'duplicate-immutable-authority',
        token: name,
      });
    }
  }
  return violations;
}

function uniqueViolations(
  violations: readonly DeploymentAuthorityBoundaryViolation[],
): readonly DeploymentAuthorityBoundaryViolation[] {
  const seen = new Set<string>();
  return violations.filter((violation) => {
    const key = `${violation.path}\0${violation.line}\0${violation.rule}\0${violation.token ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function prioritizeAuthorityViolations(
  violations: readonly DeploymentAuthorityBoundaryViolation[],
): readonly DeploymentAuthorityBoundaryViolation[] {
  const preferredByLine = new Map<string, DeploymentAuthorityBoundaryViolation>();
  const otherViolations: DeploymentAuthorityBoundaryViolation[] = [];
  const priority = (violation: DeploymentAuthorityBoundaryViolation): number => {
    if (violation.rule === 'alternate-authority-reader') {
      return 3;
    }
    if (violation.rule === 'broad-authority-fallback') {
      return 2;
    }
    if (violation.rule === 'governed-target-reconstruction') {
      return GOVERNED_TARGET_LITERAL_VALUES.includes(violation.token ?? '') ? 1 : 0;
    }
    return -1;
  };
  for (const violation of uniqueViolations(violations)) {
    const violationPriority = priority(violation);
    if (violationPriority === -1) {
      otherViolations.push(violation);
      continue;
    }
    const key = `${violation.path}\0${violation.line}`;
    const existing = preferredByLine.get(key);
    if (existing === undefined || violationPriority > priority(existing)) {
      preferredByLine.set(key, violation);
    }
  }
  return [...otherViolations, ...preferredByLine.values()];
}

export function findDeploymentAuthorityBoundaryViolationsInText(
  relativePath: string,
  contents: string,
): readonly DeploymentAuthorityBoundaryViolation[] {
  const violations: DeploymentAuthorityBoundaryViolation[] = [...lexicalFunctionViolations(relativePath, contents)];
  let semanticImplementations: readonly SemanticImplementation[];
  if (JAVASCRIPT_LIKE_EXTENSIONS.has(path.extname(relativePath)) && !relativePath.endsWith('.d.ts')) {
    const sourceFile = parseSource(relativePath, contents);
    const implementations = implementationFunctions(sourceFile);
    semanticImplementations = semanticImplementationsFromSourceFile(sourceFile, implementations);
    for (const implementation of implementations) {
      const bodyText = nodeText(implementation.body);
      if (isContextRenderer(implementation.name, bodyText)) {
        if (!isCanonicalContextRenderer(relativePath, implementation.name)) {
          violations.push({
            path: relativePath,
            line: sourceLine(implementation.declaration),
            rule: 'duplicate-context-renderer',
            token: implementation.name,
          });
        }
        violations.push(...contextFieldViolations(relativePath, sourceFile, implementation));
      }
      if (isGenericImmutableAuthority(implementation.name) && !isAuthorityOwnerPath(relativePath)) {
        violations.push({
          path: relativePath,
          line: sourceLine(implementation.declaration),
          rule: 'duplicate-immutable-authority',
          token: implementation.name,
        });
      }
    }
    if (isGovernedTargetConsumerPath(relativePath)) {
      violations.push(...codeFallbackViolations(relativePath, sourceFile));
      violations.push(...codeGovernedTargetViolations(relativePath, sourceFile));
      violations.push(
        ...governedTargetLiteralViolations(
          relativePath,
          contents,
          ignoredLiteralLines(sourceFile, semanticImplementations),
        ),
      );
    }
  } else {
    semanticImplementations = lexicalSemanticImplementations(contents);
    if (isGovernedTargetConsumerPath(relativePath)) {
      violations.push(
        ...governedTargetLiteralViolations(
          relativePath,
          contents,
          ignoredLiteralLines(undefined, semanticImplementations),
        ),
      );
    }
  }

  if (isGovernedTargetConsumerPath(relativePath)) {
    for (const implementation of semanticImplementations) {
      violations.push(...semanticImplementationViolations(relativePath, implementation));
    }
    violations.push(...hexParserViolations(relativePath, contents));
    violations.push(...inlineSemanticViolations(relativePath, contents, semanticImplementations));
    violations.push(...lineFallbackViolations(relativePath, contents));
  }
  const fallbackLines = new Set(
    violations.filter((violation) => violation.rule === 'broad-authority-fallback').map((violation) => violation.line),
  );
  if (isGovernedTargetConsumerPath(relativePath)) {
    violations.push(...governedTargetViolations(relativePath, contents, fallbackLines));
  }
  return [...prioritizeAuthorityViolations(violations)].sort(
    (left, right) =>
      left.line - right.line ||
      left.rule.localeCompare(right.rule) ||
      (left.token ?? '').localeCompare(right.token ?? ''),
  );
}

export function isDeploymentAuthorityBoundaryPath(relativePath: string): boolean {
  if (
    relativePath === 'scripts/security/deployment-authority-boundary.ts' ||
    relativePath.endsWith('.d.ts') ||
    TEST_PATH_PATTERN.test(relativePath) ||
    !ACTIVE_EXTENSIONS.has(path.extname(relativePath))
  ) {
    return false;
  }
  if (/^buildspec[^/]*\.ya?ml$/u.test(relativePath)) {
    return true;
  }
  if (isActiveTerraformHclPath(relativePath)) {
    return true;
  }
  if (relativePath.startsWith('packages/') && relativePath.includes('/src/')) {
    return true;
  }
  return ACTIVE_SCRIPT_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function trackedAndUntrackedFiles(repositoryRoot: string): readonly string[] {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error('Unable to enumerate repository files for the deployment authority boundary guard.');
  }
  return result.stdout.split('\0').filter(Boolean);
}

export function findDeploymentAuthorityBoundaryViolations(
  repositoryRoot: string,
): readonly DeploymentAuthorityBoundaryViolation[] {
  const violations: DeploymentAuthorityBoundaryViolation[] = [];
  for (const relativePath of trackedAndUntrackedFiles(repositoryRoot)) {
    if (!isDeploymentAuthorityBoundaryPath(relativePath)) {
      continue;
    }
    const absolutePath = path.join(repositoryRoot, relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }
    violations.push(
      ...findDeploymentAuthorityBoundaryViolationsInText(relativePath, readFileSync(absolutePath, 'utf8')),
    );
  }
  return violations.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule) ||
      (left.token ?? '').localeCompare(right.token ?? ''),
  );
}

function main(): void {
  const violations = findDeploymentAuthorityBoundaryViolations(process.cwd());
  if (violations.length === 0) {
    process.stdout.write('Deployment authority boundary guard passed.\n');
    return;
  }
  for (const violation of violations) {
    process.stderr.write(
      `${violation.path}:${violation.line} ${violation.rule}${violation.token === undefined ? '' : ` ${violation.token}`}\n`,
    );
  }
  process.exitCode = 1;
}

export function isDeploymentAuthorityBoundaryCliEntry(
  moduleUrl: string,
  argumentPath: string | undefined,
  currentWorkingDirectory: string,
): boolean {
  return (
    argumentPath !== undefined && moduleUrl === pathToFileURL(path.resolve(currentWorkingDirectory, argumentPath)).href
  );
}

if (isDeploymentAuthorityBoundaryCliEntry(import.meta.url, process.argv[1], process.cwd())) {
  main();
}
