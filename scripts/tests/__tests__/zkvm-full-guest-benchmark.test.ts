import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSerializedBenchmarkInput, parseBenchmarkArgs, summarizeMeasurements } from '../zkvm-full-guest-benchmark';

describe('zkvm full guest benchmark harness', () => {
  it('builds a validated 64-slot full-guest host input by default', () => {
    const input = buildSerializedBenchmarkInput(64);

    expect(input['tree_size']).toBe(64);
    expect(input['total_expected']).toBe(64);
    expect(Array.isArray(input['votes'])).toBe(true);
    expect(input['votes']).toHaveLength(64);
  });

  it('parses benchmark options with explicit full-guest defaults', () => {
    const cwd = '/repo';
    const options = parseBenchmarkArgs(
      ['--iterations', '3', '--slots=64', '--host-bin', 'zkvm/target/release/host'],
      cwd,
    );

    expect(options).toMatchObject({
      hostBin: path.resolve(cwd, 'zkvm/target/release/host'),
      iterations: 3,
      slots: 64,
      keepArtifacts: false,
    });
  });

  it('rejects invalid iteration counts before starting proof work', () => {
    expect(() => parseBenchmarkArgs(['--iterations', '0'])).toThrow(/Invalid iterations/);
    expect(() => parseBenchmarkArgs(['--slots', '1.5'])).toThrow(/Invalid slots/);
  });

  it('summarizes repeated timing measurements for median and tail latency', () => {
    expect(summarizeMeasurements([30, 10, 20, 40])).toEqual({
      iterations: 4,
      median: 25,
      p95: 40,
      max: 40,
    });
  });
});
