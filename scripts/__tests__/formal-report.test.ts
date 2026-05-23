/**
 * @vitest-environment node
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPORT_PATH = path.resolve(process.cwd(), 'docs/current/formal/formal-report.json');

type FormalReport = {
  schema: string;
  leanToolchain: string;
  reportKind: string;
  modelModules: string[];
  theorems: Array<{
    name: string;
    source: string;
    claim: string;
  }>;
  generatedVectorArtifacts: string[];
  formalAuditArtifact: string;
  assumptions: string[];
  nonClaims: string[];
  generatedAt?: string;
  repoCommit?: string;
};

function readFormalReport(): FormalReport {
  return JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as FormalReport;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mapByUniqueName<T extends { name: string }>(entries: T[], label: string): Map<string, T> {
  const byName = new Map<string, T>();
  for (const entry of entries) {
    expect(byName.has(entry.name), `${label} duplicate ${entry.name}`).toBe(false);
    byName.set(entry.name, entry);
  }
  return byName;
}

describe('formal-report.json', () => {
  it('keeps the stable formal report schema inspectable', () => {
    const report = readFormalReport();

    expect(report.schema).toBe('stark-ballot:formal-report|v1');
    expect(report.reportKind).toBe('stable');
    expect(report.leanToolchain).toMatch(/^leanprover\/lean4:v\d+\.\d+\.\d+$/);
    expect(report.generatedAt).toBeUndefined();
    expect(report.repoCommit).toBeUndefined();
    expect(report.modelModules).toContain('formal/StarkBallotFormal/GuestModel.lean');
    expect(report.formalAuditArtifact).toBe('docs/current/formal/formal-audit.json');
    expect(existsSync(path.resolve(process.cwd(), report.formalAuditArtifact))).toBe(true);
  });

  it('reports the phase 3 guest-model claims and boundaries', () => {
    const report = readFormalReport();
    const theoremNames = report.theorems.map((theorem) => theorem.name);

    expect(theoremNames).toEqual(
      expect.arrayContaining([
        'accepted_votes_count_tally',
        'acceptVote_increments_selected_candidate',
        'valid_votes_count_accepted',
        'rejected_records_classification',
        'processVotes_fold_invariant',
        'processVotes_seen_indices_length_le_treeSize',
        'zero_exclusion_guest_model_complete',
        'no_overflow_under_guest_bounds',
      ]),
    );
    expect(report.assumptions).toContain(
      'The guest model is an abstract state machine over presented records, not a direct Rust verification',
    );
    expect(report.nonClaims).toContain('Lean does not prove SHA-256 collision resistance');
    expect(report.nonClaims).toContain('Lean does not prove production-election security');
  });

  it('keeps reported theorem names tied to Lean declarations', () => {
    const report = readFormalReport();

    for (const theorem of report.theorems) {
      const sourcePath = path.resolve(process.cwd(), theorem.source);
      expect(existsSync(sourcePath), theorem.source).toBe(true);

      const sourceText = readFileSync(sourcePath, 'utf8');
      expect(sourceText, theorem.name).toMatch(new RegExp(`\\btheorem\\s+${escapeRegExp(theorem.name)}\\b`));
    }
  });

  it('reports all generated vector artifacts and audit hashes for freshness review', () => {
    const report = readFormalReport();
    const audit = JSON.parse(readFileSync(path.resolve(process.cwd(), report.formalAuditArtifact), 'utf8')) as {
      schema: string;
      theoremStatements: Array<{ name: string; statementSha256: string }>;
      theoremDependencies: Array<{
        name: string;
        qualifiedName: string;
        coreAxiomDependencies: string[];
        nativeDecideAxiomCount: number;
        nativeDecideAxiomSha256: string | null;
        dependencySetSha256: string;
      }>;
      generatedVectorArtifacts: Array<{ path: string; sha256: string }>;
    };

    expect(audit.schema).toBe('stark-ballot:formal-audit|v1');
    const reportTheoremsByName = mapByUniqueName(report.theorems, 'report theorem');
    const statementsByName = mapByUniqueName(audit.theoremStatements, 'audit theorem statement');
    const dependenciesByName = mapByUniqueName(audit.theoremDependencies, 'audit theorem dependency');

    expect(report.generatedVectorArtifacts).toEqual(
      expect.arrayContaining([
        'docs/current/formal/generated-vectors/check-definitions.json',
        'docs/current/formal/generated-vectors/guest-model-cases.json',
      ]),
    );
    expect([...statementsByName.keys()].sort()).toEqual([...reportTheoremsByName.keys()].sort());
    expect([...dependenciesByName.keys()].sort()).toEqual([...reportTheoremsByName.keys()].sort());
    expect(audit.theoremStatements.every((entry) => /^[a-f0-9]{64}$/.test(entry.statementSha256))).toBe(true);
    expect(audit.theoremDependencies.every((entry) => entry.qualifiedName.startsWith('StarkBallotFormal.'))).toBe(true);
    expect(audit.theoremDependencies.every((entry) => /^[a-f0-9]{64}$/.test(entry.dependencySetSha256))).toBe(true);
    expect(
      audit.theoremDependencies.every((entry) =>
        entry.coreAxiomDependencies.every((axiom) => ['Classical.choice', 'Quot.sound', 'propext'].includes(axiom)),
      ),
    ).toBe(true);
    expect(audit.theoremDependencies.find((entry) => entry.name === 'pack_bits_get_bit')?.nativeDecideAxiomCount).toBe(
      2048,
    );
    expect(audit.generatedVectorArtifacts.map((entry) => entry.path)).toEqual(report.generatedVectorArtifacts);
    expect(audit.generatedVectorArtifacts.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
  });
});
