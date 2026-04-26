# Security Scripts

Utilities for lightweight repository safety checks.

## Public Safety Scan

```bash
pnpm public-safety:scan          # tracked files in git; non-skipped text files in a non-git export
pnpm public-safety:scan:staged   # staged files
```

The scan blocks high-confidence secret formats and publishable-repo leaks such as real AWS account IDs in ARNs/ECR URLs, concrete Amplify/AppSync IDs, AWS resource IDs, non-canonical project S3 bucket names, concrete Amplify app origins, and local user paths. It reports only `file:line` and rule IDs, not matched values.

