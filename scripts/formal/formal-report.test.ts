import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFormalReport, type FormalReport } from './formal-report-admission';

const REPORT_PATH = path.resolve(process.cwd(), 'docs/formal/formal-report.json');

function readFormalReport(): FormalReport {
  const input: unknown = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
  return parseFormalReport(input);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mapByUniqueName<T extends { name: string }>(entries: readonly T[], label: string): Map<string, T> {
  const byName = new Map<string, T>();
  for (const entry of entries) {
    expect(byName.has(entry.name), `${label} duplicate ${entry.name}`).toBe(false);
    byName.set(entry.name, entry);
  }
  return byName;
}

describe('formal-report.json', () => {
  it('rejects unknown report fields', () => {
    const report = readFormalReport();
    expect(() => parseFormalReport({ ...report, compatibilityMarker: 'retired' })).toThrow(/exactly/u);
  });

  it('keeps the stable formal report schema inspectable', () => {
    const report = readFormalReport();

    expect(report.schema).toBe('stark-ballot:formal-report|v1');
    expect(report.reportKind).toBe('stable');
    expect(report.generatedVectorEnvelopeType).toBe('stark-ballot.formal-vector.current');
    expect(report.leanToolchain).toMatch(/^leanprover\/lean4:v\d+\.\d+\.\d+$/);
    expect('generatedAt' in report).toBe(false);
    expect('repoCommit' in report).toBe(false);
    expect(report.modelModules).toContain('formal/StarkBallotFormal/GuestModel.lean');
    expect(report.formalAuditArtifact).toBe('docs/formal/formal-audit.json');
    expect(existsSync(path.resolve(process.cwd(), report.formalAuditArtifact))).toBe(true);
  });

  it('reports the guest-model claims and boundaries', () => {
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

  it('reports the candidate tally bound as a proved consequence of the guest input bounds', () => {
    const report = readFormalReport();
    const noOverflowClaim = report.theorems.find((theorem) => theorem.name === 'no_overflow_under_guest_bounds');

    expect(noOverflowClaim?.claim).toBe(
      'under explicit guest tree-size and vote-count input bounds of 1,000,000, modeled seen, valid, rejected, and candidate tally bucket counts remain inside the Rust u32 domain, and each candidate tally bucket is proved <= 1,000,000',
    );
    expect(report.assumptions).toContain(
      'Rust bounded-counter correspondence is scoped to the explicit guest input bounds treeSize <= 1,000,000 and vote count <= 1,000,000; under those bounds, Lean proves each candidate tally bucket <= 1,000,000',
    );
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

    expect(report.generatedVectorArtifacts).toEqual([
      {
        path: 'docs/formal/generated-vectors/verification-summary-cases.json',
        kind: 'verification-summary-cases',
      },
      {
        path: 'docs/formal/generated-vectors/verification-display-cases.json',
        kind: 'verification-display-cases',
      },
      { path: 'docs/formal/generated-vectors/check-definitions.json', kind: 'check-definitions' },
      {
        path: 'docs/formal/generated-vectors/input-commitment-cases.json',
        kind: 'input-commitment-cases',
      },
      { path: 'docs/formal/generated-vectors/bitmap-cases.json', kind: 'bitmap-cases' },
      { path: 'docs/formal/generated-vectors/guest-model-cases.json', kind: 'guest-model-cases' },
    ]);
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
    expect(audit.generatedVectorArtifacts.map((entry) => entry.path)).toEqual(
      report.generatedVectorArtifacts.map((entry) => entry.path),
    );
    expect(audit.generatedVectorArtifacts.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
  });
});
