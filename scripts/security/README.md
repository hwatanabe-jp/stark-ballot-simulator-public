# Security Scripts

Utilities for lightweight repository safety and contract checks.

## Public Safety Scan

```bash
pnpm public-safety:scan          # tracked files in git; non-skipped text files in a non-git export
pnpm public-safety:scan:staged   # staged files
./scripts/security/scan-public-safety.sh --root .tmp/public-repo --all
```

The shell scan blocks high-confidence secret formats and publishable-repo leaks such as real AWS
account IDs in ARNs/ECR/SQS URLs or labeled account fields, concrete Amplify/AppSync/Cognito/IAM
IDs, AWS resource IDs, non-canonical project S3 bucket names, presigned AWS URLs, raw S3 object
URLs, concrete Amplify app origins, and local user paths. It reports only `file:line` and rule IDs,
not matched values.

The selected mode defines the scan scope. `public-safety:scan` scans every
tracked, non-skipped text file in the source repository; `public-safety:scan:staged`
scans the staged copies of added, copied, modified, and renamed files. With an
explicit non-git `--root`, `--all` scans every non-skipped text file below that
root. Generated public snapshots are identified by `.public-repository` and do
not inherit the private deployment-target account-ID exception.

Additional scope-specific rules keep publishable material free of concrete
deployment identities:

- Terraform variable files, root documentation entry points, `public-book/`,
  and public documentation areas reject every non-zero bare 12-digit account
  ID. Private operational and archived documentation is exempt only from this
  stricter bare-ID rule; the general safety rules still apply.
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
  `packages/deployment-authority/deployment-targets.json`, which the public
  exporter projects to the zero-account placeholder. That path has no
  exception inside a generated snapshot: an unsanitized exported configuration
  fails the same account-ID rule.

## Contract Guard Inventory

These guards run through the repository's Vitest suites. Each guard owns a
different boundary; passing one does not substitute for the others. The
private-source naming and compatibility guard remains in a separate section
because the public exporter removes that complete source-only section.

### Public boundary

`public-boundary-scan.ts` is the TypeScript scanner used by contract tests to keep public-shaped
fixtures free of retired fields, private artifact names, private locators, vote openings, capability
tokens outside explicit allowlists, raw paths, stack traces, signed URLs, and private S3 keys.

### Operational contract versioning

The private source repository's core Vitest suite includes an operational contract versioning guard;
the generated public snapshot does not ship that private-source guard. Across its scoped operational
workflows, documentation, infrastructure, packages, and scripts, the guard rejects generic
`schemaVersion` and `schema_version` fields and repository-defined `*-vN` identifiers.

The exact external tokens `list-objects-v2` and `payload-v2` are built-in
exceptions. Other external schema fields and version identifiers require an explicit
`operational-versioning-allow: external-schema-field` or
`operational-versioning-allow: external-version` comment. Centralized rejection fixtures use
`operational-versioning-allow: rejection-fixture`. The guard has no dedicated package alias; it runs
with the private source repository's core tests through `pnpm test:run`.

### Deployment authority boundary

`deployment-authority-boundary.ts` keeps deployment authority in
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
