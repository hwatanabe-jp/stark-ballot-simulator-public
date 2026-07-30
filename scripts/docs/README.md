# Documentation Scripts

This directory contains documentation-related helper scripts and supporting notes. It is not only a
prose-docs folder: several files here are executable helpers for the public mdBook, generated assets, and
license metadata.

## Active Helpers

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

### check-license-metadata-freshness.ts

Compares the tracked pnpm and Cargo license JSON/CSV artifacts with the current
lockfiles without modifying files or accessing the network. The package script
is:

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
