use contract_core::{
    compute_bitmap_merkle_root, compute_input_commitment_v4, compute_root_from_proof,
    verify_inclusion_proof_rfc6962, VoteWithProof,
};
use proptest::prelude::*;
use sha2::{Digest, Sha256};

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
        );

        let actual = compute_input_commitment_v4(
            &election_id,
            &bulletin_root,
            tree_size,
            total_expected,
            &reordered,
        );

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
        );

        let actual = compute_input_commitment_v4(
            &election_id,
            &bulletin_root,
            tree_size,
            total_expected,
            &reordered,
        );

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
        bitmap in bitmap_strategy(0..260),
    ) {
        let expected = reference_bitmap_root(&bitmap);
        let actual = compute_bitmap_merkle_root(&bitmap);

        prop_assert_eq!(actual, expected);
    }

    #[test]
    fn property_bitmap_root_changes_when_a_bit_flips(
        (mut bitmap, bit_index) in bitmap_strategy(1..260).prop_flat_map(|bitmap| {
            let len = bitmap.len();
            (Just(bitmap), 0..len)
        }),
    ) {
        let expected = compute_bitmap_merkle_root(&bitmap);
        bitmap[bit_index] = !bitmap[bit_index];
        let actual = compute_bitmap_merkle_root(&bitmap);

        prop_assert_ne!(actual, expected);
    }
}
