# Architecture and ownership

The `stark-ballot-simulator` System has one maintainer-owned source graph:

- `web` is the Vite/React voting and verification interface. It consumes the
  `stark-ballot-api` API.
- `api` is the Hono request boundary. It provides `stark-ballot-api` and coordinates
  finalization, proving, and verification.
- `prover` runs the RISC Zero host flow and depends on the `zkvm-guest` method.
- `release-ledger` is the shared library for Toolchain and Prover candidate and
  release records and their accepted pointers. The API and Prover components
  depend on it for release selection.
- `verifier-service` independently verifies receipts against the expected
  ImageID.
- `zkvm-guest` validates admitted vote evidence and emits the tally journal.

The catalog records only real source relationships. A `guest-visible` tag is a
classification label; it does not grant access or deployment authority.

The Public Specs define the [system overview](https://specs.stark-ballot-sim.hwatanabe.dev/overview.html)
and [AWS service responsibilities](https://specs.stark-ballot-sim.hwatanabe.dev/aws/design-and-services.html).
