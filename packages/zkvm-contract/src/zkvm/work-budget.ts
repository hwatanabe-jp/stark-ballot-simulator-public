import type { ZkVMInput } from './types';

export const MAX_GUEST_TOTAL_PATH_NODES = 1_000_000;
export const MAX_GUEST_SERIALIZED_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_GUEST_TREE_SIZE = 1_000_000;
export const MAX_GUEST_TOTAL_EXPECTED = MAX_GUEST_TREE_SIZE;
export const MAX_GUEST_VOTE_COUNT = MAX_GUEST_TREE_SIZE;
export const MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD = 0xffff;

const FIXED_INPUT_BYTES = 16 + 32 + 4 + 32 + 8 + 4 + 32;
const VOTE_FIXED_BYTES = 32 + 1 + 32 + 4;
const VEC_LEN_BYTES = 8;
const MERKLE_PATH_NODE_BYTES = 32;

declare const guestWorkBudgetBrand: unique symbol;

export type TotalPathNodes = number & {
  readonly [guestWorkBudgetBrand]: 'TotalPathNodes';
};

export type SerializedInputBytes = number & {
  readonly [guestWorkBudgetBrand]: 'SerializedInputBytes';
};

export type StructuralInputBytes = number & {
  readonly [guestWorkBudgetBrand]: 'StructuralInputBytes';
};

export interface GuestWorkBudget {
  totalPathNodes: TotalPathNodes;
  structuralInputBytes: StructuralInputBytes;
  serializedInputBytes?: SerializedInputBytes;
}

export function asSerializedInputBytes(value: number): SerializedInputBytes {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('serialized input bytes must be a non-negative safe integer');
  }
  return value as SerializedInputBytes;
}

export function asStructuralInputBytes(value: number): StructuralInputBytes {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('structural input bytes must be a non-negative safe integer');
  }
  return value as StructuralInputBytes;
}

export function calculateTotalPathNodes(input: Pick<ZkVMInput, 'votes'>): TotalPathNodes {
  let total = 0;
  for (const [votePosition, vote] of input.votes.entries()) {
    const pathLength = vote.merklePath.length;
    if (pathLength > MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD) {
      throw new Error(
        `zkVM input votes[${votePosition}] Merkle path length exceeds per-record budget: ${pathLength} > ${MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD}`,
      );
    }
    total += pathLength;
    if (!Number.isSafeInteger(total)) {
      throw new Error('total Merkle path nodes exceed JavaScript safe integer range');
    }
  }
  return total as TotalPathNodes;
}

export function calculateStructuralInputBytes(input: Pick<ZkVMInput, 'votes'>): StructuralInputBytes {
  const totalPathNodes = calculateTotalPathNodes(input);
  const voteCount = input.votes.length;
  const structuralBytes =
    FIXED_INPUT_BYTES +
    VEC_LEN_BYTES +
    voteCount * (VOTE_FIXED_BYTES + VEC_LEN_BYTES) +
    totalPathNodes * MERKLE_PATH_NODE_BYTES;

  return asStructuralInputBytes(structuralBytes);
}

export function validateGuestWorkBudget(
  input: Pick<ZkVMInput, 'treeSize' | 'totalExpected' | 'votes'>,
  options?: { serializedInputBytes?: number },
): GuestWorkBudget {
  if (input.treeSize < 1 || input.treeSize > MAX_GUEST_TREE_SIZE) {
    throw new Error(
      `zkVM input treeSize exceeds guest contract bounds: ${input.treeSize} not in 1..${MAX_GUEST_TREE_SIZE}`,
    );
  }
  if (input.totalExpected > MAX_GUEST_TOTAL_EXPECTED) {
    throw new Error(
      `zkVM input totalExpected exceeds guest contract bound: ${input.totalExpected} > ${MAX_GUEST_TOTAL_EXPECTED}`,
    );
  }
  if (input.votes.length > MAX_GUEST_VOTE_COUNT) {
    throw new Error(
      `zkVM input vote count exceeds guest contract bound: ${input.votes.length} > ${MAX_GUEST_VOTE_COUNT}`,
    );
  }

  const totalPathNodes = calculateTotalPathNodes(input);
  if (totalPathNodes > MAX_GUEST_TOTAL_PATH_NODES) {
    throw new Error(
      `zkVM input exceeds total Merkle path node budget: ${totalPathNodes} > ${MAX_GUEST_TOTAL_PATH_NODES}`,
    );
  }

  const structuralInputBytes = calculateStructuralInputBytes(input);
  if (structuralInputBytes > MAX_GUEST_SERIALIZED_INPUT_BYTES) {
    throw new Error(
      `zkVM input exceeds structural byte budget: ${structuralInputBytes} > ${MAX_GUEST_SERIALIZED_INPUT_BYTES}`,
    );
  }

  const serializedInputBytes =
    options?.serializedInputBytes === undefined ? undefined : asSerializedInputBytes(options.serializedInputBytes);
  if (serializedInputBytes !== undefined && serializedInputBytes > MAX_GUEST_SERIALIZED_INPUT_BYTES) {
    throw new Error(
      `zkVM input exceeds serialized byte budget: ${serializedInputBytes} > ${MAX_GUEST_SERIALIZED_INPUT_BYTES}`,
    );
  }
  if (serializedInputBytes !== undefined && serializedInputBytes < structuralInputBytes) {
    throw new Error(
      `zkVM serialized JSON byte count must dominate structural byte estimate: ${serializedInputBytes} < ${structuralInputBytes}`,
    );
  }

  return {
    totalPathNodes,
    structuralInputBytes,
    ...(serializedInputBytes !== undefined ? { serializedInputBytes } : {}),
  };
}
