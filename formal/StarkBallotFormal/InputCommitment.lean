import StarkBallotFormal.Basic

namespace StarkBallotFormal

def u16Max : Nat := 65535
def u32Max : Nat := 4294967295
def inputCommitmentFormatVersion : Nat := 10
def inputDomainTagBytes : List Nat :=
  [115, 116, 97, 114, 107, 45, 98, 97, 108, 108, 111, 116, 58, 105, 110, 112, 117, 116, 124, 118, 49, 46, 48]

structure CommitmentVote where
  id : String
  index : Nat
  commitment : List Nat
  merklePath : List (List Nat)
  deriving Repr

structure InputCommitmentCase where
  name : String
  electionIdText : String
  electionId : List Nat
  bulletinRoot : List Nat
  treeSize : Nat
  totalExpected : Nat
  votes : List CommitmentVote
  deriving Repr

structure CommitmentVoteEncoding where
  index : Nat
  commitment : List Nat
  merklePath : List (List Nat)
  deriving DecidableEq, Repr

def boundedU16 (value : Nat) : Prop :=
  value ≤ u16Max

def boundedU32 (value : Nat) : Prop :=
  value ≤ u32Max

def byteBounded (bytes : List Nat) : Prop :=
  ∀ byte, byte ∈ bytes → byte ≤ 255

def voteEncoding (vote : CommitmentVote) : CommitmentVoteEncoding := {
  index := vote.index
  commitment := vote.commitment
  merklePath := vote.merklePath
}

def wellFormedVoteEncoding (vote : CommitmentVoteEncoding) : Prop :=
  boundedU32 vote.index ∧
    vote.commitment.length = 32 ∧
    byteBounded vote.commitment ∧
    boundedU16 vote.merklePath.length ∧
    ∀ node, node ∈ vote.merklePath → node.length = 32 ∧ byteBounded node

def wellFormedInputCommitmentCase (testCase : InputCommitmentCase) : Prop :=
  testCase.electionId.length = 16 ∧
    byteBounded testCase.electionId ∧
    testCase.bulletinRoot.length = 32 ∧
    byteBounded testCase.bulletinRoot ∧
    boundedU32 testCase.treeSize ∧
    boundedU32 testCase.totalExpected ∧
    boundedU32 testCase.votes.length ∧
    ∀ vote, vote ∈ testCase.votes → wellFormedVoteEncoding (voteEncoding vote)

/-- A well-formed input case carries exactly the integer-width obligations used
by the implementation encoder: `u32` public counters and vote indices, plus
`u16` Merkle path lengths. -/
theorem wellFormedInputCommitmentCase_encoding_bounds
    (testCase : InputCommitmentCase)
    (hWellFormed : wellFormedInputCommitmentCase testCase) :
    boundedU32 testCase.treeSize ∧
      boundedU32 testCase.totalExpected ∧
      boundedU32 testCase.votes.length ∧
      ∀ vote, vote ∈ testCase.votes →
        boundedU32 (voteEncoding vote).index ∧
          boundedU16 (voteEncoding vote).merklePath.length := by
  rcases hWellFormed with
    ⟨_, _, _, _, hTreeSize, hTotalExpected, hVoteCount, hVotes⟩
  refine ⟨hTreeSize, hTotalExpected, hVoteCount, ?_⟩
  intro vote hVote
  have hVoteWellFormed := hVotes vote hVote
  exact ⟨hVoteWellFormed.1, hVoteWellFormed.2.2.2.1⟩

def lexNatLE : List Nat → List Nat → Bool
  | [], _ => true
  | _ :: _, [] => false
  | left :: leftRest, right :: rightRest =>
      if left = right then lexNatLE leftRest rightRest else left ≤ right

def lexPathLE : List (List Nat) → List (List Nat) → Bool
  | [], _ => true
  | _ :: _, [] => false
  | left :: leftRest, right :: rightRest =>
      if left = right then lexPathLE leftRest rightRest else lexNatLE left right

def canonicalEncodingLE (left right : CommitmentVoteEncoding) : Bool :=
  if left.index = right.index then
    if left.commitment = right.commitment then
      lexPathLE left.merklePath right.merklePath
    else
      lexNatLE left.commitment right.commitment
  else
    left.index ≤ right.index

def canonicalVoteLE (left right : CommitmentVote) : Bool :=
  canonicalEncodingLE (voteEncoding left) (voteEncoding right)

def canonicalVotes (votes : List CommitmentVote) : List CommitmentVote :=
  votes.mergeSort canonicalVoteLE

def canonicalVoteEncodings (votes : List CommitmentVote) : List CommitmentVoteEncoding :=
  (votes.map voteEncoding).mergeSort canonicalEncodingLE

def u16LE (value : Nat) : List Nat :=
  [value % 256, (value / 256) % 256]

def u32LE (value : Nat) : List Nat :=
  [value % 256, (value / 256) % 256, (value / 65536) % 256, (value / 16777216) % 256]

def encodeVoteForInputCommitment (vote : CommitmentVoteEncoding) : List Nat :=
  u32LE vote.index ++
    u16LE 32 ++
    vote.commitment ++
    u16LE vote.merklePath.length ++
    vote.merklePath.flatten

def canonicalInputCommitmentPreimage (testCase : InputCommitmentCase) : List Nat :=
  inputDomainTagBytes ++
    u32LE inputCommitmentFormatVersion ++
    testCase.electionId ++
    testCase.bulletinRoot ++
    u32LE testCase.treeSize ++
    u32LE testCase.totalExpected ++
    u32LE testCase.votes.length ++
    (canonicalVoteEncodings testCase.votes).flatMap encodeVoteForInputCommitment

theorem lexNatLE_refl (value : List Nat) : lexNatLE value value = true := by
  induction value with
  | nil => simp [lexNatLE]
  | cons _ _ ih => simp [lexNatLE, ih]

theorem lexNatLE_antisymm
    (left right : List Nat)
    (hLeft : lexNatLE left right = true)
    (hRight : lexNatLE right left = true) :
    left = right := by
  induction left generalizing right with
  | nil =>
      cases right with
      | nil => rfl
      | cons _ _ => simp [lexNatLE] at hRight
  | cons leftHead leftTail ih =>
      cases right with
      | nil => simp [lexNatLE] at hLeft
      | cons rightHead rightTail =>
          by_cases hEq : leftHead = rightHead
          · subst rightHead
            simp [lexNatLE] at hLeft hRight
            exact congrArg (List.cons leftHead) (ih rightTail hLeft hRight)
          · have hLeftHead : leftHead ≤ rightHead := by
              simpa [lexNatLE, hEq] using hLeft
            have hNeSymm : rightHead ≠ leftHead := by
              intro h
              exact hEq h.symm
            have hRightHead : rightHead ≤ leftHead := by
              simpa [lexNatLE, hNeSymm] using hRight
            have hHead : leftHead = rightHead := Nat.le_antisymm hLeftHead hRightHead
            exact False.elim (hEq hHead)

theorem lexNatLE_trans
    (left middle right : List Nat)
    (hLeft : lexNatLE left middle = true)
    (hRight : lexNatLE middle right = true) :
    lexNatLE left right = true := by
  induction left generalizing middle right with
  | nil => simp [lexNatLE]
  | cons leftHead leftTail ih =>
      cases middle with
      | nil => simp [lexNatLE] at hLeft
      | cons middleHead middleTail =>
          cases right with
          | nil => simp [lexNatLE] at hRight
          | cons rightHead rightTail =>
              by_cases hLeftMiddle : leftHead = middleHead
              · subst middleHead
                by_cases hMiddleRight : leftHead = rightHead
                · subst rightHead
                  simp [lexNatLE] at hLeft hRight ⊢
                  exact ih middleTail rightTail hLeft hRight
                · have hLeftRight : leftHead ≤ rightHead := by
                    simpa [lexNatLE, hMiddleRight] using hRight
                  simp [lexNatLE, hMiddleRight, hLeftRight]
              · have hLeftMiddleLe : leftHead ≤ middleHead := by
                  simpa [lexNatLE, hLeftMiddle] using hLeft
                by_cases hMiddleRight : middleHead = rightHead
                · subst rightHead
                  simp [lexNatLE, hLeftMiddle, hLeftMiddleLe]
                · have hMiddleRightLe : middleHead ≤ rightHead := by
                    simpa [lexNatLE, hMiddleRight] using hRight
                  have hLeftRightLe : leftHead ≤ rightHead :=
                    Nat.le_trans hLeftMiddleLe hMiddleRightLe
                  by_cases hLeftRight : leftHead = rightHead
                  · have hMiddleLeft : middleHead ≤ leftHead := by
                      simpa [hLeftRight] using hMiddleRightLe
                    have hMiddleEq : leftHead = middleHead :=
                      Nat.le_antisymm hLeftMiddleLe hMiddleLeft
                    exact False.elim (hLeftMiddle hMiddleEq)
                  · simp [lexNatLE, hLeftRight, hLeftRightLe]

theorem lexPathLE_refl (value : List (List Nat)) : lexPathLE value value = true := by
  induction value with
  | nil => simp [lexPathLE]
  | cons _ _ ih => simp [lexPathLE, ih]

theorem lexPathLE_antisymm
    (left right : List (List Nat))
    (hLeft : lexPathLE left right = true)
    (hRight : lexPathLE right left = true) :
    left = right := by
  induction left generalizing right with
  | nil =>
      cases right with
      | nil => rfl
      | cons _ _ => simp [lexPathLE] at hRight
  | cons leftHead leftTail ih =>
      cases right with
      | nil => simp [lexPathLE] at hLeft
      | cons rightHead rightTail =>
          by_cases hEq : leftHead = rightHead
          · subst rightHead
            simp [lexPathLE] at hLeft hRight
            exact congrArg (List.cons leftHead) (ih rightTail hLeft hRight)
          · have hLeftHead : lexNatLE leftHead rightHead = true := by
              simpa [lexPathLE, hEq] using hLeft
            have hNeSymm : rightHead ≠ leftHead := by
              intro h
              exact hEq h.symm
            have hRightHead : lexNatLE rightHead leftHead = true := by
              simpa [lexPathLE, hNeSymm] using hRight
            have hHead : leftHead = rightHead :=
              lexNatLE_antisymm leftHead rightHead hLeftHead hRightHead
            exact False.elim (hEq hHead)

theorem lexPathLE_trans
    (left middle right : List (List Nat))
    (hLeft : lexPathLE left middle = true)
    (hRight : lexPathLE middle right = true) :
    lexPathLE left right = true := by
  induction left generalizing middle right with
  | nil => simp [lexPathLE]
  | cons leftHead leftTail ih =>
      cases middle with
      | nil => simp [lexPathLE] at hLeft
      | cons middleHead middleTail =>
          cases right with
          | nil => simp [lexPathLE] at hRight
          | cons rightHead rightTail =>
              by_cases hLeftMiddle : leftHead = middleHead
              · subst middleHead
                by_cases hMiddleRight : leftHead = rightHead
                · subst rightHead
                  simp [lexPathLE] at hLeft hRight ⊢
                  exact ih middleTail rightTail hLeft hRight
                · have hLeftRight : lexNatLE leftHead rightHead = true := by
                    simpa [lexPathLE, hMiddleRight] using hRight
                  simp [lexPathLE, hMiddleRight, hLeftRight]
              · have hLeftMiddleLe : lexNatLE leftHead middleHead = true := by
                  simpa [lexPathLE, hLeftMiddle] using hLeft
                by_cases hMiddleRight : middleHead = rightHead
                · subst rightHead
                  simp [lexPathLE, hLeftMiddle, hLeftMiddleLe]
                · have hMiddleRightLe : lexNatLE middleHead rightHead = true := by
                    simpa [lexPathLE, hMiddleRight] using hRight
                  have hLeftRightLe : lexNatLE leftHead rightHead = true :=
                    lexNatLE_trans leftHead middleHead rightHead hLeftMiddleLe hMiddleRightLe
                  by_cases hLeftRight : leftHead = rightHead
                  · have hMiddleLeft : lexNatLE middleHead leftHead = true := by
                      simpa [hLeftRight] using hMiddleRightLe
                    have hMiddleEq : leftHead = middleHead :=
                      lexNatLE_antisymm leftHead middleHead hLeftMiddleLe hMiddleLeft
                    exact False.elim (hLeftMiddle hMiddleEq)
                  · simp [lexPathLE, hLeftRight, hLeftRightLe]

theorem lexNatLE_total (left right : List Nat) :
    lexNatLE left right = true ∨ lexNatLE right left = true := by
  induction left generalizing right with
  | nil =>
      simp [lexNatLE]
  | cons leftHead leftTail ih =>
      cases right with
      | nil =>
          simp [lexNatLE]
      | cons rightHead rightTail =>
          by_cases hEq : leftHead = rightHead
          · simpa [lexNatLE, hEq] using ih rightTail
          · have hNat : leftHead ≤ rightHead ∨ rightHead ≤ leftHead := Nat.le_total leftHead rightHead
            cases hNat with
            | inl hLeft =>
                left
                simp [lexNatLE, hEq, hLeft]
            | inr hRight =>
                right
                have hNeSymm : rightHead ≠ leftHead := by
                  intro h
                  exact hEq h.symm
                simp [lexNatLE, hNeSymm, hRight]

theorem lexPathLE_total (left right : List (List Nat)) :
    lexPathLE left right = true ∨ lexPathLE right left = true := by
  induction left generalizing right with
  | nil =>
      simp [lexPathLE]
  | cons leftHead leftTail ih =>
      cases right with
      | nil =>
          simp [lexPathLE]
      | cons rightHead rightTail =>
          by_cases hEq : leftHead = rightHead
          · simpa [lexPathLE, hEq] using ih rightTail
          · have hNodes : lexNatLE leftHead rightHead = true ∨ lexNatLE rightHead leftHead = true :=
              lexNatLE_total leftHead rightHead
            cases hNodes with
            | inl hLeft =>
                left
                simp [lexPathLE, hEq, hLeft]
            | inr hRight =>
                right
                have hNeSymm : rightHead ≠ leftHead := by
                  intro h
                  exact hEq h.symm
                simp [lexPathLE, hNeSymm, hRight]

theorem canonicalEncodingLE_refl (value : CommitmentVoteEncoding) :
    canonicalEncodingLE value value = true := by
  cases value
  simp [canonicalEncodingLE, lexPathLE_refl]

theorem canonicalEncodingLE_antisymm
    (left right : CommitmentVoteEncoding)
    (hLeft : canonicalEncodingLE left right = true)
    (hRight : canonicalEncodingLE right left = true) :
    left = right := by
  cases left with
  | mk leftIndex leftCommitment leftPath =>
  cases right with
  | mk rightIndex rightCommitment rightPath =>
      simp [canonicalEncodingLE] at hLeft hRight ⊢
      by_cases hIndex : leftIndex = rightIndex
      · subst rightIndex
        simp at hLeft hRight
        by_cases hCommitment : leftCommitment = rightCommitment
        · subst rightCommitment
          simp at hLeft hRight
          exact ⟨rfl, rfl, lexPathLE_antisymm leftPath rightPath hLeft hRight⟩
        · have hLeftCommitment : lexNatLE leftCommitment rightCommitment = true := by
            simpa [hCommitment] using hLeft
          have hCommitmentNeSymm : rightCommitment ≠ leftCommitment := by
            intro h
            exact hCommitment h.symm
          have hRightCommitment : lexNatLE rightCommitment leftCommitment = true := by
            simpa [hCommitmentNeSymm] using hRight
          exact False.elim
            (hCommitment
              (lexNatLE_antisymm leftCommitment rightCommitment hLeftCommitment hRightCommitment))
      · have hLeftIndex : leftIndex ≤ rightIndex := by
          simpa [hIndex] using hLeft
        have hIndexNeSymm : rightIndex ≠ leftIndex := by
          intro h
          exact hIndex h.symm
        have hRightIndex : rightIndex ≤ leftIndex := by
          simpa [hIndexNeSymm] using hRight
        exact False.elim (hIndex (Nat.le_antisymm hLeftIndex hRightIndex))

theorem canonicalEncodingLE_trans
    (left middle right : CommitmentVoteEncoding)
    (hLeft : canonicalEncodingLE left middle = true)
    (hRight : canonicalEncodingLE middle right = true) :
    canonicalEncodingLE left right = true := by
  cases left with
  | mk leftIndex leftCommitment leftPath =>
  cases middle with
  | mk middleIndex middleCommitment middlePath =>
  cases right with
  | mk rightIndex rightCommitment rightPath =>
      simp [canonicalEncodingLE] at hLeft hRight ⊢
      by_cases hLeftMiddleIndex : leftIndex = middleIndex
      · subst middleIndex
        by_cases hMiddleRightIndex : leftIndex = rightIndex
        · subst rightIndex
          simp at hLeft hRight ⊢
          by_cases hLeftMiddleCommitment : leftCommitment = middleCommitment
          · subst middleCommitment
            by_cases hMiddleRightCommitment : leftCommitment = rightCommitment
            · subst rightCommitment
              simp at hLeft hRight ⊢
              exact lexPathLE_trans leftPath middlePath rightPath hLeft hRight
            · have hLeftRightCommitment : lexNatLE leftCommitment rightCommitment = true := by
                simpa [hMiddleRightCommitment] using hRight
              simp [hMiddleRightCommitment, hLeftRightCommitment]
          · have hLeftMiddleCommitmentLe : lexNatLE leftCommitment middleCommitment = true := by
              simpa [hLeftMiddleCommitment] using hLeft
            by_cases hMiddleRightCommitment : middleCommitment = rightCommitment
            · subst rightCommitment
              simp [hLeftMiddleCommitment, hLeftMiddleCommitmentLe]
            · have hMiddleRightCommitmentLe :
                  lexNatLE middleCommitment rightCommitment = true := by
                simpa [hMiddleRightCommitment] using hRight
              have hLeftRightCommitmentLe :
                  lexNatLE leftCommitment rightCommitment = true :=
                lexNatLE_trans leftCommitment middleCommitment rightCommitment
                  hLeftMiddleCommitmentLe hMiddleRightCommitmentLe
              by_cases hLeftRightCommitment : leftCommitment = rightCommitment
              · have hMiddleLeftCommitment : lexNatLE middleCommitment leftCommitment = true := by
                  simpa [hLeftRightCommitment] using hMiddleRightCommitmentLe
                have hCommitmentEq : leftCommitment = middleCommitment :=
                  lexNatLE_antisymm leftCommitment middleCommitment
                    hLeftMiddleCommitmentLe hMiddleLeftCommitment
                exact False.elim (hLeftMiddleCommitment hCommitmentEq)
              · simp [hLeftRightCommitment, hLeftRightCommitmentLe]
        · have hLeftRightIndex : leftIndex ≤ rightIndex := by
            simpa [hMiddleRightIndex] using hRight
          simp [hMiddleRightIndex, hLeftRightIndex]
      · have hLeftMiddleIndexLe : leftIndex ≤ middleIndex := by
          simpa [hLeftMiddleIndex] using hLeft
        by_cases hMiddleRightIndex : middleIndex = rightIndex
        · subst rightIndex
          simp [hLeftMiddleIndex, hLeftMiddleIndexLe]
        · have hMiddleRightIndexLe : middleIndex ≤ rightIndex := by
            simpa [hMiddleRightIndex] using hRight
          have hLeftRightIndexLe : leftIndex ≤ rightIndex :=
            Nat.le_trans hLeftMiddleIndexLe hMiddleRightIndexLe
          by_cases hLeftRightIndex : leftIndex = rightIndex
          · have hMiddleLeftIndex : middleIndex ≤ leftIndex := by
              simpa [hLeftRightIndex] using hMiddleRightIndexLe
            have hIndexEq : leftIndex = middleIndex :=
              Nat.le_antisymm hLeftMiddleIndexLe hMiddleLeftIndex
            exact False.elim (hLeftMiddleIndex hIndexEq)
          · simp [hLeftRightIndex, hLeftRightIndexLe]

theorem canonicalEncodingLE_total (left right : CommitmentVoteEncoding) :
    canonicalEncodingLE left right = true ∨ canonicalEncodingLE right left = true := by
  cases left with
  | mk leftIndex leftCommitment leftPath =>
  cases right with
  | mk rightIndex rightCommitment rightPath =>
      simp [canonicalEncodingLE]
      by_cases hIndex : leftIndex = rightIndex
      · subst rightIndex
        simp
        by_cases hCommitment : leftCommitment = rightCommitment
        · subst rightCommitment
          simpa using lexPathLE_total leftPath rightPath
        · have hCommitmentTotal := lexNatLE_total leftCommitment rightCommitment
          cases hCommitmentTotal with
          | inl hLeft =>
              left
              simp [hCommitment, hLeft]
          | inr hRight =>
              right
              have hCommitmentNeSymm : rightCommitment ≠ leftCommitment := by
                intro h
                exact hCommitment h.symm
              simp [hCommitmentNeSymm, hRight]
      · have hIndexTotal : leftIndex ≤ rightIndex ∨ rightIndex ≤ leftIndex :=
          Nat.le_total leftIndex rightIndex
        cases hIndexTotal with
        | inl hLeft =>
            left
            simp [hIndex, hLeft]
        | inr hRight =>
            right
            have hIndexNeSymm : rightIndex ≠ leftIndex := by
              intro h
              exact hIndex h.symm
            simp [hIndexNeSymm, hRight]

theorem canonicalEncodingLE_total_bool (left right : CommitmentVoteEncoding) :
    (canonicalEncodingLE left right || canonicalEncodingLE right left) = true := by
  cases canonicalEncodingLE_total left right with
  | inl hLeft => simp [hLeft]
  | inr hRight => simp [hRight]

theorem canonical_vote_order_total (left right : CommitmentVote) :
    canonicalVoteLE left right = true ∨ canonicalVoteLE right left = true := by
  simpa [canonicalVoteLE] using
    canonicalEncodingLE_total (voteEncoding left) (voteEncoding right)

theorem sorted_perm_eq_by_head
    {α : Type}
    {le : α → α → Bool}
    (refl : ∀ value, le value value = true)
    (antisym : ∀ left right, le left right = true → le right left = true → left = right)
    {left right : List α}
    (hLeft : left.Pairwise (fun a b => le a b = true))
    (hRight : right.Pairwise (fun a b => le a b = true))
    (hPermutation : left.Perm right) :
    left = right := by
  induction left generalizing right with
  | nil =>
      exact (List.Perm.eq_nil hPermutation.symm).symm
  | cons head leftTail ih =>
      cases right with
      | nil =>
          have hNil : (head :: leftTail) = ([] : List α) := List.Perm.eq_nil hPermutation
          cases hNil
      | cons rightHead rightTail =>
          have hRightHeadInLeft : rightHead ∈ head :: leftTail :=
            hPermutation.symm.subset (List.Mem.head rightTail)
          have hHeadInRight : head ∈ rightHead :: rightTail :=
            hPermutation.subset (List.Mem.head leftTail)
          have hRightHeadLeHead : le rightHead head = true := by
            cases hHeadInRight with
            | head => exact refl _
            | tail _ hTail => exact List.rel_of_pairwise_cons hRight hTail
          have hHeadLeRightHead : le head rightHead = true := by
            cases hRightHeadInLeft with
            | head => exact refl _
            | tail _ hTail => exact List.rel_of_pairwise_cons hLeft hTail
          have hHead : head = rightHead :=
            antisym head rightHead hHeadLeRightHead hRightHeadLeHead
          subst rightHead
          have hTailPermutation : leftTail.Perm rightTail :=
            List.Perm.cons_inv hPermutation
          have hLeftTail : leftTail.Pairwise (fun a b => le a b = true) := by
            simpa using List.Pairwise.tail hLeft
          have hRightTail : rightTail.Pairwise (fun a b => le a b = true) := by
            simpa using List.Pairwise.tail hRight
          simp [ih hLeftTail hRightTail hTailPermutation]

theorem canonical_vote_encodings_permutation_invariant
    {left right : List CommitmentVote}
    (hEncodingPermutation : (left.map voteEncoding).Perm (right.map voteEncoding)) :
    canonicalVoteEncodings left = canonicalVoteEncodings right := by
  let leftKeys := left.map voteEncoding
  let rightKeys := right.map voteEncoding
  have hSortedPermutation :
      (leftKeys.mergeSort canonicalEncodingLE).Perm
        (rightKeys.mergeSort canonicalEncodingLE) :=
    ((List.mergeSort_perm leftKeys canonicalEncodingLE).trans hEncodingPermutation).trans
      (List.mergeSort_perm rightKeys canonicalEncodingLE).symm
  have hLeftSorted :
      (leftKeys.mergeSort canonicalEncodingLE).Pairwise
        (fun a b => canonicalEncodingLE a b = true) :=
    List.pairwise_mergeSort canonicalEncodingLE_trans canonicalEncodingLE_total_bool leftKeys
  have hRightSorted :
      (rightKeys.mergeSort canonicalEncodingLE).Pairwise
        (fun a b => canonicalEncodingLE a b = true) :=
    List.pairwise_mergeSort canonicalEncodingLE_trans canonicalEncodingLE_total_bool rightKeys
  exact sorted_perm_eq_by_head
    canonicalEncodingLE_refl
    canonicalEncodingLE_antisymm
    hLeftSorted
    hRightSorted
    hSortedPermutation

/-- If two input cases differ only by a permutation of the same votes, their
canonical input-commitment preimage bytes are identical. The proof is over
`CommitmentVoteEncoding`, which intentionally excludes the non-hashed vector
`id` field. The well-formed preconditions document the implementation widths
that TypeScript and Rust test vectors exercise instead of treating arbitrary
`Nat` modulo encodings as accepted implementation inputs. -/
theorem canonical_encoding_permutation_invariant
    (left right : InputCommitmentCase)
    (hLeftWellFormed : wellFormedInputCommitmentCase left)
    (hRightWellFormed : wellFormedInputCommitmentCase right)
    (hEncodingPermutation : (left.votes.map voteEncoding).Perm (right.votes.map voteEncoding))
    (hElection : left.electionId = right.electionId)
    (hRoot : left.bulletinRoot = right.bulletinRoot)
    (hTree : left.treeSize = right.treeSize)
    (hExpected : left.totalExpected = right.totalExpected) :
    canonicalInputCommitmentPreimage left = canonicalInputCommitmentPreimage right := by
  have hLeftEncodingBounds :=
    wellFormedInputCommitmentCase_encoding_bounds left hLeftWellFormed
  have hRightEncodingBounds :=
    wellFormedInputCommitmentCase_encoding_bounds right hRightWellFormed
  have _hEncodingBoundsDocumented :
      boundedU32 left.treeSize ∧
        boundedU32 right.treeSize ∧
        boundedU32 left.totalExpected ∧
        boundedU32 right.totalExpected ∧
        boundedU32 left.votes.length ∧
        boundedU32 right.votes.length :=
    ⟨hLeftEncodingBounds.1,
      hRightEncodingBounds.1,
      hLeftEncodingBounds.2.1,
      hRightEncodingBounds.2.1,
      hLeftEncodingBounds.2.2.1,
      hRightEncodingBounds.2.2.1⟩
  have hCanonicalEncoding :
      canonicalVoteEncodings left.votes = canonicalVoteEncodings right.votes :=
    canonical_vote_encodings_permutation_invariant hEncodingPermutation
  have hLength : left.votes.length = right.votes.length := by
    simpa using hEncodingPermutation.length_eq
  simp [canonicalInputCommitmentPreimage, hElection, hRoot, hTree, hExpected, hLength,
    hCanonicalEncoding]

theorem canonical_encoding_duplicate_indices_deterministic
    (left right : CommitmentVote)
    (hIndex : left.index = right.index) :
    canonicalVoteLE left right =
      if left.commitment = right.commitment then
        lexPathLE left.merklePath right.merklePath
      else
        lexNatLE left.commitment right.commitment := by
  cases left
  cases right
  simp [canonicalVoteLE, canonicalEncodingLE, voteEncoding] at hIndex ⊢
  simp [hIndex]

theorem encoded_vote_index_is_u32_bounded
    (vote : CommitmentVote)
    (h : boundedU32 vote.index) :
    vote.index ≤ u32Max := h

theorem encoded_vote_path_length_is_u16_bounded
    (vote : CommitmentVote)
    (h : boundedU16 vote.merklePath.length) :
    vote.merklePath.length ≤ u16Max := h

end StarkBallotFormal
