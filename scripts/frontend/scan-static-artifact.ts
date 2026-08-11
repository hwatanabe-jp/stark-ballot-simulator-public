import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseImageIdMapping } from '@stark-ballot/validation/image-id-mapping';

const DEFAULT_DIST_DIR = 'dist';
const REQUIRED_STABLE_ARTIFACTS = new Set([
  'index.html',
  'imageId-mapping.json',
  'patterns/sayagata.svg',
  'textures/paper-noise.png',
  'textures/stamp-texture.png',
]);
const ALLOWED_ROOT_FILES = new Set(['index.html', 'imageId-mapping.json']);
const ALLOWED_PUBLIC_ASSET_FILES = new Set([
  'patterns/sayagata.svg',
  'textures/paper-noise.png',
  'textures/stamp-texture.png',
]);
const ALLOWED_GENERATED_ASSET_EXTENSIONS = new Set([
  '.css',
  '.gif',
  '.html',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.png',
  '.svg',
  '.txt',
  '.webmanifest',
  '.woff',
  '.woff2',
]);
const DENIED_FILENAMES = new Set(['input.json', 'verification.json', 'included-bitmap.json', 'seen-bitmap.json']);
const MIN_DENIED_ENV_VALUE_LENGTH = 8;
const RETIRED_DEPLOYMENT_ENV_KEYS = [
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_RISC0_IMAGE_ID',
  'EXPECTED_IMAGE_ID',
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
  'NEXT_PUBLIC_TURNSTILE_BYPASS',
  'TURNSTILE_BYPASS',
  'NEXT_PUBLIC_SESSION_CREATE_TURNSTILE_REQUIRED',
  'SESSION_CREATE_TURNSTILE_REQUIRED',
  'TRUSTED_PROXY',
  'NEXT_PUBLIC_USE_MOCK_API',
  'USE_AMPLIFY_DATA',
  'AWS_BRANCH',
  'AMPLIFY_BRANCH',
  'AMPLIFY_DATA_ENDPOINT',
  'AMPLIFY_DATA_API_ID',
  'AMPLIFY_DATA_TTL_SECONDS',
  'AMPLIFY_DATA_VERIFICATION_TTL_SECONDS',
  'ENV_NAME',
  'SESSION_CAPABILITY_TTL_SECONDS',
  'MAX_SESSIONS',
  'FILE_STORE_CACHE_LIMIT',
  'USE_S3',
  'S3_PROOF_BUCKET',
  'S3_PROOF_PREFIX',
  'FINALIZE_ASYNC_MODE',
  'FINALIZE_CALLBACK_MAX_SKEW_MS',
  'FINALIZE_CALLBACK_BODY_LIMIT_BYTES',
  'PROVER_STEP_FUNCTIONS_ENABLED',
  'PROVER_STATE_MACHINE_ARN',
  'PROVER_WORK_QUEUE_ARN',
  'PROVER_WORK_QUEUE_URL',
  'PROVER_LAMBDA_CONCURRENCY',
  'PROVER_PUBLISH_MAX_ATTEMPTS',
  'VOTE_RATE_LIMIT',
  'VOTE_RATE_LIMIT_WINDOW_MS',
  'VOTE_RATE_LIMIT_MAX_BUCKETS',
  'SESSION_CREATE_RATE_LIMIT',
  'SESSION_CREATE_RATE_LIMIT_WINDOW_MS',
  'SESSION_CREATE_RATE_LIMIT_MAX_BUCKETS',
  'FINALIZE_CANCEL_RATE_LIMIT',
  'FINALIZE_CANCEL_RATE_LIMIT_WINDOW_MS',
  'FINALIZE_CANCEL_RATE_LIMIT_MAX_BUCKETS',
  'USE_MOCK_STORE',
  'USE_MOCK_ZKVM',
  'RISC0_DEV_MODE',
  'VERIFIER_SERVICE_BIN',
  'VERIFIER_WORK_DIR',
  'VERIFICATION_WORKER_FUNCTION_NAME',
  'CLI_HEADERS_TIMEOUT_MS',
  'CLI_BODY_TIMEOUT_MS',
  'CLI_FINALIZE_TIMEOUT_MS',
  'TSA_URL',
  'TSA_CERT_URL',
  'DEBUG_FILE_STORE',
  'ALLOW_DEV_MODE_VERIFICATION',
] as const;
const RETIRED_BROWSER_PUBLIC_ENV_KEYS = new Set([
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
  'NEXT_PUBLIC_TURNSTILE_BYPASS',
  'NEXT_PUBLIC_SESSION_CREATE_TURNSTILE_REQUIRED',
  'NEXT_PUBLIC_USE_MOCK_API',
]);
const TARGET_RUNTIME_EXTERNAL_IDENTIFIER_ENV_KEYS = [
  'AWS_ACCOUNT_ID',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'DYNAMODB_SESSIONS_TABLE',
  'DYNAMODB_VOTES_TABLE',
  'RATE_LIMIT_EVENTS_TABLE',
  'RATE_LIMIT_COUNTERS_TABLE',
  'PROVER_WORK_QUEUE_URL',
  'VERIFICATION_WORK_QUEUE_URL',
  'PROVER_STATE_MACHINE_ARN',
  'VERIFICATION_WORKER_FUNCTION_NAME',
  'S3_PROOF_BUCKET',
  'S3_PROOF_PREFIX',
  'VERIFIER_PUBLIC_BASE_URL',
  'EXPECTED_IMAGE_ID',
  'TURNSTILE_ALLOWED_HOSTNAMES',
  'TRUSTED_PROXY',
  'SESSION_CAPABILITY_SECRET_REF',
  'VOTE_SECRET_ENCRYPTION_KEY_REF',
  'SESSION_CAPABILITY_TTL_SECONDS_REF',
  'TURNSTILE_SECRET_KEY_REF',
  'EXPECTED_ORIGIN_VERIFY_HEADER_REF',
  'LOG_IP_HASH_SALT_REF',
] as const;
const SERVER_ONLY_ENV_KEYS = [
  ...new Set([
    ...RETIRED_DEPLOYMENT_ENV_KEYS.filter((key) => !RETIRED_BROWSER_PUBLIC_ENV_KEYS.has(key)),
    ...TARGET_RUNTIME_EXTERNAL_IDENTIFIER_ENV_KEYS,
    'EXPECTED_IMAGE_ID_VARIANT',
    'RATE_LIMIT_STORE',
    'S3_BUNDLE_SIGNED_URL_TTL_SECONDS',
    'S3_SIGNED_URL_TTL_SECONDS',
    'SESSION_CAPABILITY_SECRET',
    'TURNSTILE_SECRET_KEY',
  ]),
];
const SENSITIVE_SERVER_ONLY_ENV_VALUE_KEYS = [
  'FINALIZE_CALLBACK_SECRET',
  'INPUT_S3_BUCKET',
  'OUTPUT_S3_BUCKET',
  'OUTPUT_S3_PREFIX',
  'S3_PROOF_BUCKET',
  'S3_PROOF_PREFIX',
  'SESSION_CAPABILITY_SECRET',
  'TURNSTILE_SECRET_KEY',
  'VOTE_SECRET_ENCRYPTION_KEY',
] as const;
const COMMON_NON_SECRET_ENV_VALUES = new Set([
  '0',
  '1',
  'false',
  'local',
  'none',
  'null',
  'off',
  'on',
  'test',
  'true',
  'undefined',
]);
const DENIED_CONTENT_PATTERNS: Array<{ label: string; pattern: RegExp; allowInLocalMockBypass?: boolean }> = [
  { label: 'private proof artifact filename', pattern: /\b(input|verification|included-bitmap|seen-bitmap)\.json\b/i },
  {
    label: 'session capability material',
    pattern: /SESSION_CAPABILITY_SECRET|test-capability-token|v1\.test\.capability/i,
  },
  {
    label: 'server-only environment key',
    pattern: new RegExp(`\\b(?:${SERVER_ONLY_ENV_KEYS.join('|')})\\b`),
  },
  { label: 'raw S3 locator', pattern: /\bs3:\/\/|S3_PROOF_BUCKET|S3_PROOF_PREFIX/i },
  { label: 'signed URL marker', pattern: /X-Amz-(?:Algorithm|Credential|Expires|Security-Token|Signature)/i },
  { label: 'Next runtime artifact', pattern: /_next\/static|next\/dist/i },
  {
    label: 'mock API fixture or implementation',
    pattern: /stark-ballot-mock-api|mockApiFetch|buildSessionResponse|MockSessionStore|mock vote|mock-random/i,
  },
  { label: 'Turnstile browser bypass token', pattern: /\bturnstile-bypass-token\b/i, allowInLocalMockBypass: true },
  { label: 'test-only Turnstile global override', pattern: /\b__TEST_TURNSTILE__\b/ },
  { label: 'legacy STH browser global override', pattern: /\b__STH_(?:SOURCES|MIN_MATCHES)\b/ },
];
const TARGET_ARTIFACT_DISABLED_FLAGS = [
  'VITE_TURNSTILE_BYPASS',
  'NEXT_PUBLIC_TURNSTILE_BYPASS',
  'VITE_USE_MOCK_API',
  'NEXT_PUBLIC_USE_MOCK_API',
] as const;

type Finding = {
  file: string;
  reason: string;
};

export type StaticArtifactFinding = {
  file: string;
  reason: string;
};

export type StaticArtifactScanResult = {
  files: string[];
  findings: StaticArtifactFinding[];
};

export type StaticArtifactScanOptions = {
  allowLocalMockBypass?: boolean;
};

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listFiles(fullPath);
      }
      return [fullPath];
    }),
  );
  return files.flat();
}

function shouldScanContent(filePath: string): boolean {
  return ['.css', '.html', '.js', '.json', '.map', '.svg', '.txt', '.webmanifest'].includes(path.extname(filePath));
}

function toArtifactPath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function isAllowedArtifactPath(relative: string): boolean {
  if (ALLOWED_ROOT_FILES.has(relative) || ALLOWED_PUBLIC_ASSET_FILES.has(relative)) {
    return true;
  }
  if (!relative.startsWith('assets/')) {
    return false;
  }
  return ALLOWED_GENERATED_ASSET_EXTENSIONS.has(path.extname(relative));
}

function validateImageIdMapping(relative: string, content: string): Finding[] {
  if (relative !== 'imageId-mapping.json') {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return [{ file: relative, reason: 'ImageID mapping must be valid JSON' }];
  }

  let mapping;
  try {
    mapping = parseImageIdMapping(parsed);
  } catch (error) {
    return [
      {
        file: relative,
        reason: `ImageID mapping semantic contract is invalid: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
  const currentMapping = mapping.mappings[mapping.current];
  if (!currentMapping || Object.values(currentMapping.variants).every((variant) => variant.state !== 'confirmed')) {
    return [{ file: relative, reason: 'ImageID mapping current entry has no confirmed ImageID variant' }];
  }

  return [];
}

function shouldDenyEnvironmentValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < MIN_DENIED_ENV_VALUE_LENGTH) {
    return false;
  }
  if (COMMON_NON_SECRET_ENV_VALUES.has(trimmed.toLowerCase())) {
    return false;
  }
  if (/^\d+$/.test(trimmed)) {
    return false;
  }
  return true;
}

function readDeniedEnvironmentValues(): string[] {
  const values = new Set<string>();
  for (const key of SENSITIVE_SERVER_ONLY_ENV_VALUE_KEYS) {
    const value = process.env[key];
    if (value && shouldDenyEnvironmentValue(value)) {
      values.add(value.trim());
    }
  }
  return [...values];
}

async function scanFile(filePath: string, root: string, options: StaticArtifactScanOptions): Promise<Finding[]> {
  const relative = toArtifactPath(root, filePath);
  const findings: Finding[] = [];
  if (!isAllowedArtifactPath(relative)) {
    findings.push({ file: relative, reason: 'unexpected generated frontend artifact' });
  }

  if (DENIED_FILENAMES.has(path.basename(filePath))) {
    findings.push({ file: relative, reason: 'denied private filename' });
  }

  if (path.extname(filePath) === '.map') {
    findings.push({ file: relative, reason: 'source maps are disabled for target production artifacts' });
  }

  if (!shouldScanContent(filePath)) {
    return findings;
  }

  const content = await fs.readFile(filePath, 'utf-8');
  findings.push(...validateImageIdMapping(relative, content));
  for (const { label, pattern, allowInLocalMockBypass } of DENIED_CONTENT_PATTERNS) {
    if (options.allowLocalMockBypass && allowInLocalMockBypass) {
      continue;
    }
    if (pattern.test(content)) {
      findings.push({ file: relative, reason: label });
    }
  }
  for (const deniedValue of readDeniedEnvironmentValues()) {
    if (content.includes(deniedValue)) {
      findings.push({ file: relative, reason: 'server-only environment value' });
    }
  }
  return findings;
}

function scanRequiredArtifacts(files: string[]): Finding[] {
  const present = new Set(files);
  return [...REQUIRED_STABLE_ARTIFACTS]
    .filter((artifact) => !present.has(artifact))
    .map((artifact) => ({ file: artifact, reason: 'required public frontend artifact missing' }));
}

function isTruthyFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function scanBuildEnvironment(options: StaticArtifactScanOptions): Finding[] {
  if (options.allowLocalMockBypass) {
    return [];
  }
  return TARGET_ARTIFACT_DISABLED_FLAGS.filter((key) => isTruthyFlag(process.env[key])).map((key) => ({
    file: '(build environment)',
    reason: `${key} must be disabled for target static artifacts`,
  }));
}

export async function scanStaticArtifact(
  rootDir: string,
  options: StaticArtifactScanOptions = {},
): Promise<StaticArtifactScanResult> {
  const root = path.resolve(rootDir);
  const files = await listFiles(root);
  const artifactFiles = files.map((file) => toArtifactPath(root, file)).sort();
  const findings = [
    ...scanBuildEnvironment(options),
    ...scanRequiredArtifacts(artifactFiles),
    ...(await Promise.all(files.map((file) => scanFile(file, root, options)))).flat(),
  ];
  return { files: artifactFiles, findings };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowLocalMockBypass = args.includes('--allow-local-mock-bypass');
  const distArg = args.find((arg) => !arg.startsWith('--'));
  const root = path.resolve(process.cwd(), distArg ?? DEFAULT_DIST_DIR);
  const result = await scanStaticArtifact(root, { allowLocalMockBypass });
  const { findings } = result;
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`[frontend-artifact-scan] ${finding.file}: ${finding.reason}`);
    }
    throw new Error(`Generated frontend artifact scan failed with ${findings.length} finding(s).`);
  }
  console.log(`[frontend-artifact-scan] scanned ${result.files.length} files under ${root}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
