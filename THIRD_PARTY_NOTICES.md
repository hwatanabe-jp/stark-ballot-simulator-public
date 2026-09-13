# Third-Party Notices

Documentation revised: 2026-09-11

The public application repository is published as a sanitized source snapshot.
The notices below summarize known third-party licenses for that snapshot,
vendored documentation assets, and separately identified private source tooling.
This manually maintained notice accompanies the generated package metadata.
Update its scope and asset notices when covered dependencies, assets, or tooling
change; metadata generation does not rewrite this file.

## Scope

This summary distinguishes two source boundaries:

- The public application repository is a sanitized, allowlist-generated snapshot.
  It contains the publishable application, proof, formal-model, infrastructure,
  documentation, script, and test sources described below; it does not contain
  every file from the private source repository.
- Private development and reusable-IaC tooling is outside that public snapshot.
  When such a tool is relevant to source-repository development or CI, this file
  identifies it separately rather than treating it as a public application
  dependency.

The public application snapshot includes:

- Vite / React Router app under `apps/web/`, Hono API under `apps/api/`, and
  shared libraries under `packages/`
- zkVM workspace under `zkvm/`
- verifier-service under `verifier-service/`
- Target Lambdas under `infra/lambdas/`: `public-api`, `finalization-writer`,
  `proof-dispatcher`, `verification-worker`, `image-signature-verifier`, and
  `semaphore-janitor`
- The separate Foundation-owned `ecr-retention` Lambda under
  `infra/lambdas/ecr-retention/`
- Lean formal models under `formal/` (current Lake metadata lists no external packages)
- Allowlisted docs, scripts, and tests

## Generated metadata source of truth

The eight tracked artifacts below report package identities and declared
license expressions from the repository's pnpm and Cargo dependency graphs.
The production pnpm report and the all-dependencies report have different
scopes; neither is a separate inventory of the files copied into a public
snapshot. Native and vendored assets have their own notices below.

| Dependency graph                                   | JSON metadata                                                                | CSV license summary                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| pnpm production dependencies                       | [pnpm-licenses-prod.json](./docs/licenses/pnpm-licenses-prod.json)           | [pnpm-licenses-prod.csv](./docs/licenses/pnpm-licenses-prod.csv)           |
| pnpm all dependencies, including development tools | [pnpm-licenses-all.json](./docs/licenses/pnpm-licenses-all.json)             | [pnpm-licenses-all.csv](./docs/licenses/pnpm-licenses-all.csv)             |
| zkVM Cargo workspace                               | [cargo-metadata-zkvm.json](./docs/licenses/cargo-metadata-zkvm.json)         | [cargo-licenses-zkvm.csv](./docs/licenses/cargo-licenses-zkvm.csv)         |
| verifier-service Cargo workspace                   | [cargo-metadata-verifier.json](./docs/licenses/cargo-metadata-verifier.json) | [cargo-licenses-verifier.csv](./docs/licenses/cargo-licenses-verifier.csv) |

The `image-signature-verifier` Lambda is bundled from the repository pnpm
dependency graph; regenerate this metadata when its bundled dependencies
change. The native binaries listed below are recorded separately in their
asset manifest.

Check committed metadata without modifying files or accessing the network:

```bash
pnpm licenses:check
```

[The freshness checker](./scripts/docs/check-license-metadata-freshness.ts)
requires all eight artifacts to exist and, in a Git checkout, be tracked and
unignored. It compares Cargo package identities with each lockfile, checks pnpm
required-package coverage and direct production dependencies while permitting
absent optional platform packages, and compares JSON/CSV license records. It
selects the workspace dependency document in pnpm's multi-document lockfile;
the environment document is not the package inventory for these reports.
This check does not verify description sanitization, this notice's prose, or
upstream license terms independently.

## How to regenerate

Run the [metadata generator](./scripts/docs/regenerate-license-metadata.sh)
from the repository root when dependency metadata needs refreshing:

```bash
pnpm licenses:regen
```

The generator requires pnpm, Cargo, jq, and Perl and performs these steps:

1. Run `pnpm licenses list --json --prod` and `pnpm licenses list --json` for
   the production and all-dependencies reports.
2. Run `cargo metadata --format-version 1` against `zkvm/Cargo.toml` and
   `verifier-service/Cargo.toml`.
3. Replace local absolute paths with `<REPO_ROOT>`, `<CARGO_HOME>`, and
   `<HOME>`. In string `description` fields, remove the selected decorative
   emoji code points and trim leading ASCII spaces. Package identities and license
   fields are preserved.
4. Write the four sanitized JSON files and their four CSV projections, format
   the JSON with Oxfmt, and finish with `pnpm public-safety:scan`.

Review the generated changes and update this notice separately where needed.
Use `pnpm licenses:check` to check artifact freshness; regeneration and the
safety scan do not establish an external license review.

## Special obligations / attention

The generated inventories currently identify these packages and expressions
for attention. This list highlights selected entries; it does not replace the
complete metadata or the corresponding license texts.

CC-BY-4.0 (Node all-dependencies metadata):

- `caniuse-lite` (requires attribution)

MPL-2.0 (Rust):

- `option-ext` (file-level copyleft)

MPL-2.0 (Node dev):

- `@axe-core/playwright`
- `axe-core`
- `lightningcss`
- `lightningcss-linux-x64-gnu`

Unicode-3.0 (Rust):

- ICU-related crates such as `icu_*`, `tinystr`, `zerovec`, and `yoke` (see Cargo metadata)
- `unicode-ident`: `(MIT OR Apache-2.0) AND Unicode-3.0` in both Cargo inventories

## Native image-signature verifier assets

The `image-signature-verifier` Lambda package distributes these checksum-pinned
native assets:

- Notation 1.3.2 — Apache-2.0
- AWS Signer Notation plugin 1.0.2292 — Apache-2.0, including the plugin's
  bundled third-party notices
- Amazon ECR credential helper 0.12.0 — Apache-2.0

The pinned source revisions, download URLs, checksums, and license metadata are
recorded in `infra/image-signature-verifier/asset-manifest.json`. The package
installer copies the corresponding LICENSE and NOTICE files into its
`licenses/` directory.

## Vendored public-book browser assets

The mdBook source includes small browser assets that are committed directly so
the generated Public Specs can build without a network fetch:

- `public-book/mermaid.min.js`
  - Mermaid v11.6.0
  - License: MIT
  - Source: <https://github.com/mermaid-js/mermaid>
  - Header notice: "MIT Licensed. Copyright (c) 2014 - 2022 Knut Sveidqvist"
  - Embedded bundled license block includes notices for DOMPurify
    (Apache-2.0 / MPL-2.0), js-yaml (MIT), lodash-es (MIT), and
    cytoscape-related MIT components; inspect the committed file before
    redistributing generated Public Specs assets.
- `public-book/fzf.umd.js`
  - fzf v0.5.2
  - License: BSD-3-Clause
  - Source: <https://github.com/ajitid/fzf-for-js>
  - Header notice: "Copyright (c) 2021 Ajit"
- `public-book/elasticlunr-fzf.js`
  - Project-local mdBook search patch
  - Covered by this repository's Apache-2.0 license rather than a third-party
    package license
- `public-book/mermaid-init.js`
  - License: MPL-2.0
  - The committed file carries the MPL-2.0 source-code notice

## Private source tooling: independent secret scanner

The private reusable-IaC safety gate downloads and executes one
checksum-pinned developer/CI tool without committing its binary. This tooling
is outside the public application snapshot:

- Gitleaks 8.30.1 — MIT
- Source: <https://github.com/gitleaks/gitleaks>
- Reviewed Linux archive names and SHA-256 checksums:
  `scripts/security/gitleaks/release-manifest.json`

Review the upstream license again before any separately authorized framework
publication or binary redistribution.

## Notes

- Some Rust crates are multi-licensed (e.g., "MIT OR Apache-2.0"). You may choose
  the permissive option for compliance.
- Preserve complete license expressions: an `OR` choice does not remove a
  separate `AND` component, as shown by `unicode-ident` above.
- This file is informational and not legal advice.
