# Repository formatting

`pnpm format` and `pnpm format:check` use Oxfmt with the central
[configuration](../../oxfmt.config.ts). They cover `ts`, `tsx`, `js`, `jsx`,
`json`, and `md` files, including `AGENTS.md`. The configuration excludes the
generated Public Specs build, bundled vendor scripts, and Lean's `.lake` directory.

The configuration sorts package manifest fields and dependencies, and Tailwind
classes using the web application's CSS theme. It preserves import evaluation
order. Formatting does not delete unused imports; the compiler and linter own
those diagnostics.

`format-source.ts` applies the same configuration to generated JSON and Markdown
and rejects formatter errors before a caller writes output. Public export,
OpenAPI, contract capture, formal evidence, and golden-vector generators use
this boundary. The workspace metadata CLI uses Oxfmt's stdin interface.

Oxfmt formats JavaScript, TypeScript, and JSON natively. Its bundled Prettier
handles Markdown; the repository no longer configures or invokes Prettier
directly. See [Oxfmt language support](https://oxc.rs/docs/guide/usage/formatter/language-support).

Run `pnpm exec vitest run scripts/formatting/format-source.test.ts` to verify
CLI/API agreement, manifest ordering, Tailwind sorting, and failure handling.
