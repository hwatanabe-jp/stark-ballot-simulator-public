import Std

namespace StarkBallotFormal

/-- Finite interleavings; queueing and cancellation requests can stutter. -/
inductive WorkerReach {α : Type} (step : α → α → Prop) (initial : α) : α → Prop where
  | initial : WorkerReach step initial initial
  | next : WorkerReach step initial s → step s t → WorkerReach step initial t

/-- Abstract model of the current AWS Batch resource-aware scheduling contract.
Each entry is one admitted single-container attempt, from STARTING until Batch
releases its resource on SUCCEEDED or FAILED after computation stops.
Waiting jobs have no entry and need no resident worker.
The provider, not application code, owns resource acquisition and release. -/
abbrev BatchActive := List Nat

/-- One shared REPLENISHABLE resource of quantity 2; every attempt needs 1.
Cancellation requests, queueing and notifications alone cannot return capacity.
`finished` means provider resource release after actual termination.
A Step Functions timeout or application callback does not establish this transition. -/
inductive BatchStep : BatchActive → BatchActive → Prop where
  | launch (active : BatchActive) (attempt : Nat)
      (capacity : active.length < 2) (fresh : attempt ∉ active) :
      BatchStep active (attempt :: active)
  | finished (active : BatchActive) (attempt : Nat) :
      BatchStep active (active.erase attempt)
  | wait (active : BatchActive) : BatchStep active active

/-- Each admitted attempt is counted once and consumes one of the two units. -/
def BatchInvariant (active : BatchActive) : Prop :=
  active.Nodup ∧ active.length ≤ 2

theorem batch_step_preserves_invariant
    (h : BatchInvariant active) (step : BatchStep active next) :
    BatchInvariant next := by
  rcases h with ⟨hnodup, hbound⟩
  cases step with
  | launch attempt capacity fresh =>
      exact ⟨List.nodup_cons.mpr ⟨fresh, hnodup⟩, by simp only [List.length_cons]; omega⟩
  | finished attempt =>
      exact ⟨hnodup.sublist List.erase_sublist,
        Nat.le_trans List.erase_sublist.length_le hbound⟩
  | wait => exact ⟨hnodup, hbound⟩

theorem batch_reachable_invariant
    (h : WorkerReach BatchStep [] active) : BatchInvariant active := by
  induction h with
  | initial => simp [BatchInvariant]
  | next _ step ih => exact batch_step_preserves_invariant ih step

/-- Conditional on Batch implementing the modeled resource/termination contract. -/
theorem batch_workers_at_most_two
    (h : WorkerReach BatchStep [] active) : active.length ≤ 2 := by
  exact (batch_reachable_invariant h).2

/-- Both jobs can execute concurrently, then all admitted workers can terminate.
This is reachability, not a fairness or eventual-termination assertion. -/
theorem batch_can_run_two_and_drain :
    ∃ active, WorkerReach BatchStep [] active ∧ active.length = 2 ∧
      WorkerReach BatchStep active [] := by
  have first : WorkerReach BatchStep [] [0] :=
    .next .initial (.launch [] 0 (by decide) (by decide))
  have both : WorkerReach BatchStep [] [1, 0] :=
    .next first (.launch [0] 1 (by decide) (by decide))
  have oneLeft : WorkerReach BatchStep [1, 0] [0] :=
    .next .initial (.finished [1, 0] 1)
  exact ⟨[1, 0], both, rfl, .next oneLeft (.finished [0] 0)⟩

end StarkBallotFormal
