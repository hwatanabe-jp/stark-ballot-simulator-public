/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const backendSource = readFileSync(new URL('../backend.ts', import.meta.url), 'utf8');

describe('async prover backend guardrails', () => {
  it('does not hard-code legacy generic async prover resource names', () => {
    expect(backendSource).not.toContain('stateMachine:ProverDispatcher');
    expect(backendSource).not.toContain(':ProverWorkQueue');
  });
});
