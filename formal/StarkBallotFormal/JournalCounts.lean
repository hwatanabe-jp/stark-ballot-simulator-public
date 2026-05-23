import StarkBallotFormal.Basic

namespace StarkBallotFormal

def missingSlotsOf (treeSize seenIndicesCount : Nat) : Nat :=
  treeSize - seenIndicesCount

def invalidPresentedSlotsOf (seenIndicesCount validVotes : Nat) : Nat :=
  seenIndicesCount - validVotes

def excludedSlotsOf (missingSlots invalidPresentedSlots : Nat) : Nat :=
  missingSlots + invalidPresentedSlots

theorem excluded_zero_implies_no_slot_loss
    {missingSlots invalidPresentedSlots excludedSlots : Nat}
    (hExcluded : excludedSlots = missingSlots + invalidPresentedSlots)
    (hZero : excludedSlots = 0) :
    missingSlots = 0 ∧ invalidPresentedSlots = 0 := by
  omega

theorem excluded_zero_implies_all_seen_slots_counted
    {validVotes seenIndicesCount treeSize missingSlots invalidPresentedSlots excludedSlots : Nat}
    (hMissing : missingSlots = missingSlotsOf treeSize seenIndicesCount)
    (hInvalid : invalidPresentedSlots = invalidPresentedSlotsOf seenIndicesCount validVotes)
    (hExcluded : excludedSlots = excludedSlotsOf missingSlots invalidPresentedSlots)
    (hZero : excludedSlots = 0)
    (hValidSeen : validVotes ≤ seenIndicesCount)
    (hSeenTree : seenIndicesCount ≤ treeSize) :
    seenIndicesCount = treeSize ∧ validVotes = seenIndicesCount := by
  unfold missingSlotsOf invalidPresentedSlotsOf excludedSlotsOf at *
  omega

theorem slot_partition_total
    {validVotes seenIndicesCount treeSize missingSlots invalidPresentedSlots excludedSlots : Nat}
    (hMissing : missingSlots = missingSlotsOf treeSize seenIndicesCount)
    (hInvalid : invalidPresentedSlots = invalidPresentedSlotsOf seenIndicesCount validVotes)
    (hExcluded : excludedSlots = excludedSlotsOf missingSlots invalidPresentedSlots)
    (hZero : excludedSlots = 0)
    (hValidSeen : validVotes ≤ seenIndicesCount)
    (hSeenTree : seenIndicesCount ≤ treeSize) :
    seenIndicesCount = treeSize ∧ validVotes = seenIndicesCount ∧ validVotes = treeSize := by
  unfold missingSlotsOf invalidPresentedSlotsOf excludedSlotsOf at *
  omega

end StarkBallotFormal
