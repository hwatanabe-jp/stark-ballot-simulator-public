# Exact-source reviewed releases

A release starts from an explicitly selected deployment target and source
commit. The requested commit, pipeline Source action, and build-resolved source
identity must agree. Retained evidence must match the independently selected
target. The pipeline rejects ambiguity rather than falling back to a branch head.

Terraform changes are reviewed as a saved binary plan with a stable redacted
JSON projection. Approval binds the selected target, source, and saved-plan checksum;
Apply consumes those exact saved bytes without replanning. Immutable image
digests and confirmed ImageID mappings keep the proof toolchain bound through
the application release.

Records are create-only. A mutable current pointer is first created only if
absent; later updates use conditional compare-and-swap against the observed
pointer. A conflict leaves the existing accepted authority intact.
