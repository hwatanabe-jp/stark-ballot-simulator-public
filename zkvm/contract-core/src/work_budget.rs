use crate::types::AggregatorInput;

/// Maximum aggregate number of Merkle path nodes the current guest accepts.
pub const MAX_GUEST_TOTAL_PATH_NODES: usize = 1_000_000;
/// Maximum serialized input payload bytes accepted before proving.
pub const MAX_GUEST_SERIALIZED_INPUT_BYTES: u64 = 64 * 1024 * 1024;
/// Maximum authenticated bulletin tree size accepted by the current guest.
pub const MAX_GUEST_TREE_SIZE: u32 = 1_000_000;
/// Maximum expected vote count accepted by the current guest.
pub const MAX_GUEST_TOTAL_EXPECTED: u32 = MAX_GUEST_TREE_SIZE;
/// Maximum presented record count accepted by the current guest.
pub const MAX_GUEST_VOTE_COUNT: usize = MAX_GUEST_TREE_SIZE as usize;
/// Maximum per-record Merkle path length accepted by input commitment encoding.
pub const MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD: usize = u16::MAX as usize;

const FIXED_INPUT_BYTES: u64 = 16 + 32 + 4 + 32 + 8 + 4 + 32;
const VOTE_FIXED_BYTES: u64 = 32 + 1 + 32 + 4;
const VEC_LEN_BYTES: u64 = 8;
const MERKLE_PATH_NODE_BYTES: u64 = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GuestWorkBudget {
    pub total_path_nodes: usize,
    pub estimated_structural_bytes: u64,
    pub serialized_input_bytes: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GuestWorkBudgetError {
    TreeSizeOutOfBounds {
        actual: u32,
        min: u32,
        max: u32,
    },
    TotalExpectedExceeded {
        actual: u32,
        max: u32,
    },
    VoteCountExceeded {
        actual: usize,
        max: usize,
    },
    MerklePathNodesPerRecordExceeded {
        vote_position: usize,
        actual: usize,
        max: usize,
    },
    TotalPathNodesExceeded {
        actual: usize,
        max: usize,
    },
    SerializedInputBytesExceeded {
        actual: u64,
        max: u64,
    },
    StructuralInputBytesExceeded {
        actual: u64,
        max: u64,
    },
    StructuralInputBytesOverflow,
}

pub fn validate_guest_work_budget(
    input: &AggregatorInput,
    serialized_input_bytes: Option<u64>,
) -> Result<GuestWorkBudget, GuestWorkBudgetError> {
    validate_guest_contract_bounds(input.tree_size, input.total_expected, input.votes.len())?;

    let total_path_nodes = total_path_nodes(input)?;
    if total_path_nodes > MAX_GUEST_TOTAL_PATH_NODES {
        return Err(GuestWorkBudgetError::TotalPathNodesExceeded {
            actual: total_path_nodes,
            max: MAX_GUEST_TOTAL_PATH_NODES,
        });
    }

    if let Some(actual) = serialized_input_bytes {
        if actual > MAX_GUEST_SERIALIZED_INPUT_BYTES {
            return Err(GuestWorkBudgetError::SerializedInputBytesExceeded {
                actual,
                max: MAX_GUEST_SERIALIZED_INPUT_BYTES,
            });
        }
    }

    let estimated_structural_bytes = estimate_structural_input_bytes(input)?;
    if estimated_structural_bytes > MAX_GUEST_SERIALIZED_INPUT_BYTES {
        return Err(GuestWorkBudgetError::StructuralInputBytesExceeded {
            actual: estimated_structural_bytes,
            max: MAX_GUEST_SERIALIZED_INPUT_BYTES,
        });
    }

    Ok(GuestWorkBudget {
        total_path_nodes,
        estimated_structural_bytes,
        serialized_input_bytes,
    })
}

fn validate_guest_contract_bounds(
    tree_size: u32,
    total_expected: u32,
    vote_count: usize,
) -> Result<(), GuestWorkBudgetError> {
    if !(1..=MAX_GUEST_TREE_SIZE).contains(&tree_size) {
        return Err(GuestWorkBudgetError::TreeSizeOutOfBounds {
            actual: tree_size,
            min: 1,
            max: MAX_GUEST_TREE_SIZE,
        });
    }

    if total_expected > MAX_GUEST_TOTAL_EXPECTED {
        return Err(GuestWorkBudgetError::TotalExpectedExceeded {
            actual: total_expected,
            max: MAX_GUEST_TOTAL_EXPECTED,
        });
    }

    if vote_count > MAX_GUEST_VOTE_COUNT {
        return Err(GuestWorkBudgetError::VoteCountExceeded {
            actual: vote_count,
            max: MAX_GUEST_VOTE_COUNT,
        });
    }

    Ok(())
}

fn total_path_nodes(input: &AggregatorInput) -> Result<usize, GuestWorkBudgetError> {
    input
        .votes
        .iter()
        .enumerate()
        .try_fold(0usize, |total, (vote_position, vote)| {
            if vote.merkle_path.len() > MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD {
                return Err(GuestWorkBudgetError::MerklePathNodesPerRecordExceeded {
                    vote_position,
                    actual: vote.merkle_path.len(),
                    max: MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD,
                });
            }

            total.checked_add(vote.merkle_path.len()).ok_or(
                GuestWorkBudgetError::TotalPathNodesExceeded {
                    actual: usize::MAX,
                    max: MAX_GUEST_TOTAL_PATH_NODES,
                },
            )
        })
}

fn estimate_structural_input_bytes(input: &AggregatorInput) -> Result<u64, GuestWorkBudgetError> {
    let vote_count = u64::try_from(input.votes.len())
        .map_err(|_| GuestWorkBudgetError::StructuralInputBytesOverflow)?;
    let path_nodes = u64::try_from(total_path_nodes(input)?)
        .map_err(|_| GuestWorkBudgetError::StructuralInputBytesOverflow)?;

    FIXED_INPUT_BYTES
        .checked_add(VEC_LEN_BYTES)
        .and_then(|value| {
            value.checked_add(vote_count.checked_mul(VOTE_FIXED_BYTES + VEC_LEN_BYTES)?)
        })
        .and_then(|value| value.checked_add(path_nodes.checked_mul(MERKLE_PATH_NODE_BYTES)?))
        .ok_or(GuestWorkBudgetError::StructuralInputBytesOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AggregatorInput, VoteWithProof};
    use alloc::vec;
    use alloc::vec::Vec;

    fn input_with_path_lengths(path_lengths: &[usize]) -> AggregatorInput {
        AggregatorInput {
            election_id: [0u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: 1,
            log_id: [2u8; 32],
            timestamp: 1,
            total_expected: 1,
            election_config_hash: [3u8; 32],
            votes: path_lengths
                .iter()
                .map(|path_len| VoteWithProof {
                    commitment: [4u8; 32],
                    choice: 0,
                    random: [5u8; 32],
                    index: 0,
                    merkle_path: vec![[6u8; 32]; *path_len],
                })
                .collect::<Vec<_>>(),
        }
    }

    #[test]
    fn accepts_maximum_path_node_budget() {
        let vote_count = 50_000;
        let path_len = MAX_GUEST_TOTAL_PATH_NODES / vote_count;
        let input = input_with_path_lengths(&vec![path_len; vote_count]);
        let budget =
            validate_guest_work_budget(&input, Some(MAX_GUEST_SERIALIZED_INPUT_BYTES)).unwrap();

        assert_eq!(budget.total_path_nodes, MAX_GUEST_TOTAL_PATH_NODES);
    }

    #[test]
    fn rejects_over_path_node_budget() {
        let vote_count = 50_000;
        let path_len = (MAX_GUEST_TOTAL_PATH_NODES / vote_count) + 1;
        let input = input_with_path_lengths(&vec![path_len; vote_count]);

        assert_eq!(
            validate_guest_work_budget(&input, None),
            Err(GuestWorkBudgetError::TotalPathNodesExceeded {
                actual: vote_count * path_len,
                max: MAX_GUEST_TOTAL_PATH_NODES
            })
        );
    }

    #[test]
    fn rejects_tree_size_outside_guest_contract_bounds() {
        let mut input = input_with_path_lengths(&[]);
        input.tree_size = 0;

        assert_eq!(
            validate_guest_work_budget(&input, None),
            Err(GuestWorkBudgetError::TreeSizeOutOfBounds {
                actual: 0,
                min: 1,
                max: MAX_GUEST_TREE_SIZE
            })
        );

        input.tree_size = MAX_GUEST_TREE_SIZE + 1;
        assert_eq!(
            validate_guest_work_budget(&input, None),
            Err(GuestWorkBudgetError::TreeSizeOutOfBounds {
                actual: MAX_GUEST_TREE_SIZE + 1,
                min: 1,
                max: MAX_GUEST_TREE_SIZE
            })
        );
    }

    #[test]
    fn rejects_total_expected_above_guest_contract_bound() {
        let mut input = input_with_path_lengths(&[]);
        input.total_expected = MAX_GUEST_TOTAL_EXPECTED + 1;

        assert_eq!(
            validate_guest_work_budget(&input, None),
            Err(GuestWorkBudgetError::TotalExpectedExceeded {
                actual: MAX_GUEST_TOTAL_EXPECTED + 1,
                max: MAX_GUEST_TOTAL_EXPECTED
            })
        );
    }

    #[test]
    fn rejects_vote_count_above_guest_contract_bound() {
        assert_eq!(
            validate_guest_contract_bounds(1, 1, MAX_GUEST_VOTE_COUNT + 1),
            Err(GuestWorkBudgetError::VoteCountExceeded {
                actual: MAX_GUEST_VOTE_COUNT + 1,
                max: MAX_GUEST_VOTE_COUNT
            })
        );
    }

    #[test]
    fn rejects_per_record_path_length_above_input_commitment_encoding_bound() {
        let input = input_with_path_lengths(&[MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD + 1]);

        assert_eq!(
            validate_guest_work_budget(&input, None),
            Err(GuestWorkBudgetError::MerklePathNodesPerRecordExceeded {
                vote_position: 0,
                actual: MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD + 1,
                max: MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD
            })
        );
    }

    #[test]
    fn rejects_over_serialized_byte_budget() {
        let input = input_with_path_lengths(&[]);

        assert_eq!(
            validate_guest_work_budget(&input, Some(MAX_GUEST_SERIALIZED_INPUT_BYTES + 1)),
            Err(GuestWorkBudgetError::SerializedInputBytesExceeded {
                actual: MAX_GUEST_SERIALIZED_INPUT_BYTES + 1,
                max: MAX_GUEST_SERIALIZED_INPUT_BYTES
            })
        );
    }
}
