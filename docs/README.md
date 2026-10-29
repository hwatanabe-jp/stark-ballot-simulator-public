# Documentation

The [Public Specs](../public-book/src/introduction.md) define the protocol,
verification conditions, public evidence formats, and AWS architecture.
The [system overview](../public-book/src/overview.md) describes the verification
stages and their execution responsibilities. This tree complements the Public Specs with implementation-oriented contracts,
architecture notes, operating guides, and evidence produced alongside the
code. When documentation and implementation disagree, current code and tests
win.

The public snapshot omits account-specific procedures, live inventory, approval
records, and private historical working notes. Retained public decision records
and formal phase plans are identified by their documentation indexes. Its generated
`docs/PUBLIC_REPOSITORY.md` records the source revision and documentation
footprint of that snapshot.

The Backstage overview uses the dedicated [`techdocs/docs/`](../techdocs/docs/index.md)
tree, which limits MkDocs to public portal content. The catalog API entity reads
the deterministic [OpenAPI reference](../openapi/stark-ballot-api.openapi.json).
Public Specs define the normative rules; runtime validators enforce accepted data shapes.

## Review Path

1. [Verification pipeline](./verification/README.md) — the fail-closed checks,
   verdict rules, and public/private artifact boundary.
2. [Formal evidence](./formal/README.md) — the Lean scope, generated vectors,
   and the limits of the formal claims.
3. [AWS architecture](./architecture/aws-architecture.md) — the deployed
   application and proof pipeline.
4. [zkVM decision records](./zkvm/decisions/README.md) — why the current proof
   contract and trust boundaries look the way they do.
5. [UI design specification](./ui/design-spec-transparent-trust.md) — how the
   verification model is presented without overstating assurance.

For a runnable review, continue with the [CLI guide](./guides/cli.md) or the
root `README.md` mock quick start.

## Documentation Map

| Area                                         | Purpose                                                                            | Primary language   |
| -------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------ |
| [Verification](./verification/README.md)     | Verification checks, summary semantics, bundle delivery, and hard-failure rules    | Japanese           |
| [Formal](./formal/README.md)                 | Lean models, audit output, and generated implementation vectors                    | English            |
| [Architecture](./architecture/README.md)     | System boundaries, AWS topology, Hono ownership, and repository context            | English / Japanese |
| [Guides](./guides/)                          | Local setup, CLI operation, and STARK verification testing                         | English / Japanese |
| [Infrastructure](./infrastructure/README.md) | Terraform ownership, release lanes, toolchain images, and cloud security routing   | English / Japanese |
| [Runbooks](./runbooks/README.md)             | Read-only-first runtime diagnosis, logging, and security response                  | English / Japanese |
| [UI](./ui/README.md)                         | Visual system, UI-facing API vocabulary, page behavior, and lifecycle presentation | Japanese           |
| [zkVM](./zkvm/README.md)                     | Proof design, journal/reference material, mock behavior, and decision records      | English / Japanese |
| [Roadmap](./roadmap.md)                      | Current forward-looking priorities                                                 | English            |
| [Licenses](./licenses/)                      | Generated dependency-license and metadata artifacts                                | Machine-generated  |

## How to Read the Evidence

- The files under [zkVM decisions](./zkvm/decisions/README.md) are decision and
  execution records. Their status text explains how the design evolved; it is
  not a substitute for current code.
- The [formal artifacts](./formal/README.md) machine-check selected invariants
  and feed generated vectors into TypeScript and Rust tests. They do not claim
  to prove the complete application, AWS runtime, or browser UI.
- Runbooks distinguish read-only diagnosis from authorized changes. Public
  runbooks explain the safety boundary but do not grant deployment authority.
- The repository remains an educational proof of concept, not a production
  voting system.
