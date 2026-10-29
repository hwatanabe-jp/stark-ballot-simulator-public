# Repository source analysis

Repository policy tools consume the native TypeScript ESTree produced by
`oxc-parser`. `source.ts` owns parsing, source spans, parent links, and traversal;
invalid syntax fails closed. Traversal visits a shorthand name once even when
ESTree exposes the same source span as both a key and a value.
Syntax-only consumers share that parser admission without indexing parent links
and source positions across the entire tree.

`imports.ts` extracts static import, export, loader, and JSDoc type references.
JSDoc type expressions are parsed as TypeScript return types so predicates are
supported; ordinary comments and string examples do not become dependencies.

`compiler-project.ts` reads project membership and effective options from the
installed TypeScript CLI's `--showConfig` output and validates that JSON.
Each asynchronous load first runs `--noEmit --listFilesOnly` to reject
configuration errors that `--showConfig` alone can omit, including a missing
`extends` target. Each of the two sequential compiler calls has a 10-second
timeout and a 16 MiB output-buffer limit. Loads are not cached, so changed
configurations and inherited options are admitted again. Repository ownership
batching belongs to
`tooling/repository/test-support/repository-inventory.ts`:
it loads at most four projects concurrently (bounded by available CPUs), waits
for each batch, and reports failures in configuration order.

`repository-files.ts` shares Git tracked/untracked file enumeration, file scans,
and finding comparison across the repository-policy, operational-versioning,
and deployment-authority guards. Callers own path filtering, whether to read
content, and inspection policy. Scans skip missing paths; callers use the shared
comparator to order findings by path, line, rule, and optional token.

The implementation does not use the legacy TypeScript Compiler API or the
experimental TypeScript 7 API. Production workspaces must not import these
repository helpers. The web translation test uses Oxc directly within its own
workspace boundary.

Run `pnpm exec vitest run scripts/source-analysis` for parser and compiler
boundary tests. Policy consumers retain their own adjacent regression tests;
run `pnpm type-system:verify` and `pnpm test:run` for the complete gates.
