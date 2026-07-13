# AWS Runtime Operations Runbook

> **Scope:** the deployed, operator-gated `stark-dev/develop` AWS runtime.
> `stark-prod/main` has not been deployed, validated, or approved. Never turn a
> develop command into a production command by substituting names or profiles.

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
session/execution IDs, object keys, request IDs, and log excerpts as restricted
incident evidence.

## 2. Runtime map

```text
Browser / approved CLI
  -> CloudFront signed-cookie gate
     -> private S3 static frontend
     -> API Gateway -> Hono public-api Lambda -> DynamoDB
        -> async finalization:
           prover SQS -> dispatcher -> Step Functions
             -> image-signature gate -> semaphore -> ECS prover -> private proof S3
             -> finalization writer -> DynamoDB terminal state and artifact metadata
        -> async verification:
           verification SQS -> verification-worker Lambda
             -> bundled verifier-service -> private report S3 + DynamoDB

Authenticated delivery
  -> GET /api/verification/bundles/:sessionId/:executionId
  -> GET /api/verification/bundles/:sessionId/:executionId/report
```

Finalization uses Step Functions, the semaphore, and ECS. Verification uses a
separate SQS queue and Lambda worker; it does not normally use Step Functions
or ECS.

## 3. Initial response

Record the environment, incident window and timezone, symptom and HTTP/error
code, gated hostname versus direct origin, source SHA, accepted deployment
record, pipeline execution, and restricted session/execution identifiers. Do
not record the capability token. Any path that can display **Verified** while a
required check has not passed is a security escalation.

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
the mutable `index.json` is only the compare-and-swap-selected pointer to that
attempt. In a restricted workspace, bind the authoritative deployment record
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
  --query 'Environment.Variables.{Sessions:DYNAMODB_SESSIONS_TABLE,Votes:DYNAMODB_VOTES_TABLE,Admission:TARGET_PUBLIC_SESSION_CREATE_ENABLED}' \
  --output json --no-cli-pager

for function_name in proof-dispatcher verification-worker; do
  aws lambda list-event-source-mappings \
    --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
    --function-name "${TARGET_PREFIX}-${function_name}" \
    --query 'EventSourceMappings[].{UUID:UUID,State:State,LastProcessingResult:LastProcessingResult}' \
    --output json --no-cli-pager
done
```

In either quiesced phase, rejected session creation and disabled mappings are
the intended containment posture, not by themselves an outage. A served-pair,
admission, or mapping state that disagrees with the accepted phase is drift and
requires escalation. Queue drain, in-flight Lambda/Step Functions/ECS work,
and data reconciliation are separate evidence; phase smoke does not prove
them. Recovery moves one ordered phase per newly reviewed saved-plan execution
and is outside this runbook's mutation scope.

Discover logs instead of relying on remembered names:

```bash
aws logs describe-log-groups \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --log-group-name-prefix "/aws/lambda/${TARGET_PREFIX}-" \
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

For operator-gate incidents, run the read-only checked-in inspector after the
identity check:

```bash
pnpm aws:operator-gate:develop -- inspect \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}"
```

`inspect` requires the exact develop distribution and hostname, the stable key
group on every cache behavior, the exact tracked managed and legacy trust set,
one checked-in issuer generation, an enabled KMS `RSA_2048` `SIGN_VERIFY` key
with the supported SHA-256 signing algorithm, and byte-identical KMS and
CloudFront public keys. Retain its non-secret generation, key-group, algorithm,
and public-key fingerprint summary with the incident evidence. `inspect` does
not issue cookies or perform a positive probe. Do not substitute `issue`,
`--probe`, or a hand-built signing command during read-only triage.

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
[develop gated smoke procedure](../../scripts/tests/README.md#develop-gated-smoke)
without copying signed-cookie values into evidence.

## 5. Authenticated bundle and report delivery

The supported contract is capability-checked API delivery:

- the bundle endpoint returns public `bundle.zip` evidence and supports byte
  ranges for large objects;
- the report endpoint returns private `verification.json` and fails closed
  above its hosted payload limit;
- both require matching `X-Session-ID` and `X-Session-Capability` context;
- the API validates canonical `sessions/<sessionId>/<executionId>/...` object
  identity before S3 access.

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

Use `head-object`, not `get-object`, for routine metadata checks, and only for
a locator already validated against the session:

```bash
PROOF_BUCKET="${TARGET_PREFIX}-proof-artifacts"
SESSION_ID="<restricted-session-id>"
EXECUTION_ID="<restricted-execution-id>"

aws s3api head-object \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --bucket "${PROOF_BUCKET}" \
  --key "sessions/${SESSION_ID}/${EXECUTION_ID}/bundle.zip" \
  --query '{ContentLength:ContentLength,ContentType:ContentType,LastModified:LastModified,Encryption:ServerSideEncryption}' \
  --output json --no-cli-pager

aws s3api head-object \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --bucket "${PROOF_BUCKET}" \
  --key "sessions/${SESSION_ID}/${EXECUTION_ID}/verification.json" \
  --query '{ContentLength:ContentLength,ContentType:ContentType,LastModified:LastModified,Encryption:ServerSideEncryption}' \
  --output json --no-cli-pager
```

If report content is essential, use the authenticated endpoint in a restricted
workspace and retain only a redacted summary. See
[Verification Implementation](../verification/README.md).

## 6. Async finalization

```text
POST /api/finalize -> prover SQS -> proof-dispatcher
  -> Step Functions -> signature gate -> semaphore -> ECS prover
  -> finalization writer -> terminal state and bundle metadata
```

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

A queue backlog is pre-dispatch work; it does not count executions waiting for
a semaphore slot. Queue age is the `AWS/SQS` CloudWatch
`ApproximateAgeOfOldestMessage` metric, not a `GetQueueAttributes` field. Check
`public-api` for enqueue errors and `proof-dispatcher` for parsing,
session-state preconditions, duplicate handling, and
`StartExecution`/`DescribeExecution` errors. Malformed work retries/DLQs;
missing-session or non-pending work can be intentionally discarded as stale.

### Step Functions, signature, semaphore, and ECS

```bash
FINALIZATION_EXECUTION_ARN="<restricted-execution-arn>"

aws stepfunctions describe-execution \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --execution-arn "${FINALIZATION_EXECUTION_ARN}" \
  --query '{Status:status,Start:startDate,Stop:stopDate,Error:error,Cause:cause,RedriveStatus:redriveStatus}' \
  --output json --no-cli-pager

aws stepfunctions get-execution-history \
  --profile "${AWS_PROFILE_NAME}" --region "${AWS_REGION_NAME}" \
  --execution-arn "${FINALIZATION_EXECUTION_ARN}" --reverse-order --max-results 40 \
  --query 'events[].{Id:id,Timestamp:timestamp,Type:type,PreviousEventId:previousEventId}' \
  --output json --no-cli-pager
```

- Signature states: inspect `image-signature-gate`, digest pin, ECR signing
  configuration, and signing evidence. Do not bypass the check.
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
- terminal application states are sticky per execution ID;
- cancellation during slot wait prevents later proof start and releases the
  superseded slot.

Cancellation changes state and requires the matching capability plus owner
approval. Direct `StopExecution` can split session state from semaphore
ownership and is not the standard path. No mutation command is provided here.

## 7. Async verification

```text
POST /api/verification/run -> verification SQS -> verification-worker
  -> bundle download -> bundled Rust verifier-service
  -> private report upload -> terminal verification state
```

Target AWS returns `running` after enqueue. A terminal verification `failed`
can be the correct cryptographic verdict, not infrastructure failure. Never
retry or overwrite required-check failure to obtain a successful UI.

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

For verification DLQ work, confirm the current execution, report metadata, and
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
- signature gate: ECR/signing observation;
- ECS roles: proof-artifact read/write, without delete;
- Step Functions role: ECS, selected Lambda invoke, semaphore, and logs.

Record caller role, action, resource class, time, and source SHA. Compare with
app IaC and the accepted plan; never attach a broad policy as a shortcut.

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

## 10. Monitoring, evidence, and escalation

Current alarms are passive and do not auto-remediate:

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

An escalation packet should contain:

1. environment, incident owner, time range, symptom, and severity;
2. control and selected source SHAs, deployment mode, pipeline execution,
   acceptance attempt, authoritative deployment record, and exact stage
   results;
3. edge/API path and sanitized request/error IDs;
4. restricted session/execution identifiers or stable hashes;
5. relevant queue, Step Functions, ECS, semaphore, object-metadata, and alarm
   summaries;
6. short redacted log excerpts with timestamps;
7. expected invariant, observed divergence, and hypothesis;
8. every mutation already made, including partial apply or console action;
9. saved-plan checksum, versioned approval evidence, and normal or rollback
   retained-evidence identity;
10. proposed change story, blast radius, containment/rollback, approval, and
    validation.

Escalate immediately for identity/state-scope uncertainty; possible secret or
private-artifact leakage; direct-origin bypass; false **Verified** presentation;
private files in a public bundle; a DLQ/semaphore/IAM/KMS/signing issue that
needs mutation; Terraform/live drift or partial apply; or any production
target.

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
