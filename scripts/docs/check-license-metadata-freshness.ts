#!/usr/bin/env tsx

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonObject = Record<string, unknown>;

type CargoMetadataPackage = {
  name: string;
  version: string;
  license: string | null;
};

type PnpmMetadataPackage = {
  name: string;
  versions: string[];
  license: string;
};

type PnpmLockPackages = {
  all: Set<string>;
  required: Set<string>;
  directProduction: Set<string>;
};

const CARGO_LANES = [
  {
    label: 'zkVM Cargo metadata',
    lockPath: 'zkvm/Cargo.lock',
    jsonPath: 'docs/licenses/cargo-metadata-zkvm.json',
    csvPath: 'docs/licenses/cargo-licenses-zkvm.csv',
  },
  {
    label: 'verifier Cargo metadata',
    lockPath: 'verifier-service/Cargo.lock',
    jsonPath: 'docs/licenses/cargo-metadata-verifier.json',
    csvPath: 'docs/licenses/cargo-licenses-verifier.csv',
  },
] as const;

const PNPM_PATHS = {
  lock: 'pnpm-lock.yaml',
  allJson: 'docs/licenses/pnpm-licenses-all.json',
  allCsv: 'docs/licenses/pnpm-licenses-all.csv',
  prodJson: 'docs/licenses/pnpm-licenses-prod.json',
  prodCsv: 'docs/licenses/pnpm-licenses-prod.csv',
} as const;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readRepoFile(repoRoot: string, relativePath: string): string {
  try {
    return readFileSync(path.join(repoRoot, relativePath), 'utf8');
  } catch (error: unknown) {
    throw new Error(`cannot read ${relativePath}: ${describeError(error)}`);
  }
}

function readJsonFile(repoRoot: string, relativePath: string): unknown {
  const content = readRepoFile(repoRoot, relativePath);
  try {
    return JSON.parse(content) as unknown;
  } catch (error: unknown) {
    throw new Error(`${relativePath} is not valid JSON: ${describeError(error)}`);
  }
}

function parseTomlString(value: string, location: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'string' || parsed.length === 0) {
      throw new Error('expected a non-empty string');
    }
    return parsed;
  } catch (error: unknown) {
    throw new Error(`${location} must be a TOML basic string: ${describeError(error)}`);
  }
}

function packageIdentity(name: string, version: string): string {
  return `${name}@${version}`;
}

function parseCargoLock(content: string, relativePath: string): Set<string> {
  const packages = new Set<string>();
  let inPackage = false;
  let packageName: string | undefined;
  let packageVersion: string | undefined;

  const finishPackage = (lineNumber: number): void => {
    if (!inPackage) {
      return;
    }
    if (packageName === undefined || packageVersion === undefined) {
      throw new Error(`${relativePath}:${lineNumber}: package entry is missing name or version`);
    }
    packages.add(packageIdentity(packageName, packageVersion));
  };

  const lines = content.replaceAll('\r\n', '\n').split('\n');
  for (const [index, line] of lines.entries()) {
    if (line === '[[package]]') {
      finishPackage(index + 1);
      inPackage = true;
      packageName = undefined;
      packageVersion = undefined;
      continue;
    }
    if (!inPackage) {
      continue;
    }

    const field = /^(name|version)\s*=\s*(.+)$/.exec(line);
    if (!field) {
      continue;
    }
    const value = parseTomlString(field[2] ?? '', `${relativePath}:${index + 1}`);
    if (field[1] === 'name') {
      if (packageName !== undefined) {
        throw new Error(`${relativePath}:${index + 1}: duplicate package name`);
      }
      packageName = value;
    } else {
      if (packageVersion !== undefined) {
        throw new Error(`${relativePath}:${index + 1}: duplicate package version`);
      }
      packageVersion = value;
    }
  }
  finishPackage(lines.length);

  if (packages.size === 0) {
    throw new Error(`${relativePath} contains no package entries`);
  }
  return packages;
}

function parseCargoMetadata(value: unknown, relativePath: string): CargoMetadataPackage[] {
  if (!isJsonObject(value) || !Array.isArray(value['packages'])) {
    throw new Error(`${relativePath}.packages must be an array`);
  }

  return value['packages'].map((entry: unknown, index: number): CargoMetadataPackage => {
    const location = `${relativePath}.packages[${index}]`;
    if (!isJsonObject(entry)) {
      throw new Error(`${location} must be an object`);
    }
    if (typeof entry['name'] !== 'string' || entry['name'].length === 0) {
      throw new Error(`${location}.name must be a non-empty string`);
    }
    if (typeof entry['version'] !== 'string' || entry['version'].length === 0) {
      throw new Error(`${location}.version must be a non-empty string`);
    }
    if (entry['license'] !== null && typeof entry['license'] !== 'string') {
      throw new Error(`${location}.license must be a string or null`);
    }
    return {
      name: entry['name'],
      version: entry['version'],
      license: entry['license'],
    };
  });
}

function parseCsv(content: string, relativePath: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: 'unquoted' | 'quoted' | 'after-quote' = 'unquoted';

  const finishField = (): void => {
    row.push(field);
    field = '';
    state = 'unquoted';
  };
  const finishRow = (): void => {
    finishField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? '';
    if (state === 'quoted') {
      if (character === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          state = 'after-quote';
        }
      } else {
        field += character;
      }
      continue;
    }

    if (state === 'after-quote') {
      if (character === ',') {
        finishField();
      } else if (character === '\n') {
        finishRow();
      } else if (character !== '\r') {
        throw new Error(`${relativePath}: unexpected character after closing quote`);
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      state = 'quoted';
    } else if (character === ',') {
      finishField();
    } else if (character === '\n') {
      finishRow();
    } else if (character !== '\r') {
      field += character;
    }
  }

  if (state === 'quoted') {
    throw new Error(`${relativePath}: unterminated quoted field`);
  }
  if (field.length > 0 || row.length > 0) {
    finishRow();
  }
  return rows;
}

function parseCsvRecords(content: string, relativePath: string, expectedHeader: readonly string[]): string[][] {
  const rows = parseCsv(content, relativePath);
  const header = rows.shift();
  if (header === undefined || header.join('\0') !== expectedHeader.join('\0')) {
    throw new Error(`${relativePath} must start with header ${expectedHeader.join(',')}`);
  }
  for (const [index, row] of rows.entries()) {
    if (row.length !== expectedHeader.length) {
      throw new Error(`${relativePath}:${index + 2}: expected ${expectedHeader.length} columns, found ${row.length}`);
    }
  }
  return rows;
}

function sortedDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

function formatPackageMismatch(
  artifactPath: string,
  sourcePath: string,
  direction: 'missing' | 'unexpected',
  packages: readonly string[],
): string {
  return `${artifactPath} is stale relative to ${sourcePath}; ${direction} ${packages.length} package(s):\n${packages
    .map((identity) => `  ${identity}`)
    .join('\n')}`;
}

function formatRecordMismatch(
  csvPath: string,
  jsonPath: string,
  direction: 'missing' | 'unexpected',
  records: readonly string[],
): string {
  return `${csvPath} does not match ${jsonPath}; ${direction} ${records.length} record(s):\n${records
    .map((record) => `  ${record}`)
    .join('\n')}`;
}

function cargoJsonRecords(packages: readonly CargoMetadataPackage[]): Set<string> {
  return new Set(
    packages.map(({ name, version, license }) => `${packageIdentity(name, version)}\t${license ?? 'UNKNOWN'}`),
  );
}

function cargoCsvRecords(content: string, relativePath: string): Set<string> {
  const rows = parseCsvRecords(content, relativePath, ['name', 'version', 'license']);
  return new Set(
    rows.map(([name, version, license], index) => {
      if (!name || !version || !license) {
        throw new Error(`${relativePath}:${index + 2}: name, version, and license must be non-empty`);
      }
      return `${packageIdentity(name, version)}\t${license}`;
    }),
  );
}

function auditCargoLane(repoRoot: string, lane: (typeof CARGO_LANES)[number]): string[] {
  const findings: string[] = [];
  const lockPackages = parseCargoLock(readRepoFile(repoRoot, lane.lockPath), lane.lockPath);
  const metadata = parseCargoMetadata(readJsonFile(repoRoot, lane.jsonPath), lane.jsonPath);
  const metadataPackages = new Set(metadata.map(({ name, version }) => packageIdentity(name, version)));

  const missing = sortedDifference(lockPackages, metadataPackages);
  if (missing.length > 0) {
    findings.push(formatPackageMismatch(lane.jsonPath, lane.lockPath, 'missing', missing));
  }
  const unexpected = sortedDifference(metadataPackages, lockPackages);
  if (unexpected.length > 0) {
    findings.push(formatPackageMismatch(lane.jsonPath, lane.lockPath, 'unexpected', unexpected));
  }

  const jsonRecords = cargoJsonRecords(metadata);
  const csvRecords = cargoCsvRecords(readRepoFile(repoRoot, lane.csvPath), lane.csvPath);
  const csvMissing = sortedDifference(jsonRecords, csvRecords);
  if (csvMissing.length > 0) {
    findings.push(formatRecordMismatch(lane.csvPath, lane.jsonPath, 'missing', csvMissing));
  }
  const csvUnexpected = sortedDifference(csvRecords, jsonRecords);
  if (csvUnexpected.length > 0) {
    findings.push(formatRecordMismatch(lane.csvPath, lane.jsonPath, 'unexpected', csvUnexpected));
  }

  return findings;
}

function decodeYamlScalar(value: string, location: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      throw new Error(`${location}: malformed single-quoted YAML scalar`);
    }
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed !== 'string') {
        throw new Error('expected a string');
      }
      return parsed;
    } catch (error: unknown) {
      throw new Error(`${location}: malformed double-quoted YAML scalar: ${describeError(error)}`);
    }
  }
  return trimmed;
}

function normalizePnpmPackageKey(rawKey: string, location: string): string {
  const decoded = decodeYamlScalar(rawKey, location);
  const peerContextStart = decoded.indexOf('(');
  const packageKey = peerContextStart === -1 ? decoded : decoded.slice(0, peerContextStart);
  const separator = packageKey.lastIndexOf('@');
  if (separator <= 0 || separator === packageKey.length - 1) {
    throw new Error(`${location}: unsupported pnpm package key ${decoded}`);
  }
  return packageIdentity(packageKey.slice(0, separator), packageKey.slice(separator + 1));
}

function extractYamlSection(content: string, sectionName: string, nextSectionName?: string): string {
  const startMarker = `${sectionName}:\n`;
  const start = content.indexOf(startMarker);
  if (start === -1 || (start > 0 && content[start - 1] !== '\n')) {
    throw new Error(`pnpm-lock.yaml is missing ${sectionName}: section`);
  }
  const contentStart = start + startMarker.length;
  if (nextSectionName === undefined) {
    return content.slice(contentStart);
  }
  const endMarker = `\n${nextSectionName}:\n`;
  const end = content.indexOf(endMarker, contentStart);
  if (end === -1) {
    throw new Error(`pnpm-lock.yaml is missing ${nextSectionName}: section`);
  }
  return content.slice(contentStart, end);
}

function parsePnpmPackageEntries(section: string, sectionName: string): Set<string> {
  const packages = new Set<string>();
  for (const [index, line] of section.split('\n').entries()) {
    const entry = /^ {2}(\S.*?):(?: \{\})?\s*$/.exec(line);
    if (entry) {
      packages.add(normalizePnpmPackageKey(entry[1] ?? '', `pnpm-lock.yaml ${sectionName}:${index + 1}`));
    }
  }
  if (packages.size === 0) {
    throw new Error(`pnpm-lock.yaml ${sectionName}: section contains no package entries`);
  }
  return packages;
}

function parseRequiredPnpmPackages(section: string): Set<string> {
  const requiredVariants = new Map<string, boolean>();
  let currentIdentity: string | undefined;
  let currentOptional = false;

  const finishEntry = (): void => {
    if (currentIdentity === undefined) {
      return;
    }
    const previouslyRequired = requiredVariants.get(currentIdentity) ?? false;
    requiredVariants.set(currentIdentity, previouslyRequired || !currentOptional);
  };

  for (const [index, line] of section.split('\n').entries()) {
    const entry = /^ {2}(\S.*?):(?: \{\})?\s*$/.exec(line);
    if (entry) {
      finishEntry();
      currentIdentity = normalizePnpmPackageKey(entry[1] ?? '', `pnpm-lock.yaml snapshots:${index + 1}`);
      currentOptional = false;
    } else if (currentIdentity !== undefined && line === '    optional: true') {
      currentOptional = true;
    }
  }
  finishEntry();

  return new Set(
    [...requiredVariants.entries()]
      .filter(([, hasRequiredVariant]) => hasRequiredVariant)
      .map(([identity]) => identity),
  );
}

function resolvedPnpmDependencyIdentity(name: string, rawVersion: string, location: string): string | undefined {
  const decodedVersion = decodeYamlScalar(rawVersion, location);
  if (
    decodedVersion.startsWith('link:') ||
    decodedVersion.startsWith('workspace:') ||
    decodedVersion.startsWith('file:')
  ) {
    return undefined;
  }
  const peerContextStart = decodedVersion.indexOf('(');
  const version = peerContextStart === -1 ? decodedVersion : decodedVersion.slice(0, peerContextStart);
  if (version.length === 0 || version.includes(':')) {
    throw new Error(`${location}: unsupported resolved pnpm version ${decodedVersion}`);
  }
  return packageIdentity(name, version);
}

function parseDirectProductionPnpmPackages(importersSection: string): Set<string> {
  const packages = new Set<string>();
  let inProductionDependencies = false;
  let dependencyName: string | undefined;

  for (const [index, line] of importersSection.split('\n').entries()) {
    if (/^ {2}\S.*:\s*$/.test(line)) {
      inProductionDependencies = false;
      dependencyName = undefined;
      continue;
    }

    const dependencyGroup = /^ {4}(\S[^:]*):\s*$/.exec(line);
    if (dependencyGroup) {
      const groupName = dependencyGroup[1] ?? '';
      inProductionDependencies = groupName === 'dependencies' || groupName === 'optionalDependencies';
      dependencyName = undefined;
      continue;
    }
    if (!inProductionDependencies) {
      continue;
    }

    const dependency = /^ {6}(\S.*):\s*$/.exec(line);
    if (dependency) {
      dependencyName = decodeYamlScalar(dependency[1] ?? '', `pnpm-lock.yaml importers:${index + 1}`);
      continue;
    }

    const version = /^ {8}version:\s+(.+)$/.exec(line);
    if (version && dependencyName !== undefined) {
      const identity = resolvedPnpmDependencyIdentity(
        dependencyName,
        version[1] ?? '',
        `pnpm-lock.yaml importers:${index + 1}`,
      );
      if (identity !== undefined) {
        packages.add(identity);
      }
      dependencyName = undefined;
    }
  }
  return packages;
}

function parsePnpmLock(content: string): PnpmLockPackages {
  const normalized = content.replaceAll('\r\n', '\n');
  const importersSection = extractYamlSection(normalized, 'importers', 'packages');
  const packagesSection = extractYamlSection(normalized, 'packages', 'snapshots');
  const snapshotsSection = extractYamlSection(normalized, 'snapshots');
  const all = parsePnpmPackageEntries(packagesSection, 'packages');
  const required = parseRequiredPnpmPackages(snapshotsSection);

  const snapshotOnly = sortedDifference(required, all);
  if (snapshotOnly.length > 0) {
    throw new Error(`pnpm-lock.yaml snapshots contain package(s) absent from packages: ${snapshotOnly.join(', ')}`);
  }

  return {
    all,
    required,
    directProduction: parseDirectProductionPnpmPackages(importersSection),
  };
}

function parsePnpmMetadata(value: unknown, relativePath: string): PnpmMetadataPackage[] {
  if (!isJsonObject(value)) {
    throw new Error(`${relativePath} must be an object grouped by license`);
  }

  const packages: PnpmMetadataPackage[] = [];
  const identities = new Set<string>();
  for (const [licenseGroup, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) {
      throw new Error(`${relativePath}.${licenseGroup} must be an array`);
    }
    for (const [index, entry] of entries.entries()) {
      const location = `${relativePath}.${licenseGroup}[${index}]`;
      if (!isJsonObject(entry)) {
        throw new Error(`${location} must be an object`);
      }
      if (typeof entry['name'] !== 'string' || entry['name'].length === 0) {
        throw new Error(`${location}.name must be a non-empty string`);
      }
      if (
        !Array.isArray(entry['versions']) ||
        entry['versions'].length === 0 ||
        entry['versions'].some((version: unknown) => typeof version !== 'string' || version.length === 0)
      ) {
        throw new Error(`${location}.versions must be a non-empty string array`);
      }
      if (typeof entry['license'] !== 'string' || entry['license'] !== licenseGroup) {
        throw new Error(`${location}.license must equal its ${licenseGroup} license group`);
      }

      const name = entry['name'];
      const versions = entry['versions'].map((version: unknown) => {
        if (typeof version !== 'string') {
          throw new Error(`${location}.versions must contain only strings`);
        }
        const identity = packageIdentity(name, version);
        if (identities.has(identity)) {
          throw new Error(`${relativePath} contains duplicate package ${identity}`);
        }
        identities.add(identity);
        return version;
      });
      packages.push({ name, versions, license: entry['license'] });
    }
  }
  if (packages.length === 0) {
    throw new Error(`${relativePath} contains no package entries`);
  }
  return packages;
}

function pnpmPackageIdentities(packages: readonly PnpmMetadataPackage[]): Set<string> {
  return new Set(packages.flatMap(({ name, versions }) => versions.map((version) => packageIdentity(name, version))));
}

function pnpmJsonRecords(packages: readonly PnpmMetadataPackage[]): Set<string> {
  return new Set(
    packages.flatMap(({ name, versions, license }) =>
      versions.map((version) => `${packageIdentity(name, version)}\t${license}`),
    ),
  );
}

function pnpmCsvRecords(content: string, relativePath: string): Set<string> {
  const rows = parseCsvRecords(content, relativePath, ['name', 'versions', 'license']);
  const records = new Set<string>();
  for (const [index, [name, versionsValue, license]] of rows.entries()) {
    if (!name || !versionsValue || !license) {
      throw new Error(`${relativePath}:${index + 2}: name, versions, and license must be non-empty`);
    }
    for (const version of versionsValue.split(',')) {
      if (version.length === 0) {
        throw new Error(`${relativePath}:${index + 2}: versions must not contain an empty value`);
      }
      records.add(`${packageIdentity(name, version)}\t${license}`);
    }
  }
  return records;
}

function comparePnpmCsv(
  repoRoot: string,
  jsonPath: string,
  csvPath: string,
  packages: readonly PnpmMetadataPackage[],
): string[] {
  const findings: string[] = [];
  const jsonRecords = pnpmJsonRecords(packages);
  const csvRecords = pnpmCsvRecords(readRepoFile(repoRoot, csvPath), csvPath);
  const missing = sortedDifference(jsonRecords, csvRecords);
  if (missing.length > 0) {
    findings.push(formatRecordMismatch(csvPath, jsonPath, 'missing', missing));
  }
  const unexpected = sortedDifference(csvRecords, jsonRecords);
  if (unexpected.length > 0) {
    findings.push(formatRecordMismatch(csvPath, jsonPath, 'unexpected', unexpected));
  }
  return findings;
}

function auditPnpmMetadata(repoRoot: string): string[] {
  const findings: string[] = [];
  const lock = parsePnpmLock(readRepoFile(repoRoot, PNPM_PATHS.lock));
  const allMetadata = parsePnpmMetadata(readJsonFile(repoRoot, PNPM_PATHS.allJson), PNPM_PATHS.allJson);
  const prodMetadata = parsePnpmMetadata(readJsonFile(repoRoot, PNPM_PATHS.prodJson), PNPM_PATHS.prodJson);
  const allPackages = pnpmPackageIdentities(allMetadata);
  const prodPackages = pnpmPackageIdentities(prodMetadata);

  const missingRequired = sortedDifference(lock.required, allPackages);
  if (missingRequired.length > 0) {
    findings.push(formatPackageMismatch(PNPM_PATHS.allJson, PNPM_PATHS.lock, 'missing', missingRequired));
  }
  const absentFromLock = sortedDifference(allPackages, lock.all);
  if (absentFromLock.length > 0) {
    findings.push(formatPackageMismatch(PNPM_PATHS.allJson, PNPM_PATHS.lock, 'unexpected', absentFromLock));
  }
  const prodMissingDirect = sortedDifference(lock.directProduction, prodPackages);
  if (prodMissingDirect.length > 0) {
    findings.push(formatPackageMismatch(PNPM_PATHS.prodJson, PNPM_PATHS.lock, 'missing', prodMissingDirect));
  }
  const prodAbsentFromAll = sortedDifference(prodPackages, allPackages);
  if (prodAbsentFromAll.length > 0) {
    findings.push(formatPackageMismatch(PNPM_PATHS.prodJson, PNPM_PATHS.allJson, 'unexpected', prodAbsentFromAll));
  }

  findings.push(...comparePnpmCsv(repoRoot, PNPM_PATHS.allJson, PNPM_PATHS.allCsv, allMetadata));
  findings.push(...comparePnpmCsv(repoRoot, PNPM_PATHS.prodJson, PNPM_PATHS.prodCsv, prodMetadata));
  return findings;
}

function auditSafely(label: string, audit: () => string[]): string[] {
  try {
    return audit();
  } catch (error: unknown) {
    return [`${label}: ${describeError(error)}`];
  }
}

export function checkLicenseMetadataFreshness(repoRoot: string): string[] {
  const resolvedRoot = path.resolve(repoRoot);
  return [
    ...CARGO_LANES.flatMap((lane) => auditSafely(lane.label, () => auditCargoLane(resolvedRoot, lane))),
    ...auditSafely('pnpm license metadata', () => auditPnpmMetadata(resolvedRoot)),
  ];
}

export function formatLicenseMetadataFindings(findings: readonly string[]): string {
  if (findings.length === 0) {
    return 'License metadata is fresh.';
  }
  return [
    `License metadata freshness check failed with ${findings.length} issue(s):`,
    ...findings.map((finding) => `- ${finding}`),
    'Run `pnpm licenses:regen` and commit the regenerated docs/licenses artifacts.',
  ].join('\n');
}

function main(): number {
  const findings = checkLicenseMetadataFreshness(process.cwd());
  const message = formatLicenseMetadataFindings(findings);
  if (findings.length > 0) {
    console.error(message);
    return 1;
  }
  console.log(message);
  return 0;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href) {
  process.exitCode = main();
}
