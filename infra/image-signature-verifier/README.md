# Image-signature verifier runtime

This directory contains the shared cryptographic verifier for the dedicated
App-owned ZIP Lambda. `asset-manifest.json` is the authority for the pinned
native Notation, AWS Signer plugin, ECR credential helper, and trust-root
assets.

## Execution boundary

Native App preparation and the runtime verifier Lambda cryptographically verify
the selected digest-pinned Prover image. The Prover release lane records ECR
managed-signing readiness for that later check. Toolchain has no image-signing
or signature-verification contract, and neither release lane performs the
cryptographic check itself.

During App preparation, `prepare-app-signature.mjs` installs checksum-pinned
assets and runs the shared native CLI against the selected digest. It packages
the same verified assets with `scripts/build/build-image-signature-verifier-lambda.mjs`,
then publishes immutable versioned evidence and ZIP references for the full App
plan. Verification failure or timeout stops before deployment.

`asset-files.mjs` owns shared file shapes, paths, inventory and integrity checks
for the installer, packager and runtime. Each caller retains its own size,
permission and diagnostic policies.

`verifier.mjs` implements the shared core and bounded result admission; `verify-image.mjs` is its native
CodeBuild CLI boundary. `infra/lambdas/image-signature-verifier/index.mjs`
provides the Lambda request, response, configuration and logging boundary.
The ordinary App saved plan owns code/configuration and `publish = true`.
Step Functions invokes that exact immutable qualified ARN and verifies the
signature again before launching Prover. There is no verifier-only Terraform
plan, alias reconciliation or separate preflight approval.

## Lambda package and runtime authority

The asset installer and Lambda package use the AWS Lambda POSIX permission
contract: regular data files are `0644`, while native executables are `0755`.
Runtime validation keeps those exact modes as package and installation-record
authority, together with the checksum, size, type, and allowlist checks. It
does not treat the optimized read-only Lambda filesystem's `stat` projection
as a second package authority. The isolated
`isLambdaRuntimeAssetModeCompatible()` adapter accepts only these projections:

- recorded `0644`: runtime `0444`, `0555`, `0644`, or `0755`;
- recorded `0755`: runtime `0555` or `0755`.

All other modes, including special bits, group/other-writable modes, and
insufficient read/execute permissions, fail closed. The deterministic ZIP
contains only `0644` regular data files and `0755` native executables, and
Lambda supplies directory permissions because the ZIP omits explicit
directory entries. If a future Lambda contract guarantees byte-for-byte mode
identity after optimization, remove only this adapter and its focused test
matrix; do not relax or remove the package-mode, checksum, size, type, or
allowlist checks.

The ZIP handler is bundled for Node.js 24 and deployed with the managed
`nodejs24.x` Lambda runtime. The runtime update mode remains AWS `Auto`; do not
introduce a separate patch-version pin.

## Lambda response and diagnostic contract

The Lambda response is the sanitized public verifier contract. A rejected
request may add only a bounded, code-owned `internalReasonCode` to the
`verification_completed` CloudWatch log; that field is operator diagnostic
evidence, not a caller-visible compatibility surface. Do not log native
verifier output, raw errors, credentials, image authorities, asset paths,
hashes, or ARNs.

Asset metadata, installation records, directory inventory, file
type/size/mode/hash validation, deployment authority, process spawn,
unexpected signal, and wrapper failures have distinct bounded codes. This
allows a runtime verification failure to be diagnosed without weakening the public
verification contract.
