# Documentation Scripts

This directory contains documentation-related helper scripts and supporting notes. It is not only a
prose-docs folder: several files here are executable helpers for the public mdBook, generated assets, and
license metadata.

## Active Helpers

### build-mdbook.sh

Builds the Public Specs with the exact supported `mdbook` 0.5.4 and
`mdbook-mermaid` 0.17.0 pair. The preprocessor declares a semver-compatible
`mdbook-preprocessor` 0.5.x dependency but emits an exact-patch mismatch
diagnostic; the helper removes only that one known message for this exact
pair. It preserves every other diagnostic and the original build exit status.
Local and generated Pages workflows use this as the single mdBook build entry
point.

### create-mdbook-readme-aliases.sh

Creates `README.html` redirect aliases for every top-level public-book section
index after `mdbook build public-book`.

### harden-mdbook-output.sh

Injects GitHub Pages-compatible security tags into generated mdBook HTML, including CSP and referrer meta
tags plus best-effort frame busting.

### check-mdbook-security-tags.sh

Checks that generated mdBook HTML contains the required security hardening tags.

### check-markdown-links.ts

Checks local targets and Markdown anchors in a repository tree. Public export
generation runs it against the generated snapshot; the package script is:

```bash
pnpm docs:links:check -- --root public-book/src
```

An explicit `--root` is required outside a generated public repository.
For a repository-root check, use `pnpm docs:links:check -- --root .`. An
optional reviewed historical-reference manifest admits only exact
source-line/destination pairs under its declared historical roots. Unlisted
broken links and stale manifest entries still fail the check.

### check-license-metadata-freshness.ts

Compares the tracked pnpm and Cargo license JSON/CSV artifacts with the current
lockfiles without modifying files or accessing the network. Its explicit
eight-artifact manifest also requires each generated license file to exist, be
tracked, and remain unignored in a Git checkout. Generated public trees enforce
artifact existence before they become their own Git checkout. The package
script is:

```bash
pnpm licenses:check
```

### regenerate-license-metadata.sh

Regenerates sanitized third-party license metadata under `docs/licenses/`. The package script is:

```bash
pnpm licenses:regen
```

### generate-sayagata.ts

Regenerates `public/patterns/sayagata.svg`.

## Supporting Notes

### stark-verification-summary.md

Historical summary of STARK proof verification testing results:

- Command-line verification approach
- Results from all 6 tamper scenarios
- Current `verifier-service` cryptographic verification path
- Historical findings retained for context

## Purpose

The directory groups documentation-adjacent automation and reference notes so that public-spec publishing,
license metadata refreshes, and historical verification context have a single local home. This includes:

- mdBook post-processing helpers
- local Markdown-link validation
- license metadata validation and generation
- generated documentation assets
- Test results and summaries
- Technical documentation
- Implementation notes
- Analysis reports
