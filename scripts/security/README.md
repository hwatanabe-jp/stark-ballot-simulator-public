# Security Scripts

Utilities for lightweight repository safety checks.

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

Strict account-ID hygiene also rejects every non-zero bare 12-digit value in Terraform variable files,
the root documentation entry points, `public-book/`, and public documentation areas. Private operational
and archived documentation areas are exempt only from this strict bare-ID rule; the general safety rules
still scan them.

`public-boundary-scan.ts` is the TypeScript scanner used by contract tests to keep public-shaped
fixtures free of retired fields, private artifact names, private locators, vote openings, capability
tokens outside explicit allowlists, raw paths, stack traces, signed URLs, and private S3 keys.
