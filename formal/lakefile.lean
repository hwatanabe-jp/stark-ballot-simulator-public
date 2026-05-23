import Lake
open Lake DSL

package stark_ballot_formal where

@[default_target]
lean_lib StarkBallotFormal where
  globs := #[.submodules `StarkBallotFormal]

@[default_target]
lean_exe emitTestVectors where
  root := `Scripts.EmitTestVectors

@[default_target]
lean_exe emitFormalReport where
  root := `Scripts.EmitFormalReport
