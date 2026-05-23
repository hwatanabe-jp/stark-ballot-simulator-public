# Third-Party Notices

Last updated: 2026-05-12

This repository is published as source. The notices below summarize known
third-party licenses used by this codebase and by vendored documentation assets.
Update this file when dependencies or vendored assets change.

## Scope (public repo)

This summary assumes the public repository includes the full codebase, including:

- Next.js app and shared libraries in the repository root
- zkVM workspace under `zkvm/`
- verifier-service under `verifier-service/`
- Terraform lambda under `terraform/lambda/check-image-signature/`
- Lean formal models under `formal/` (current Lake metadata lists no external packages)
- Docs, scripts, and tests

## How to regenerate

Regenerate the tracked JSON and CSV metadata with:

```bash
pnpm licenses:regen
```

The script runs `pnpm licenses list --json`, `cargo metadata` for `zkvm/` and
`verifier-service/`, replaces local absolute paths with `<REPO_ROOT>` and
`<CARGO_HOME>` / `<HOME>`, writes `docs/current/licenses/*.{json,csv}`, and finishes with
`pnpm public-safety:scan`.

## Generated metadata source of truth

Use these tracked files for current package-level license data:

- `docs/current/licenses/pnpm-licenses-prod.json`
- `docs/current/licenses/pnpm-licenses-prod.csv`
- `docs/current/licenses/pnpm-licenses-all.json`
- `docs/current/licenses/pnpm-licenses-all.csv`
- `docs/current/licenses/cargo-licenses-zkvm.csv`
- `docs/current/licenses/cargo-licenses-verifier.csv`
- `docs/current/licenses/cargo-metadata-zkvm.json`
- `docs/current/licenses/cargo-metadata-verifier.json`

The Terraform image-signature Lambda is bundled from the root pnpm dependency
graph; regenerate this metadata when its bundled dependencies change.

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

## Special obligations / attention

LGPL-3.0-or-later (Node prod):

- `@img/sharp-libvips-linux-x64`

CC-BY-4.0 (Node prod):

- `caniuse-lite` (requires attribution)

MPL-2.0 (Rust):

- `option-ext` (file-level copyleft)

MPL-2.0 (Node dev):

- `@axe-core/playwright`
- `axe-core`
- `lightningcss`
- `lightningcss-linux-x64-gnu`

Unicode-3.0 (Rust):

- ICU-related crates such as `icu_*`, `tinystr`, `zerovec`, `yoke`, plus `unicode-ident` (see cargo metadata)

## Notes

- Some Rust crates are multi-licensed (e.g., "MIT OR Apache-2.0"). You may choose
  the permissive option for compliance.
- If you distribute compiled artifacts that embed LGPL components, ensure the LGPL
  obligations are met (e.g., relinking requirements). Source-only publication may
  not trigger the same obligations, but verify based on your distribution model.
- This file is informational and not legal advice.
