# AWS Runtime Operations Runbook

> **Scope:** the deployed, operator-gated `stark-dev/develop` AWS runtime.
> `stark-prod/main` has not been deployed, validated, or approved. Never turn a
> develop command into a production command by substituting names or profiles.
> The live finalization state machine invokes the qualified cryptographic
> `image-signature-verifier:runtime` alias. The retired status-only
> `image-signature-gate` is not part of the current runtime.

Use this runbook for read-only incident triage and evidence collection. It does
not authorize an AWS change. Lane selection, approvals, deployment procedures,
live inventory, and known-drift records remain in private operator
documentation.

## 1. Safety boundary

| Phase              | In scope                                                                                     | Out of scope                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only triage   | Identity checks; non-mutating `list`, `describe`, `get`, `head`, logs, and retained evidence | Resource, queue, execution, secret, key, policy, object, or state mutation                                                                                    |
| Change application | Evidence handoff and selection of an approved deployment/recovery story                      | Local Terraform, ad hoc console repair, direct CodeBuild, unreviewed pipeline starts, redrive/purge, `StopExecution`, semaphore edits, or key/secret rotation |

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
             -> qualified cryptographic image-signature-verifier:runtime alias
             -> semaphore -> ECS prover -> private proof S3
             -> finalization writer -> DynamoDB terminal state and artifact metadata
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

Finalization uses Step Functions, the semaphore, and ECS. Verification uses a
separate SQS queue and Lambda worker; it does not normally use Step Functions
or ECS.

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
code, gated hostname versus direct origin, source SHA, accepted deployment
record, pipeline execution, and restricted session/finalization or AWS execution identifiers. Do
not record the capability token. Any path that can display **Verified** while a
required check has not passed is a security escalation.

Before interpreting live symptoms as new drift, read the dated inventory and
the exact retained accepted-baseline and latest root-specific report evidence
selected by the private operator procedure. `no-drift`, `drift-detected`, and
`check-failed` describe report-only evidence; none authorizes a saved plan,
Apply, remediation, or a readiness invocation.

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

For an accepted app deployment, identify both the CodePipeline execution ID
and the acceptance-attempt ID. The retained authority is immutable under
`accepted-deployments/stark-dev/develop/app/executions/<pipelineExecutionId>/attempts/<acceptanceAttemptId>/`;
the mutable
`accepted-deployments/stark-dev/develop/app/current.json` authority is updated
by compare-and-swap and contains the exact immutable record coordinates that
remain reachable for current operation and rollback. Never read or infer
authority from the retired `index.json`. In a restricted workspace, exact-read
the selected record by its key, S3 `VersionId`, and body SHA-256, then bind it
to its exact `tfplan`, checksum, approval-evidence object version and SHA-256,
apply outputs, static deploy record, and smoke report before treating the
runtime as accepted. Multiple smoke attempts can share one pipeline execution,
so the pipeline execution ID alone is not sufficient evidence.

Normal evidence must have no rollback selection. Rollback evidence must bind
the current control source to the selected historical source, historical
accepted deployment record and acceptance attempt, historical approval
evidence, and immutable app/toolchain/prover release records. Do not infer
rollback authority from a successful stage or source SHA alone.

### Recovery posture

Establish the selected DynamoDB recovery phase before diagnosing admission,
queue-consumer, or store behavior. Read the accepted attempt's authoritative
deployment record, `apply-outputs.json`, and
`app-smoke-dynamodb-recovery-phase-evidence.json`; do not obtain a phase by
editing Terraform inputs or starting a pipeline.

| Phase                  | Served pair | Public session creation | Prover/verifier SQS consumers |
| ---------------------- | ----------- | ----------------------- | ----------------------------- |
| `primary_active`       | Primary     | Enabled                 | Enabled                       |
| `primary_quiesced`     | Primary     | Disabled                | Disabled                      |
| `replacement_quiesced` | Replacement | Disabled                | Disabled                      |
| `replacement_active`   | Replacement | Enabled                 | Enabled                       |

Corroborate the retained phase against live configuration. Table ARNs and
mapping UUIDs are restricted incident evidence:

```bash
aws lambda get-function-configuration \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --function-name "${TARGET_PREFIX}-public-api" \
  --query 'Environment.Variables.{RuntimeProfile:RUNTIME_PROFILE,Sessions:DYNAMODB_SESSIONS_TABLE,Votes:DYNAMODB_VOTES_TABLE}' \
  --output json --no-cli-pager

for function_name in proof-dispatcher verification-worker; do
  aws lambda list-event-source-mappings \
    --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
    --function-name "${TARGET_PREFIX}-${function_name}" \
    --query 'EventSourceMappings[].{UUID:UUID,State:State,LastProcessingResult:LastProcessingResult}' \
    --output json --no-cli-pager
done
```

In either quiesced phase, the public API must select
`target-aws-async-quiesced`; active phases select `target-aws-async`. Rejected
session creation and disabled mappings are the intended containment posture,
not by themselves an outage. A served-pair, runtime profile, or mapping state
that disagrees with the accepted phase is drift and requires escalation. Queue
drain, in-flight Lambda/Step Functions/ECS work, and data reconciliation are
separate evidence; phase smoke does not prove them. Recovery moves one ordered
phase per newly reviewed saved-plan execution and is outside this runbook's
mutation scope.

Discover logs instead of relying on remembered names:

```bash
aws logs describe-log-groups \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --log-group-name-prefix "/aws/lambda/${TARGET_PREFIX}-" \
  --query 'logGroups[].{Name:logGroupName,RetentionDays:retentionInDays}' \
  --output json --no-cli-pager

aws logs describe-log-groups \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --log-group-name-prefix "/aws/lambda/${IMAGE_SIGNATURE_PREFIX}-image-signature-verifier" \
  --query 'logGroups[].{Name:logGroupName,RetentionDays:retentionInDays}' \
  --output json --no-cli-pager

aws logs describe-log-groups \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --log-group-name-prefix "/aws/vendedlogs/states/${TARGET_PREFIX}-finalization" \
  --query 'logGroups[].{Name:logGroupName,RetentionDays:retentionInDays}' \
  --output json --no-cli-pager

aws logs describe-log-groups \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --log-group-name-prefix "/aws/ecs/${TARGET_PREFIX}-prover" \
  --query 'logGroups[].{Name:logGroupName,RetentionDays:retentionInDays}' \
  --output json --no-cli-pager
```

Use the narrowest useful time range and redact excerpts before sharing. The
detailed Logs Insights query catalog remains in private operator
documentation.

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

Expected boundaries:

- the develop hostname requires the CloudFront signed-cookie gate;
- static files use private S3 through OAC;
- `/api` and `/api/*` route through CloudFront to the HTTP API;
- the execute-api endpoint remains enabled as the CloudFront origin, while the
  application must reject requests without the expected origin header;
- DNS is externally owned, and the CloudFront certificate is in ACM
  `us-east-1`;
- AWS WAF is intentionally absent; rate limits, API throttling, Turnstile where
  enabled, the outer develop gate, logs, and alarms are compensating controls.

An unauthenticated develop-hostname `403` can be the expected gate. Successful
direct-origin access that bypasses the gate or origin-header check is a
security incident.

```bash
aws cloudfront list-distributions \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --query "DistributionList.Items[?Comment=='${TARGET_PREFIX} static frontend'].{Enabled:Enabled,Status:Status,Aliases:Aliases.Items,Origins:Origins.Items[].DomainName,TrustedKeyGroups:DefaultCacheBehavior.TrustedKeyGroups.Items}" \
  --output json --no-cli-pager

aws apigatewayv2 get-apis \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --query "Items[?Name=='${TARGET_PREFIX}-api'].{Name:Name,Protocol:ProtocolType,DisableExecuteEndpoint:DisableExecuteApiEndpoint,Created:CreatedDate}" \
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
  -> Step Functions -> qualified runtime image-signature verifier alias
  -> semaphore -> ECS prover
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

A queue backlog is pre-dispatch work; it does not count Step Functions executions waiting for
a semaphore slot. Queue age is the `AWS/SQS` CloudWatch
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

### Step Functions, cryptographic signature verifier, semaphore, and ECS

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
  --query 'events[].{Id:id,Timestamp:timestamp,Type:type,PreviousEventId:previousEventId}' \
  --output json --no-cli-pager
```

- `VerifyImageSignature`: confirm the accepted state-machine definition invokes
  only the qualified `runtime` alias, then bind its typed
  `result = VERIFIED`, `mode = cryptographic` response to the exact digest and
  signing profile, `verifierVersion`, `trustPolicySha256`,
  `assetManifestSha256`, and `verifierAssets.trustRootSha256`. Successful
  pinned Notation verification under that strict trust policy is the
  certificate-chain, trusted-identity, and revocation-enforcement evidence;
  `DescribeImageSigningStatus` is readiness evidence only. Do not accept an
  unqualified function or `$LATEST`, a status-only ECR observation, or a
  bypass.
- Semaphore states: compare the counter, owner markers, execution status, and
  janitor logs. The work has already left the SQS backlog.
- `RunProver`: inspect ECS capacity/retries, task status, stopped reason, exit
  code, and prover log.
- Callback states: inspect `finalization-writer`, DynamoDB/KMS, bundle metadata,
  and sticky terminal-state persistence.

```bash
ECS_CLUSTER="${TARGET_PREFIX}-prover"
ECS_TASK_ARN="<restricted-task-arn>"

aws ecs describe-tasks \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --cluster "${ECS_CLUSTER}" --tasks "${ECS_TASK_ARN}" \
  --query 'tasks[].{LastStatus:lastStatus,StopCode:stopCode,StoppedReason:stoppedReason,StartedAt:startedAt,StoppedAt:stoppedAt,Containers:containers[].{Name:name,ExitCode:exitCode,Reason:reason}}' \
  --output json --no-cli-pager
```

ECS retains stopped-task descriptions briefly; use execution history and logs
when the task is no longer describable.

State reconciliation is fail closed:

- duplicate finalize requests describe the existing attempt rather than start
  another proof;
- no execution past the dispatch deadline becomes
  `FINALIZATION_DISPATCH_TIMEOUT`;
- a closed execution without recorded outcome becomes
  `FINALIZATION_OUTCOME_UNRECORDED`, even if Step Functions says `SUCCEEDED`;
- terminal application states are sticky per `finalizationId`;
- cancellation during slot wait prevents later proof start and releases the
  superseded slot.

Closed lifecycle reasons have these operator responses:

| Reason                                 | Interpretation and response                                                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROVER_INPUT_PERSISTENCE_UNAVAILABLE` | Target dependency wiring refused work before enqueue. Confirm the accepted deployment/config and persisted failed state; do not retry blind. |
| `STEP_FUNCTIONS_EXECUTION_CLOSED`      | Dispatcher found a closed same-name execution while state remained pending. Preserve retry/DLQ evidence and reconcile the missing outcome.   |
| `FINALIZATION_NOT_CANCELLABLE`         | Authenticated cancellation was refused before persistence. Compare requested `finalizationId` with the current sticky/terminal state.        |
| `INVALID_FINALIZATION_ARTIFACT`        | Current finalization artifact admission failed closed. Escalate as artifact integrity; do not overwrite or retry to force a green result.    |

Cancellation changes state and requires the matching capability plus owner
approval. Direct `StopExecution` can split session state from semaphore
ownership and is not the standard path. No mutation command is provided here.

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
authenticated report response. Do not use Step Functions or ECS unless a
separate finalization failure prevented creation of the bundle.

## 8. DLQ and semaphore

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

Read only the semaphore counter and seed limit during routine triage:

```bash
PROVER_SEMAPHORE_TABLE="${TARGET_PREFIX}-prover-semaphore"

aws dynamodb get-item \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --table-name "${PROVER_SEMAPHORE_TABLE}" \
  --key '{"LockName":{"S":"prover-fargate"}}' \
  --projection-expression 'LockName,currentLockCount,#limit' \
  --expression-attribute-names '{"#limit":"limit"}' --consistent-read \
  --output json --no-cli-pager
```

The stored limit is inventory; the deployed state-machine variable is the
enforcement authority. Full owner markers contain restricted execution IDs.
Compare them only in the incident workspace with execution status and
`semaphore-janitor` terminal-event/30-minute-sweep logs. Do not use
`update-item` to release owners or recreate the row. Such repair requires an
approved recovery and post-repair gated smoke.

## 9. IAM and configuration drift

Map `AccessDenied` to the actual caller and intended owner:

- public-api: DynamoDB, enqueue, authenticated artifact reads, references;
- dispatcher: queue consumption, artifacts, Step Functions;
- verification worker: queue, bundle read/report write, DynamoDB, KMS;
- finalization writer: terminal state and artifact metadata;
- qualified runtime image-signature verifier: exact prover ECR
  manifest/layer and authorization-token reads, signing-readiness observation,
  and scoped Signer revocation reads; Notation success under the strict trust
  policy is the acceptance authority;
- ECS roles: proof-artifact read/write, without delete;
- Step Functions role: ECS, selected Lambda invoke, semaphore, and logs.

Record caller role, action, resource class, time, and source SHA. Compare with
app IaC and the accepted plan; never attach a broad policy as a shortcut.

For suspected Terraform drift, bind the diagnosis to the immutable accepted
baseline and exact-version report selected by the current inventory. The
installed root-specific runners plan the accepted historical configuration
with refresh and `-lock=false`; their `no-drift`, `drift-detected`, and
`check-failed` classifications do not write state, move an accepted pointer,
approve a saved plan, apply, or remediate. Preserve the report and escalate a
required correction to the ordinary saved-plan lane owned by Bootstrap,
Foundation, or App. The separate rollback and recovery readiness projects
remain uninvoked; do not start either as alarm or drift diagnosis.

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

The dated live inventory records 36 Terraform-defined alarms. Thirty remain
passive detectors. The isolated `verification-invariant-contradiction` alarm
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

Use DLQ alarms to enter the evidence-first decision above; Step Functions
failure/timeout alarms to inspect history, semaphore, ECS, and callback;
Lambda alarms to inspect the named handler; Fargate usage to inspect quota,
tasks, retries, and slot limit; and DynamoDB throttling to identify the affected
table and request path. Queue depth is not a user-visible position estimate.
The current detector set also includes:

| Alarm suffix                           | First response                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public-api-errors`                    | Correlate API access/request IDs, `api_error`, config, and the accepted deployment; distinguish handler error from API 5xx/throttle.                                                         |
| `verification-worker-errors`           | Inspect queue retry/DLQ, bundle read, verifier category, report write, and terminal persistence; never retry a cryptographic red verdict.                                                    |
| `image-signature-verifier-errors`      | Inspect the qualified runtime-alias invocation, typed result, selected digest, strict trust-policy/trust-root evidence, revocation enforcement, and state-machine history; do not bypass it. |
| `public-api-throttles`                 | Compare API count/5xx, Lambda concurrency, and global rate-limit evidence; do not infer abuse from one demo request.                                                                         |
| `finalization-writer-throttles`        | Preserve the Step Functions attempt and check whether the terminal outcome was recorded before considering replay.                                                                           |
| `proof-dispatcher-throttles`           | Inspect SQS age/retry/DLQ and each execution attempt; do not redrive before confirming owner/idempotency state.                                                                              |
| `verification-worker-throttles`        | Inspect verification queue age/retry/DLQ and the current finalization result; keep demo red separate from infrastructure failure.                                                            |
| `image-signature-verifier-throttles`   | Inspect state-machine retry/timeout and verifier concurrency; never replace signature evidence with a retry-only conclusion.                                                                 |
| `semaphore-janitor-throttles`          | Compare the scheduled/terminal invocation, owner markers, and live executions; do not edit the semaphore during triage.                                                                      |
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

| Condition                                                                                                   | Owner / severity                                                                  | Preservation-first dashboard/query and diagnosis                                                                                                                                                                                                                              | No-data / false-positive interpretation                                                                                                                                                                                                             | Normal authorized lane and warnings                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPS-DLQ-01`: visible messages in either owned DLQ for 3/3 five-minute periods                              | Async-runtime owner / high                                                        | Open the async dashboard, correlate the named DLQ with source-queue age, Lambda errors/throttles, Q2, each Step Functions attempt, current finalization state, and accepted deployment. Preserve message/attempt metadata without copying a private body.                     | Missing data is configured non-breaching but is insufficient evidence of end-to-end health. Delayed metrics, an already-investigated retained message, or duplicate notification can be non-current; prove age and current depth before escalation. | A code/config fix uses the full App saved-plan lane. Do not receive, redrive, delete, purge, alter visibility, cancel an execution, or edit the semaphore until ownership, idempotency, and the terminal record are proven and the specific mutation is separately authorized.              |
| `OPS-QUEUE-AGE-01`: oldest work exceeds 900 seconds for 3/3 five-minute periods                             | Async-runtime owner / high                                                        | Open the queue/finalization dashboard and use Q2 plus queue depth/age, event-source mapping, consumer errors/throttles, DLQ, Step Functions/ECS/semaphore state, and accepted deployment. Preserve the oldest attempt and current owner state.                                | Missing data is non-breaching but not proof that admission works. A long valid prover job, planned quiescence, low consumer volume, or one delayed CloudWatch point can look old; require the configured consecutive periods.                       | A runtime/config fix uses the full App lane; a prover-image defect follows the Prover release and then App lane. Do not receive/redrive/delete, raise concurrency, repair semaphore ownership, or bypass quiescence during triage.                                                          |
| `OPS-API-5XX-01`: in each of 3/3 five-minute periods, at least 20 requests and 5 errors with a rate over 5% | API-runtime owner / high                                                          | Open the API SLI/dashboard and correlate API Gateway `Count`/`5xx`, access-log request IDs, Q1, Lambda errors/throttles, dependencies, and the exact accepted deployment. Separate integration/pre-handler failure from application 5xx.                                      | Missing/low traffic is non-breaching and `insufficient_evidence`, not 100% success. Expected 4xx is excluded. Retries, health probes, or one client burst can duplicate symptoms; all count/rate/period conditions must hold.                       | Application/config fixes use the full App lane. A frontend-only fix may use static-fast only if that lane's default-deny path gate admits it. Do not weaken auth/origin/capability/rate-limit behavior, manufacture requests, or retry a failed deployment blind.                           |
| `OPS-PIPELINE-FAILED-01`: owned deployment pipeline enters `FAILED`                                         | Deployment operator / high; escalate immediately for partial apply or user impact | Open the pipeline execution and Q8/change-health ledger views. Bind the bounded execution ID to requested/resolved source, stage/action result, state/backend, saved-plan checksum, approval, Apply, smoke, and accepted record. Preserve the failed execution and artifacts. | EventBridge is at least once, so duplicate rows/notifications are expected. A later success does not erase a prior partial failure. Missing ledger or acceptance data is insufficient evidence, not proof that no mutation occurred.                | Follow the exact owning deployment-lane runbook. A reviewed source correction starts a normal lane; do not blind-rerun, reuse a saved plan, approve a different checksum, repoint an accepted record, roll back, or repair state out of band.                                               |
| Repeated Step Functions platform failures                                                                   | Async-runtime owner / deferred                                                    | Continue using the existing passive failed/timed-out alarms, Q2/Q10, execution history, ECS/semaphore evidence, and accepted deployment during the 30-day calibration. Keep expected-domain outcomes separate.                                                                | Sparse traffic, duplicate events, expected-domain failures, and one isolated platform failure cannot establish a low-noise repeated condition. No data is insufficient evidence.                                                                    | No Step Functions actionable route or automatic action is enabled until a post-calibration review approves a bounded low-noise condition. If a defect is found, use the full App lane; never retry a cryptographic red outcome, cancel/redrive automatically, or bypass the signature gate. |

An operations notification may initiate diagnosis or, after evidence and normal
authorization, the relevant deployment lane. It cannot initiate Apply,
rollback/readiness, recovery, redrive, deletion, cancellation, semaphore repair,
or accepted-pointer changes. It also never changes a verification result.

The invariant SNS topic carries only the last alarm. A subscription in
`PendingConfirmation` cannot notify, and a confirmed subscription proves
confirmation rather than test delivery. Use the dated AWS inventory for current
subscription and delivery evidence. Never copy the endpoint or subscription ARN
into incident notes. Enabling or changing the recipient is a deployment and
secret-entry story in private operator documentation, not incident repair.

The operations route has its own fixed SSM SecureString endpoint contract:

```text
/stark-ballot-simulator/stark-dev/develop/observability/ops-actionable-email/endpoint
```

An absent value means no subscription. An unexpected child, multiple values,
non-SecureString type, or invalid/untrimmed email fails the saved plan. Terraform
may output only the fixed parameter name and configured state; the value must not
enter tfvars, environment variables, command lines, logs, notification evidence,
or incident notes. The provider necessarily retains the sensitive decrypted
value in encrypted, access-restricted App state. Treat endpoint presence,
subscription creation, `PendingConfirmation`/confirmed state, and actual message
delivery as four separate facts.

Operations notification bodies are limited to the closed environment,
resource/pipeline name, approved bounded pipeline execution identity, timestamp,
alarm state, dashboard, and runbook ID. They contain no source SHA, ARN, account,
session/finalization identifier, raw reason, secret, or artifact locator.

The alarms, rules, topics, saved queries, and metric filters are deployed. The
actionable recipient's configuration and confirmation, benign notification
delivery, post-rollout metric-filter observation, query calibration, and
completion of the first 30 live days remain separate evidence boundaries. Use
the dated AWS inventory for their current status; do not infer an actionable
recipient from the installed topic or from the invariant subscription. Do not
create traffic or publish a synthetic notification solely to manufacture
evidence. A test publish still needs separate explicit authorization. The first
30 live days are measurement-only: no burn-rate alarm, error-budget gate, or
automatic operator policy is active. No traffic is insufficient evidence, not
100% reliability.

Dispatcher, finalization, and verification custom metrics have only closed
reason/category dimensions and are investigation aids, not verdict inputs.
Lambda metric filters select canonical fields below the outer `$.message`
object. The private operator documentation provides a bounded, read-only saved
query smoke that prints query status, not query results.

Escalate immediately for identity/state-scope uncertainty; possible secret or
private-artifact leakage; direct-origin bypass; false **Verified** presentation;
private files in a public bundle; a DLQ/semaphore/IAM/KMS/signing issue that
needs mutation; Terraform/live drift or partial apply; or any production
target.

### Investigation workflows

Each workflow begins with the identity check and a bounded UTC window.

| Workflow                  | First evidence                                                                                       | Supported conclusion required before recovery                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| W1 stuck finalization     | `describe-session`, dispatcher/DLQ, each SFN attempt, ECS-stop ledger                                | what/where/why per attempt; `SUCCEEDED` without canonical outcome remains `FINALIZATION_OUTCOME_UNRECORDED` |
| W2 bundle/report failure  | admission status, `bundle_download_failed`, canonical metadata                                       | distinguish 401/403, 404/409, missing/expired object, IAM denial, range/integrity failure                   |
| W3 red verification       | server scenario, exact-finalization browser observation, required checks, `verification_run_summary` | infrastructure category, expected S1–S5 educational red, or unexpected S0/product defect                    |
| W4 quiet system           | API count/access log, queues, invocations, throttles, SFN, latest deploy                             | traffic lull versus broken admission/dispatch; gated journey only when explicitly authorized                |
| W5 post-deploy regression | one accepted deployment/attempt plus before/after Q1/Q8 windows                                      | bind actual source/mode and keep resource smoke, operator probe, and full journey as separate evidence      |
| W6 alarm or DLQ           | alarm definition/reason/window plus correlated deploy/traffic/runtime state                          | safe-to-redrive, stale-to-drop, or preserve untouched; returning to `OK` does not close the incident        |

For W1, preserve ambiguity when multiple AWS execution ARNs exist, but do not
invent a second repository lifecycle ID alongside `finalizationId`. For W2, use
`head-object` only after validating the stored locator and never create a
presigned URL. For W3, never retry or change a verdict to make it green; a path
that can show **Verified** with an unpassed required check is a security
escalation. `verification_run_summary` is emitted only after the authenticated
browser submits the four local cast-check statuses for the current finalization;
the server supplies the other checks and all scenario/failure metadata. For
W5, do not mix action results from different pipeline executions. For W6,
inspect before redrive, purge, deletion, cancellation, or semaphore repair.

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
- Deployment: <control and selected source SHAs; mode; pipeline execution; acceptance attempt; authoritative record; exact stage results>
- Approval evidence: <saved-plan checksum; versioned approval; normal or rollback retained authority>
- Edge/API: <path and sanitized request/error IDs>
- Restricted identifiers: <stable hashes or session/finalization/AWS execution IDs>
- What: <one sentence>
- Where: <journey stage and component>
- Why: <expected invariant; observed divergence; closed reason codes; supported hypothesis>
- Runtime evidence: <queue / Step Functions / ECS / semaphore / object metadata / alarms>
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
3. use the selected AWS-managed saved-plan or image-release lane, never routine
   local Terraform or a reused saved plan;
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

There is no deployed or validated production lane. Stop rather than adapting
the develop procedure when the requested target is production.

## 12. References

- [Runbook index](./README.md)
- [Infrastructure and cloud security](../infrastructure/README.md)
- [Terraform ownership](../infrastructure/terraform.md)
- App Terraform runtime: `infra/terraform/app/README.md` (private operator documentation)
- AWS operator helper contracts: `scripts/aws/README.md` (private operator documentation)
- [Verification and artifact boundary](../verification/README.md)
- [Logging runbook](./logging.md)
- [Security runbook](./security.md)
