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

Raw S3 object URLs are blocked except for these exact pinned public ECR credential-helper distribution
objects:

- `https://amazon-ecr-credential-helper-releases.s3.us-east-2.amazonaws.com/0.12.0/linux-amd64/docker-credential-ecr-login`
- `https://amazon-ecr-credential-helper-releases.s3.us-east-2.amazonaws.com/0.12.0/linux-arm64/docker-credential-ecr-login`

Unpinned versions and other object paths on the same distribution bucket remain blocked.

Strict account-ID hygiene also rejects every non-zero bare 12-digit value in Terraform variable files,
the root documentation entry points, `public-book/`, and public documentation areas. Private operational
and archived documentation areas are exempt only from this strict bare-ID rule; the general safety rules
still scan them.

## Public Boundary Contract Guard

`public-boundary-scan.ts` is the TypeScript scanner used by contract tests to keep public-shaped
fixtures free of retired fields, private artifact names, private locators, vote openings, capability
tokens outside explicit allowlists, raw paths, stack traces, signed URLs, and private S3 keys.

## Operational Contract Versioning Guard

The private source repository's core Vitest suite includes an operational contract versioning guard;
the generated public snapshot does not ship that private-source guard. Across its scoped operational
workflows, documentation, infrastructure, packages, and scripts, the guard rejects generic
`schemaVersion` and `schema_version` fields and repository-defined `*-vN` identifiers.

External schema fields and version identifiers require an explicit
`operational-versioning-allow: external-schema-field` or
`operational-versioning-allow: external-version` comment. Centralized rejection fixtures use
`operational-versioning-allow: rejection-fixture`. The guard has no dedicated package alias; it runs
with the private source repository's core tests through `pnpm test:run`.
