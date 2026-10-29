# AWS Runtime Operations Runbook

> **Scope:** the deployed, operator-gated `stark-dev/develop` AWS runtime.
> Production `stark-prod/main` is also deployed, with a separate public ingress
> and target-bound operator procedure. All commands here remain develop-only;
> never turn them into production commands by substituting names or profiles.
> The current finalization state machine invokes the cryptographic
> image-signature verifier's exact published numeric Lambda version. The retired status-only
> `image-signature-gate` is not part of the current runtime.

Use this runbook for read-only incident triage and evidence collection. It does
not authorize an AWS change. Lane selection, approvals, deployment procedures,
live inventory, and known-drift records remain in private operator
documentation.

## 1. Safety boundary

| Phase              | In scope                                                                                     | Out of scope                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only triage   | Identity checks; non-mutating `list`, `describe`, `get`, `head`, logs, and retained evidence | Resource, queue, execution, secret, key, policy, object, or state mutation                                                                                           |
| Change application | Evidence handoff and selection of an approved deployment/recovery story                      | Local Terraform, ad hoc console repair, direct CodeBuild, unreviewed pipeline starts, redrive/purge, `StopExecution`, Batch capacity changes, or key/secret rotation |

All service commands below are read-only and explicitly select the current
profile and region, JSON output, and no pager. Ensure an active Identity Center
session for `stark-dev-admin`, then make identity the first AWS inspection:

```bash
AWS_PROFILE_NAME="stark-dev-admin"
AWS_REGION_NAME="ap-northeast-1"
TARGET_PREFIX="stark-ballot-simulator-stark-dev-develop"
IMAGE_SIGNATURE_PREFIX="stark-ballot-sim-stark-dev-develop"

aws sts get-caller-identity \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --query '{Account:Account,Arn:Arn}' --output json --no-cli-pager

aws configure get region --profile "${AWS_PROFILE_NAME}"
```

The region must be `ap-northeast-1`, and STS must identify the reviewed
`stark-dev` account and role. Do not paste full account IDs or ARNs into shared
evidence. Stop on an identity mismatch; do not compensate by changing targets.
Expired SSO or AWS credentials stop AWS work immediately. Report the expiry and
wait for the operator to reauthenticate; do not log in, refresh credentials, or
switch profiles to continue. Wait 180 seconds between AWS or GitHub CI status
checks.

Never record capability tokens, signed cookies, private keys, secret values,
origin-verification headers, vote openings, private zkVM inputs, Terraform
state, private artifact bodies, or full `verification.json` contents. Treat
session/finalization IDs, AWS execution IDs, object keys, request IDs, and log excerpts as restricted
incident evidence.

## 2. Runtime map

```text
Browser / approved CLI
  -> CloudFront signed-cookie gate
     -> private S3 static frontend
     -> API Gateway -> Hono public-api Lambda -> DynamoDB
        -> async finalization:
           prover SQS -> dispatcher -> Step Functions
             -> exact published cryptographic image-signature-verifier version
             -> AWS Batch queue/capacity -> Fargate prover -> private proof S3
             -> finalization writer -> DynamoDB terminal state and artifact metadata
           one-minute EventBridge sweep -> finalization writer -> reconciliation
        -> async verification:
           verification SQS -> verification-worker Lambda
             -> bundled verifier-service -> private report S3 + DynamoDB
        -> verification observation:
           capability-protected
           POST /api/sessions/:sessionId/finalizations/:finalizationId/verification/observations
             -> durable exact-finalization observation + verification_run_summary

Authenticated delivery
  -> GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle
  -> GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report
```

Finalization uses Step Functions and AWS Batch on Fargate. Verification uses a
separate SQS queue and Lambda worker; it does not normally use Step Functions
or Batch.

The repository lifecycle uses one `finalizationId` (`finalization_id` in
snake-case events/messages) across create/current/cancel, verification
work/observation, and artifact locators. AWS Step Functions execution ARNs and
statuses remain AWS orchestration vocabulary. Prover and verification queue
records are distinguished by `recordType: "prover-work"` and
`recordType: "verification-work"`.

Persistence is lifecycle-owned rather than one aggregate session row:
identity/configuration, voting/bulletin state, finalization authority,
verification result/observation, and AWS delivery/runtime metadata are separate
record families. Missing or malformed current records fail closed; diagnosis
must not infer absent identity, reinterpret a replaced item shape, or copy
adapter metadata into proof/finalization authority.

## 3. Initial response

Record the environment, incident window and timezone, symptom and HTTP/error
code, gated hostname versus direct origin, source SHA, live accepted-deployment
authority identified by the dated inventory, pipeline execution, and restricted
session/finalization or AWS execution identifiers. Do not record the capability
token. Any path that can display **Verified** while a required check has not
passed is a security escalation.

Before interpreting live symptoms as new drift, read the dated inventory and
the exact root checkpoint, plan package, and root-specific local drift evidence
selected by the private operator procedure. `no-drift`, `drift-detected`, and
`check-failed` describe report-only evidence; none authorizes a saved plan,
Apply, remediation, rollback, or recovery operation.

Check pipeline history without starting or retrying anything:

```bash
PIPELINE_NAME="stark-ballot-simulator-pipeline-stark-dev-develop-app"

aws codepipeline list-pipeline-executions \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --pipeline-name "${PIPELINE_NAME}" --max-results 10 \
  --query 'pipelineExecutionSummaries[].{Status:status,Start:startTime,LastUpdate:lastUpdateTime,RevisionId:sourceRevisions[0].revisionId,Summary:sourceRevisions[0].revisionSummary}' \
  --output json --no-cli-pager

aws codepipeline get-pipeline-state \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --name "${PIPELINE_NAME}" \
  --query 'stageStates[].{Stage:stageName,Actions:actionStates[].{Action:actionName,Status:latestExecution.status,Summary:latestExecution.summary}}' \
  --output json --no-cli-pager
```

`get-pipeline-state` can show action results from different executions. Match
every result to the selected execution before using it as evidence. Read the
first failed build log and retained artifact before considering a retry.

### Current App deployment authority

The current App root checkpoint identifies the successful deployment and its
exact immutable plan package. In the restricted workspace, verify the selected
checkpoint's object version and bytes, then bind its source, execution, backend,
runtime identity, and package reference to the package's exact object version
and SHA-256. The package binds the saved plan, provider lock, nonsecret inputs,
immutable artifacts, dependencies, and pre-Plan publication observations.
The private operator procedure owns exact storage coordinates and invocation.

The plan package is the approval object. Correlate native successful approval,
Apply, static publication, and owning Smoke with that exact execution/package;
only successful Smoke publishes the checkpoint. A failed execution may have
partially changed resources while the checkpoint still identifies the previous
success. Inspect mutation-owner and action evidence through the operator
procedure before concluding that the live runtime matches the checkpoint.

Old acceptance pointers and historical checkpoint versions are audit history,
not active readers or rollback selectors. A retry or corrective deployment
requires a fresh execution, plan, and approval. Neither a successful stage nor
a source SHA alone establishes deployment authority.

### Recovery posture

The four-phase recovery engine, manifest selectors and historical App rollback
are retired. Keep PITR, deletion protection and original tables. A stopped
restore creates a distinct sessions/votes pair, validates its data and settings,
then changes exact source/configuration through a fresh App plan and approval.
The source-owned `application_quiesced` setting closes new-session and queue/
sweeper admission in develop; existing-session writes and in-flight work must
be blocked/drained separately. Runtime admission smoke checks saved-plan
settings and live Lambda/table/mapping bindings. The private stopped-recovery runbook owns authorization, RTO/RPO, resume and retained-data boundaries.

### Hash-first session timeline

When a report starts with only a raw session ID, private operators should use
the read-only session-description aggregator instead of pasting the ID into a
log query. Its exact invocation remains in private operator documentation.

The helper hashes the raw ID in memory, searches the normalized
`session_id_hash`, keeps attempts separate, and combines bounded log,
DynamoDB, Step Functions, artifact-metadata, and operations-ledger evidence.
It does not use `ListExecutions` as a name lookup or expose raw identifiers,
secret material, full object keys, execution payloads, or pagination tokens.
Treat its remaining hashes and execution IDs as restricted incident evidence.
Its complete data-source, pagination, expiry, redaction, and polling contract is
maintained in private operator documentation.

## 4. Edge and API

The command examples below inspect develop. Use production’s exact target-bound
operator authority for main investigations; the boundary distinctions here do
not authorize adapting these commands. Current architecture does not replace
dated inventory observations or incident-specific validation evidence.

Expected boundaries:

- the develop hostname requires the CloudFront signed-cookie gate and remains
  independent of Cloudflare;
- the production hostname is proxied through Cloudflare. Every CloudFront
  viewer behavior admits the expected hostname, Cloudflare origin token, and
  bounded client-IP header before cache lookup or origin access. The token is
  removed before forwarding, while the API receives `CF-Connecting-IP`;
- static files use private S3 through OAC;
- `/api` and `/api/*` route through CloudFront to the REST API's `live` stage;
- the execute-api endpoint remains enabled as the CloudFront origin, while the
  application must reject requests without the expected origin header;
- DNS is externally owned, and the CloudFront certificate is in ACM
  `us-east-1`;
- AWS WAF is intentionally absent. Develop uses its outer operator gate; main
  requires server-side Turnstile on session creation, voting, and finalization.
  Rate limits, API throttling, logs, and alarms provide additional controls.

An unauthenticated develop-hostname `403` can be the expected gate. Successful
direct-origin access that bypasses the gate or origin-header check is a
security incident. Production CloudFront admission and the API origin-header
check are separate boundaries: passing one does not establish the other.

For production, Terraform waits for the guarded distribution deployment before
updating the API Lambda to `TRUSTED_PROXY=cloudflare`. That mode accepts only a
single bare valid IPv4 or IPv6 `CF-Connecting-IP`; missing, malformed, list,
port-suffixed, or bracketed values have no fallback to API Gateway source IP,
`X-Forwarded-For`, or `X-Real-IP`. The edge character/length check is not the
API's full IP validation. Never loosen proxy trust to work around a rejection.

Classify the boundary before diagnosing a token, capability, or application
failure:

| Observation                                                                   | First investigation                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Develop `403` before the API                                                  | Check the signed-cookie gate and its inspector evidence.                                                                                                                                                            |
| Main edge rejection or an HTML challenge instead of the expected API response | Inspect the authorized Cloudflare rules and CloudFront viewer admission, hostname, and error evidence. A rejected viewer request never reaches the API; missing API logs alone do not prove which edge rejected it. |
| API `SAME_ORIGIN_REQUIRED`                                                    | Check the separate CloudFront-to-API origin-header boundary and browser same-origin checks. The error code alone does not distinguish them.                                                                         |
| API `INVALID_REQUEST` with `client_ip_missing`                                | Check authenticated client-IP forwarding and strict IP admission. Rate-limited routes reject the missing identity before Turnstile validation.                                                                      |
| API `CAPTCHA_FAILED` and `turnstile_failed` evidence                          | Inspect the redacted server-side validation reason, expected action and hostname, and validation-service failure evidence. This is distinct from an edge challenge or origin-header rejection.                      |

Do not retain Cloudflare origin tokens, Turnstile tokens, or raw client IPs in
shared incident evidence. Keep capability diagnosis in the authenticated
bundle/report checks below.

```bash
aws cloudfront list-distributions \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --query "DistributionList.Items[?Comment=='${TARGET_PREFIX} static frontend'].{Enabled:Enabled,Status:Status,Aliases:Aliases.Items,Origins:Origins.Items[].DomainName,TrustedKeyGroups:DefaultCacheBehavior.TrustedKeyGroups.Items}" \
  --output json --no-cli-pager

aws apigateway get-rest-apis \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --query "items[?name=='${TARGET_PREFIX}-api'].{Name:name,Id:id,DisableExecuteEndpoint:disableExecuteApiEndpoint,Created:createdDate}" \
  --output json --no-cli-pager

aws lambda get-function-configuration \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --function-name "${TARGET_PREFIX}-public-api" \
  --query '{Name:FunctionName,State:State,LastUpdateStatus:LastUpdateStatus,LastModified:LastModified,Runtime:Runtime}' \
  --output json --no-cli-pager
```

For operator-gate incidents, private operators should run the read-only
checked-in inspector after the identity check, following the private operator
procedure.

The inspector requires the exact develop distribution and hostname, the stable key
group on every cache behavior, the exact checked-in managed keyset with no
legacy trusted signer, one issuer generation, an enabled KMS `RSA_2048`
`SIGN_VERIFY` key with the supported SHA-256 signing algorithm, and
byte-identical KMS and CloudFront public keys. Retain its non-secret generation,
key-group, algorithm, and public-key fingerprint summary with the incident
evidence. The inspector does not issue cookies or perform a positive probe. Do
not substitute credential issuance, a positive probe, or a hand-built signing
command during read-only triage. The full inspection and issuance contract is
maintained in private operator documentation.

For TLS incidents, use the CloudFront certificate region explicitly:

```bash
aws acm list-certificates \
  --profile "${AWS_PROFILE_NAME}" --region us-east-1 \
  --certificate-statuses ISSUED PENDING_VALIDATION EXPIRED FAILED \
  --query "CertificateSummaryList[?DomainName=='develop.stark-ballot-sim.hwatanabe.dev'].{Domain:DomainName,Status:Status,InUse:InUse,NotAfter:NotAfter}" \
  --output json --no-cli-pager
```

Do not look for the CloudFront certificate in the application region.

Triage order:

1. CloudFront distribution, aliases, behaviors, and origin.
2. API Gateway access logs and stage/integration.
3. `public-api` state and logs.
4. Accepted static deploy and invalidation evidence for stale assets.
5. Deployed CORS, hostname, origin-header, and browser-public configuration.

Do not rotate or reveal the origin-header secret as a quick fix. Positive
gated smoke creates runtime data and requires explicit approval. Follow the
[develop gated smoke procedure](../../scripts/tests/README.md#live-develop-acceptance)
without copying signed-cookie values into evidence.

## 5. Authenticated bundle and report delivery

The supported contract is capability-checked API delivery:

- the bundle endpoint returns public `bundle.zip` evidence and supports byte
  ranges for large objects;
- the report endpoint returns private `verification.json` and fails closed
  above its hosted payload limit;
- both derive session identity from the path and require only a matching
  `X-Session-Capability`;
- the API validates canonical `sessions/<sessionId>/<finalizationId>/...` object
  identity before S3 access.
- one configured artifact reader handles each request; an unavailable S3
  reader does not fall through to local storage.

Do not replace these endpoints with S3 URLs, presigned URLs, public access, or
`aws s3 presign`. Never place `verification.json`, `input.json`,
`included-bitmap.json`, or `seen-bitmap.json` in the public bundle.

Check in this order:

1. For `401`/`403`, confirm session/capability association without recording
   the capability.
2. If API Gateway saw no request, inspect CloudFront and the signed-cookie gate.
3. If the API rejects a locator, inspect persisted finalization/verification
   metadata instead of guessing a key.
4. For `AccessDenied`, compare public-api `s3:GetObject` and
   `s3:GetObjectVersion` authority with app IaC.
5. Missing `bundle.zip` belongs to finalization; existing bundle with missing
   `verification.json` normally belongs to verification.

Use the `describe-session` metadata listing for routine checks. If an owner
needs a separate `head-object` check, first validate the exact persisted locator
against the authenticated session, then pass that locator only inside the
restricted incident terminal. Do not reconstruct, paste, or retain a full key
pattern in a command or incident note, and never substitute `get-object` for a
routine metadata check.

If report content is essential, use the authenticated endpoint in a restricted
workspace and retain only a redacted summary. See
[Verification Implementation](../verification/README.md).

## 6. Async finalization

```text
POST /api/sessions/:sessionId/finalizations -> prover SQS -> proof-dispatcher
  -> Step Functions -> exact published image-signature verifier version
  -> AWS Batch queue/capacity -> Fargate prover -> startup admission
  -> finalization writer -> terminal state and bundle metadata
```

The path-authoritative browser lifecycle is:

- create: `POST /api/sessions/:sessionId/finalizations`
- current: `GET /api/sessions/:sessionId/finalizations/current`
- cancel:
  `POST /api/sessions/:sessionId/finalizations/:finalizationId/cancel`

All three require `X-Session-Capability` and use the same discriminated
`FinalizationResource`. The API-local HMAC callback is
`POST /api/internal/sessions/:sessionId/finalizations/:finalizationId/callback`;
it is outside the public API Gateway route inventory/CORS surface and requires
path/payload identity equality.

### Queue and dispatcher

```bash
aws sqs list-queues \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --queue-name-prefix "${TARGET_PREFIX}-prover-work" \
  --query 'QueueUrls' --output json --no-cli-pager

PROVER_QUEUE_URL="<reviewed-queue-url>"

aws sqs get-queue-attributes \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --queue-url "${PROVER_QUEUE_URL}" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible RedrivePolicy VisibilityTimeout \
  --query 'Attributes' --output json --no-cli-pager
```

An SQS backlog is pre-dispatch work; it does not count jobs already submitted
to Batch and waiting for capacity. Queue age is the `AWS/SQS` CloudWatch
`ApproximateAgeOfOldestMessage` metric, not a `GetQueueAttributes` field. Check
`public-api` for enqueue errors and `proof-dispatcher` for parsing,
session-state preconditions, duplicate handling, and
`StartExecution`/`DescribeExecution` errors. Malformed work retries/DLQs;
missing-session or non-pending work can be intentionally discarded as stale.
Q3 groups those acknowledged `dispatch_dropped` decisions. In a
finalization-scoped timeline, a `finalize_transition_attempted` event with
`STEP_FUNCTIONS_EXECUTION_CLOSED` means the session is still pending while the
same named execution is already closed; it records the caller-side guard and
does not claim that persistence occurred. Preserve the queue/DLQ item and
inspect reconciliation evidence instead of treating it as a safe stale drop.

### Step Functions, cryptographic signature verifier, and Batch

```bash
FINALIZATION_EXECUTION_ARN="<restricted-execution-arn>"

aws stepfunctions describe-execution \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --execution-arn "${FINALIZATION_EXECUTION_ARN}" \
  --query '{Status:status,Start:startDate,Stop:stopDate,RedriveStatus:redriveStatus}' \
  --output json --no-cli-pager

aws stepfunctions get-execution-history \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --execution-arn "${FINALIZATION_EXECUTION_ARN}" --reverse-order --max-results 40 \
  --no-paginate --no-include-execution-data \
  --query 'events[].{Id:id,Timestamp:timestamp,Type:type,PreviousEventId:previousEventId}' \
  --output json --no-cli-pager
```

- `VerifyImageSignature`: confirm the accepted state-machine definition and
  invocation permission select the exact published numeric Lambda version,
  then bind its typed
  `result = VERIFIED`, `mode = cryptographic` response to the exact digest and
  signing profile, `verifierVersion`, `trustPolicySha256`,
  `assetManifestSha256`, and `verifierAssets.trustRootSha256`. Successful
  pinned Notation verification under that strict trust policy is the
  certificate-chain, trusted-identity, and revocation-enforcement evidence;
  `DescribeImageSigningStatus` is readiness evidence only. Do not accept a
  mutable alias, unqualified function or `$LATEST`, a status-only ECR observation, or a
  bypass.
- `RunProver`: inspect the exact Batch job and queue, capacity, status, exit
  code and restricted prover logs using the checks below. Work submitted to
  Batch has already left the SQS backlog.
- Container startup: confirm the finalization writer admitted the current
  attempt before input download and host execution. Cancelled or superseded attempts and rejected admission cannot start the
  proof; matching repeated RUNNING updates can be idempotent.
- Callback states: inspect `finalization-writer`, DynamoDB/KMS, bundle metadata,
  and sticky terminal-state persistence.

```bash
BATCH_JOB_ID="<restricted-job-id-from-reviewed-execution>"

aws batch describe-jobs \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --jobs "${BATCH_JOB_ID}" \
  --query 'jobs[].{Status:status,CreatedAt:createdAt,StartedAt:startedAt,StoppedAt:stoppedAt,AttemptLimit:retryStrategy.attempts,AttemptTimeout:timeout.attemptDurationSeconds,Tasks:ecsProperties.taskProperties[].{Containers:containers[].{Name:name,ExitCode:exitCode}}}' \
  --output json --no-cli-pager
```

Use the exact job selected from restricted execution evidence; do not guess a
job ID or print environment overrides, input payloads, task ARNs or free-form
AWS failure reasons. Missing job metadata is an evidence gap, not proof that
work never ran. Keep the bounded status/timestamp/exit-code result with the
execution history and redacted prover logs.

`RunProver` has one combined deadline of `prover_task_timeout_seconds + 1800 +
180` seconds covering Batch queue wait and execution. There is no separately
enforced 30-minute capacity-wait timer. The Batch attempt limit is
`prover_task_timeout_seconds` (default 1,800), excluding queue wait. Inside the
container, the host has its own `ZKVM_TIMEOUT_SECONDS` limit (default 900) and
`ZKVM_TERMINATION_GRACE_SECONDS` (default 10). The container stop grace is 120
seconds. Identify which boundary expired before attributing a timeout to
capacity. Step Functions does not retry `SubmitJob`, whose ambiguous response
cannot be safely resubmitted; Batch also allows only one attempt.

State reconciliation is fail closed:

- duplicate finalize requests describe the existing attempt rather than start
  another proof;
- no execution past the dispatch deadline becomes
  `FINALIZATION_DISPATCH_TIMEOUT`;
- a closed execution without recorded outcome becomes
  `FINALIZATION_OUTCOME_UNRECORDED`, even if Step Functions says `SUCCEEDED`;
- terminal application states are sticky per `finalizationId`;
- cancellation during Batch wait prevents later proof through container
  startup admission; Batch owns capacity replenishment.

The finalization writer runs reconciliation from an EventBridge rule every
minute, independently of browser polling. Current-finalization GET only reads
and projects stored authority; repeated reads do not repair a stuck attempt.
The writer queries unexpired candidates through `finalization-expiry-index`,
then rereads current authority before a transition. Candidate failures are
reported after processing the remaining candidates. Diagnose the rule's
delivery alarm, writer errors, index access, and Step Functions observations.
Develop quiescence disables this rule, both queue consumers, and the Batch
queue. It does not itself drain in-flight work. The retained `semaphore-janitor`
Lambda normalizes operations-ledger events only; it owns neither capacity
release nor persisted finalization outcomes.

Closed lifecycle reasons have these operator responses:

| Reason                                 | Interpretation and response                                                                                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROVER_INPUT_PERSISTENCE_UNAVAILABLE` | Target dependency wiring refused work before enqueue. Confirm the accepted deployment/config and persisted failed state; do not retry blind.                                                                     |
| `STEP_FUNCTIONS_EXECUTION_CLOSED`      | Dispatcher found a closed same-name execution while state remained pending. Preserve retry/DLQ evidence and reconcile the missing outcome.                                                                       |
| `FINALIZATION_NOT_CANCELLABLE`         | Authenticated cancellation was refused before persistence. Compare requested `finalizationId` with the current sticky/terminal state.                                                                            |
| `INVALID_FINALIZATION_ARTIFACT`        | Current finalization artifact admission failed closed. Escalate as artifact integrity; do not overwrite or retry to force a green result.                                                                        |
| `PROVER_CAPACITY_WAIT_TIMEOUT`         | This remains an admitted failure code, but the current Batch state machine does not emit it. Bind the observation to its source/execution; diagnose current timeouts using the combined workflow deadline above. |

Cancellation changes state and requires the matching capability plus owner
approval. Direct `StopExecution` or Batch cancellation/termination is not the
standard application cancellation path and can leave an unrecorded outcome.
No mutation command is provided here.

## 7. Async verification

```text
POST /api/sessions/:sessionId/finalizations/:finalizationId/verification
  -> verification SQS -> verification-worker
  -> bundle download -> bundled Rust verifier-service
  -> private report upload -> terminal verification state
```

Target AWS returns `running` after enqueue. A terminal verification `failed`
can be the correct cryptographic verdict, not infrastructure failure. Never
retry or overwrite required-check failure to obtain a successful UI.

The run route requires the matching path capability and accepts only a strict
empty body. Read status from
`GET /api/sessions/:sessionId/finalizations/:finalizationId/verification`;
its strict grouped resource fails closed when authority is unavailable or
corrupt, and `include=journal` is the only journal opt-in. The observation
route accepts only telemetry `{ castChecks: ... }`; identity is never accepted
from its body.

```bash
aws sqs list-queues \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --queue-name-prefix "${TARGET_PREFIX}-verification-work" \
  --query 'QueueUrls' --output json --no-cli-pager

VERIFICATION_QUEUE_URL="<reviewed-queue-url>"

aws sqs get-queue-attributes \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --queue-url "${VERIFICATION_QUEUE_URL}" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible RedrivePolicy VisibilityTimeout \
  --query 'Attributes' --output json --no-cli-pager

aws lambda list-event-source-mappings \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --function-name "${TARGET_PREFIX}-verification-worker" \
  --query 'EventSourceMappings[].{State:State,BatchSize:BatchSize,FunctionResponseTypes:FunctionResponseTypes,LastModified:LastModified,LastProcessingResult:LastProcessingResult}' \
  --output json --no-cli-pager
```

Check `public-api` enqueue/marker logs; queue depth, age, DLQ, and mapping;
worker parsing/idempotency, bundle download, verifier, report upload, and
result-persistence logs; then canonical bundle/report metadata and the
authenticated report response. Do not use Step Functions or Batch unless a
separate finalization failure prevented creation of the bundle.

## 8. DLQ and Batch capacity

Do not receive, redrive, purge, delete, or edit messages during initial triage.
Preserve queue attributes, restricted message identity, application state,
parser/error logs, Step Functions status for prover work, bundle/report
metadata, retry count, and any sticky terminal state.

For prover DLQ work:

- missing session or non-pending state suggests stale work;
- a running execution suggests duplicate delivery;
- not-found or closed-without-outcome requires state reconciliation;
- dispatch-timeout attempts are not revived by redrive;
- malformed messages return to the same fail-closed path.

For verification DLQ work, confirm the current `finalizationId`, report metadata, and
stored result. A cryptographic `failed` result is not retryable infrastructure
work. Redrive/drop requires an owner decision documenting identity,
idempotency, expected result, containment, and evidence.

For capacity symptoms, first follow [async finalization](#6-async-finalization)
to distinguish SQS dispatch, signature verification, Batch wait, startup
admission, proof execution and callback persistence. Inspect the target queue
without printing job payloads or free-form status reasons:

```bash
BATCH_QUEUE_NAME="${TARGET_PREFIX}-prover"

aws batch describe-job-queues \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --job-queues "${BATCH_QUEUE_NAME}" \
  --query 'jobQueues[].{State:state,Status:status,Priority:priority}' \
  --output json --no-cli-pager
```

Compare the accepted job definition's one-unit replenishable requirement,
`prover_max_concurrent_provers` capacity, compute-environment vCPU ceiling and
Fargate quota with the exact job's status and timestamps. Batch owns scheduling
and capacity replenishment. There is no application semaphore table, owner
marker or scheduled capacity-release repair. A disabled queue may be reviewed
develop quiescence; read-only triage never enables it, raises capacity, retries
a submission or cancels/terminates a job.

The terminal-event ledger records `prover_job_finished` for the exact target
Batch queue, with resource `prover-job`, state `SUCCEEDED` or `FAILED`, and the
admitted deployment ID. The retained `semaphore-janitor` Lambda validates and
writes these normalized events. Its errors/throttles indicate ledger delivery
problems. The record deliberately omits job IDs, task ARNs and free-form
reasons; it supports deployment correlation, not a per-attempt outcome or
cryptographic verdict. Bind detailed diagnosis to the restricted execution/job
and current finalization record. Missing ledger evidence does not authorize
retry or establish that no job ran.

## 9. IAM and configuration drift

Map `AccessDenied` to the actual caller and intended owner:

- public-api: DynamoDB, enqueue, authenticated artifact reads, references;
- dispatcher: queue consumption, artifacts, Step Functions;
- verification worker: queue, bundle read/report write, DynamoDB, KMS;
- finalization writer: terminal state and artifact metadata, reconciliation-index
  reads, and Step Functions execution observations;
- qualified runtime image-signature verifier: exact prover ECR
  manifest/layer and authorization-token reads, signing-readiness observation,
  and scoped Signer revocation reads; Notation success under the strict trust
  policy is the acceptance authority;
- Batch prover task roles: proof-artifact read/write without delete, plus
  finalization-writer invocation for startup admission;
- Step Functions role: target Batch submission/tagging, job observation and
  tag-scoped termination, its Batch integration EventBridge rule, selected
  Lambda invoke, and logs;
- retained `semaphore-janitor`: validated operations-ledger writes, without
  semaphore or capacity mutation.

Record caller role, action, resource class, time, and source SHA. Compare with
app IaC and the accepted plan; never attach a broad policy as a shortcut.

For suspected Terraform drift, use the private local read-only procedure for
the selected root. It reproduces one exact checkpoint version and its package-
bound source, provider lock, nonsecret inputs, and immutable artifacts under
the root's read role, with refresh and `-lock=false`. It checks native work,
state, checkpoint, mutation-owner, and image availability before and after.
Missing dependencies or a changed observation fail the check. Exit 0 means
`no-drift`, 2 means `drift-detected`, and 1 means `check-failed`.

There is no managed drift runner or remote report publication. Preserve the
local redacted report; it does not write state, publish a checkpoint, approve
a plan, apply, or remediate. Corrections use reviewed local Bootstrap or the
managed Foundation/App saved-plan lane as appropriate. Stopped recovery keeps
its separate authorization; an alarm or drift report cannot select a historical
rollback or authorize state repair.

Inspect reference metadata without secret values:

```bash
aws ssm describe-parameters \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --parameter-filters Key=Name,Option=BeginsWith,Values=/stark-ballot-simulator/stark-dev/develop \
  --query 'Parameters[].{Name:Name,Type:Type,Tier:Tier,LastModified:LastModifiedDate}' \
  --output json --no-cli-pager

aws secretsmanager list-secrets \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --filters Key=name,Values=/stark-ballot-simulator/stark-dev/develop \
  --query 'SecretList[].{Name:Name,RotationEnabled:RotationEnabled,LastChanged:LastChangedDate,LastAccessed:LastAccessedDate}' \
  --output json --no-cli-pager
```

Do not use `get-secret-value` for routine diagnosis. Lambda entrypoints load
references at cold start and cache them in warm environments. A value update
alone does not prove coordinated rollout. Origin-header rotation remains a
single-value change story without an ad hoc safe path. Develop signed-cookie
rotation uses the tracked KMS keyset and separately reviewed overlap, probe,
retirement, and cleanup applies; do not bypass that staged workflow.

For GitHub-trigger incidents, distinguish “workflow assumed the OIDC role and
started AWS” from “the AWS pipeline succeeded.” Verify OIDC trust,
CodeConnection status, requested source revision, and pipeline execution as
separate evidence.

## 10. Monitoring, investigation, and escalation

Current App source defines 35 alarms per target, including the finalization
sweep delivery alarm. Twenty-nine remain passive detectors. Historical 36-alarm
observations in the dated inventory describe the configuration observed then;
they are not a fresh measurement of current deployment. The isolated
`verification-invariant-contradiction` alarm
has the only direct SNS action. Five separate sustained alarms—two DLQ, two
queue-age, and one API 5xx—route exact `ALARM` events through EventBridge to the
notification-only `ops-actionable` topic. An exact owned-pipeline `FAILED` rule
uses the same topic but is not another alarm. Neither notification route has a
mutation or remediation target.

```bash
aws cloudwatch describe-alarms \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --alarm-name-prefix "${TARGET_PREFIX}-" \
  --query 'MetricAlarms[].{Name:AlarmName,State:StateValue,Reason:StateReason,Updated:StateUpdatedTimestamp,Metric:MetricName,Namespace:Namespace}' \
  --output json --no-cli-pager
```

REST metrics use `ApiName` and `Stage=live` dimensions. Use `Count` with
`SampleCount`, `5XXError` and `4XXError` with `Sum`, and latency metrics in
milliseconds. Correlate the REST access-log request IDs with application logs;
pre-handler rejections can have no application event.

Use [DLQ and capacity triage](#8-dlq-and-batch-capacity) for queue or Fargate
alarms and [async finalization](#6-async-finalization) for Step Functions
failure/timeout alarms. Lambda alarms identify the named handler; DynamoDB
throttling identifies the affected table and request path. Queue depth is not
a user-visible position estimate.
The current detector set also includes:

| Alarm suffix                           | First response                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finalization-sweep-delivery`          | Inspect the exact EventBridge rule, target permission, exhausted delivery retries, and writer logs; repeated GETs do not reconcile state.                                                    |
| `public-api-errors`                    | Correlate API access/request IDs, `api_error`, config, and the accepted deployment; distinguish handler error from API 5xx/throttle.                                                         |
| `verification-worker-errors`           | Inspect queue retry/DLQ, bundle read, verifier category, report write, and terminal persistence; never retry a cryptographic red verdict.                                                    |
| `image-signature-verifier-errors`      | Inspect the exact published-version invocation, typed result, selected digest, strict trust-policy/trust-root evidence, revocation enforcement, and state-machine history; do not bypass it. |
| `public-api-throttles`                 | Compare API count/5xx, Lambda concurrency, and global rate-limit evidence; do not infer abuse from one demo request.                                                                         |
| `finalization-writer-throttles`        | Preserve the Step Functions attempt and check whether the terminal outcome was recorded before considering replay.                                                                           |
| `proof-dispatcher-throttles`           | Inspect SQS age/retry/DLQ and each execution attempt; do not redrive before confirming owner/idempotency state.                                                                              |
| `verification-worker-throttles`        | Inspect verification queue age/retry/DLQ and the current finalization result; keep demo red separate from infrastructure failure.                                                            |
| `image-signature-verifier-throttles`   | Inspect state-machine retry/timeout and verifier concurrency; never replace signature evidence with a retry-only conclusion.                                                                 |
| `semaphore-janitor-throttles`          | Inspect normalized operations-ledger delivery, EventBridge invocation, and log-write errors; this retained Lambda does not release capacity.                                                 |
| `api-gateway-5xx`                      | Join the access-log request ID to Lambda/system logs and native Lambda metrics; identify integration/pre-handler versus application 5xx.                                                     |
| `prover-work-oldest-message-age`       | Inspect queue consumer, dispatcher, DLQ, state-machine attempts, and recovery quiescence before any receive/redrive/delete action.                                                           |
| `verification-work-oldest-message-age` | Inspect mapping state, worker throttles/errors, DLQ, and current verification record before any queue mutation.                                                                              |
| `verification-invariant-contradiction` | Security-escalate a likely verdict-pipeline code bug, preserve the raw-check summary evidence, and do not describe it as proof of tamper.                                                    |

### Invariant and operations-actionable routes

The verification-invariant topic is an isolated highest-severity security
route. It carries only the contradiction alarm and must not be reused for
operational availability notifications. The separate `ops-actionable` topic is
limited to the reviewed conditions below; do not attach the current one-period
diagnostic alarms wholesale.

Every investigation starts with the identity check, the notification timestamp,
the named resource/pipeline, its configured alarm/rule, and a bounded UTC
window. Preserve the first failing attempt and evidence before considering any
mutation.

| Condition                                                                                                   | Owner / severity                                                                  | Preservation-first dashboard/query and diagnosis                                                                                                                                                                                                                                                            | No-data / false-positive interpretation                                                                                                                                                                                                             | Normal authorized lane and warnings                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPS-DLQ-01`: visible messages in either owned DLQ for 3/3 five-minute periods                              | Async-runtime owner / high                                                        | Open the async dashboard, correlate the named DLQ with source-queue age, Lambda errors/throttles, Q2, each Step Functions attempt, current finalization state, and accepted deployment. Preserve message/attempt metadata without copying a private body.                                                   | Missing data is configured non-breaching but is insufficient evidence of end-to-end health. Delayed metrics, an already-investigated retained message, or duplicate notification can be non-current; prove age and current depth before escalation. | A code/config fix uses the full App saved-plan lane. Do not receive, redrive, delete, purge, alter visibility, cancel an execution, or change Batch capacity until ownership, idempotency, and the terminal record are proven and the specific mutation is separately authorized.           |
| `OPS-QUEUE-AGE-01`: oldest work exceeds 900 seconds for 3/3 five-minute periods                             | Async-runtime owner / high                                                        | Open the queue/finalization dashboard and use Q2 plus queue depth/age, event-source mapping, consumer errors/throttles, DLQ, [Batch diagnosis](#6-async-finalization) and [capacity checks](#8-dlq-and-batch-capacity), and accepted deployment. Preserve the oldest attempt and current application state. | Missing data is non-breaching but not proof that admission works. A long valid prover job, planned quiescence, low consumer volume, or one delayed CloudWatch point can look old; require the configured consecutive periods.                       | A runtime/config fix uses the full App lane; a prover-image defect follows the Prover release and then App lane. Do not receive/redrive/delete, raise concurrency, change Batch capacity, or bypass quiescence during triage.                                                               |
| `OPS-API-5XX-01`: in each of 3/3 five-minute periods, at least 20 requests and 5 errors with a rate over 5% | API-runtime owner / high                                                          | Open the API SLI/dashboard and correlate REST API `Count`/`5XXError`, access-log request IDs, Q1, Lambda errors/throttles, dependencies, and the exact accepted deployment. Separate integration/pre-handler failure from application 5xx.                                                                  | Missing/low traffic is non-breaching and `insufficient_evidence`, not 100% success. Expected 4xx is excluded. Retries, health probes, or one client burst can duplicate symptoms; all count/rate/period conditions must hold.                       | Application, configuration and frontend fixes use the normal App saved-plan lane. Do not weaken auth/origin/capability/rate-limit behavior, manufacture requests, or retry a failed deployment blind.                                                                                       |
| `OPS-PIPELINE-FAILED-01`: owned deployment pipeline enters `FAILED`                                         | Deployment operator / high; escalate immediately for partial apply or user impact | Open the pipeline execution and Q8/change-health ledger views. Bind the bounded execution ID to requested/resolved source, stage/action result, state/backend, saved-plan checksum, approval, Apply, smoke, and accepted record. Preserve the failed execution and artifacts.                               | EventBridge is at least once, so duplicate rows/notifications are expected. A later success does not erase a prior partial failure. Missing ledger or acceptance data is insufficient evidence, not proof that no mutation occurred.                | Follow the exact owning deployment-lane runbook. A reviewed source correction starts a normal lane; do not blind-rerun, reuse a saved plan, approve a different checksum, repoint an accepted record, roll back, or repair state out of band.                                               |
| Repeated Step Functions platform failures                                                                   | Async-runtime owner / deferred                                                    | Continue using the existing passive failed/timed-out alarms, Q2/Q10, [finalization evidence](#6-async-finalization) and [Batch ledger](#8-dlq-and-batch-capacity), and accepted deployment during the 30-day calibration. Keep expected-domain outcomes separate.                                           | Sparse traffic, duplicate events, expected-domain failures, and one isolated platform failure cannot establish a low-noise repeated condition. No data is insufficient evidence.                                                                    | No Step Functions actionable route or automatic action is enabled until a post-calibration review approves a bounded low-noise condition. If a defect is found, use the full App lane; never retry a cryptographic red outcome, cancel/redrive automatically, or bypass the signature gate. |

An operations notification may initiate diagnosis or, after evidence and normal
authorization, the relevant deployment lane. It cannot initiate Apply,
rollback, recovery, redrive, deletion, cancellation, capacity changes, or
accepted-pointer changes. It also never changes a verification result.

For each notification route, use the dated inventory to distinguish endpoint
presence, subscription creation, confirmation and actual delivery.
`PendingConfirmation` cannot notify; a confirmed subscription alone does not
prove delivery. Never copy an endpoint or subscription ARN into incident
notes. Enabling or changing recipients is a deployment and secret-entry story
under the private operator procedure, not incident repair.

The operations route has its own fixed SSM SecureString endpoint contract:

```text
/stark-ballot-simulator/stark-dev/develop/observability/ops-actionable-email/endpoint
```

An absent value means no subscription. An unexpected child, multiple values,
non-SecureString type, or invalid/untrimmed email fails the saved plan. Terraform
may output only the fixed parameter name and configured state; the value must not
enter tfvars, environment variables, command lines, logs, notification evidence,
or incident notes. The provider necessarily retains the sensitive decrypted
value in encrypted, access-restricted App state.

Operations notification bodies are limited to the closed environment,
resource/pipeline name, approved bounded pipeline execution identity, timestamp,
alarm state, dashboard, and runbook ID. They contain no source SHA, ARN, account,
session/finalization identifier, raw reason, secret, or artifact locator.

Resource deployment, recipient/delivery evidence, post-rollout metric-filter
observation, query calibration and completion of the first 30 live days are
separate inventory observations. Do not infer an actionable recipient from an
installed topic or the invariant subscription. Do not create traffic or publish
a synthetic notification solely to manufacture evidence; test publication
requires separate explicit authorization. The first 30 live days are
measurement-only: no burn-rate alarm, error-budget gate or automatic operator
policy is active. No traffic is insufficient evidence, not 100% reliability.

Dispatcher, finalization, and verification custom metrics have only closed
reason/category dimensions and are investigation aids, not verdict inputs.
Lambda metric filters select canonical fields below the outer `$.message`
object. The private operator documentation provides a bounded, read-only saved
query smoke that prints query status, not query results. The retained monitoring
window at source `3c2f0353…` already records completion of all ten canonical
queries and readback/execution of corrected saved cohort/reason definitions.
That bounded historical evidence is not fresh calibration of every later
source or target. Runtime log retention is 90 days in develop and 180 in main;
operations-ledger retention is 365 and 731 days respectively. A retained report
does not make its expired underlying logs queryable.

Escalate immediately for identity/state-scope uncertainty; possible secret or
private-artifact leakage; direct-origin bypass; false **Verified** presentation;
private files in a public bundle; a DLQ/Batch/IAM/KMS/signing issue that
needs mutation; or Terraform/live drift or partial apply. Route a production
incident to its exact target-bound operator authority because these command
procedures cover develop; production deployment does not authorize target
substitution.

### Investigation workflows

Each workflow begins with the identity check and a bounded UTC window.

| Workflow                  | First evidence                                                                                                         | Supported conclusion required before recovery                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| W1 stuck finalization     | `describe-session`, [finalization evidence](#6-async-finalization), [Batch ledger/capacity](#8-dlq-and-batch-capacity) | what/where/why per attempt; `SUCCEEDED` without canonical outcome remains `FINALIZATION_OUTCOME_UNRECORDED` |
| W2 bundle/report failure  | admission status, `bundle_download_failed`, canonical metadata                                                         | distinguish 401/403, 404/409, missing/expired object, IAM denial, range/integrity failure                   |
| W3 red verification       | server scenario, exact-finalization browser observation, required checks, `verification_run_summary`                   | infrastructure category, expected S1–S5 educational red, or unexpected S0/product defect                    |
| W4 quiet system           | API count/access log, queues, invocations, throttles, SFN, latest deploy                                               | traffic lull versus broken admission/dispatch; gated journey only when explicitly authorized                |
| W5 post-deploy regression | one accepted deployment/attempt plus before/after Q1/Q8 windows                                                        | bind actual source/mode and keep resource smoke, operator probe, and full journey as separate evidence      |
| W6 alarm or DLQ           | alarm definition/reason/window plus correlated deploy/traffic/runtime state                                            | safe-to-redrive, stale-to-drop, or preserve untouched; returning to `OK` does not close the incident        |

For W1, preserve ambiguity when multiple AWS execution ARNs exist, but do not
invent a second repository lifecycle ID alongside `finalizationId`. For W2, use
`head-object` only after validating the stored locator and never create a
presigned URL. For W3, never retry or change a verdict to make it green; a path
that can show **Verified** with an unpassed required check is a security
escalation. `verification_run_summary` is emitted only after the authenticated
browser submits the four local cast-check statuses for the current finalization;
the server supplies the other checks and all scenario/failure metadata. For
W5, do not mix action results from different pipeline executions. For W6,
inspect before redrive, purge, deletion, cancellation, or Batch capacity changes.

### Incident note and TTU

Store the note in an approved private location. Record engagement-to-supported-
conclusion time, not merely time to first response:

```markdown
# <date> <short title>

- Environment: stark-dev/develop
- Owner / severity / symptom: <owner / severity / one sentence>
- Reported: <time / timezone / channel>
- Engaged: <time> Concluded: <time>
- TTU: <minutes from engagement to evidence-backed conclusion>
- Surfaces touched: <count and short list>
- Trigger: <user report / alarm review / gated smoke>
- Deployment: <exact source SHA; execution; checkpoint object version; plan-package reference; exact stage results>
- Approval evidence: <exact plan-package version/hash and saved-plan checksum; native approval action and execution>
- Edge/API: <path and sanitized request/error IDs>
- Restricted identifiers: <stable hashes or session/finalization/AWS execution IDs>
- What: <one sentence>
- Where: <journey stage and component>
- Why: <expected invariant; observed divergence; closed reason codes; supported hypothesis>
- Runtime evidence: <SQS / Step Functions / Batch / object metadata / alarms>
- Logs: <query IDs/windows and short redacted excerpts>
- Expired evidence: <expected expiry or none>
- Unanswerable questions: <questions no longer supported or none>
- Prior mutations: <partial apply / console action / other mutation or none>
- Security/privacy review: <redaction and invariant impact>
- Follow-up: <change story; blast radius; containment/rollback; approval; validation; signal gap>
```

Do not include account IDs, full ARNs, capability tokens, signed cookies,
private artifact bodies, raw vote/session data, secret/config values, full S3
keys, or unredacted log dumps. If a failure class repeatedly exceeds 30 minutes
TTU, use that measured gap to prioritize the next signal investment.

## 11. Applying a change after triage

Diagnosis is not repair authorization. After owner approval:

1. classify the change with the deployment guide and check current inventory
   drift;
2. bind source SHA, account, region, state scope/backend, immutable artifact or
   image coordinates, and approvals;
3. use reviewed local Bootstrap for deployment-control changes, or the selected
   managed Foundation/App or image-release lane; never reuse a saved plan;
4. distinguish resource smoke from the gated
   session -> vote -> finalize -> verify -> bundle/report flow;
5. require same-execution apply and smoke evidence; partial updates in a failed
   pipeline are not a successful deployment;
6. refresh the inventory and attach redacted evidence.

`test:develop:gated-smoke` is deliberately not an automatic pipeline stage. It
creates application state and consumes global rate-limit and Fargate capacity,
so run it only as a separately authorized acceptance check. Preserve three
claims: PostApplySmoke proves resource/configuration wiring, the operator-gate
probe proves admission behavior, and the full gated journey proves its own
state-creating end-to-end path.

For deployed production, use the main target’s own approved change and
validation procedure. Its public Turnstile journey is separate from the develop
operator-gated checks above; do not adapt these commands or treat develop
evidence as production validation.

## 12. References

- [Runbook index](./README.md)
- [Infrastructure and cloud security](../infrastructure/README.md)
- [Terraform ownership](../infrastructure/terraform.md)
- App Terraform runtime: `infra/terraform/app/README.md` (private operator documentation)
- AWS operator helper contracts: `scripts/aws/README.md` (private operator documentation)
- [Verification and artifact boundary](../verification/README.md)
- [Logging runbook](./logging.md)
- [Security runbook](./security.md)
