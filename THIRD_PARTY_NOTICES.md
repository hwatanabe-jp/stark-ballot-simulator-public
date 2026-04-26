# Third-Party Notices (Template)

Last updated: 2026-04-25

This repository is intended to be published as source. The notices below summarize
known third-party licenses used by this codebase. Update this file when dependencies
change or when preparing a public release.

## Scope (public repo)

This summary assumes the public repository includes the full codebase, including:

- Next.js app and shared libraries in the repository root
- zkVM workspace under `zkvm/`
- verifier-service under `verifier-service/`
- Terraform lambda under `terraform/lambda/check-image-signature/`
- Docs, scripts, and tests

## How to regenerate

Regenerate the tracked JSON and CSV metadata with:

```bash
pnpm licenses:regen
```

The script runs `pnpm licenses list --json`, `cargo metadata` for `zkvm/` and
`verifier-service/`, replaces local absolute paths with `<REPO_ROOT>` and
`<CARGO_HOME>`, writes `docs/current/licenses/*.{json,csv}`, and finishes with
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

The Terraform image-signature Lambda has its own `package-lock.json`; inspect it
directly when `terraform/lambda/check-image-signature/` dependencies change.

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
