import StarkBallotFormal.Basic

namespace StarkBallotFormal

def checkDefinitions : List CheckDefinition := [
  ⟨.cast_receipt_present, .cast_as_intended, .cast_receipt_integrity, .required⟩,
  ⟨.cast_choice_range, .cast_as_intended, .cast_receipt_integrity, .required⟩,
  ⟨.cast_random_format, .cast_as_intended, .cast_receipt_integrity, .required⟩,
  ⟨.cast_commitment_match, .cast_as_intended, .cast_receipt_integrity, .required⟩,
  ⟨.recorded_commitment_in_bulletin, .recorded_as_cast, .recorded_inclusion, .optional⟩,
  ⟨.recorded_index_in_range, .recorded_as_cast, .recorded_inclusion, .required⟩,
  ⟨.recorded_root_at_cast_consistent, .recorded_as_cast, .recorded_append_only, .optional⟩,
  ⟨.recorded_inclusion_proof, .recorded_as_cast, .recorded_inclusion, .required⟩,
  ⟨.recorded_consistency_proof, .recorded_as_cast, .recorded_append_only, .required⟩,
  ⟨.recorded_sth_third_party, .recorded_as_cast, .optional_external_audit, .optional⟩,
  ⟨.counted_input_sanity, .counted_as_recorded, .tally_input_integrity, .required⟩,
  ⟨.counted_unique_indices, .counted_as_recorded, .tally_input_integrity, .required⟩,
  ⟨.counted_unique_commitments, .counted_as_recorded, .tally_input_integrity, .required⟩,
  ⟨.counted_tally_consistent, .counted_as_recorded, .tally_consistency, .required⟩,
  ⟨.counted_missing_indices_zero, .counted_as_recorded, .tally_completeness, .required⟩,
  ⟨.counted_expected_vs_tree_size, .counted_as_recorded, .tally_input_integrity, .required⟩,
  ⟨.counted_election_manifest_consistent, .counted_as_recorded, .tally_input_integrity, .required⟩,
  ⟨.counted_close_statement_consistent, .counted_as_recorded, .tally_input_integrity, .required⟩,
  ⟨.counted_my_vote_included, .counted_as_recorded, .user_inclusion, .required⟩,
  ⟨.counted_input_commitment_match, .counted_as_recorded, .tally_input_integrity, .required⟩,
  ⟨.stark_image_id_match, .stark_verification, .proof_verification, .required⟩,
  ⟨.stark_receipt_verify, .stark_verification, .proof_verification, .required⟩
]

def isRequiredCheck (ctx : SummaryContext) (definition : CheckDefinition) : Bool :=
  definition.criticality == .required ||
    (definition.role == .optional_external_audit && ctx.sthSourcesConfigured)

def requiredDefinitions (ctx : SummaryContext) : List CheckDefinition :=
  checkDefinitions.filter (isRequiredCheck ctx)

def optionalDefinitions (ctx : SummaryContext) : List CheckDefinition :=
  checkDefinitions.filter (fun definition => !(isRequiredCheck ctx definition))

def checkStatusPriority : CheckStatus -> Nat
  | .success => 0
  | .not_run => 1
  | .pending => 2
  | .running => 3
  | .failed => 4

def worseStatus (left right : CheckStatus) : CheckStatus :=
  if checkStatusPriority left < checkStatusPriority right then right else left

def resolveWorstStatus : List CheckStatus -> Option CheckStatus
  | [] => none
  | first :: rest => some (rest.foldl worseStatus first)

def resultFor (checks : List CheckResult) (id : CheckId) : Option CheckStatus :=
  resolveWorstStatus (checks.filterMap (fun check =>
    match check.id with
    | .known knownId => if knownId == id then some check.status else none
    | .unknown _ => none))

def definitionFor (id : CheckId) : Option CheckDefinition :=
  checkDefinitions.find? (fun definition => definition.id == id)

def requiredCheckPresent (checks : List CheckResult) (definition : CheckDefinition) : Bool :=
  (resultFor checks definition.id).isSome

def requiredCheckSuccess (checks : List CheckResult) (definition : CheckDefinition) : Bool :=
  match resultFor checks definition.id with
  | some status => statusIsSuccess status
  | none => false

def allRequiredPresent (ctx : SummaryContext) (checks : List CheckResult) : Bool :=
  (requiredDefinitions ctx).all (requiredCheckPresent checks)

def allRequiredSuccess (ctx : SummaryContext) (checks : List CheckResult) : Bool :=
  (requiredDefinitions ctx).all (requiredCheckSuccess checks)

def noUnknownChecks (checks : List CheckResult) : Bool :=
  checks.all (fun check => isKnownRef check.id)

def roleRequiredSuccess (ctx : SummaryContext) (checks : List CheckResult) (role : CheckRole) : Bool :=
  (requiredDefinitions ctx).all (fun definition =>
    if definition.role == role then requiredCheckSuccess checks definition else true)

def proofVerificationRoleSuccess (ctx : SummaryContext) (checks : List CheckResult) : Bool :=
  roleRequiredSuccess ctx checks .proof_verification

def tallyCompletenessRoleSuccess (ctx : SummaryContext) (checks : List CheckResult) : Bool :=
  roleRequiredSuccess ctx checks .tally_completeness

def userInclusionRoleSuccess (ctx : SummaryContext) (checks : List CheckResult) : Bool :=
  roleRequiredSuccess ctx checks .user_inclusion

def requiredRolesSuccess (ctx : SummaryContext) (checks : List CheckResult) : Bool :=
  proofVerificationRoleSuccess ctx checks &&
    tallyCompletenessRoleSuccess ctx checks &&
    userInclusionRoleSuccess ctx checks

def optionalCheckBlocksFullyVerified (ctx : SummaryContext) (checks : List CheckResult) : Bool :=
  (optionalDefinitions ctx).any (fun definition =>
    match resultFor checks definition.id with
    | some status => statusBlocksOptionalFullyVerified status
    | none => false)

def anyRequiredInProgress (ctx : SummaryContext) (checks : List CheckResult) : Bool :=
  (requiredDefinitions ctx).any (fun definition =>
    match resultFor checks definition.id with
    | some status => statusIsInProgress status
    | none => false)

def requiredCheckNotRun (checks : List CheckResult) (definition : CheckDefinition) : Bool :=
  match resultFor checks definition.id with
  | some .not_run => true
  | _ => false

def anyRequiredNotRun (ctx : SummaryContext) (checks : List CheckResult) : Bool :=
  (requiredDefinitions ctx).any (requiredCheckNotRun checks)

def roleStatuses (checks : List CheckResult) (role : CheckRole) : List CheckStatus :=
  checks.filterMap (fun check =>
    match check.id with
    | .unknown _ => none
    | .known id =>
      match definitionFor id with
      | some definition => if definition.role == role then some check.status else none
      | none => none)

def roleStatus (checks : List CheckResult) (role : CheckRole) : Option CheckStatus :=
  resolveWorstStatus (roleStatuses checks role)

def roleStatusIs (checks : List CheckResult) (role : CheckRole) (status : CheckStatus) : Bool :=
  match roleStatus checks role with
  | some actual => actual == status
  | none => false

def roleStatusMissing (checks : List CheckResult) (role : CheckRole) : Bool :=
  match roleStatus checks role with
  | some _ => false
  | none => true

def requiredCategoryFailed (ctx : SummaryContext) (checks : List CheckResult) (category : CheckCategory) : Bool :=
  (requiredDefinitions ctx).any (fun definition =>
    if definition.category == category then
      match resultFor checks definition.id with
      | some .failed => true
      | _ => false
    else
      false)

def requiredCategoryAllSucceeded (ctx : SummaryContext) (checks : List CheckResult) (category : CheckCategory) : Bool :=
  let categoryDefinitions := (requiredDefinitions ctx).filter (fun definition => definition.category == category)
  categoryDefinitions.any (fun _ => true) &&
    categoryDefinitions.all (requiredCheckSuccess checks)

def canFullyVerify (ctx : SummaryContext) (checks : List CheckResult) : Bool :=
  allRequiredPresent ctx checks &&
    allRequiredSuccess ctx checks &&
    noUnknownChecks checks &&
    requiredRolesSuccess ctx checks &&
    !optionalCheckBlocksFullyVerified ctx checks &&
    !anyRequiredInProgress ctx checks

def deriveNonFullySummaryModel (ctx : SummaryContext) (checks : List CheckResult) : NonFullySummaryStatus :=
  if anyRequiredInProgress ctx checks then
    .in_progress
  else if roleStatusIs checks .proof_verification .failed then
    .proof_verification_failed
  else if roleStatusIs checks .tally_completeness .failed then
    if roleStatusIs checks .user_inclusion .failed then
      .user_vote_excluded
    else if roleStatusIs checks .user_inclusion .success then
      .votes_excluded
    else
      .votes_excluded_unknown
  else if requiredCategoryFailed ctx checks .recorded_as_cast then
    .recorded_integrity_failed
  else if roleStatusIs checks .tally_consistency .failed &&
      roleStatusIs checks .proof_verification .success &&
      roleStatusIs checks .tally_completeness .success &&
      roleStatusIs checks .user_inclusion .success &&
      roleStatusIs checks .tally_input_integrity .success &&
      requiredCategoryAllSucceeded ctx checks .recorded_as_cast &&
      !anyRequiredNotRun ctx checks &&
      allRequiredPresent ctx checks &&
      noUnknownChecks checks then
    .published_tally_mismatch
  else if requiredCategoryFailed ctx checks .counted_as_recorded then
    .counted_integrity_failed
  else if requiredCategoryFailed ctx checks .cast_as_intended then
    .cast_integrity_failed
  else if anyRequiredNotRun ctx checks ||
      !noUnknownChecks checks ||
      roleStatusMissing checks .tally_completeness ||
      roleStatusMissing checks .user_inclusion ||
      !allRequiredPresent ctx checks then
    .missing_evidence
  else if optionalCheckBlocksFullyVerified ctx checks then
    .verified_with_limitations
  else
    .missing_evidence

def deriveSummaryModel (ctx : SummaryContext) (checks : List CheckResult) : SummaryStatus :=
  if canFullyVerify ctx checks then
    .fully_verified
  else
    (deriveNonFullySummaryModel ctx checks).toSummaryStatus

theorem fully_verified_implies_canFullyVerify
    {ctx : SummaryContext} {checks : List CheckResult}
    (h : deriveSummaryModel ctx checks = .fully_verified) :
    canFullyVerify ctx checks = true := by
  unfold deriveSummaryModel at h
  split at h
  next hCan => exact hCan
  next =>
    cases hNonFully : deriveNonFullySummaryModel ctx checks <;>
      simp [NonFullySummaryStatus.toSummaryStatus, hNonFully] at h

theorem fully_verified_implies_all_required_present
    {ctx : SummaryContext} {checks : List CheckResult}
    (h : deriveSummaryModel ctx checks = .fully_verified) :
    allRequiredPresent ctx checks = true := by
  have hCan := fully_verified_implies_canFullyVerify h
  cases hPresent : allRequiredPresent ctx checks <;> simp [canFullyVerify, hPresent] at hCan ⊢

theorem fully_verified_implies_all_required_success
    {ctx : SummaryContext} {checks : List CheckResult}
    (h : deriveSummaryModel ctx checks = .fully_verified) :
    allRequiredSuccess ctx checks = true := by
  have hCan := fully_verified_implies_canFullyVerify h
  cases hSuccess : allRequiredSuccess ctx checks <;> simp [canFullyVerify, hSuccess] at hCan ⊢

theorem fully_verified_implies_no_unknown_checks
    {ctx : SummaryContext} {checks : List CheckResult}
    (h : deriveSummaryModel ctx checks = .fully_verified) :
    noUnknownChecks checks = true := by
  have hCan := fully_verified_implies_canFullyVerify h
  cases hKnown : noUnknownChecks checks <;> simp [canFullyVerify, hKnown] at hCan ⊢

theorem fully_verified_implies_required_roles_success
    {ctx : SummaryContext} {checks : List CheckResult}
    (h : deriveSummaryModel ctx checks = .fully_verified) :
    proofVerificationRoleSuccess ctx checks = true ∧
      tallyCompletenessRoleSuccess ctx checks = true ∧
      userInclusionRoleSuccess ctx checks = true := by
  have hRoles : requiredRolesSuccess ctx checks = true := by
    have hCan := fully_verified_implies_canFullyVerify h
    cases hRequiredRoles : requiredRolesSuccess ctx checks <;>
      simp [canFullyVerify, hRequiredRoles] at hCan ⊢
  unfold requiredRolesSuccess at hRoles
  cases hProof : proofVerificationRoleSuccess ctx checks <;> simp [hProof] at hRoles ⊢
  cases hCompleteness : tallyCompletenessRoleSuccess ctx checks <;> simp [hCompleteness] at hRoles ⊢
  cases hUser : userInclusionRoleSuccess ctx checks <;> simp [hUser] at hRoles ⊢

theorem fully_verified_implies_no_optional_blocking_status
    {ctx : SummaryContext} {checks : List CheckResult}
    (h : deriveSummaryModel ctx checks = .fully_verified) :
    optionalCheckBlocksFullyVerified ctx checks = false := by
  have hCan := fully_verified_implies_canFullyVerify h
  cases hOptional : optionalCheckBlocksFullyVerified ctx checks <;>
    simp [canFullyVerify, hOptional] at hCan ⊢

theorem sth_configured_promotes_third_party_check :
    (checkDefinitions.find? (fun definition => definition.id == .recorded_sth_third_party)).map
      (isRequiredCheck { sthSourcesConfigured := true }) = some true := by
  rfl

end StarkBallotFormal
