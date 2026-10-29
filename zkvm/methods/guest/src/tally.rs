extern crate alloc;

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;
use contract_core::{
    compute_bitmap_merkle_root, compute_commitment, compute_input_commitment_v4,
    validate_guest_work_budget, verify_inclusion_proof_rfc6962, AggregatorInput, BulletinRoot,
    ElectionConfigHash, ElectionId16, IncludedBitmapRoot, InputCommitment, LogId, Randomness32,
    SeenBitmapRoot, SthDigest, TotalExpected, TreeSize, UnixTimestampMillis, VerificationOutput,
    VoteCommitment, VoteCount, VoteWithProof, CURRENT_METHOD_VERSION,
    MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD, MAX_GUEST_TREE_SIZE, MAX_GUEST_VOTE_COUNT,
};

use crate::sth::compute_sth_digest;

/// Maximum value any candidate tally bucket may reach under accepted guest inputs.
pub const MAX_FORMAL_GUEST_TALLY_BUCKET: u32 = MAX_GUEST_TREE_SIZE;

struct ValidatedAggregatorInput<'a> {
    raw: &'a AggregatorInput,
    election_id: ElectionId16,
    bulletin_root: BulletinRoot,
    tree_size: TreeSize,
    log_id: LogId,
    timestamp: UnixTimestampMillis,
    total_expected: TotalExpected,
    election_config_hash: ElectionConfigHash,
    votes: Vec<ValidatedVoteRecord<'a>>,
}

#[derive(Clone, Copy)]
struct ValidatedVoteRecord<'a> {
    raw: &'a VoteWithProof,
    commitment: VoteCommitment,
    random: Randomness32,
}

impl<'a> ValidatedAggregatorInput<'a> {
    fn validate(input: &'a AggregatorInput) -> Result<Self, String> {
        let election_id = ElectionId16::new(input.election_id);
        let bulletin_root = BulletinRoot::new(input.bulletin_root)
            .map_err(|_| "Invalid bulletin root".to_string())?;
        let tree_size = validate_tree_size(input.tree_size)?;
        let log_id = LogId::new(input.log_id);
        let timestamp = UnixTimestampMillis::new(input.timestamp)
            .map_err(|_| "Timestamp must be positive Unix timestamp milliseconds".to_string())?;
        let total_expected = validate_total_expected(input.total_expected)?;
        let election_config_hash = ElectionConfigHash::new(input.election_config_hash);

        if input.votes.len() > MAX_GUEST_VOTE_COUNT {
            return Err(format!(
                "Vote count exceeds guest bound of {}",
                MAX_GUEST_VOTE_COUNT
            ));
        }

        VoteCount::new(input.votes.len())
            .map_err(|_| "Vote count exceeds u32 journal encoding".to_string())?;

        if input
            .votes
            .iter()
            .any(|vote| vote.merkle_path.len() > MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD)
        {
            return Err("Merkle path length exceeds u16 input commitment encoding".to_string());
        }

        validate_guest_work_budget(input, None)
            .map_err(|error| format!("Guest work budget exceeded: {error:?}"))?;

        let votes = input.votes.iter().map(ValidatedVoteRecord::new).collect();

        Ok(Self {
            raw: input,
            election_id,
            bulletin_root,
            tree_size,
            log_id,
            timestamp,
            total_expected,
            election_config_hash,
            votes,
        })
    }
}

impl<'a> ValidatedVoteRecord<'a> {
    fn new(raw: &'a VoteWithProof) -> Self {
        Self {
            raw,
            commitment: VoteCommitment::new(raw.commitment),
            random: Randomness32::new(raw.random),
        }
    }

    fn choice(&self) -> u8 {
        self.raw.choice
    }

    fn index(&self) -> u32 {
        self.raw.index
    }

    fn merkle_path(&self) -> &[[u8; 32]] {
        &self.raw.merkle_path
    }
}

fn validate_tree_size(value: u32) -> Result<TreeSize, String> {
    let tree_size = TreeSize::new(value).map_err(|_| "Tree size cannot be zero".to_string())?;
    if tree_size.get() > MAX_GUEST_TREE_SIZE {
        return Err(format!(
            "Tree size exceeds guest bound of {}",
            MAX_GUEST_TREE_SIZE
        ));
    }
    Ok(tree_size)
}

fn validate_total_expected(value: u32) -> Result<TotalExpected, String> {
    if value > MAX_GUEST_TREE_SIZE {
        return Err(format!(
            "Total expected exceeds guest bound of {}",
            MAX_GUEST_TREE_SIZE
        ));
    }
    Ok(TotalExpected::new(value))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RejectionReason {
    OutOfRangeIndex,
    DuplicateIndex,
    InvalidChoice,
    InvalidCommitment,
    DuplicateCommitment,
    InvalidInclusionProof,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GuestVoteInspection {
    Accepted,
    Rejected {
        reason: RejectionReason,
        slot_seen: bool,
        commitment_reserved: bool,
    },
}

#[derive(Clone, Debug)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct GuestTallyInspection {
    pub output: VerificationOutput,
    pub vote_outcomes: Vec<GuestVoteInspection>,
    pub included_bitmap: Vec<bool>,
}

struct GuestTallyArtifacts {
    output: VerificationOutput,
    #[cfg_attr(not(test), allow(dead_code))]
    included_bitmap: Vec<bool>,
}

struct AccountingSummary {
    missing_slots: u32,
    invalid_presented_slots: u32,
    rejected_records: u32,
    excluded_slots: u32,
}

struct VerificationOutputConstruction<'a> {
    election_id: ElectionId16,
    election_config_hash: ElectionConfigHash,
    bulletin_root: BulletinRoot,
    tree_size: TreeSize,
    total_expected: TotalExpected,
    verified_tally: [u32; 5],
    total_votes: u32,
    valid_votes: u32,
    invalid_votes: u32,
    seen_indices_count: u32,
    seen_bitmap: &'a [bool],
    included_bitmap: &'a [bool],
    seen_bitmap_root: SeenBitmapRoot,
    included_bitmap_root: IncludedBitmapRoot,
    input_commitment: InputCommitment,
    sth_digest: SthDigest,
}

impl AccountingSummary {
    fn derive(
        tree_size: TreeSize,
        seen_indices_count: u32,
        valid_count: u32,
        invalid_count: u32,
    ) -> Result<Self, String> {
        let missing_slots = tree_size
            .get()
            .checked_sub(seen_indices_count)
            .ok_or_else(|| "seen index count exceeds tree size".to_string())?;
        let invalid_presented_slots = seen_indices_count
            .checked_sub(valid_count)
            .ok_or_else(|| "valid vote count exceeds seen index count".to_string())?;
        let excluded_slots = missing_slots
            .checked_add(invalid_presented_slots)
            .ok_or_else(|| "excluded slot count overflow".to_string())?;

        Ok(Self {
            missing_slots,
            invalid_presented_slots,
            rejected_records: invalid_count,
            excluded_slots,
        })
    }
}

fn checked_bitmap_popcount(bitmap: &[bool], label: &str) -> Result<u32, String> {
    let count = bitmap.iter().filter(|bit| **bit).count();
    u32::try_from(count).map_err(|_| format!("{label} popcount exceeds u32 journal encoding"))
}

fn checked_tally_sum(verified_tally: &[u32; 5]) -> Result<u32, String> {
    let mut sum = 0u32;
    for count in verified_tally {
        sum = sum
            .checked_add(*count)
            .ok_or_else(|| "verified tally sum exceeds u32 journal encoding".to_string())?;
    }
    Ok(sum)
}

fn build_verification_output(
    state: VerificationOutputConstruction<'_>,
) -> Result<VerificationOutput, String> {
    let expected_bitmap_len = usize::try_from(state.tree_size.get())
        .map_err(|_| "tree size exceeds bitmap length encoding".to_string())?;
    if state.seen_bitmap.len() != expected_bitmap_len {
        return Err("seen bitmap length must equal treeSize".to_string());
    }
    if state.included_bitmap.len() != expected_bitmap_len {
        return Err("included bitmap length must equal treeSize".to_string());
    }

    let expected_total_votes = state
        .valid_votes
        .checked_add(state.invalid_votes)
        .ok_or_else(|| "validVotes + invalidVotes exceeds u32 journal encoding".to_string())?;
    if state.total_votes != expected_total_votes {
        return Err("totalVotes must equal validVotes + invalidVotes".to_string());
    }

    if checked_tally_sum(&state.verified_tally)? != state.valid_votes {
        return Err("verified tally sum must equal validVotes".to_string());
    }

    let seen_popcount = checked_bitmap_popcount(state.seen_bitmap, "seen bitmap")?;
    if seen_popcount != state.seen_indices_count {
        return Err("seen bitmap popcount must equal seenIndicesCount".to_string());
    }

    let included_popcount = checked_bitmap_popcount(state.included_bitmap, "included bitmap")?;
    if included_popcount != state.valid_votes {
        return Err("included bitmap popcount must equal validVotes".to_string());
    }

    if state
        .included_bitmap
        .iter()
        .zip(state.seen_bitmap.iter())
        .any(|(included, seen)| *included && !*seen)
    {
        return Err("included bitmap must be a subset of seen bitmap".to_string());
    }

    let accounting = AccountingSummary::derive(
        state.tree_size,
        state.seen_indices_count,
        state.valid_votes,
        state.invalid_votes,
    )?;

    if state
        .seen_indices_count
        .checked_add(accounting.missing_slots)
        .ok_or_else(|| "seenIndicesCount + missingSlots exceeds u32 journal encoding".to_string())?
        != state.tree_size.get()
    {
        return Err("treeSize must equal seenIndicesCount + missingSlots".to_string());
    }

    if accounting
        .missing_slots
        .checked_add(accounting.invalid_presented_slots)
        .ok_or_else(|| {
            "missingSlots + invalidPresentedSlots exceeds u32 journal encoding".to_string()
        })?
        != accounting.excluded_slots
    {
        return Err("excludedSlots must equal missingSlots + invalidPresentedSlots".to_string());
    }

    Ok(VerificationOutput {
        election_id: state.election_id.get(),
        election_config_hash: state.election_config_hash.get(),
        bulletin_root: state.bulletin_root.get(),
        tree_size: state.tree_size.get(),
        total_expected: state.total_expected.get(),
        sth_digest: state.sth_digest.get(),
        verified_tally: state.verified_tally,
        total_votes: state.total_votes,
        valid_votes: state.valid_votes,
        invalid_votes: state.invalid_votes,
        seen_indices_count: state.seen_indices_count,
        missing_slots: accounting.missing_slots,
        invalid_presented_slots: accounting.invalid_presented_slots,
        rejected_records: accounting.rejected_records,
        seen_bitmap_root: state.seen_bitmap_root.get(),
        included_bitmap_root: state.included_bitmap_root.get(),
        excluded_slots: accounting.excluded_slots,
        input_commitment: state.input_commitment.get(),
        method_version: CURRENT_METHOD_VERSION,
    })
}

/// Validate input structure and bounded-counter assumptions.
#[cfg(test)]
pub fn validate_input(input: &AggregatorInput) -> Result<(), String> {
    ValidatedAggregatorInput::validate(input).map(|_| ())
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn verify_and_tally_checked(input: &AggregatorInput) -> Result<GuestTallyInspection, String> {
    let input = ValidatedAggregatorInput::validate(input)?;
    let mut vote_outcomes = Vec::with_capacity(input.raw.votes.len());
    let artifacts = verify_and_tally_core(&input, Some(&mut vote_outcomes))?;
    Ok(GuestTallyInspection {
        output: artifacts.output,
        vote_outcomes,
        included_bitmap: artifacts.included_bitmap,
    })
}

pub fn verify_and_tally_checked_output(
    input: &AggregatorInput,
) -> Result<VerificationOutput, String> {
    let input = ValidatedAggregatorInput::validate(input)?;
    verify_and_tally_core(&input, None).map(|artifacts| artifacts.output)
}

#[cfg(test)]
pub fn verify_and_tally_output(input: &AggregatorInput) -> VerificationOutput {
    verify_and_tally_checked_output(input)
        .expect("checked guest tally should accept valid test input")
}

fn verify_and_tally_core(
    input: &ValidatedAggregatorInput<'_>,
    mut vote_outcomes: Option<&mut Vec<GuestVoteInspection>>,
) -> Result<GuestTallyArtifacts, String> {
    let tree_size = input.tree_size.get();
    let total_expected = input.total_expected.get();
    let mut verified_tally = [0u32; 5];
    let tree_size_usize = tree_size as usize;
    let mut included_bitmap = vec![false; tree_size_usize];
    let mut index_seen = vec![false; tree_size_usize];
    let mut seen_commitments: Vec<[u8; 32]> = Vec::with_capacity(input.votes.len());
    let mut valid_count = 0u32;
    let mut invalid_count = 0u32;
    let mut seen_indices_count = 0u32;

    let _expected_actual_mismatch = total_expected != tree_size;

    for vote in &input.votes {
        if vote.index() >= tree_size {
            invalid_count = checked_increment(invalid_count, "invalid vote count")?;
            record_vote_outcome(&mut vote_outcomes, || GuestVoteInspection::Rejected {
                reason: RejectionReason::OutOfRangeIndex,
                slot_seen: false,
                commitment_reserved: false,
            });
            continue;
        }

        let index = vote.index() as usize;
        if index_seen[index] {
            invalid_count = checked_increment(invalid_count, "invalid vote count")?;
            record_vote_outcome(&mut vote_outcomes, || GuestVoteInspection::Rejected {
                reason: RejectionReason::DuplicateIndex,
                slot_seen: false,
                commitment_reserved: false,
            });
            continue;
        }
        index_seen[index] = true;
        seen_indices_count = checked_increment(seen_indices_count, "seen index count")?;

        if vote.choice() >= 5 {
            invalid_count = checked_increment(invalid_count, "invalid vote count")?;
            record_vote_outcome(&mut vote_outcomes, || GuestVoteInspection::Rejected {
                reason: RejectionReason::InvalidChoice,
                slot_seen: true,
                commitment_reserved: false,
            });
            continue;
        }

        let computed_commitment = compute_commitment(
            input.election_id.as_bytes(),
            vote.choice(),
            vote.random.as_bytes(),
        );
        if computed_commitment != *vote.commitment.as_bytes() {
            invalid_count = checked_increment(invalid_count, "invalid vote count")?;
            record_vote_outcome(&mut vote_outcomes, || GuestVoteInspection::Rejected {
                reason: RejectionReason::InvalidCommitment,
                slot_seen: true,
                commitment_reserved: false,
            });
            continue;
        }

        match seen_commitments.binary_search(&computed_commitment) {
            Ok(_) => {
                invalid_count = checked_increment(invalid_count, "invalid vote count")?;
                record_vote_outcome(&mut vote_outcomes, || GuestVoteInspection::Rejected {
                    reason: RejectionReason::DuplicateCommitment,
                    slot_seen: true,
                    commitment_reserved: false,
                });
                continue;
            }
            Err(pos) => seen_commitments.insert(pos, computed_commitment),
        };

        if !verify_inclusion_proof_rfc6962(
            vote.commitment.as_bytes(),
            vote.index(),
            vote.merkle_path(),
            input.bulletin_root.as_bytes(),
            tree_size,
        ) {
            invalid_count = checked_increment(invalid_count, "invalid vote count")?;
            record_vote_outcome(&mut vote_outcomes, || GuestVoteInspection::Rejected {
                reason: RejectionReason::InvalidInclusionProof,
                slot_seen: true,
                commitment_reserved: true,
            });
            continue;
        }

        verified_tally[vote.choice() as usize] =
            checked_increment(verified_tally[vote.choice() as usize], "candidate tally")?;
        if verified_tally[vote.choice() as usize] > MAX_FORMAL_GUEST_TALLY_BUCKET {
            return Err(format!(
                "Candidate tally bucket exceeds guest bound of {}",
                MAX_FORMAL_GUEST_TALLY_BUCKET
            ));
        }
        included_bitmap[index] = true;
        valid_count = checked_increment(valid_count, "valid vote count")?;
        record_vote_outcome(&mut vote_outcomes, || GuestVoteInspection::Accepted);
    }

    let seen_bitmap_root = SeenBitmapRoot::new(compute_bitmap_merkle_root(&index_seen));
    let included_bitmap_root =
        IncludedBitmapRoot::new(compute_bitmap_merkle_root(&included_bitmap));

    let input_commitment = InputCommitment::new(compute_input_commitment_v4(
        input.election_id.as_bytes(),
        input.bulletin_root.as_bytes(),
        tree_size,
        total_expected,
        &input.raw.votes,
    )?);
    let sth_digest = SthDigest::new(compute_sth_digest(
        input.log_id.as_bytes(),
        tree_size,
        input.timestamp.get(),
        input.bulletin_root.as_bytes(),
    ));
    let total_votes = VoteCount::new(input.votes.len())
        .map_err(|_| "Vote count exceeds u32 journal encoding".to_string())?;

    let output = build_verification_output(VerificationOutputConstruction {
        election_id: input.election_id,
        election_config_hash: input.election_config_hash,
        bulletin_root: input.bulletin_root,
        tree_size: input.tree_size,
        total_expected: input.total_expected,
        verified_tally,
        total_votes: total_votes.get(),
        valid_votes: valid_count,
        invalid_votes: invalid_count,
        seen_indices_count,
        seen_bitmap: &index_seen,
        included_bitmap: &included_bitmap,
        seen_bitmap_root,
        included_bitmap_root,
        input_commitment,
        sth_digest,
    })?;

    Ok(GuestTallyArtifacts {
        output,
        included_bitmap,
    })
}

fn record_vote_outcome(
    vote_outcomes: &mut Option<&mut Vec<GuestVoteInspection>>,
    outcome: impl FnOnce() -> GuestVoteInspection,
) {
    if let Some(outcomes) = vote_outcomes {
        outcomes.push(outcome());
    }
}

fn checked_increment(value: u32, label: &str) -> Result<u32, String> {
    value
        .checked_add(1)
        .ok_or_else(|| format!("{label} exceeds u32 journal encoding"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::{String, ToString};
    use contract_core::{
        compute_merkle_root, hash_internal, hash_leaf, VoteWithProof,
        INPUT_COMMITMENT_FORMAT_VERSION, MAX_GUEST_SERIALIZED_INPUT_BYTES,
        MAX_GUEST_TOTAL_EXPECTED, MAX_GUEST_TOTAL_PATH_NODES, VERIFIED_TALLY_WIDTH,
    };
    use serde::Deserialize;

    mod formal_vector_test_support {
        include!("../../../contract-core/src/formal_vector_test_support.rs");
    }
    use formal_vector_test_support::{
        admit_current_formal_vector, FormalVectorEnvelope, FormalVectorModeledBounds,
    };

    #[test]
    fn test_verify_and_tally_empty_votes() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: 10,
            log_id: [2u8; 32],
            timestamp: 1_234_567_890_000,
            total_expected: 0,
            election_config_hash: [3u8; 32],
            votes: vec![],
        };

        let output = verify_and_tally_output(&input);

        assert_eq!(output.total_votes, 0);
        assert_eq!(output.valid_votes, 0);
        assert_eq!(output.invalid_votes, 0);
        assert_eq!(output.verified_tally, [0, 0, 0, 0, 0]);
        assert_eq!(output.missing_slots, 10);
    }

    #[test]
    fn test_verify_and_tally_single_valid_vote() {
        let election_id = [1u8; 16];
        let commitment = compute_commitment(&election_id, 0, &[42u8; 32]);
        let votes = vec![VoteWithProof {
            commitment,
            choice: 0,
            random: [42u8; 32],
            index: 0,
            merkle_path: vec![],
        }];
        let input = AggregatorInput {
            election_id,
            bulletin_root: hash_leaf(&commitment),
            tree_size: 1,
            log_id: [2u8; 32],
            timestamp: 1_234_567_890_000,
            total_expected: 1,
            election_config_hash: [3u8; 32],
            votes,
        };

        let output = verify_and_tally_output(&input);

        assert_eq!(output.total_votes, 1);
        assert_eq!(output.valid_votes, 1);
        assert_eq!(output.invalid_votes, 0);
        assert_eq!(output.verified_tally, [1, 0, 0, 0, 0]);
        assert_eq!(output.missing_slots, 0);
        assert_eq!(output.invalid_presented_slots, 0);
        assert_eq!(output.rejected_records, 0);
    }

    #[test]
    fn test_validate_input_zero_bulletin_root() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [0u8; 32],
            tree_size: 1,
            log_id: [2u8; 32],
            timestamp: 1_234_567_890_000,
            total_expected: 1,
            election_config_hash: [3u8; 32],
            votes: vec![],
        };

        let result = validate_input(&input);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Invalid bulletin root");
    }

    #[test]
    fn test_validate_input_zero_tree_size() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: 0,
            log_id: [2u8; 32],
            timestamp: 1_234_567_890_000,
            total_expected: 0,
            election_config_hash: [3u8; 32],
            votes: vec![],
        };

        let result = validate_input(&input);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Tree size cannot be zero");
    }

    #[test]
    fn test_validate_input_zero_timestamp() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: 1,
            log_id: [2u8; 32],
            timestamp: 0,
            total_expected: 1,
            election_config_hash: [3u8; 32],
            votes: vec![],
        };

        let result = validate_input(&input);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "Timestamp must be positive Unix timestamp milliseconds"
        );
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct FormalGuestCase {
        name: String,
        tree_size: u32,
        votes: Vec<FormalGuestVote>,
        expected_outcomes: Vec<FormalGuestOutcome>,
        expected_seen_indices_count: u32,
        expected_missing_slots: u32,
        expected_invalid_presented_slots: u32,
        expected_rejected_records: u32,
        expected_rejection_reasons: Vec<String>,
        expected_excluded_slots: u32,
        expected_valid_votes: u32,
        expected_tally: [u32; 5],
        expected_included_bitmap_true_indices: Vec<usize>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct FormalGuestVote {
        #[serde(rename = "id")]
        _id: String,
        index: u32,
        choice: u8,
        random_byte: u8,
        commitment: u8,
        commitment_ok: bool,
        inclusion_ok: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct FormalGuestOutcome {
        accepted: bool,
        reason: Option<String>,
        slot_seen: bool,
        commitment_reserved: bool,
    }

    // Fixture-local deterministic election ID; every vector commitment and
    // Merkle proof in this test is built from the same value.
    const FORMAL_GUEST_VECTOR_ELECTION_ID: [u8; 16] = [0x42u8; 16];

    fn formal_guest_cases() -> Vec<FormalGuestCase> {
        let envelope: FormalVectorEnvelope<FormalGuestCase> = admit_current_formal_vector(
            include_str!("../../../../docs/formal/generated-vectors/guest-model-cases.json"),
            "guest-model-cases",
        )
        .expect("formal guest model vectors should admit");
        assert_formal_vector_bounds(&envelope.modeled_bounds);
        envelope.payload
    }

    fn assert_formal_vector_bounds(bounds: &FormalVectorModeledBounds) {
        assert_eq!(
            bounds.input_commitment.format_version,
            INPUT_COMMITMENT_FORMAT_VERSION
        );
        assert_eq!(bounds.input_commitment.u16_max, u32::from(u16::MAX));
        assert_eq!(bounds.input_commitment.u32_max, u64::from(u32::MAX));
        assert_eq!(bounds.guest.method_version, CURRENT_METHOD_VERSION);
        assert_eq!(bounds.guest.tree_size_max, MAX_GUEST_TREE_SIZE);
        assert_eq!(bounds.guest.total_expected_max, MAX_GUEST_TOTAL_EXPECTED);
        assert_eq!(bounds.guest.vote_count_max, MAX_GUEST_VOTE_COUNT);
        assert_eq!(
            bounds.guest.merkle_path_nodes_per_record_max,
            MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD
        );
        assert_eq!(
            bounds.guest.total_merkle_path_nodes_max,
            MAX_GUEST_TOTAL_PATH_NODES
        );
        assert_eq!(
            bounds.guest.serialized_input_bytes_max,
            MAX_GUEST_SERIALIZED_INPUT_BYTES
        );
        assert_eq!(bounds.guest.tally_width, VERIFIED_TALLY_WIDTH);
        assert_eq!(bounds.guest.tally_bucket_max, MAX_FORMAL_GUEST_TALLY_BUCKET);
    }

    fn reason_name(reason: RejectionReason) -> &'static str {
        match reason {
            RejectionReason::OutOfRangeIndex => "out_of_range_index",
            RejectionReason::DuplicateIndex => "duplicate_index",
            RejectionReason::InvalidChoice => "invalid_choice",
            RejectionReason::InvalidCommitment => "invalid_commitment",
            RejectionReason::DuplicateCommitment => "duplicate_commitment",
            RejectionReason::InvalidInclusionProof => "invalid_inclusion_proof",
        }
    }

    fn outcome_matches(actual: &GuestVoteInspection, expected: &FormalGuestOutcome) {
        match actual {
            GuestVoteInspection::Accepted => {
                assert!(expected.accepted);
                assert_eq!(expected.reason, None);
                assert!(expected.slot_seen);
                assert!(expected.commitment_reserved);
            }
            GuestVoteInspection::Rejected {
                reason,
                slot_seen,
                commitment_reserved,
            } => {
                assert!(!expected.accepted);
                assert_eq!(expected.reason.as_deref(), Some(reason_name(*reason)));
                assert_eq!(*slot_seen, expected.slot_seen);
                assert_eq!(*commitment_reserved, expected.commitment_reserved);
            }
        }
    }

    fn assert_output_eq(left: &VerificationOutput, right: &VerificationOutput, label: &str) {
        assert_eq!(left.election_id, right.election_id, "{label}");
        assert_eq!(
            left.election_config_hash, right.election_config_hash,
            "{label}"
        );
        assert_eq!(left.bulletin_root, right.bulletin_root, "{label}");
        assert_eq!(left.tree_size, right.tree_size, "{label}");
        assert_eq!(left.total_expected, right.total_expected, "{label}");
        assert_eq!(left.sth_digest, right.sth_digest, "{label}");
        assert_eq!(left.verified_tally, right.verified_tally, "{label}");
        assert_eq!(left.total_votes, right.total_votes, "{label}");
        assert_eq!(left.valid_votes, right.valid_votes, "{label}");
        assert_eq!(left.invalid_votes, right.invalid_votes, "{label}");
        assert_eq!(left.seen_indices_count, right.seen_indices_count, "{label}");
        assert_eq!(left.missing_slots, right.missing_slots, "{label}");
        assert_eq!(
            left.invalid_presented_slots, right.invalid_presented_slots,
            "{label}"
        );
        assert_eq!(left.rejected_records, right.rejected_records, "{label}");
        assert_eq!(left.seen_bitmap_root, right.seen_bitmap_root, "{label}");
        assert_eq!(
            left.included_bitmap_root, right.included_bitmap_root,
            "{label}"
        );
        assert_eq!(left.excluded_slots, right.excluded_slots, "{label}");
        assert_eq!(left.input_commitment, right.input_commitment, "{label}");
        assert_eq!(left.method_version, right.method_version, "{label}");
    }

    fn commitment_for_vector_vote(election_id: &[u8; 16], vote: &FormalGuestVote) -> [u8; 32] {
        if vote.commitment_ok {
            compute_commitment(election_id, vote.choice, &[vote.random_byte; 32])
        } else {
            [vote.commitment; 32]
        }
    }

    fn merkle_proof_for_index(leaves: &[[u8; 32]], leaf_index: usize) -> Vec<[u8; 32]> {
        let mut path = Vec::new();
        let mut index = leaf_index;
        let mut level: Vec<[u8; 32]> = leaves.iter().map(hash_leaf).collect();

        while level.len() > 1 {
            if index % 2 == 1 {
                path.push(level[index - 1]);
            } else if index + 1 < level.len() {
                path.push(level[index + 1]);
            }

            let mut next_level = Vec::with_capacity(level.len().div_ceil(2));
            let (pairs, remainder) = level.as_chunks::<2>();
            for pair in pairs {
                next_level.push(hash_internal(&pair[0], &pair[1]));
            }
            if let Some(rem) = remainder.first() {
                next_level.push(*rem);
            }

            index /= 2;
            level = next_level;
        }

        path
    }

    fn build_formal_guest_input(case: &FormalGuestCase) -> AggregatorInput {
        let election_id = FORMAL_GUEST_VECTOR_ELECTION_ID;
        let mut leaves: Vec<[u8; 32]> = (0..case.tree_size)
            .map(|index| {
                let mut leaf = [0xA0; 32];
                leaf[0] = index as u8;
                leaf
            })
            .collect();
        let mut assigned_leaf = vec![false; case.tree_size as usize];

        for vote in &case.votes {
            if vote.inclusion_ok
                && vote.index < case.tree_size
                && !assigned_leaf[vote.index as usize]
            {
                leaves[vote.index as usize] = commitment_for_vector_vote(&election_id, vote);
                assigned_leaf[vote.index as usize] = true;
            }
        }

        let hashed_leaves: Vec<[u8; 32]> = leaves.iter().map(hash_leaf).collect();
        let bulletin_root = compute_merkle_root(&hashed_leaves);
        let votes = case
            .votes
            .iter()
            .map(|vote| {
                let merkle_path = if vote.inclusion_ok && vote.index < case.tree_size {
                    merkle_proof_for_index(&leaves, vote.index as usize)
                } else {
                    Vec::new()
                };
                VoteWithProof {
                    commitment: commitment_for_vector_vote(&election_id, vote),
                    choice: vote.choice,
                    random: [vote.random_byte; 32],
                    index: vote.index,
                    merkle_path,
                }
            })
            .collect();

        AggregatorInput {
            election_id,
            bulletin_root,
            tree_size: case.tree_size,
            log_id: [2u8; 32],
            timestamp: 1_234_567_890_000,
            total_expected: case.tree_size,
            election_config_hash: [3u8; 32],
            votes,
        }
    }

    #[test]
    fn test_formal_guest_model_vectors() {
        for case in formal_guest_cases() {
            let input = build_formal_guest_input(&case);
            let inspection = verify_and_tally_checked(&input).unwrap_or_else(|error| {
                panic!("{} should pass guest bounds: {}", case.name, error)
            });
            let output_only = verify_and_tally_checked_output(&input).unwrap_or_else(|error| {
                panic!(
                    "{} should pass output-only guest bounds: {}",
                    case.name, error
                )
            });
            let output = inspection.output;
            assert_output_eq(&output_only, &output, &case.name);

            assert_eq!(
                inspection.vote_outcomes.len(),
                case.expected_outcomes.len(),
                "{}",
                case.name
            );
            for (actual, expected) in inspection
                .vote_outcomes
                .iter()
                .zip(case.expected_outcomes.iter())
            {
                outcome_matches(actual, expected);
            }

            let rejection_reasons: Vec<String> = inspection
                .vote_outcomes
                .iter()
                .filter_map(|outcome| match outcome {
                    GuestVoteInspection::Accepted => None,
                    GuestVoteInspection::Rejected { reason, .. } => {
                        Some(reason_name(*reason).to_string())
                    }
                })
                .collect();
            let included_true_indices: Vec<usize> = inspection
                .included_bitmap
                .iter()
                .enumerate()
                .filter_map(|(index, included)| if *included { Some(index) } else { None })
                .collect();

            assert_eq!(
                output.seen_indices_count, case.expected_seen_indices_count,
                "{}",
                case.name
            );
            assert_eq!(
                output.missing_slots, case.expected_missing_slots,
                "{}",
                case.name
            );
            assert_eq!(
                output.invalid_presented_slots, case.expected_invalid_presented_slots,
                "{}",
                case.name
            );
            assert_eq!(
                output.rejected_records, case.expected_rejected_records,
                "{}",
                case.name
            );
            assert_eq!(
                rejection_reasons, case.expected_rejection_reasons,
                "{}",
                case.name
            );
            assert_eq!(
                output.excluded_slots, case.expected_excluded_slots,
                "{}",
                case.name
            );
            assert_eq!(
                output.valid_votes, case.expected_valid_votes,
                "{}",
                case.name
            );
            assert_eq!(output.verified_tally, case.expected_tally, "{}", case.name);
            assert_eq!(
                included_true_indices, case.expected_included_bitmap_true_indices,
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn test_guest_bounds_reject_oversized_tree_size() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: MAX_GUEST_TREE_SIZE + 1,
            log_id: [2u8; 32],
            timestamp: 1_234_567_890_000,
            total_expected: 1,
            election_config_hash: [3u8; 32],
            votes: vec![],
        };

        let result = verify_and_tally_checked(&input);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("Tree size exceeds guest bound"));
    }

    #[test]
    fn test_guest_bounds_reject_oversized_total_expected() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: 1,
            log_id: [2u8; 32],
            timestamp: 1_234_567_890_000,
            total_expected: MAX_GUEST_TREE_SIZE + 1,
            election_config_hash: [3u8; 32],
            votes: vec![],
        };

        let result = verify_and_tally_checked(&input);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("Total expected exceeds guest bound"));
    }

    #[test]
    fn test_guest_bounds_reject_oversized_vote_count() {
        let vote = VoteWithProof {
            commitment: [4u8; 32],
            choice: 0,
            random: [5u8; 32],
            index: 0,
            merkle_path: vec![],
        };
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: 1,
            log_id: [2u8; 32],
            timestamp: 1_234_567_890_000,
            total_expected: 1,
            election_config_hash: [3u8; 32],
            votes: vec![vote; MAX_GUEST_VOTE_COUNT + 1],
        };

        let result = verify_and_tally_checked(&input);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("Vote count exceeds guest bound"));
    }

    #[test]
    fn test_guest_bounds_reject_oversized_merkle_path_length() {
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: 1,
            log_id: [2u8; 32],
            timestamp: 1_234_567_890_000,
            total_expected: 1,
            election_config_hash: [3u8; 32],
            votes: vec![VoteWithProof {
                commitment: [4u8; 32],
                choice: 0,
                random: [5u8; 32],
                index: 0,
                merkle_path: vec![[6u8; 32]; usize::from(u16::MAX) + 1],
            }],
        };

        let result = verify_and_tally_checked(&input);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("Merkle path length exceeds u16 input commitment encoding"));
    }

    #[test]
    fn test_guest_bounds_reject_aggregate_merkle_path_work_budget() {
        let vote_count = 50_000;
        let path_len = (MAX_GUEST_TOTAL_PATH_NODES / vote_count) + 1;
        let vote = VoteWithProof {
            commitment: [4u8; 32],
            choice: 0,
            random: [5u8; 32],
            index: 0,
            merkle_path: vec![[6u8; 32]; path_len],
        };
        let input = AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [1u8; 32],
            tree_size: 1,
            log_id: [2u8; 32],
            timestamp: 1_234_567_890_000,
            total_expected: 1,
            election_config_hash: [3u8; 32],
            votes: vec![vote; vote_count],
        };

        let result = verify_and_tally_checked(&input);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Guest work budget exceeded"));
    }

    fn accounting_boundary_base_input() -> AggregatorInput {
        AggregatorInput {
            election_id: [1u8; 16],
            bulletin_root: [2u8; 32],
            tree_size: 2,
            log_id: [3u8; 32],
            timestamp: 1_234_567_890_000,
            total_expected: 2,
            election_config_hash: [4u8; 32],
            votes: vec![
                VoteWithProof {
                    commitment: [5u8; 32],
                    choice: 0,
                    random: [6u8; 32],
                    index: 0,
                    merkle_path: vec![],
                },
                VoteWithProof {
                    commitment: [7u8; 32],
                    choice: 1,
                    random: [8u8; 32],
                    index: 1,
                    merkle_path: vec![],
                },
            ],
        }
    }

    fn valid_accounting_boundary_state<'a>(
        input: &'a AggregatorInput,
        seen_bitmap: &'a [bool],
        included_bitmap: &'a [bool],
    ) -> VerificationOutputConstruction<'a> {
        VerificationOutputConstruction {
            election_id: ElectionId16::new(input.election_id),
            election_config_hash: ElectionConfigHash::new(input.election_config_hash),
            bulletin_root: BulletinRoot::new(input.bulletin_root).unwrap(),
            tree_size: TreeSize::new(2).unwrap(),
            total_expected: TotalExpected::new(2),
            verified_tally: [1, 0, 0, 0, 0],
            total_votes: 2,
            valid_votes: 1,
            invalid_votes: 1,
            seen_indices_count: 2,
            seen_bitmap,
            included_bitmap,
            seen_bitmap_root: SeenBitmapRoot::new([9u8; 32]),
            included_bitmap_root: IncludedBitmapRoot::new([10u8; 32]),
            input_commitment: InputCommitment::new([11u8; 32]),
            sth_digest: SthDigest::new([12u8; 32]),
        }
    }

    #[test]
    fn accounting_boundary_accepts_consistent_output_state() {
        let input = accounting_boundary_base_input();
        let seen_bitmap = [true, true];
        let included_bitmap = [true, false];

        let output = build_verification_output(valid_accounting_boundary_state(
            &input,
            &seen_bitmap,
            &included_bitmap,
        ))
        .expect("consistent accounting state should build output");

        assert_eq!(output.total_votes, 2);
        assert_eq!(output.valid_votes, 1);
        assert_eq!(output.invalid_votes, 1);
        assert_eq!(output.seen_indices_count, 2);
        assert_eq!(output.missing_slots, 0);
        assert_eq!(output.invalid_presented_slots, 1);
        assert_eq!(output.excluded_slots, 1);
    }

    #[test]
    fn accounting_boundary_rejects_inconsistent_vote_totals() {
        let input = accounting_boundary_base_input();
        let seen_bitmap = [true, true];
        let included_bitmap = [true, false];
        let mut state = valid_accounting_boundary_state(&input, &seen_bitmap, &included_bitmap);
        state.invalid_votes = 0;

        let result = build_verification_output(state);

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("totalVotes must equal validVotes + invalidVotes"));
    }

    #[test]
    fn accounting_boundary_rejects_tally_sum_mismatch() {
        let input = accounting_boundary_base_input();
        let seen_bitmap = [true, true];
        let included_bitmap = [true, false];
        let mut state = valid_accounting_boundary_state(&input, &seen_bitmap, &included_bitmap);
        state.verified_tally = [0, 0, 0, 0, 0];

        let result = build_verification_output(state);

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("verified tally sum must equal validVotes"));
    }

    #[test]
    fn accounting_boundary_rejects_bitmap_popcount_mismatch() {
        let input = accounting_boundary_base_input();
        let seen_bitmap = [true, true];
        let included_bitmap = [true, true];
        let state = valid_accounting_boundary_state(&input, &seen_bitmap, &included_bitmap);

        let result = build_verification_output(state);

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("included bitmap popcount must equal validVotes"));
    }

    #[test]
    fn accounting_boundary_rejects_included_without_seen_slot() {
        let mut input = accounting_boundary_base_input();
        input.tree_size = 3;
        input.total_expected = 3;
        let seen_bitmap = [false, true, true];
        let included_bitmap = [true, false, false];
        let mut state = valid_accounting_boundary_state(&input, &seen_bitmap, &included_bitmap);
        state.tree_size = TreeSize::new(3).unwrap();
        state.total_expected = TotalExpected::new(3);

        let result = build_verification_output(state);

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("included bitmap must be a subset of seen bitmap"));
    }
}
