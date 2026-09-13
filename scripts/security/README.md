# Security Scripts

Repository leak scanning and contract-policy checks have separate scopes and
evidence. Run the scanner for selected file contents, Vitest for policy
regressions, and the type-system gate for compiler checks.

## Public Safety Scan

Choose the scope explicitly:

| Command or mode                                                          | Files inspected                                                             |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `pnpm public-safety:scan`                                                | Tracked working-tree files when Git is detected; filesystem files otherwise |
| `pnpm public-safety:scan:staged`                                         | Index copies of added, copied, modified, and renamed files; requires Git    |
| `./scripts/security/scan-public-safety.sh --root .tmp/public-repo --all` | Files below the explicit root, even if it contains Git metadata             |
| `./scripts/security/scan-public-safety.sh --files <file>...`             | Named working-tree files relative to the selected root; not staged copies   |

All modes retain the scanner's path skips and text-file checks. Without
`--root`, the scanner selects the detected Git repository root or the current
directory when Git is unavailable. Explicit `--root` selects filesystem mode;
combine it with `--all` for a complete tree scan or `--files` for selected files.
It cannot be used with `--staged`. Ordinary Git `--all` does not include
untracked files. Generated snapshots are identified by `.public-repository`
and do not inherit the private deployment-target account-ID exception.

The shell scan blocks high-confidence secret formats and publishable-repo leaks such as real AWS
account IDs in ARNs/ECR/SQS URLs or labeled account fields, concrete Amplify/AppSync/Cognito/IAM
IDs, AWS resource IDs, non-canonical project S3 bucket names, presigned AWS URLs, raw S3 object
URLs, concrete Amplify app origins, and local user paths. It reports only `file:line` and rule IDs,
not matched values.

Additional scope-specific rules keep publishable material free of concrete
deployment identities:

- Terraform variable files, root documentation entry points, `public-book/`,
  public documentation areas, `catalog-info.yaml`, `openapi/`, and `techdocs/`
  reject every non-zero bare 12-digit account ID. This includes the OpenAPI JSON
  and TechDocs configuration as well as prose. Private operational and archived
  documentation is exempt only from this stricter bare-ID rule; the general
  safety rules still apply.
- Publishable source Markdown and every Markdown file in a generated public
  snapshot reject concrete Terraform backend bucket identifiers through
  `terraform_backend_bucket_identifier`. Explicit placeholders and generic
  backend-bucket prose remain allowed.

The reviewed exceptions are deliberately narrow:

- Raw S3 object URLs are allowed only for the exact pinned public ECR
  credential-helper distribution objects below. Unpinned versions and every
  other object path on the same distribution bucket remain blocked.
  - `https://amazon-ecr-credential-helper-releases.s3.us-east-2.amazonaws.com/0.12.0/linux-amd64/docker-credential-ecr-login`
  - `https://amazon-ecr-credential-helper-releases.s3.us-east-2.amazonaws.com/0.12.0/linux-arm64/docker-credential-ecr-login`
- The private source scan admits the reviewed concrete `accountId` only at
  `packages/deployment-authority/deployment-targets.json`. The public exporter
  replaces account IDs and their references with distinct placeholders:
  `000000000000` for `stark-dev/develop` and `111111111111` for `stark-prod/main`.
  That path has no private-source exception inside a generated snapshot: an
  unsanitized exported configuration fails the same account-ID rule.

## Contract Guard Inventory

Run each gate for the evidence it owns:

| Gate                      | Evidence and limits                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm public-safety:scan` | Leak rules over the selected tree; does not run the policy or compiler suites                                              |
| `pnpm test:run`           | Complete configured Vitest suite in the current tree, including its retained security tests                                |
| `pnpm test:public`        | Vitest selection `apps packages scripts/security`; the command does not itself remove private tests from a source checkout |
| `pnpm type-system:verify` | Compiler checks; private source also checks JavaScript ownership and workspace derivations; separate from Vitest           |

The source checkout and generated snapshot have different inventories. Export
retains the public-boundary scanner/tests, shell safety scanner/tests,
`deployment-authority-boundary.ts`, and `scripts/source-analysis/` helpers. It
omits the deployment-authority boundary test, operational-versioning
implementation/test, repository-policy implementation/test, and framework
scanner/Gitleaks sources and tests. Therefore `test:public` in the source
checkout includes private security tests that do not exist in the exported
tree. A public test result cannot establish the omitted private guards.

Deployment-authority and repository-policy source inspection uses Oxc ASTs via
[scripts/source-analysis](../source-analysis/README.md), with fail-closed syntax
parsing. Operational versioning uses scoped text rules, and the public-boundary
scanner walks supplied values. These policy checks do not perform semantic
TypeScript type checking or use the former TypeScript Compiler API.

Compiler-backed ownership/discovery consumers separately use
[compiler-project.ts](../source-analysis/compiler-project.ts): the installed
TypeScript 7 CLI first runs `--noEmit --listFilesOnly` to reject configuration
errors, then `--showConfig` supplies validated file membership and effective
options. Semantic compiler diagnostics belong to the type-check commands;
configuration admission and AST policy results do not replace them.

### Public boundary

`public-boundary-scan.ts` recursively inspects supplied public-shaped values
in contract tests. Its adjacent test owns scanner regressions. It detects
retired fields, private artifact names, private locators, vote openings,
capability tokens outside explicit path allowlists, raw paths, stack traces,
signed URLs, and private S3 keys. This is a value-boundary check, not a scan of
all repository files.

### Operational contract versioning

`operational-contract-versioning.ts` and its adjacent test own the private
source guard. Across scoped operational workflows, documentation,
infrastructure, packages, and scripts, it rejects generic
`schemaVersion` and `schema_version` fields and repository-defined `*-vN` identifiers.

The exact external tokens `list-objects-v2` and `payload-v2` are built-in
exceptions. Other external schema fields and version identifiers require an explicit
`operational-versioning-allow: external-schema-field` or
`operational-versioning-allow: external-version` comment. Centralized rejection fixtures use
`operational-versioning-allow: rejection-fixture`. The guard has no dedicated package alias; it runs
with the private source repository's Vitest suite. Both implementation and test
are omitted from public snapshots.

### Deployment authority boundary

`deployment-authority-boundary.ts` and its private-source adjacent test keep
deployment authority in
`packages/deployment-authority/src/`. It scans tracked and untracked active
source files in package `src/` trees, root buildspecs, `.github/workflows/`,
the App, Bootstrap, and Foundation Terraform roots, `scripts/aws/`,
`scripts/terraform/`, and the Bootstrap-managed App, signature-preflight,
Foundation, and Terraform-drift script families. Declaration files, tests,
legacy Terraform, documentation, and unsupported file types are
outside this guard's scope.

The guard fails closed on a second deployment-context renderer; duplicate
canonical JSON, immutable-reference, publication, pointer-CAS, Terraform
baseline/action/redaction/drift, source-SHA, SHA-256, or S3 VersionId authority;
governed target reconstruction; broad authority fallbacks; alternate authority
readers; and secret or unbounded fields added to canonical contexts. Consumers
must call the canonical deployment-authority functions and use the exact
reviewed context rather than reconstructing names, target values, or admission
logic locally. Violations are reported as normalized path, line, rule, and,
when available, token evidence.
