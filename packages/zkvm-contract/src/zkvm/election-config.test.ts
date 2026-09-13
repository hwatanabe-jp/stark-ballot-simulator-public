import { describe, expect, it } from 'vitest';
import { buildDefaultElectionConfig, hashElectionConfig } from './election-config';

describe('election configuration hashing', () => {
  it('preserves the reviewed default configuration digest', () => {
    expect(hashElectionConfig(buildDefaultElectionConfig())).toBe(
      '0x5ec60925929f78d3cc3cdf73a71913ffc0cf02c1a5d8106bd9a2750dbc10e1fe',
    );
  });

  it('hashes the UTF-8 JSON representation', () => {
    expect(
      hashElectionConfig({
        totalExpected: 2,
        choices: ['青', '白'],
        version: '試験',
        botCount: 1,
        merkleTreeDepth: 1,
      }),
    ).toBe('0x8b07a1305207675f54636b43675874c833157da0d3ce366034110c331ae650ad');
  });
});
