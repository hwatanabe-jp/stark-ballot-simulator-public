locals {
  app_no_runtime_source_check_command         = <<-EOT
find infra/terraform/app -type f -name '*.tf' | sort > app-smoke-terraform-files.txt
grep -R -n -E '^[[:space:]]*(resource|module)[[:space:]]+"' infra/terraform/app --include='*.tf' > app-smoke-declared-blocks.txt || true
if grep -R -n -E '^[[:space:]]*module[[:space:]]+"' infra/terraform/app --include='*.tf'; then
  echo "Target app smoke found module blocks that can hide app/frontend resources." >&2
  exit 2
fi
node <<'NODE'
const fs = require("node:fs");

const declaredBlocks = fs.readFileSync("app-smoke-declared-blocks.txt", "utf8").split(/\r?\n/).filter(Boolean);
const targetAppAllowedResourceTypes = new Set([
  "terraform_data",
  "aws_apigatewayv2_api",
  "aws_apigatewayv2_integration",
  "aws_apigatewayv2_route",
  "aws_apigatewayv2_stage",
  "aws_cloudwatch_event_rule",
  "aws_cloudwatch_event_target",
  "aws_cloudwatch_metric_alarm",
  "aws_cloudwatch_log_group",
  "aws_cloudfront_cache_policy",
  "aws_cloudfront_distribution",
  "aws_cloudfront_function",
  "aws_cloudfront_key_group",
  "aws_cloudfront_origin_access_control",
  "aws_cloudfront_origin_request_policy",
  "aws_cloudfront_public_key",
  "aws_cloudfront_response_headers_policy",
  "aws_dynamodb_table",
  "aws_dynamodb_table_item",
  "aws_ecs_cluster",
  "aws_ecs_task_definition",
  "aws_iam_role",
  "aws_iam_role_policy_attachment",
  "aws_iam_role_policy",
  "aws_kms_alias",
  "aws_kms_key",
  "aws_lambda_event_source_mapping",
  "aws_lambda_function",
  "aws_lambda_permission",
  "aws_s3_bucket",
  "aws_s3_bucket_lifecycle_configuration",
  "aws_s3_bucket_policy",
  "aws_s3_bucket_public_access_block",
  "aws_s3_bucket_server_side_encryption_configuration",
  "aws_s3_bucket_versioning",
  "aws_ssm_parameter",
  "aws_sfn_state_machine",
  "aws_sqs_queue",
]);
const unapprovedDeclarations = declaredBlocks.filter((line) => {
  const match = line.match(/resource\s+"([^"]+)"/);
  return match && !targetAppAllowedResourceTypes.has(match[1]);
});
if (unapprovedDeclarations.length > 0) {
  throw new Error("Target app smoke found unapproved resource declarations:\n" + unapprovedDeclarations.join("\n"));
}

const plan = JSON.parse(fs.readFileSync("infra/terraform/app/tfplan.json", "utf8"));
const deferredResourceTypes = new Set([
  "aws_api_gateway_rest_api",
  "aws_s3_object",
  "aws_s3_bucket_website_configuration",
  "aws_s3_bucket_acl",
  "aws_s3_bucket_ownership_controls",
  "aws_s3_bucket_cors_configuration",
  "aws_ecs_service",
  "aws_secretsmanager_secret",
]);
const deferredResourceTypePrefixes = [
  "aws_route53_",
  "aws_acm_",
  "aws_ecr_",
];
const resourceChanges = Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
function isDeferredResourceType(type) {
  return (
    typeof type === "string" &&
    (deferredResourceTypes.has(type) || deferredResourceTypePrefixes.some((prefix) => type.startsWith(prefix)))
  );
}
const mutatingRuntimeChanges = resourceChanges.filter((change) => {
  const actions = Array.isArray(change.change?.actions) ? change.change.actions : [];
  return isDeferredResourceType(change.type) && actions.some((action) => !["no-op", "read"].includes(action));
});
if (mutatingRuntimeChanges.length > 0) {
  throw new Error("Target app smoke found deferred AWS resources in retained plan JSON.");
}
NODE
EOT
  app_smoke_dynamodb_data_plane_command       = <<-EOT
set -eu
node <<'NODE' > app-smoke-dynamodb-config.json
const fs = require("node:fs");

const outputs = JSON.parse(fs.readFileSync("infra/terraform/app/apply-outputs.json", "utf8"));
const caller = JSON.parse(fs.readFileSync("app-smoke-caller.json", "utf8"));
const config = outputs.dynamodb_runtime_config?.value;
if (!config || typeof config !== "object") {
  throw new Error("Missing dynamodb_runtime_config output for target data-plane smoke.");
}
for (const key of [
  "aws_account_id",
  "aws_region",
  "dynamodb_sessions_table",
  "dynamodb_votes_table",
  "rate_limit_events_table",
  "rate_limit_counters_table",
]) {
  if (typeof config[key] !== "string" || config[key].length === 0) {
    throw new Error("Invalid DynamoDB runtime config output: " + key);
  }
}
if (config.aws_region !== "${var.aws_region}") {
  throw new Error("DynamoDB runtime config region does not match the expected app region.");
}
if (config.aws_account_id !== "${var.aws_account_id}") {
  throw new Error("DynamoDB runtime config account does not match the expected app account.");
}
if (caller.Account !== "${var.aws_account_id}") {
  throw new Error("DynamoDB smoke caller account does not match the expected app account.");
}
function parseDynamoTableArn(label, arn) {
  const match = /^arn:aws[a-zA-Z-]*:dynamodb:([^:]+):([0-9]{12}):table\/([^/]+)$/.exec(arn);
  if (!match) {
    throw new Error("Invalid DynamoDB table ARN for " + label + ".");
  }
  const [, region, accountId, tableName] = match;
  if (region !== "${var.aws_region}") {
    throw new Error("DynamoDB table ARN region mismatch for " + label + ".");
  }
  if (accountId !== "${var.aws_account_id}") {
    throw new Error("DynamoDB table ARN account mismatch for " + label + ".");
  }
  return { arn, region, accountId, tableName };
}
const tables = {
  sessions: parseDynamoTableArn("sessions", config.dynamodb_sessions_table),
  votes: parseDynamoTableArn("votes", config.dynamodb_votes_table),
  rateLimitEvents: parseDynamoTableArn("rateLimitEvents", config.rate_limit_events_table),
  rateLimitCounters: parseDynamoTableArn("rateLimitCounters", config.rate_limit_counters_table),
};
fs.writeFileSync("app-smoke-dynamodb-config.json", JSON.stringify({
  expectedAccountId: "${var.aws_account_id}",
  expectedRegion: "${var.aws_region}",
  smokeCallerAccountId: caller.Account,
  smokeCallerArn: caller.Arn,
  runtimeConfigAccountId: config.aws_account_id,
  runtimeConfigRegion: config.aws_region,
  tables,
  alignmentChecks: {
    smokeCallerAccountMatchesExpected: true,
    runtimeConfigAccountMatchesExpected: true,
    runtimeConfigRegionMatchesExpected: true,
    tableArnAccountRegionMatchExpected: true,
  },
}, null, 2) + "\n");
NODE
sessions_table="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync("app-smoke-dynamodb-config.json","utf8")).tables.sessions.arn)')"
votes_table="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync("app-smoke-dynamodb-config.json","utf8")).tables.votes.arn)')"
rate_events_table="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync("app-smoke-dynamodb-config.json","utf8")).tables.rateLimitEvents.arn)')"
rate_counters_table="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync("app-smoke-dynamodb-config.json","utf8")).tables.rateLimitCounters.arn)')"
smoke_id="$(node -e 'const raw=process.env.CODEBUILD_BUILD_ID || String(Date.now()); console.log("PLAN04_SMOKE_" + raw.replace(/[^A-Za-z0-9_.-]/g, "_") + "_" + Date.now())')"
now_epoch="$(date +%s)"
expires_at="$((now_epoch + 600))"
rate_event_key="$(node -e 'const crypto=require("node:crypto"); console.log(String(Date.now()).padStart(16, "0") + "#" + crypto.randomUUID())')"
cleanup_complete=false
cleanup() {
  aws dynamodb delete-item --table-name "$sessions_table" --key "{\"sessionId\":{\"S\":\"$smoke_id\"}}" --output json --no-cli-pager > app-smoke-dynamodb-cleanup-session.json
  aws dynamodb delete-item --table-name "$votes_table" --key "{\"sessionId\":{\"S\":\"$smoke_id\"},\"voteIndex\":{\"N\":\"0\"}}" --output json --no-cli-pager > app-smoke-dynamodb-cleanup-vote.json
  aws dynamodb delete-item --table-name "$rate_events_table" --key "{\"scope\":{\"S\":\"$smoke_id\"},\"eventKey\":{\"S\":\"$rate_event_key\"}}" --output json --no-cli-pager > app-smoke-dynamodb-cleanup-rate-event.json
  aws dynamodb delete-item --table-name "$rate_counters_table" --key "{\"key\":{\"S\":\"$smoke_id\"}}" --output json --no-cli-pager > app-smoke-dynamodb-cleanup-rate-counter.json
}
trap 'set +e; cleanup >/dev/null 2>&1' EXIT
aws dynamodb describe-table --table-name "$sessions_table" --output json --no-cli-pager > app-smoke-dynamodb-sessions-table.json
aws dynamodb describe-time-to-live --table-name "$sessions_table" --output json --no-cli-pager > app-smoke-dynamodb-sessions-ttl.json
aws dynamodb describe-table --table-name "$votes_table" --output json --no-cli-pager > app-smoke-dynamodb-votes-table.json
aws dynamodb describe-table --table-name "$rate_events_table" --output json --no-cli-pager > app-smoke-dynamodb-rate-events-table.json
aws dynamodb describe-table --table-name "$rate_counters_table" --output json --no-cli-pager > app-smoke-dynamodb-rate-counters-table.json
aws dynamodb put-item --table-name "$sessions_table" --item "{\"sessionId\":{\"S\":\"$smoke_id\"},\"itemType\":{\"S\":\"SMOKE\"},\"createdAt\":{\"N\":\"$now_epoch\"},\"lastActivity\":{\"N\":\"$((now_epoch * 1000))\"},\"finalized\":{\"BOOL\":false},\"botCount\":{\"N\":\"0\"},\"expiresAt\":{\"N\":\"$expires_at\"}}" --condition-expression "attribute_not_exists(sessionId)" --output json --no-cli-pager > app-smoke-dynamodb-put-session.json
aws dynamodb get-item --table-name "$sessions_table" --key "{\"sessionId\":{\"S\":\"$smoke_id\"}}" --consistent-read --output json --no-cli-pager > app-smoke-dynamodb-get-session.json
aws dynamodb put-item --table-name "$votes_table" --item "{\"sessionId\":{\"S\":\"$smoke_id\"},\"voteIndex\":{\"N\":\"0\"},\"voteId\":{\"S\":\"$smoke_id\"},\"vote\":{\"S\":\"enc:v1:smoke\"},\"rand\":{\"S\":\"enc:v1:smoke\"},\"commit\":{\"S\":\"0x0000000000000000000000000000000000000000000000000000000000000000\"},\"isUserVote\":{\"BOOL\":true},\"expiresAt\":{\"N\":\"$expires_at\"}}" --condition-expression "attribute_not_exists(sessionId)" --output json --no-cli-pager > app-smoke-dynamodb-put-vote.json
aws dynamodb query --table-name "$votes_table" --key-condition-expression "sessionId = :sessionId" --expression-attribute-values "{\":sessionId\":{\"S\":\"$smoke_id\"}}" --consistent-read --output json --no-cli-pager > app-smoke-dynamodb-query-votes.json
aws dynamodb put-item --table-name "$rate_events_table" --item "{\"scope\":{\"S\":\"$smoke_id\"},\"eventKey\":{\"S\":\"$rate_event_key\"},\"timestamp\":{\"N\":\"$now_epoch\"},\"expiresAt\":{\"N\":\"$expires_at\"}}" --condition-expression "attribute_not_exists(#scope) AND attribute_not_exists(eventKey)" --expression-attribute-names "{\"#scope\":\"scope\"}" --output json --no-cli-pager > app-smoke-dynamodb-put-rate-event.json
aws dynamodb put-item --table-name "$rate_counters_table" --item "{\"key\":{\"S\":\"$smoke_id\"},\"count\":{\"N\":\"1\"},\"expiresAt\":{\"N\":\"$expires_at\"}}" --condition-expression "attribute_not_exists(#key)" --expression-attribute-names "{\"#key\":\"key\"}" --output json --no-cli-pager > app-smoke-dynamodb-put-rate-counter.json
cleanup
trap - EXIT
cleanup_complete=true
node <<NODE
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync("app-smoke-dynamodb-config.json", "utf8"));
const sessionRead = JSON.parse(fs.readFileSync("app-smoke-dynamodb-get-session.json", "utf8"));
const voteQuery = JSON.parse(fs.readFileSync("app-smoke-dynamodb-query-votes.json", "utf8"));
const describedTables = {
  sessions: JSON.parse(fs.readFileSync("app-smoke-dynamodb-sessions-table.json", "utf8")),
  votes: JSON.parse(fs.readFileSync("app-smoke-dynamodb-votes-table.json", "utf8")),
  rateLimitEvents: JSON.parse(fs.readFileSync("app-smoke-dynamodb-rate-events-table.json", "utf8")),
  rateLimitCounters: JSON.parse(fs.readFileSync("app-smoke-dynamodb-rate-counters-table.json", "utf8")),
};
if (sessionRead.Item?.sessionId?.S !== "$smoke_id") {
  throw new Error("target DynamoDB smoke did not read back the disposable session row.");
}
if (!Array.isArray(voteQuery.Items) || voteQuery.Items.length !== 1) {
  throw new Error("target DynamoDB smoke did not query back the disposable vote row.");
}
function parseDynamoTableArn(label, arn) {
  const match = /^arn:aws[a-zA-Z-]*:dynamodb:([^:]+):([0-9]{12}):table\/([^/]+)$/.exec(arn);
  if (!match) {
    throw new Error("Invalid live DynamoDB table ARN for " + label + ".");
  }
  const [, region, accountId, tableName] = match;
  return { arn, region, accountId, tableName };
}
const liveTables = {};
for (const [label, describedTable] of Object.entries(describedTables)) {
  const liveArn = describedTable.Table?.TableArn;
  if (typeof liveArn !== "string" || liveArn.length === 0) {
    throw new Error("target DynamoDB smoke could not read live table ARN for " + label + ".");
  }
  const live = parseDynamoTableArn(label, liveArn);
  const configured = config.tables[label];
  if (live.arn !== configured.arn) {
    throw new Error("Live DynamoDB table ARN does not match runtime config for " + label + ".");
  }
  if (live.region !== config.expectedRegion || live.accountId !== config.expectedAccountId) {
    throw new Error("Live DynamoDB table account or region mismatch for " + label + ".");
  }
  liveTables[label] = live;
}
const evidence = {
  schemaVersion: "target-dynamodb-data-plane-smoke-v1",
  manifestType: "dynamodb-data-plane-smoke",
  expectedAccountId: config.expectedAccountId,
  expectedRegion: config.expectedRegion,
  smokeCallerAccountId: config.smokeCallerAccountId,
  smokeCallerArn: config.smokeCallerArn,
  runtimeConfigAccountId: config.runtimeConfigAccountId,
  runtimeConfigRegion: config.runtimeConfigRegion,
  configuredTables: config.tables,
  liveDescribedTables: liveTables,
  accountRegionAlignment: {
    smokeCallerAccountMatchesExpected: config.smokeCallerAccountId === config.expectedAccountId,
    runtimeConfigAccountMatchesExpected: config.runtimeConfigAccountId === config.expectedAccountId,
    runtimeConfigRegionMatchesExpected: config.runtimeConfigRegion === config.expectedRegion,
    configuredTableArnsMatchExpected: Object.values(config.tables).every((table) => (
      table.accountId === config.expectedAccountId && table.region === config.expectedRegion
    )),
    liveDescribeTableArnsMatchConfigured: Object.entries(liveTables).every(([label, table]) => (
      table.arn === config.tables[label].arn
    )),
    liveDescribeTableArnsMatchExpected: Object.values(liveTables).every((table) => (
      table.accountId === config.expectedAccountId && table.region === config.expectedRegion
    )),
  },
  disposableRecordId: "$smoke_id",
  conditionalWritesPassed: true,
  queryPassed: true,
  rateLimitTablesPassed: true,
  kmsSseUsabilityProvedByReadWrite: true,
  cleanupComplete: $cleanup_complete,
};
fs.writeFileSync("app-smoke-dynamodb-data-plane-evidence.json", JSON.stringify(evidence, null, 2) + "\n");
NODE
EOT
  app_smoke_denial_checks_command             = <<-EOT
aws iam simulate-principal-policy --policy-source-arn "${aws_iam_role.app_terraform_smoke[0].arn}" --action-names s3:GetObject s3:PutObject kms:Decrypt kms:Encrypt --resource-arns "${aws_s3_bucket.state.arn}/${local.app_state_backend_key}" "${aws_kms_key.state.arn}" --output json --no-cli-pager > app-smoke-state-denial-simulation.json
aws iam simulate-principal-policy --policy-source-arn "${aws_iam_role.app_terraform_smoke[0].arn}" --action-names iam:CreateRole iam:PutRolePolicy cloudfront:CreateDistribution route53:CreateHostedZone acm:RequestCertificate ecr:CreateRepository ecs:CreateService secretsmanager:CreateSecret s3:PutObject s3:PutBucketPolicy s3:PutBucketWebsite s3:PutBucketAcl --resource-arns "*" --output json --no-cli-pager > app-smoke-mutation-denial-simulation.json
node <<'NODE'
const fs = require("node:fs");

const stateDenial = JSON.parse(fs.readFileSync("app-smoke-state-denial-simulation.json", "utf8"));
const mutationDenial = JSON.parse(fs.readFileSync("app-smoke-mutation-denial-simulation.json", "utf8"));

function assertAllDenied(report) {
  const allowed = (report.EvaluationResults ?? []).filter((result) => result.EvalDecision === "allowed");
  if (allowed.length > 0) {
    throw new Error("Smoke role simulation unexpectedly allowed: " + allowed.map((result) => result.EvalActionName).join(", "));
  }
  return true;
}

const evidence = {
  schemaVersion: "target-app-deployment-evidence-v1",
  manifestType: "smoke-denial-evidence",
  stateAccessDenied: assertAllDenied(stateDenial),
  mutationAccessDenied: assertAllDenied(mutationDenial),
  stateSimulationPath: "app-smoke-state-denial-simulation.json",
  mutationSimulationPath: "app-smoke-mutation-denial-simulation.json",
};
fs.writeFileSync("app-smoke-denial-evidence.json", JSON.stringify(evidence, null, 2) + "\n");
NODE
EOT
  app_fetch_existing_acceptance_index_command = <<-EOT
set +e
aws s3api get-object --bucket "${local.app_pipeline_artifact_bucket_name}" --key "${local.app_accepted_marker_path}/index.json" accepted-index-existing.json --output json --no-cli-pager > accepted-index-existing.get-object.json 2> accepted-index-existing.error
accepted_index_status="$?"
set -e
if [ "$accepted_index_status" -eq 0 ]; then
  :
elif grep -Eq '(^|[^[:alnum:]])(NoSuchKey|Not[[:space:]]*Found)([^[:alnum:]]|$)' accepted-index-existing.error; then
  printf '{"schemaVersion":"target-app-deployment-evidence-v1","stateIdentity":"stark-dev/develop/app","acceptedDeployments":[]}\n' > accepted-index-existing.json
else
  cat accepted-index-existing.error >&2
  exit "$accepted_index_status"
fi
node <<'NODE'
const fs = require("node:fs");

let index;
try {
  index = JSON.parse(fs.readFileSync("accepted-index-existing.json", "utf8"));
} catch (error) {
  throw new Error("Existing accepted deployment index is not valid JSON: " + error.message);
}

if (!index || typeof index !== "object" || Array.isArray(index)) {
  throw new Error("Existing accepted deployment index must be a JSON object.");
}
if (index.schemaVersion !== "target-app-deployment-evidence-v1") {
  throw new Error("Existing accepted deployment index has an unsupported schemaVersion.");
}
if (index.stateIdentity !== "stark-dev/develop/app") {
  throw new Error("Existing accepted deployment index has the wrong stateIdentity.");
}
if (!Array.isArray(index.acceptedDeployments)) {
  throw new Error("Existing accepted deployment index acceptedDeployments must be an array.");
}
for (const [entryIndex, deployment] of index.acceptedDeployments.entries()) {
  if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) {
    throw new Error("Existing accepted deployment index entry " + entryIndex + " must be an object.");
  }
  for (const field of [
    "sourceSha",
    "manifestPath",
    "planPath",
    "planChecksumPath",
    "planSummaryPath",
    "planJsonPath",
    "sourcePreflightPath",
    "targetLambdaArtifactsPath",
    "terraformVersionPath",
    "terraformProvidersPath",
    "applyOutputsPath",
    "staticFrontendDeployPath",
    "smokeReportPath",
    "smokeCallerPath",
    "smokeTerraformFilesPath",
    "smokeDeclaredBlocksPath",
    "dynamodbDataPlaneSmokePath",
    "denialSmokePath",
    "stateDenialSimulationPath",
    "mutationDenialSimulationPath",
    "planChecksum",
  ]) {
    if (typeof deployment[field] !== "string" || deployment[field].length === 0) {
      throw new Error("Existing accepted deployment index entry " + entryIndex + " has invalid " + field + ".");
    }
  }
}
NODE
EOT

}
