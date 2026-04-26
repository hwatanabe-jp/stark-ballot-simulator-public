import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RFC6962MerkleTree } from '@/lib/merkle/rfc6962-merkle-tree';
import { computeCommitment } from '@/lib/zkvm/types';
import { normalizeHexString } from '@/lib/utils/hex';

interface FixtureVote {
  commitment: number[];
  choice: number;
  random: number[];
  index: number;
  merkle_path: number[][];
}

interface ZkvmFixture {
  election_id: number[];
  bulletin_root: number[];
  tree_size: number;
  votes: FixtureVote[];
}

function fixturePath(fileName: string): string {
  return path.resolve(process.cwd(), 'zkvm', 'test-data', fileName);
}

function loadFixture(fileName: string): ZkvmFixture {
  return JSON.parse(readFileSync(fixturePath(fileName), 'utf-8')) as ZkvmFixture;
}

function toHex(bytes: number[]): string {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

function toUuid(bytes: number[]): string {
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

describe('checked-in zkVM fixtures', () => {
  it('keeps test-fixture-valid.json aligned with the current commitment and CT Merkle implementations', () => {
    const fixture = loadFixture('test-fixture-valid.json');
    const electionId = toUuid(fixture.election_id);
    const tree = new RFC6962MerkleTree();

    for (const vote of fixture.votes) {
      const expectedCommitment = computeCommitment(electionId, vote.choice, toHex(vote.random));
      expect(normalizeHexString(toHex(vote.commitment))).toBe(normalizeHexString(expectedCommitment));

      tree.append(toHex(vote.commitment));
    }

    expect(normalizeHexString(toHex(fixture.bulletin_root))).toBe(normalizeHexString(tree.getRoot()));

    for (const vote of fixture.votes) {
      const proof = tree.getInclusionProof(vote.index, fixture.tree_size);
      const expectedNodes = vote.merkle_path.map((node) => normalizeHexString(toHex(node)));
      const actualNodes = proof.proofNodes.map((node) => normalizeHexString(node));
      expect(actualNodes).toEqual(expectedNodes);
    }
  });
});
