use alloc::{vec, vec::Vec};
use contract_core::{
    compute_bitmap_merkle_root, compute_commitment, compute_input_commitment_v4,
    compute_root_from_proof, verify_inclusion_proof_rfc6962, AggregatorInput, VoteWithProof,
};
use proptest::prelude::*;
use sha2::{Digest, Sha256};

use crate::tally::{verify_and_tally_checked, GuestVoteInspection};

#[derive(Clone, Copy, Debug)]
enum GeneratedRecordKind {
    Correct,
    InvalidChoice,
    InvalidCommitment,
    InvalidProof,
}

#[derive(Clone, Copy, Debug)]
struct GeneratedRecord {
    index: u32,
    kind: GeneratedRecordKind,
}

#[derive(Clone, Debug)]
struct AccountingCase {
    election_id: [u8; 16],
    slot_choices: Vec<u8>,
    slot_randoms: Vec<[u8; 32]>,
    records: Vec<GeneratedRecord>,
}

#[derive(Debug)]
struct ExpectedAccounting {
    verified_tally: [u32; 5],
    total_votes: u32,
    valid_votes: u32,
    invalid_votes: u32,
    seen_indices_count: u32,
    missing_slots: u32,
    invalid_presented_slots: u32,
    rejected_records: u32,
    excluded_slots: u32,
    seen_bitmap: Vec<bool>,
    included_bitmap: Vec<bool>,
}

fn vote_strategy() -> impl Strategy<Value = VoteWithProof> {
    (
        prop::array::uniform32(any::<u8>()),
        0u8..=4,
        prop::array::uniform32(any::<u8>()),
        0u32..8,
        prop::collection::vec(prop::array::uniform32(any::<u8>()), 0..4),
    )
        .prop_map(
            |(commitment, choice, random, index, merkle_path)| VoteWithProof {
                commitment,
                choice,
                random,
                index,
                merkle_path,
            },
        )
}

fn duplicate_index_votes_strategy() -> impl Strategy<Value = Vec<VoteWithProof>> {
    (0u32..4, prop::collection::vec(vote_strategy(), 2..8)).prop_map(|(shared_index, mut votes)| {
        for vote in &mut votes {
            vote.index = shared_index;
        }
        votes
    })
}

fn reordered_votes_strategy(
    vote_strategy: impl Strategy<Value = Vec<VoteWithProof>>,
) -> impl Strategy<Value = (Vec<VoteWithProof>, Vec<VoteWithProof>)> {
    vote_strategy
        .prop_flat_map(|votes| {
            let len = votes.len();
            (Just(votes), prop::collection::vec(any::<u16>(), len))
        })
        .prop_map(|(votes, keys)| {
            let mut keyed_votes: Vec<(u16, usize, VoteWithProof)> = votes
                .iter()
                .cloned()
                .enumerate()
                .map(|(index, vote)| (keys[index], index, vote))
                .collect();
            keyed_votes.sort_by_key(|(key, index, _)| (*key, *index));

            let reordered = keyed_votes
                .into_iter()
                .map(|(_, _, vote)| vote)
                .collect::<Vec<_>>();

            (votes, reordered)
        })
}

fn leaf_case_strategy() -> impl Strategy<Value = (Vec<[u8; 32]>, usize)> {
    prop::collection::vec(prop::array::uniform32(any::<u8>()), 1..12).prop_flat_map(|leaves| {
        let len = leaves.len();
        (Just(leaves), 0..len)
    })
}

fn bitmap_strategy(len: core::ops::Range<usize>) -> impl Strategy<Value = Vec<bool>> {
    prop::collection::vec(any::<bool>(), len)
}

fn generated_record_kind_strategy() -> impl Strategy<Value = GeneratedRecordKind> {
    prop_oneof![
        Just(GeneratedRecordKind::Correct),
        Just(GeneratedRecordKind::InvalidChoice),
        Just(GeneratedRecordKind::InvalidCommitment),
        Just(GeneratedRecordKind::InvalidProof),
    ]
}

fn accounting_case_strategy() -> impl Strategy<Value = AccountingCase> {
    (prop::array::uniform16(any::<u8>()), 1usize..12).prop_flat_map(|(election_id, tree_size)| {
        let max_index = tree_size as u32 + 3;
        (
            Just(election_id),
            prop::collection::vec(0u8..5, tree_size),
            prop::collection::vec(prop::array::uniform32(0u8..6), tree_size),
            prop::collection::vec(
                (0..max_index, generated_record_kind_strategy())
                    .prop_map(|(index, kind)| GeneratedRecord { index, kind }),
                0..24,
            ),
        )
            .prop_map(|(election_id, slot_choices, slot_randoms, records)| {
                AccountingCase {
                    election_id,
                    slot_choices,
                    slot_randoms,
                    records,
                }
            })
    })
}

fn duplicate_index_order_case_strategy() -> impl Strategy<Value = AccountingCase> {
    (prop::array::uniform16(any::<u8>()), 1usize..12).prop_flat_map(|(election_id, tree_size)| {
        (
            Just(election_id),
            prop::collection::vec(0u8..5, tree_size),
            prop::collection::vec(prop::array::uniform32(any::<u8>()), tree_size),
            0..tree_size as u32,
        )
            .prop_map(
                |(election_id, slot_choices, slot_randoms, duplicate_index)| AccountingCase {
                    election_id,
                    slot_choices,
                    slot_randoms,
                    records: vec![
                        GeneratedRecord {
                            index: duplicate_index,
                            kind: GeneratedRecordKind::Correct,
                        },
                        GeneratedRecord {
                            index: duplicate_index,
                            kind: GeneratedRecordKind::InvalidChoice,
                        },
                    ],
                },
            )
    })
}

fn flip_first_bit(value: &[u8; 32]) -> [u8; 32] {
    let mut mutated = *value;
    mutated[0] ^= 0x01;
    mutated
}

fn reference_hash_leaf(data: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update([0x00]);
    hasher.update(b"stark-ballot:leaf|v1");
    hasher.update(data);

    let digest = hasher.finalize();
    let mut result = [0u8; 32];
    result.copy_from_slice(&digest);
    result
}

fn reference_hash_internal(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update([0x01]);
    hasher.update(left);
    hasher.update(right);

    let digest = hasher.finalize();
    let mut result = [0u8; 32];
    result.copy_from_slice(&digest);
    result
}

fn reference_merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.len() == 1 {
        return leaves[0];
    }

    let mut current_level = leaves.to_vec();
    while current_level.len() > 1 {
        let mut next_level = Vec::with_capacity(current_level.len().div_ceil(2));
        let mut chunks = current_level.chunks_exact(2);

        for pair in &mut chunks {
            next_level.push(reference_hash_internal(&pair[0], &pair[1]));
        }

        if let Some(remaining) = chunks.remainder().first() {
            next_level.push(*remaining);
        }

        current_level = next_level;
    }

    current_level[0]
}

fn build_reference_audit_path(leaves: &[[u8; 32]], leaf_index: usize) -> (Vec<[u8; 32]>, [u8; 32]) {
    let mut current_level = leaves
        .iter()
        .map(reference_hash_leaf)
        .collect::<Vec<[u8; 32]>>();
    let mut current_index = leaf_index;
    let mut audit_path = Vec::new();

    while current_level.len() > 1 {
        if current_index % 2 == 1 {
            audit_path.push(current_level[current_index - 1]);
        } else if current_index + 1 < current_level.len() {
            audit_path.push(current_level[current_index + 1]);
        }

        let mut next_level = Vec::with_capacity(current_level.len().div_ceil(2));
        let mut chunks = current_level.chunks_exact(2);

        for pair in &mut chunks {
            next_level.push(reference_hash_internal(&pair[0], &pair[1]));
        }

        if let Some(remaining) = chunks.remainder().first() {
            next_level.push(*remaining);
        }

        current_level = next_level;
        current_index /= 2;
    }

    (audit_path, current_level[0])
}

fn slot_commitments(case: &AccountingCase) -> Vec<[u8; 32]> {
    case.slot_choices
        .iter()
        .zip(case.slot_randoms.iter())
        .map(|(choice, random)| compute_commitment(&case.election_id, *choice, random))
        .collect()
}

fn tampered_audit_path(path: &[[u8; 32]]) -> Vec<[u8; 32]> {
    if path.is_empty() {
        return vec![[0xA5; 32]];
    }

    let mut tampered = path.to_vec();
    tampered[0] = flip_first_bit(&tampered[0]);
    tampered
}

fn build_accounting_input(case: &AccountingCase) -> AggregatorInput {
    let commitments = slot_commitments(case);
    let audit_paths = commitments
        .iter()
        .enumerate()
        .map(|(index, _)| build_reference_audit_path(&commitments, index).0)
        .collect::<Vec<_>>();
    let bulletin_root = reference_merkle_root(
        &commitments
            .iter()
            .map(reference_hash_leaf)
            .collect::<Vec<_>>(),
    );

    let votes = case
        .records
        .iter()
        .map(|record| {
            let in_range_index = (record.index as usize) < case.slot_choices.len();
            if !in_range_index {
                return VoteWithProof {
                    commitment: [0xFE; 32],
                    choice: 0,
                    random: [0xFD; 32],
                    index: record.index,
                    merkle_path: Vec::new(),
                };
            }

            let slot_index = record.index as usize;
            let choice = case.slot_choices[slot_index];
            let random = case.slot_randoms[slot_index];
            let commitment = commitments[slot_index];
            let merkle_path = audit_paths[slot_index].clone();

            match record.kind {
                GeneratedRecordKind::Correct => VoteWithProof {
                    commitment,
                    choice,
                    random,
                    index: record.index,
                    merkle_path,
                },
                GeneratedRecordKind::InvalidChoice => VoteWithProof {
                    commitment,
                    choice: 5,
                    random,
                    index: record.index,
                    merkle_path,
                },
                GeneratedRecordKind::InvalidCommitment => VoteWithProof {
                    commitment: flip_first_bit(&commitment),
                    choice,
                    random,
                    index: record.index,
                    merkle_path,
                },
                GeneratedRecordKind::InvalidProof => VoteWithProof {
                    commitment,
                    choice,
                    random,
                    index: record.index,
                    merkle_path: tampered_audit_path(&merkle_path),
                },
            }
        })
        .collect();

    AggregatorInput {
        election_id: case.election_id,
        bulletin_root,
        tree_size: case.slot_choices.len() as u32,
        log_id: [0x21; 32],
        timestamp: 1_234_567_890_000,
        total_expected: case.slot_choices.len() as u32,
        election_config_hash: [0x34; 32],
        votes,
    }
}

fn expected_accounting(case: &AccountingCase) -> ExpectedAccounting {
    let tree_size = case.slot_choices.len();
    let mut verified_tally = [0u32; 5];
    let mut seen_bitmap = vec![false; tree_size];
    let mut included_bitmap = vec![false; tree_size];
    let mut seen_commitments: Vec<[u8; 32]> = Vec::new();
    let mut valid_votes = 0u32;
    let mut invalid_votes = 0u32;
    let mut seen_indices_count = 0u32;

    for record in &case.records {
        if record.index as usize >= tree_size {
            invalid_votes += 1;
            continue;
        }

        let index = record.index as usize;
        if seen_bitmap[index] {
            invalid_votes += 1;
            continue;
        }

        seen_bitmap[index] = true;
        seen_indices_count += 1;

        if matches!(record.kind, GeneratedRecordKind::InvalidChoice) {
            invalid_votes += 1;
            continue;
        }

        let choice = case.slot_choices[index];
        let random = case.slot_randoms[index];
        let computed_commitment = compute_commitment(&case.election_id, choice, &random);

        if matches!(record.kind, GeneratedRecordKind::InvalidCommitment) {
            invalid_votes += 1;
            continue;
        }

        match seen_commitments.binary_search(&computed_commitment) {
            Ok(_) => {
                invalid_votes += 1;
                continue;
            }
            Err(pos) => seen_commitments.insert(pos, computed_commitment),
        };

        if matches!(record.kind, GeneratedRecordKind::InvalidProof) {
            invalid_votes += 1;
            continue;
        }

        verified_tally[choice as usize] += 1;
        included_bitmap[index] = true;
        valid_votes += 1;
    }

    let total_votes = case.records.len() as u32;
    let missing_slots = tree_size as u32 - seen_indices_count;
    let invalid_presented_slots = seen_indices_count - valid_votes;
    let excluded_slots = missing_slots + invalid_presented_slots;

    ExpectedAccounting {
        verified_tally,
        total_votes,
        valid_votes,
        invalid_votes,
        seen_indices_count,
        missing_slots,
        invalid_presented_slots,
        rejected_records: invalid_votes,
        excluded_slots,
        seen_bitmap,
        included_bitmap,
    }
}

fn assert_current_accounting_invariants(
    output: &contract_core::VerificationOutput,
    expected: &ExpectedAccounting,
) -> Result<(), TestCaseError> {
    prop_assert_eq!(output.verified_tally, expected.verified_tally);
    prop_assert_eq!(output.total_votes, expected.total_votes);
    prop_assert_eq!(output.valid_votes, expected.valid_votes);
    prop_assert_eq!(output.invalid_votes, expected.invalid_votes);
    prop_assert_eq!(output.seen_indices_count, expected.seen_indices_count);
    prop_assert_eq!(output.missing_slots, expected.missing_slots);
    prop_assert_eq!(
        output.invalid_presented_slots,
        expected.invalid_presented_slots
    );
    prop_assert_eq!(output.rejected_records, expected.rejected_records);
    prop_assert_eq!(output.excluded_slots, expected.excluded_slots);
    prop_assert_eq!(
        output.seen_bitmap_root,
        compute_bitmap_merkle_root(&expected.seen_bitmap)
    );
    prop_assert_eq!(
        output.included_bitmap_root,
        compute_bitmap_merkle_root(&expected.included_bitmap)
    );

    prop_assert_eq!(
        output.total_votes,
        output
            .valid_votes
            .checked_add(output.invalid_votes)
            .expect("small generated counts should not overflow")
    );
    prop_assert_eq!(
        output.verified_tally.iter().sum::<u32>(),
        output.valid_votes
    );
    prop_assert_eq!(
        output.tree_size,
        output
            .seen_indices_count
            .checked_add(output.missing_slots)
            .expect("small generated counts should not overflow")
    );
    prop_assert_eq!(
        output.excluded_slots,
        output
            .missing_slots
            .checked_add(output.invalid_presented_slots)
            .expect("small generated counts should not overflow")
    );
    prop_assert_eq!(
        output.invalid_presented_slots,
        output
            .seen_indices_count
            .checked_sub(output.valid_votes)
            .expect("valid votes must be a subset of seen slots")
    );
    prop_assert_eq!(output.rejected_records, output.invalid_votes);

    for (included, seen) in expected
        .included_bitmap
        .iter()
        .zip(expected.seen_bitmap.iter())
    {
        prop_assert!(!*included || *seen);
    }

    Ok(())
}

fn reference_pack_bits(bits: &[bool]) -> Vec<u8> {
    let mut bytes = vec![0u8; bits.len().div_ceil(8)];

    for (bit_index, bit) in bits.iter().enumerate() {
        if *bit {
            bytes[bit_index / 8] |= 1 << (bit_index % 8);
        }
    }

    bytes
}

fn reference_bitmap_root(bits: &[bool]) -> [u8; 32] {
    let packed = reference_pack_bits(bits);

    if packed.len() <= 32 {
        let mut padded = [0u8; 32];
        padded[..packed.len()].copy_from_slice(&packed);
        return reference_hash_leaf(&padded);
    }

    let leaves = packed
        .chunks(32)
        .map(|chunk| {
            let mut padded = [0u8; 32];
            padded[..chunk.len()].copy_from_slice(chunk);
            reference_hash_leaf(&padded)
        })
        .collect::<Vec<_>>();

    reference_merkle_root(&leaves)
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 32,
        .. ProptestConfig::default()
    })]

    #[test]
    fn property_input_commitment_is_permutation_invariant(
        election_id in prop::array::uniform16(any::<u8>()),
        bulletin_root in prop::array::uniform32(any::<u8>()),
        tree_size in any::<u32>(),
        total_expected in any::<u32>(),
        (votes, reordered) in reordered_votes_strategy(prop::collection::vec(vote_strategy(), 0..8)),
    ) {
        let expected = compute_input_commitment_v4(
            &election_id,
            &bulletin_root,
            tree_size,
            total_expected,
            &votes,
        ).expect("generated input commitment should encode");

        let actual = compute_input_commitment_v4(
            &election_id,
            &bulletin_root,
            tree_size,
            total_expected,
            &reordered,
        ).expect("generated input commitment should encode");

        prop_assert_eq!(actual, expected);
    }

    #[test]
    fn property_input_commitment_duplicate_index_tie_break_is_permutation_invariant(
        election_id in prop::array::uniform16(any::<u8>()),
        bulletin_root in prop::array::uniform32(any::<u8>()),
        tree_size in any::<u32>(),
        total_expected in any::<u32>(),
        (votes, reordered) in reordered_votes_strategy(duplicate_index_votes_strategy()),
    ) {
        let expected = compute_input_commitment_v4(
            &election_id,
            &bulletin_root,
            tree_size,
            total_expected,
            &votes,
        ).expect("generated input commitment should encode");

        let actual = compute_input_commitment_v4(
            &election_id,
            &bulletin_root,
            tree_size,
            total_expected,
            &reordered,
        ).expect("generated input commitment should encode");

        prop_assert_eq!(actual, expected);
    }

    #[test]
    fn property_rfc6962_inclusion_proof_round_trips_against_reference_tree(
        (leaves, leaf_index) in leaf_case_strategy(),
    ) {
        let (audit_path, root) = build_reference_audit_path(&leaves, leaf_index);
        let tree_size = leaves.len() as u32;
        let leaf = leaves[leaf_index];

        let recomputed = compute_root_from_proof(&leaf, leaf_index as u32, &audit_path, tree_size);
        prop_assert_eq!(recomputed, root);
        prop_assert!(verify_inclusion_proof_rfc6962(
            &leaf,
            leaf_index as u32,
            &audit_path,
            &root,
            tree_size,
        ));
    }

    #[test]
    fn property_rfc6962_inclusion_proof_rejects_tampered_material(
        (leaves, leaf_index) in leaf_case_strategy(),
    ) {
        let (audit_path, root) = build_reference_audit_path(&leaves, leaf_index);
        let tree_size = leaves.len() as u32;
        let leaf = leaves[leaf_index];
        let tampered_root = flip_first_bit(&root);

        prop_assert!(!verify_inclusion_proof_rfc6962(
            &leaf,
            leaf_index as u32,
            &audit_path,
            &tampered_root,
            tree_size,
        ));

        if audit_path.is_empty() {
            let tampered_leaf = flip_first_bit(&leaf);
            prop_assert!(!verify_inclusion_proof_rfc6962(
                &tampered_leaf,
                leaf_index as u32,
                &audit_path,
                &root,
                tree_size,
            ));
        } else {
            let mut tampered_path = audit_path.clone();
            tampered_path[0] = flip_first_bit(&tampered_path[0]);
            prop_assert!(!verify_inclusion_proof_rfc6962(
                &leaf,
                leaf_index as u32,
                &tampered_path,
                &root,
                tree_size,
            ));
        }
    }

    #[test]
    fn property_bitmap_root_matches_reference_oracle(
        bitmap in bitmap_strategy(0..1281),
    ) {
        let expected = reference_bitmap_root(&bitmap);
        let actual = compute_bitmap_merkle_root(&bitmap);

        prop_assert_eq!(actual, expected);
    }

    #[test]
    fn property_bitmap_root_changes_when_a_bit_flips(
        (mut bitmap, bit_index) in bitmap_strategy(1..1281).prop_flat_map(|bitmap| {
            let len = bitmap.len();
            (Just(bitmap), 0..len)
        }),
    ) {
        let expected = compute_bitmap_merkle_root(&bitmap);
        bitmap[bit_index] = !bitmap[bit_index];
        let actual = compute_bitmap_merkle_root(&bitmap);

        prop_assert_ne!(actual, expected);
    }

    #[test]
    fn property_verify_and_tally_accounting_matches_current_semantics(
        case in accounting_case_strategy(),
    ) {
        let input = build_accounting_input(&case);
        let expected = expected_accounting(&case);
        let inspection = verify_and_tally_checked(&input)
            .expect("generated accounting input should satisfy guest structural bounds");

        assert_current_accounting_invariants(&inspection.output, &expected)?;
        prop_assert_eq!(inspection.included_bitmap, expected.included_bitmap);
        prop_assert_eq!(
            inspection.vote_outcomes.len() as u32,
            inspection.output.total_votes
        );
        prop_assert_eq!(
            inspection
                .vote_outcomes
                .iter()
                .filter(|outcome| matches!(outcome, GuestVoteInspection::Accepted))
                .count() as u32,
            inspection.output.valid_votes
        );
    }

    #[test]
    fn property_duplicate_index_order_semantics_are_pinned(
        mut case in duplicate_index_order_case_strategy(),
    ) {
        let duplicate_index = case.records[0].index;

        let valid_first_input = build_accounting_input(&case);
        let valid_first_expected = expected_accounting(&case);
        let valid_first = verify_and_tally_checked(&valid_first_input)
            .expect("valid-first duplicate input should satisfy guest structural bounds");

        case.records.reverse();
        let invalid_first_input = build_accounting_input(&case);
        let invalid_first_expected = expected_accounting(&case);
        let invalid_first = verify_and_tally_checked(&invalid_first_input)
            .expect("invalid-first duplicate input should satisfy guest structural bounds");

        assert_current_accounting_invariants(&valid_first.output, &valid_first_expected)?;
        assert_current_accounting_invariants(&invalid_first.output, &invalid_first_expected)?;

        prop_assert_eq!(valid_first.output.valid_votes, 1);
        prop_assert_eq!(valid_first.output.invalid_votes, 1);
        prop_assert_eq!(valid_first.output.invalid_presented_slots, 0);
        prop_assert_eq!(valid_first.output.rejected_records, 1);
        prop_assert_eq!(valid_first.included_bitmap[duplicate_index as usize], true);

        prop_assert_eq!(invalid_first.output.valid_votes, 0);
        prop_assert_eq!(invalid_first.output.invalid_votes, 2);
        prop_assert_eq!(invalid_first.output.invalid_presented_slots, 1);
        prop_assert_eq!(invalid_first.output.rejected_records, 2);
        prop_assert_eq!(invalid_first.included_bitmap[duplicate_index as usize], false);
    }
}
