# Image-signature verifier runtime

This directory contains the shared cryptographic verifier for the dedicated
App-owned ZIP Lambda. `asset-manifest.json` is the authority for the pinned
native Notation, AWS Signer plugin, ECR credential helper, and trust-root
assets.

## Execution boundary

Cryptographic image verification does not run in the Toolchain or Prover
release lanes. Toolchain has no image-signing or signature-verification
contract. The Prover release lane records ECR managed-signing readiness, but
the App preflight and runtime verifier Lambda perform the cryptographic check
of the selected digest-pinned Prover image.

During a normal App deployment, the preflight plan builds the deterministic
`linux-amd64` Lambda ZIP with
`scripts/build/build-image-signature-verifier-lambda.mjs`. The reviewed
verifier-only plan publishes an immutable Lambda version, and the preflight
alias must verify the selected Prover before the App lane continues. The
runtime alias applies the same verifier contract before the async workflow
launches that Prover image.

`verifier.mjs` implements the shared verification core, and
`infra/lambdas/image-signature-verifier/index.mjs` provides the Lambda
request, response, configuration, and logging boundary. `verify-image.mjs`
remains tested standalone CLI source; it is not a bundled artifact or a
production release-lane entry point. The Lambda builder bundles the handler
and its JavaScript dependencies into the ZIP, then packages the same
checksum-pinned native assets.

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
allows an App preflight failure to be diagnosed without weakening the public
verification contract.
