# UI and UX Contracts

This area contains the maintained references for the current
interface. Earlier sketches and implementation planning are retained outside
the public guide set. When these documents and code disagree, current route,
component, style, and test behavior wins.

## Maintained References

| Document                                                             | Use                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [UI design specification](./design-spec-transparent-trust.md)        | Visual system, tokens, component styling, and motion guidance                   |
| [Layout architecture](./layout-architecture.md)                      | Page layout, responsive behavior, step indicator, and knowledge-panel placement |
| [UI-facing API contract](./api-contract.md)                          | API shapes and canonical naming used by the interface                           |
| [Knowledge panel](./knowledge-panel.md)                              | Data model, normalization, visibility, and storage rules                        |
| [Verify page](./verify-page/verify-page.md)                          | Verification sequencing, presentation, and fail-closed status behavior          |
| [Finalization queue](./finalization-lifecycle/finalization-queue.md) | Queue and estimated finalization lifecycle presentation                         |
| [zkVM progress](./finalization-lifecycle/zkvm-progress.md)           | Time-based progress interpolation rules                                         |

## Interpretation Rules

- UI wording must not imply that a development receipt is a production proof.
- `Verified` is reserved for the state in which every required check passes.
- Progress and queue estimates are presentation aids, not cryptographic or
  scheduling guarantees.
- Verification-gated knowledge remains hidden until verification begins.
