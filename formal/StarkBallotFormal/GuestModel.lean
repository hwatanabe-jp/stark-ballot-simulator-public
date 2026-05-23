import StarkBallotFormal.JournalCounts

namespace StarkBallotFormal

inductive RejectReason where
  | out_of_range_index
  | duplicate_index
  | invalid_choice
  | invalid_commitment
  | duplicate_commitment
  | invalid_inclusion_proof
  deriving DecidableEq, Repr

inductive VoteOutcome where
  | accepted
  | rejected (reason : RejectReason) (slotSeen : Bool) (commitmentReserved : Bool)
  deriving DecidableEq, Repr

structure GuestVote where
  index : Nat
  choice : Nat
  commitment : Nat
  random : Nat
  commitmentOk : Bool
  inclusionOk : Bool
  deriving Repr

structure CandidateTally where
  choice0 : Nat
  choice1 : Nat
  choice2 : Nat
  choice3 : Nat
  choice4 : Nat
  deriving Repr

def emptyCandidateTally : CandidateTally := {
  choice0 := 0
  choice1 := 0
  choice2 := 0
  choice3 := 0
  choice4 := 0
}

def tallyTotal (tally : CandidateTally) : Nat :=
  tally.choice0 + tally.choice1 + tally.choice2 + tally.choice3 + tally.choice4

def tallyAt (tally : CandidateTally) (choice : Nat) : Nat :=
  match choice with
  | 0 => tally.choice0
  | 1 => tally.choice1
  | 2 => tally.choice2
  | 3 => tally.choice3
  | _ => tally.choice4

def incrementTally (choice : Nat) (tally : CandidateTally) : CandidateTally :=
  match choice with
  | 0 => { tally with choice0 := tally.choice0 + 1 }
  | 1 => { tally with choice1 := tally.choice1 + 1 }
  | 2 => { tally with choice2 := tally.choice2 + 1 }
  | 3 => { tally with choice3 := tally.choice3 + 1 }
  | _ => { tally with choice4 := tally.choice4 + 1 }

theorem tallyTotal_increment (choice : Nat) (tally : CandidateTally) :
    tallyTotal (incrementTally choice tally) = tallyTotal tally + 1 := by
  cases choice with
  | zero =>
      simp [tallyTotal, incrementTally]
      omega
  | succ choice =>
      cases choice with
      | zero =>
          simp [tallyTotal, incrementTally]
          omega
      | succ choice =>
          cases choice with
          | zero =>
              simp [tallyTotal, incrementTally]
              omega
          | succ choice =>
              cases choice with
              | zero =>
                  simp [tallyTotal, incrementTally]
                  omega
              | succ _ =>
                  simp [tallyTotal, incrementTally]
                  omega

theorem tallyAt_increment_same
    (choice : Nat) (tally : CandidateTally)
    (hChoice : choice < 5) :
    tallyAt (incrementTally choice tally) choice = tallyAt tally choice + 1 := by
  cases choice with
  | zero =>
      simp [tallyAt, incrementTally]
  | succ choice =>
      cases choice with
      | zero =>
          simp [tallyAt, incrementTally]
      | succ choice =>
          cases choice with
          | zero =>
              simp [tallyAt, incrementTally]
          | succ choice =>
              cases choice with
              | zero =>
                  simp [tallyAt, incrementTally]
              | succ choice =>
                  cases choice with
                  | zero =>
                      simp [tallyAt, incrementTally]
                  | succ _ =>
                      omega

structure GuestState where
  seenIndices : List Nat
  seenCommitments : List Nat
  includedBitmap : List Bool
  validVotes : Nat
  rejectedRecords : Nat
  rejectedReasons : List RejectReason
  verifiedTally : CandidateTally

def initialGuestState (treeSize : Nat) : GuestState := {
  seenIndices := []
  seenCommitments := []
  includedBitmap := List.replicate treeSize false
  validVotes := 0
  rejectedRecords := 0
  rejectedReasons := []
  verifiedTally := emptyCandidateTally
}

def hasSeenIndex (state : GuestState) (index : Nat) : Bool :=
  state.seenIndices.contains index

def hasSeenCommitment (state : GuestState) (commitment : Nat) : Bool :=
  state.seenCommitments.contains commitment

def markSeenIndex (state : GuestState) (index : Nat) : GuestState :=
  { state with seenIndices := index :: state.seenIndices }

def insertCommitment (state : GuestState) (commitment : Nat) : GuestState :=
  { state with seenCommitments := commitment :: state.seenCommitments }

def rejectVote (state : GuestState) (reason : RejectReason) : GuestState :=
  { state with
    rejectedRecords := state.rejectedRecords + 1
    rejectedReasons := reason :: state.rejectedReasons
  }

def acceptVote (state : GuestState) (vote : GuestVote) : GuestState :=
  { state with
    includedBitmap := state.includedBitmap.set vote.index true
    validVotes := state.validVotes + 1
    verifiedTally := incrementTally vote.choice state.verifiedTally
  }

theorem acceptVote_increments_selected_candidate
    {state : GuestState} {vote : GuestVote}
    (hChoice : vote.choice < 5) :
    tallyAt (acceptVote state vote).verifiedTally vote.choice =
      tallyAt state.verifiedTally vote.choice + 1 := by
  simp [acceptVote, tallyAt_increment_same, hChoice]

def classifyVote (treeSize : Nat) (state : GuestState) (vote : GuestVote) : VoteOutcome :=
  if vote.index < treeSize then
    if hasSeenIndex state vote.index then
      .rejected .duplicate_index false false
    else
      let stateAfterIndex := markSeenIndex state vote.index
      if vote.choice < 5 then
        if vote.commitmentOk then
          if hasSeenCommitment stateAfterIndex vote.commitment then
            .rejected .duplicate_commitment true false
          else
            if vote.inclusionOk then
              .accepted
            else
              .rejected .invalid_inclusion_proof true true
        else
          .rejected .invalid_commitment true false
      else
        .rejected .invalid_choice true false
  else
    .rejected .out_of_range_index false false

def outcomeAccepted : VoteOutcome -> Bool
  | .accepted => true
  | .rejected _ _ _ => false

def voteAccepted (treeSize : Nat) (state : GuestState) (vote : GuestVote) : Bool :=
  outcomeAccepted (classifyVote treeSize state vote)

def stateAfterOutcomeReservations
    (state : GuestState)
    (vote : GuestVote)
    (slotSeen commitmentReserved : Bool) : GuestState :=
  let stateAfterSlot := if slotSeen then markSeenIndex state vote.index else state
  if commitmentReserved then insertCommitment stateAfterSlot vote.commitment else stateAfterSlot

def applyVoteOutcome (state : GuestState) (vote : GuestVote) : VoteOutcome -> GuestState
  | .accepted => acceptVote (insertCommitment (markSeenIndex state vote.index) vote.commitment) vote
  | .rejected reason slotSeen commitmentReserved =>
      rejectVote (stateAfterOutcomeReservations state vote slotSeen commitmentReserved) reason

def processVote (treeSize : Nat) (state : GuestState) (vote : GuestVote) : GuestState :=
  applyVoteOutcome state vote (classifyVote treeSize state vote)

def processVotesFrom (treeSize : Nat) (state : GuestState) (votes : List GuestVote) : GuestState :=
  votes.foldl (processVote treeSize) state

def processVotes (treeSize : Nat) (votes : List GuestVote) : GuestState :=
  processVotesFrom treeSize (initialGuestState treeSize) votes

def acceptedVoteCountFrom (treeSize : Nat) (state : GuestState) : List GuestVote -> Nat
  | [] => 0
  | vote :: rest =>
      let nextState := processVote treeSize state vote
      (if voteAccepted treeSize state vote then 1 else 0) +
        acceptedVoteCountFrom treeSize nextState rest

def acceptedVoteCount (treeSize : Nat) (votes : List GuestVote) : Nat :=
  acceptedVoteCountFrom treeSize (initialGuestState treeSize) votes

def rejectionClassificationTotal (state : GuestState) : Nat :=
  state.rejectedReasons.length

def guestMissingSlots (treeSize : Nat) (state : GuestState) : Nat :=
  missingSlotsOf treeSize state.seenIndices.length

def guestInvalidPresentedSlots (state : GuestState) : Nat :=
  invalidPresentedSlotsOf state.seenIndices.length state.validVotes

def guestExcludedSlots (treeSize : Nat) (state : GuestState) : Nat :=
  excludedSlotsOf (guestMissingSlots treeSize state) (guestInvalidPresentedSlots state)

def rustU32Max : Nat := 4294967295

def formalGuestMaxTreeSize : Nat := 1000000

def formalGuestMaxVoteCount : Nat := 1000000

def formalGuestMaxTallyBucket : Nat := formalGuestMaxTreeSize

structure GuestBounds (treeSize voteCount : Nat) where
  treeSizeWithinFormalBound : treeSize ≤ formalGuestMaxTreeSize
  voteCountWithinFormalBound : voteCount ≤ formalGuestMaxVoteCount

def candidateTallyBucketsWithin (limit : Nat) (tally : CandidateTally) : Prop :=
  tally.choice0 ≤ limit ∧
    tally.choice1 ≤ limit ∧
    tally.choice2 ≤ limit ∧
    tally.choice3 ≤ limit ∧
    tally.choice4 ≤ limit

def GuestStateFoldInvariant (treeSize : Nat) (state : GuestState) : Prop :=
  state.seenIndices.Nodup ∧
    (∀ index, index ∈ state.seenIndices → index < treeSize) ∧
    state.validVotes ≤ state.seenIndices.length

theorem bool_true_of_not_false {b : Bool} (h : ¬b = false) : b = true := by
  cases b <;> simp at h ⊢

theorem hasSeenIndex_false_not_mem
    {state : GuestState} {index : Nat}
    (hSeen : hasSeenIndex state index = false) :
    ¬index ∈ state.seenIndices := by
  unfold hasSeenIndex at hSeen
  rw [← List.elem_eq_contains, List.elem_eq_mem] at hSeen
  simpa using hSeen

theorem classifyVote_accepted_index_fresh
    {treeSize : Nat} {state : GuestState} {vote : GuestVote}
    (hOutcome : classifyVote treeSize state vote = .accepted) :
    vote.index < treeSize ∧ ¬vote.index ∈ state.seenIndices := by
  unfold classifyVote at hOutcome
  by_cases hIndex : vote.index < treeSize
  · simp [hIndex] at hOutcome
    by_cases hSeenFalse : hasSeenIndex state vote.index = false
    · exact ⟨hIndex, hasSeenIndex_false_not_mem hSeenFalse⟩
    · have hSeenTrue : hasSeenIndex state vote.index = true :=
        bool_true_of_not_false hSeenFalse
      simp [hSeenTrue] at hOutcome
  · simp [hIndex] at hOutcome

theorem classifyVote_rejected_seen_slot_fresh
    {treeSize : Nat} {state : GuestState} {vote : GuestVote}
    {reason : RejectReason} {commitmentReserved : Bool}
    (hOutcome : classifyVote treeSize state vote = .rejected reason true commitmentReserved) :
    vote.index < treeSize ∧ ¬vote.index ∈ state.seenIndices := by
  unfold classifyVote at hOutcome
  by_cases hIndex : vote.index < treeSize
  · simp [hIndex] at hOutcome
    by_cases hSeenFalse : hasSeenIndex state vote.index = false
    · exact ⟨hIndex, hasSeenIndex_false_not_mem hSeenFalse⟩
    · have hSeenTrue : hasSeenIndex state vote.index = true :=
        bool_true_of_not_false hSeenFalse
      simp [hSeenTrue] at hOutcome
  · simp [hIndex] at hOutcome

theorem insertCommitment_preserves_fold_invariant
    {treeSize : Nat} {state : GuestState} {commitment : Nat}
    (hInv : GuestStateFoldInvariant treeSize state) :
    GuestStateFoldInvariant treeSize (insertCommitment state commitment) := by
  simpa [GuestStateFoldInvariant, insertCommitment] using hInv

theorem rejectVote_preserves_fold_invariant
    {treeSize : Nat} {state : GuestState} {reason : RejectReason}
    (hInv : GuestStateFoldInvariant treeSize state) :
    GuestStateFoldInvariant treeSize (rejectVote state reason) := by
  simpa [GuestStateFoldInvariant, rejectVote] using hInv

theorem markSeenIndex_preserves_fold_invariant
    {treeSize : Nat} {state : GuestState} {vote : GuestVote}
    (hInv : GuestStateFoldInvariant treeSize state)
    (hIndex : vote.index < treeSize)
    (hFresh : ¬vote.index ∈ state.seenIndices) :
    GuestStateFoldInvariant treeSize (markSeenIndex state vote.index) := by
  rcases hInv with ⟨hNodup, hRange, hValidSeen⟩
  unfold GuestStateFoldInvariant markSeenIndex
  constructor
  · rw [List.nodup_cons]
    exact ⟨hFresh, hNodup⟩
  constructor
  · intro index hMem
    rw [List.mem_cons] at hMem
    cases hMem with
    | inl hEq => simpa [hEq] using hIndex
    | inr hTail => exact hRange index hTail
  · simp
    omega

theorem acceptVote_after_reservation_preserves_fold_invariant
    {treeSize : Nat} {state : GuestState} {vote : GuestVote}
    (hInv : GuestStateFoldInvariant treeSize state)
    (hIndex : vote.index < treeSize)
    (hFresh : ¬vote.index ∈ state.seenIndices) :
    GuestStateFoldInvariant treeSize
      (acceptVote (insertCommitment (markSeenIndex state vote.index) vote.commitment) vote) := by
  rcases hInv with ⟨hNodup, hRange, hValidSeen⟩
  unfold GuestStateFoldInvariant markSeenIndex insertCommitment acceptVote
  constructor
  · rw [List.nodup_cons]
    exact ⟨hFresh, hNodup⟩
  constructor
  · intro index hMem
    rw [List.mem_cons] at hMem
    cases hMem with
    | inl hEq => simpa [hEq] using hIndex
    | inr hTail => exact hRange index hTail
  · simp
    omega

theorem processVote_preserves_fold_invariant
    {treeSize : Nat} {state : GuestState} {vote : GuestVote}
    (hInv : GuestStateFoldInvariant treeSize state) :
    GuestStateFoldInvariant treeSize (processVote treeSize state vote) := by
  unfold processVote
  cases hOutcome : classifyVote treeSize state vote with
  | accepted =>
      have hFresh := classifyVote_accepted_index_fresh hOutcome
      simpa [hOutcome, applyVoteOutcome] using
        acceptVote_after_reservation_preserves_fold_invariant hInv hFresh.1 hFresh.2
  | rejected reason slotSeen commitmentReserved =>
      cases slotSeen
      · cases commitmentReserved <;>
          simpa [hOutcome, applyVoteOutcome, stateAfterOutcomeReservations] using
            rejectVote_preserves_fold_invariant (reason := reason) hInv
      · have hFresh := classifyVote_rejected_seen_slot_fresh hOutcome
        have hMarked :
            GuestStateFoldInvariant treeSize (markSeenIndex state vote.index) :=
          markSeenIndex_preserves_fold_invariant hInv hFresh.1 hFresh.2
        cases commitmentReserved
        · simpa [hOutcome, applyVoteOutcome, stateAfterOutcomeReservations] using
            rejectVote_preserves_fold_invariant (reason := reason) hMarked
        · have hInserted :
              GuestStateFoldInvariant treeSize
                (insertCommitment (markSeenIndex state vote.index) vote.commitment) :=
            insertCommitment_preserves_fold_invariant hMarked
          simpa [hOutcome, applyVoteOutcome, stateAfterOutcomeReservations] using
            rejectVote_preserves_fold_invariant (reason := reason) hInserted

theorem initialGuestState_fold_invariant (treeSize : Nat) :
    GuestStateFoldInvariant treeSize (initialGuestState treeSize) := by
  simp [GuestStateFoldInvariant, initialGuestState]

theorem processVotesFrom_preserves_fold_invariant
    (treeSize : Nat) (votes : List GuestVote) (state : GuestState)
    (hInv : GuestStateFoldInvariant treeSize state) :
    GuestStateFoldInvariant treeSize (processVotesFrom treeSize state votes) := by
  induction votes generalizing state with
  | nil =>
      simp [processVotesFrom, hInv]
  | cons vote rest ih =>
      simp [processVotesFrom]
      exact ih (processVote treeSize state vote) (processVote_preserves_fold_invariant hInv)

theorem processVotes_fold_invariant
    (treeSize : Nat) (votes : List GuestVote) :
    GuestStateFoldInvariant treeSize (processVotes treeSize votes) := by
  unfold processVotes
  exact processVotesFrom_preserves_fold_invariant treeSize votes (initialGuestState treeSize)
    (initialGuestState_fold_invariant treeSize)

theorem nat_not_mem_erase_self_of_nodup
    {a : Nat} {l : List Nat}
    (hNodup : l.Nodup) :
    ¬a ∈ l.erase a := by
  induction l with
  | nil =>
      simp [List.erase]
  | cons x xs ih =>
      rw [List.nodup_cons] at hNodup
      by_cases hEq : x = a
      · subst hEq
        simp [List.erase_cons_head, hNodup.1]
      · have hBEq : ¬(x == a) = true := by
          simp [Bool.beq_eq_decide_eq, hEq]
        have hTail : ¬a ∈ xs.erase a := ih hNodup.2
        have hNe : a ≠ x := by omega
        simp [List.erase_cons_tail hBEq, hNe, hTail]

theorem nat_list_nodup_length_le_of_forall_lt
    {n : Nat} {indices : List Nat}
    (hNodup : indices.Nodup)
    (hRange : ∀ index, index ∈ indices → index < n) :
    indices.length ≤ n := by
  induction n generalizing indices with
  | zero =>
      cases indices with
      | nil =>
          simp
      | cons index rest =>
          have hIndex : index < 0 := hRange index (by simp)
          omega
  | succ n ih =>
      by_cases hContainsTop : n ∈ indices
      · have hEraseNodup : (indices.erase n).Nodup := List.Nodup.erase n hNodup
        have hEraseRange : ∀ index, index ∈ indices.erase n → index < n := by
          intro index hIndexErase
          have hIndexMem : index ∈ indices := List.mem_of_mem_erase hIndexErase
          have hIndexLtSucc : index < n + 1 := hRange index hIndexMem
          have hIndexNe : index ≠ n := by
            intro hEq
            subst hEq
            exact nat_not_mem_erase_self_of_nodup hNodup hIndexErase
          omega
        have hEraseLen : (indices.erase n).length = indices.length - 1 :=
          List.length_erase_of_mem hContainsTop
        have hEraseBound : (indices.erase n).length ≤ n := ih hEraseNodup hEraseRange
        omega
      · have hRangeSmall : ∀ index, index ∈ indices → index < n := by
          intro index hIndexMem
          have hIndexLtSucc : index < n + 1 := hRange index hIndexMem
          have hIndexNe : index ≠ n := by
            intro hEq
            exact hContainsTop (by simpa [hEq] using hIndexMem)
          omega
        have hBound : indices.length ≤ n := ih hNodup hRangeSmall
        omega

theorem processVotes_seen_indices_length_le_treeSize
    (treeSize : Nat) (votes : List GuestVote) :
    (processVotes treeSize votes).seenIndices.length ≤ treeSize := by
  have hInv := processVotes_fold_invariant treeSize votes
  exact nat_list_nodup_length_le_of_forall_lt hInv.1 hInv.2.1

theorem processVote_preserves_tally_count
    {treeSize : Nat} {state : GuestState} {vote : GuestVote}
    (hTally : tallyTotal state.verifiedTally = state.validVotes) :
    tallyTotal (processVote treeSize state vote).verifiedTally =
      (processVote treeSize state vote).validVotes := by
  unfold processVote
  cases hOutcome : classifyVote treeSize state vote with
  | accepted =>
      simp [applyVoteOutcome, markSeenIndex, insertCommitment, acceptVote] at hTally ⊢
      rw [tallyTotal_increment]
      omega
  | rejected reason slotSeen commitmentReserved =>
      cases slotSeen <;> cases commitmentReserved <;>
        simp [
          applyVoteOutcome,
          stateAfterOutcomeReservations,
          markSeenIndex,
          insertCommitment,
          rejectVote,
          hTally
        ]

theorem accepted_votes_count_tally_from
    (treeSize : Nat) (votes : List GuestVote) (state : GuestState)
    (hTally : tallyTotal state.verifiedTally = state.validVotes) :
    tallyTotal (processVotesFrom treeSize state votes).verifiedTally =
      (processVotesFrom treeSize state votes).validVotes := by
  induction votes generalizing state with
  | nil =>
      simp [processVotesFrom, hTally]
  | cons vote rest ih =>
      simp [processVotesFrom]
      exact ih (processVote treeSize state vote) (processVote_preserves_tally_count hTally)

theorem accepted_votes_count_tally
    (treeSize : Nat) (votes : List GuestVote) :
    tallyTotal (processVotes treeSize votes).verifiedTally =
      (processVotes treeSize votes).validVotes := by
  unfold processVotes
  exact accepted_votes_count_tally_from treeSize votes (initialGuestState treeSize) (by rfl)

theorem candidate_tally_buckets_le_total
    (tally : CandidateTally) :
    tally.choice0 ≤ tallyTotal tally ∧
      tally.choice1 ≤ tallyTotal tally ∧
      tally.choice2 ≤ tallyTotal tally ∧
      tally.choice3 ≤ tallyTotal tally ∧
      tally.choice4 ≤ tallyTotal tally := by
  unfold tallyTotal
  omega

theorem processVote_validVotes_delta
    {treeSize : Nat} {state : GuestState} {vote : GuestVote} :
    (processVote treeSize state vote).validVotes =
      state.validVotes + if voteAccepted treeSize state vote then 1 else 0 := by
  unfold processVote voteAccepted
  cases hOutcome : classifyVote treeSize state vote with
  | accepted =>
      simp [
        outcomeAccepted,
        applyVoteOutcome,
        markSeenIndex,
        insertCommitment,
        acceptVote
      ]
  | rejected reason slotSeen commitmentReserved =>
      cases slotSeen <;> cases commitmentReserved <;>
        simp [
          outcomeAccepted,
          applyVoteOutcome,
          stateAfterOutcomeReservations,
          markSeenIndex,
          insertCommitment,
          rejectVote
        ]

theorem valid_votes_count_accepted_from
    (treeSize : Nat) (votes : List GuestVote) (state : GuestState) :
    (processVotesFrom treeSize state votes).validVotes =
      state.validVotes + acceptedVoteCountFrom treeSize state votes := by
  induction votes generalizing state with
  | nil =>
      simp [processVotesFrom, acceptedVoteCountFrom]
  | cons vote rest ih =>
      simp [processVotesFrom, acceptedVoteCountFrom]
      change
        (processVotesFrom treeSize (processVote treeSize state vote) rest).validVotes =
          state.validVotes +
            ((if voteAccepted treeSize state vote = true then 1 else 0) +
              acceptedVoteCountFrom treeSize (processVote treeSize state vote) rest)
      rw [ih (processVote treeSize state vote)]
      rw [processVote_validVotes_delta]
      by_cases hAccepted : voteAccepted treeSize state vote <;> simp [hAccepted]
      omega

theorem valid_votes_count_accepted
    (treeSize : Nat) (votes : List GuestVote) :
    (processVotes treeSize votes).validVotes = acceptedVoteCount treeSize votes := by
  unfold processVotes acceptedVoteCount
  simpa [initialGuestState] using
    valid_votes_count_accepted_from treeSize votes (initialGuestState treeSize)

theorem processVote_preserves_rejected_records_classification
    {treeSize : Nat} {state : GuestState} {vote : GuestVote}
    (hRejected : state.rejectedRecords = rejectionClassificationTotal state) :
    (processVote treeSize state vote).rejectedRecords =
      rejectionClassificationTotal (processVote treeSize state vote) := by
  unfold processVote
  cases hOutcome : classifyVote treeSize state vote with
  | accepted =>
      simp [
        applyVoteOutcome,
        markSeenIndex,
        insertCommitment,
        acceptVote,
        rejectionClassificationTotal,
        hRejected
      ]
  | rejected reason slotSeen commitmentReserved =>
      cases slotSeen <;> cases commitmentReserved <;>
        simp [
          applyVoteOutcome,
          stateAfterOutcomeReservations,
          markSeenIndex,
          insertCommitment,
          rejectVote,
          rejectionClassificationTotal,
          hRejected
        ]

theorem rejected_records_classification_from
    (treeSize : Nat) (votes : List GuestVote) (state : GuestState)
    (hRejected : state.rejectedRecords = rejectionClassificationTotal state) :
    (processVotesFrom treeSize state votes).rejectedRecords =
      rejectionClassificationTotal (processVotesFrom treeSize state votes) := by
  induction votes generalizing state with
  | nil =>
      simp [processVotesFrom, hRejected]
  | cons vote rest ih =>
      simp [processVotesFrom]
      exact ih (processVote treeSize state vote)
        (processVote_preserves_rejected_records_classification hRejected)

theorem rejected_records_classification
    (treeSize : Nat) (votes : List GuestVote) :
    (processVotes treeSize votes).rejectedRecords =
      rejectionClassificationTotal (processVotes treeSize votes) := by
  unfold processVotes
  exact rejected_records_classification_from treeSize votes (initialGuestState treeSize) (by rfl)

theorem processVote_rejectedRecords_delta_le_one
    {treeSize : Nat} {state : GuestState} {vote : GuestVote} :
    (processVote treeSize state vote).rejectedRecords ≤ state.rejectedRecords + 1 := by
  unfold processVote
  cases hOutcome : classifyVote treeSize state vote with
  | accepted =>
      simp [
        applyVoteOutcome,
        markSeenIndex,
        insertCommitment,
        acceptVote
      ]
  | rejected reason slotSeen commitmentReserved =>
      cases slotSeen <;> cases commitmentReserved <;>
        simp [
          applyVoteOutcome,
          stateAfterOutcomeReservations,
          markSeenIndex,
          insertCommitment,
          rejectVote
        ]

theorem rejected_records_le_initial_plus_votes_length
    (treeSize : Nat) (votes : List GuestVote) (state : GuestState) :
    (processVotesFrom treeSize state votes).rejectedRecords ≤ state.rejectedRecords + votes.length := by
  induction votes generalizing state with
  | nil =>
      simp [processVotesFrom]
  | cons vote rest ih =>
      change
        (processVotesFrom treeSize (processVote treeSize state vote) rest).rejectedRecords ≤
          state.rejectedRecords + (vote :: rest).length
      have hStep := processVote_rejectedRecords_delta_le_one
        (treeSize := treeSize) (state := state) (vote := vote)
      have hRest := ih (processVote treeSize state vote)
      simp only [List.length_cons]
      omega

theorem processVotes_rejected_records_le_votes_length
    (treeSize : Nat) (votes : List GuestVote) :
    (processVotes treeSize votes).rejectedRecords ≤ votes.length := by
  unfold processVotes
  simpa [initialGuestState] using
    rejected_records_le_initial_plus_votes_length treeSize votes (initialGuestState treeSize)

theorem no_overflow_under_guest_bounds
    (treeSize : Nat) (votes : List GuestVote)
    (hBounds : GuestBounds treeSize votes.length) :
    (processVotes treeSize votes).seenIndices.length ≤ rustU32Max ∧
      (processVotes treeSize votes).validVotes ≤ rustU32Max ∧
      (processVotes treeSize votes).rejectedRecords ≤ rustU32Max ∧
      (processVotes treeSize votes).verifiedTally.choice0 ≤ rustU32Max ∧
      (processVotes treeSize votes).verifiedTally.choice1 ≤ rustU32Max ∧
      (processVotes treeSize votes).verifiedTally.choice2 ≤ rustU32Max ∧
      (processVotes treeSize votes).verifiedTally.choice3 ≤ rustU32Max ∧
      (processVotes treeSize votes).verifiedTally.choice4 ≤ rustU32Max ∧
      candidateTallyBucketsWithin formalGuestMaxTallyBucket
        (processVotes treeSize votes).verifiedTally := by
  have hSeenTree := processVotes_seen_indices_length_le_treeSize treeSize votes
  have hInv := processVotes_fold_invariant treeSize votes
  have hRejected := processVotes_rejected_records_le_votes_length treeSize votes
  have hFormalTreeU32 : formalGuestMaxTreeSize ≤ rustU32Max := by
    unfold formalGuestMaxTreeSize rustU32Max
    omega
  have hFormalVoteU32 : formalGuestMaxVoteCount ≤ rustU32Max := by
    unfold formalGuestMaxVoteCount rustU32Max
    omega
  have hValidBound : (processVotes treeSize votes).validVotes ≤ rustU32Max :=
    Nat.le_trans hInv.2.2
      (Nat.le_trans hSeenTree (Nat.le_trans hBounds.treeSizeWithinFormalBound hFormalTreeU32))
  have hValidFormalBound :
      (processVotes treeSize votes).validVotes ≤ formalGuestMaxTallyBucket := by
    unfold formalGuestMaxTallyBucket
    exact Nat.le_trans hInv.2.2
      (Nat.le_trans hSeenTree hBounds.treeSizeWithinFormalBound)
  have hTallyTotal := accepted_votes_count_tally treeSize votes
  have hTallyTotalBound :
      tallyTotal (processVotes treeSize votes).verifiedTally ≤ rustU32Max := by
    rw [hTallyTotal]
    exact hValidBound
  have hTallyTotalFormalBound :
      tallyTotal (processVotes treeSize votes).verifiedTally ≤ formalGuestMaxTallyBucket := by
    rw [hTallyTotal]
    exact hValidFormalBound
  have hBuckets := candidate_tally_buckets_le_total (processVotes treeSize votes).verifiedTally
  constructor
  · exact Nat.le_trans hSeenTree
      (Nat.le_trans hBounds.treeSizeWithinFormalBound hFormalTreeU32)
  constructor
  · exact hValidBound
  constructor
  · exact Nat.le_trans hRejected
      (Nat.le_trans hBounds.voteCountWithinFormalBound hFormalVoteU32)
  · rcases hBuckets with ⟨hChoice0, hChoice1, hChoice2, hChoice3, hChoice4⟩
    constructor
    · exact Nat.le_trans hChoice0 hTallyTotalBound
    constructor
    · exact Nat.le_trans hChoice1 hTallyTotalBound
    constructor
    · exact Nat.le_trans hChoice2 hTallyTotalBound
    constructor
    · exact Nat.le_trans hChoice3 hTallyTotalBound
    constructor
    · exact Nat.le_trans hChoice4 hTallyTotalBound
    · exact ⟨
        Nat.le_trans hChoice0 hTallyTotalFormalBound,
        Nat.le_trans hChoice1 hTallyTotalFormalBound,
        Nat.le_trans hChoice2 hTallyTotalFormalBound,
        Nat.le_trans hChoice3 hTallyTotalFormalBound,
        Nat.le_trans hChoice4 hTallyTotalFormalBound
      ⟩

theorem duplicate_index_rejected_before_marking
    {treeSize : Nat} {state : GuestState} {vote : GuestVote}
    (hIndex : vote.index < treeSize)
    (hDuplicate : hasSeenIndex state vote.index = true) :
    processVote treeSize state vote =
      rejectVote state .duplicate_index := by
  unfold processVote classifyVote
  simp [
    hIndex,
    hDuplicate,
    applyVoteOutcome,
    stateAfterOutcomeReservations,
    rejectVote
  ]

theorem invalid_choice_marks_seen_slot
    {treeSize : Nat} {state : GuestState} {vote : GuestVote}
    (hIndex : vote.index < treeSize)
    (hFresh : hasSeenIndex state vote.index = false)
    (hInvalidChoice : vote.choice ≥ 5) :
    (processVote treeSize state vote).seenIndices =
        vote.index :: state.seenIndices ∧
      (processVote treeSize state vote).validVotes = state.validVotes ∧
      (processVote treeSize state vote).rejectedReasons =
        .invalid_choice :: state.rejectedReasons := by
  have hChoiceFalse : ¬vote.choice < 5 := by omega
  unfold processVote classifyVote
  simp [
    hIndex,
    hFresh,
    hChoiceFalse,
    applyVoteOutcome,
    stateAfterOutcomeReservations,
    markSeenIndex,
    rejectVote
  ]

theorem invalid_inclusion_reserves_commitment
    {treeSize : Nat} {state : GuestState} {vote : GuestVote}
    (hIndex : vote.index < treeSize)
    (hFresh : hasSeenIndex state vote.index = false)
    (hChoice : vote.choice < 5)
    (hCommitmentOk : vote.commitmentOk = true)
    (hFreshCommitment : hasSeenCommitment (markSeenIndex state vote.index) vote.commitment = false)
    (hInclusion : vote.inclusionOk = false) :
    (processVote treeSize state vote).seenCommitments =
        vote.commitment :: state.seenCommitments ∧
      (processVote treeSize state vote).rejectedReasons =
        .invalid_inclusion_proof :: state.rejectedReasons := by
  have hFreshCommitment' :
      hasSeenCommitment
          { seenIndices := vote.index :: state.seenIndices,
            seenCommitments := state.seenCommitments,
            includedBitmap := state.includedBitmap,
            validVotes := state.validVotes,
            rejectedRecords := state.rejectedRecords,
            rejectedReasons := state.rejectedReasons,
            verifiedTally := state.verifiedTally }
          vote.commitment = false := by
    simpa [markSeenIndex] using hFreshCommitment
  unfold processVote classifyVote
  simp [
    hIndex,
    hFresh,
    hChoice,
    hCommitmentOk,
    hFreshCommitment',
    hInclusion,
    applyVoteOutcome,
    stateAfterOutcomeReservations,
    markSeenIndex,
    insertCommitment,
    rejectVote
  ]

theorem zero_exclusion_counts_complete
    {treeSize : Nat} {state : GuestState}
    (hExcluded : guestExcludedSlots treeSize state = 0)
    (hValidSeen : state.validVotes ≤ state.seenIndices.length)
    (hSeenTree : state.seenIndices.length ≤ treeSize) :
    state.seenIndices.length = treeSize ∧
      state.validVotes = state.seenIndices.length ∧
      state.validVotes = treeSize := by
  unfold guestExcludedSlots guestMissingSlots guestInvalidPresentedSlots at hExcluded
  exact slot_partition_total rfl rfl rfl hExcluded hValidSeen hSeenTree

theorem zero_exclusion_guest_model_complete
    (treeSize : Nat) (votes : List GuestVote)
    (hExcluded : guestExcludedSlots treeSize (processVotes treeSize votes) = 0) :
    (processVotes treeSize votes).seenIndices.length = treeSize ∧
      (processVotes treeSize votes).validVotes =
        (processVotes treeSize votes).seenIndices.length ∧
      (processVotes treeSize votes).validVotes = treeSize := by
  have hInv := processVotes_fold_invariant treeSize votes
  have hSeenTree := processVotes_seen_indices_length_le_treeSize treeSize votes
  exact zero_exclusion_counts_complete hExcluded hInv.2.2 hSeenTree

end StarkBallotFormal
