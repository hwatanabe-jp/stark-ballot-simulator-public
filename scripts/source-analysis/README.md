# Repository source analysis

Repository policy tools consume the native TypeScript ESTree produced by
`oxc-parser`. `source.ts` owns parsing, source spans, parent links, and traversal;
invalid syntax fails closed. Traversal visits a shorthand name once even when
ESTree exposes the same source span as both a key and a value.

`imports.ts` extracts static import, export, loader, and JSDoc type references.
JSDoc type expressions are parsed as TypeScript return types so predicates are
supported; ordinary comments and string examples do not become dependencies.
`compiler-project.ts` reads project membership and effective options from the
installed TypeScript CLI's `--showConfig` output and validates that JSON.
It first runs `--noEmit --listFilesOnly` to reject configuration errors that
`--showConfig` alone can omit, including a missing `extends` target.

The implementation does not use the legacy TypeScript Compiler API or the
experimental TypeScript 7 API. Production workspaces must not import these
repository helpers. The web translation test uses Oxc directly within its own
workspace boundary.

Run `pnpm exec vitest run scripts/source-analysis/source.test.ts` for parser
boundary tests. Policy consumers retain their own adjacent regression tests;
run `pnpm type-system:verify` and `pnpm test:run` for the complete gates.
