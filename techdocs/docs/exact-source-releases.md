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

Plan packages and image candidates are create-only. Root checkpoints and image
promotions use fixed, versioned keys: explicit first creation requires absence,
and later updates require compare-and-swap. A per-root mutation owner and
create-only action records reject stale publishers and retries. A conflict
cannot establish new successful authority. Native image retention keeps the
newest five images; missing digests require rebuild and a fresh approved release.

The Public Specs define the [saved-plan and approval rules](https://specs.stark-ballot-sim.hwatanabe.dev/aws/terraform.html)
and [container image signature verification](https://specs.stark-ballot-sim.hwatanabe.dev/aws/image-signing.html).
