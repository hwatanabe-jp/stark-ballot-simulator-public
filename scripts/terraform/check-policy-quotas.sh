#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
policy_workspace="$(mktemp -d "${TMPDIR:-/tmp}/stark-ballot-policy-check.XXXXXX")"
trap 'rm -rf -- "$policy_workspace"' EXIT

# Render current inputs through their owning admission policy, without AWS.
node --input-type=module - "$policy_workspace/inputs.json" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDeploymentTargetConfiguration, renderDeploymentLaneContext, resolveAllowedDeploymentTarget } from './packages/deployment-authority/src/index.js';
import { promotionKey } from './packages/deployment-authority/src/release-ledger.js';
import { buildBootstrapConfiguredInputs, decodeTerraformBaselineNonsecretInputValues } from './packages/deployment-authority/src/terraform-authority.js';
const configuration = JSON.parse(readFileSync('infra/terraform/bootstrap/operator-inputs.json', 'utf8'));
const targets = parseDeploymentTargetConfiguration(JSON.parse(readFileSync('packages/deployment-authority/deployment-targets.json', 'utf8')));
const inputs = {};
for (const targetKey of Object.keys(targets.allowedTargets)) {
  const target = resolveAllowedDeploymentTarget(targetKey);
  const source = 'a'.repeat(40);
  const context = renderDeploymentLaneContext({ target, lane: 'bootstrap', accountId: target.accountId,
    requestedControlSourceSha: source, selectedApplicationSourceSha: source, frameworkSourceSha: source });
  inputs[targetKey] = decodeTerraformBaselineNonsecretInputValues(buildBootstrapConfiguredInputs(context, configuration[targetKey]));
}
writeFileSync(process.argv[2], JSON.stringify(inputs), { mode: 0o600 });
writeFileSync(`${process.argv[2]}.promotions`, JSON.stringify(Object.fromEntries(Object.keys(inputs).map(targetKey => [targetKey, ['toolchain','prover'].map(kind => promotionKey(targetKey, kind))]))), { mode: 0o600 });
JS

python3 - "$policy_workspace" <<'PY'
import json, pathlib, re, shutil, sys, uuid

workspace = pathlib.Path(sys.argv[1])
root = workspace / 'infra/terraform/bootstrap'
root.mkdir(parents=True)
source = pathlib.Path('infra/terraform/bootstrap')
inputs = json.loads((workspace / 'inputs.json').read_text())
promotions = json.loads((workspace / 'inputs.json.promotions').read_text())
configuration = workspace / 'packages/deployment-authority'
configuration.mkdir(parents=True)
shutil.copy('packages/deployment-authority/deployment-targets.json', configuration)
shutil.copytree('infra/framework/terraform/modules/codebuild-log-groups',
                workspace / 'infra/framework/terraform/modules/codebuild-log-groups')

# Derive deterministic AWS identifiers from the actual configured names. Mock
# provider random IDs would shorten ARNs and split one role's inline policies.
identities = {
    'aws_sfn_state_machine': ('name', 'arn:aws:states:%s:%s:stateMachine:%s', 'var.aws_region, var.aws_account_id'),
    'aws_sqs_queue': ('name', 'arn:aws:sqs:%s:%s:%s', 'var.aws_region, var.aws_account_id'),
    'aws_cloudwatch_metric_alarm': ('alarm_name', 'arn:aws:cloudwatch:%s:%s:alarm:%s', 'var.aws_region, var.aws_account_id'),

    'aws_iam_role': ('name', 'arn:aws:iam::%s:role/%s', 'var.aws_account_id'),
    'aws_iam_policy': ('name', 'arn:aws:iam::%s:policy/%s', 'var.aws_account_id'),
    'aws_s3_bucket': ('bucket', 'arn:aws:s3:::%s', None),
    'aws_codebuild_project': ('name', 'arn:aws:codebuild:%s:%s:project/%s', 'var.aws_region, var.aws_account_id'),
    'aws_secretsmanager_secret': ('name', 'arn:aws:secretsmanager:%s:%s:secret:%s-ABCDEF', 'var.aws_region, var.aws_account_id'),
}
documents, managed, inline, attachments, waits, kms_keys = [], [], [], [], [], []
role_boundaries = {}
for path in sorted(source.glob('*.tf')):
    if path.name == 'backend.tf':
        continue  # The mock apply and dependency graph use no remote backend.
    text = path.read_text()
    for match in re.finditer(r'^resource "aws_iam_role" "([^"]+)" \{(.*?)(?=^resource |^data |\Z)', text, re.M | re.S):
        boundary = re.search(r'permissions_boundary\s*=\s*(aws_iam_policy\.[a-z_]+\[0\])\.arn', match[2])
        if boundary:
            role_boundaries[match[1]] = boundary[1]
    kms_keys += re.findall(r'^resource "aws_kms_key" "([^"]+)"', text, re.M)
    documents += re.findall(r'^data "aws_iam_policy_document" "([^"]+)"', text, re.M)
    managed += re.findall(r'^resource "aws_iam_policy" "([^"]+)"', text, re.M)
    inline += re.findall(r'^resource "aws_iam_role_policy" "([^"]+)"', text, re.M)
    attachments += re.findall(r'^resource "aws_iam_role_policy_attachment" "([^"]+)"', text, re.M)
    waits += re.findall(r'^resource "terraform_data" "([^"]+)"', text, re.M)
    # Only IAM propagation waits exist here. They have no meaning in a mock
    # account. Reject any new provisioner command instead of executing it.
    if 'provisioner ' in text:
        commands = re.findall(r'^\s*command\s*=\s*(.+)$', text, re.M)
        if not commands or any(command != '"sleep 30"' for command in commands):
            raise SystemExit(f'Unreviewed provisioner in {path.name}')
        text = re.sub(r'(command\s*=\s*)"sleep 30"', r'\1"true"', text)
    for kind, (attribute, pattern, arguments) in identities.items():
        ref = rf'({kind}\.[a-z_]+(?:\[[^\]\n]+\])?)'
        def arn(match):
            args = f'{arguments}, ' if arguments else ''
            identity = f'{match[1]}.{attribute}'
            if kind in ('aws_iam_role', 'aws_iam_policy'):
                identity = f'format("%s%s", trimprefix(coalesce({match[1]}.path, "/"), "/"), {identity})'
            return f'format("{pattern}", {args}{identity})'
        text = re.sub(ref + r'\.arn\b', arn, text)
        if kind in ('aws_iam_role', 'aws_s3_bucket'):
            text = re.sub(ref + r'\.id\b', rf'\1.{attribute}', text)
    # Preserve alias-to-key identity: distinct keys must not collapse during
    # provider deduplication of a policy's resource list.
    text = re.sub(r'(aws_kms_alias\.[a-z_]+(?:\[[^\]\n]+\])?)\.target_key_arn\b',
                  r'format("arn:aws:kms:%s:%s:key/%s", var.aws_region, var.aws_account_id, \1.target_key_id)', text)
    (root / path.name).write_text(text)

# Render the Foundation log-writer policy itself, rather than a rewritten test
# policy. Its name-prefix binding is shared by the two owning roots.
gateway_source = pathlib.Path('infra/terraform/foundation/api_gateway_logging.tf').read_text()
gateway_policy = gateway_source.split('resource "aws_iam_policy" "gateway_logging_boundary"', 1)[0]
(root / 'gateway_logging_policy_test.tf').write_text(
    'locals { name_prefix = local.deployment_shared_names.runtimeNamePrefix }\n' + gateway_policy)
documents.append('gateway_logging')
shutil.copy('infra/terraform/foundation/retained_image_logs.tf', root / 'retained_image_logs_test.tf')

# All AWS resources use the mock provider. Only the provider's local JSON
# renderer uses this alias; it has no usable AWS credentials or AWS endpoint.
(root / 'policy_test_provider.tf').write_text('''provider "aws" {
  alias = "policy_test"
  region = var.aws_region
  access_key = "offline-policy-test"
  secret_key = "offline-policy-test"
  skip_credentials_validation = true
  skip_requesting_account_id = true
  skip_metadata_api_check = true
  skip_region_validation = true
  max_retries = 0
  endpoints { sts = "http://127.0.0.1:1" }
}
''')
(root / 'policy_test_override.tf').write_text(''.join(
    f'data "aws_iam_policy_document" "{name}" {{\n provider = aws.policy_test\n}}\n'
    for name in documents))
managed_expression = 'concat(' + ','.join(
    f'[for p in aws_iam_policy.{name} : {{ name = p.name, arn = format("arn:aws:iam::%s:policy/%s%s", var.aws_account_id, trimprefix(coalesce(p.path, "/"), "/"), p.name), bytes = length(jsonencode(jsondecode(p.policy))) }}]'
    for name in managed) + ')'
inline_expression = 'concat(' + ','.join(
    f'[for p in aws_iam_role_policy.{name} : {{ role = p.role, bytes = length(jsonencode(jsondecode(p.policy))) }}]'
    for name in inline) + ')'
attachment_expression = 'concat(' + ','.join(
    f'[for p in aws_iam_role_policy_attachment.{name} : {{ role = p.role, policy = p.policy_arn }}]'
    for name in attachments) + ')'
# Derive boundary selection from actual IAM roles so a correct identity grant
# cannot mask a boundary that still names a build ARN. AWS authorizes
# BatchGetBuilds against project*, despite the API accepting build IDs.
boundary_expression = '{' + ','.join(
    f'{name} = jsondecode({policy}.policy).Statement'
    for name, policy in role_boundaries.items()) + '}'
(root / 'policy_test_outputs.tf').write_text(f'''
output "app_prepare_dependency_authority" {{ value = {{
 identity = jsondecode(aws_iam_policy.app_foundation_checkpoint_read[0].policy).Statement
 attachment_role = aws_iam_role_policy_attachment.app_foundation_checkpoint_read[0].role
 attachment_policy = aws_iam_role_policy_attachment.app_foundation_checkpoint_read[0].policy_arn
 policy = "arn:aws:iam::${{var.aws_account_id}}:policy/${{aws_iam_policy.app_foundation_checkpoint_read[0].name}}"
 role = aws_iam_role.app_terraform_plan[0].name
 boundary = jsondecode(aws_iam_policy.app_deploy_permissions_boundary[0].policy).Statement
 bucket_policy = jsondecode(data.aws_iam_policy_document.terraform_authority_bucket[0].json).Statement
 grants = {{
  ReadExactFoundationCheckpointVersion = {{ action = "s3:GetObjectVersion", resources = [local.foundation_checkpoint_object_arn] }}
  SelectCurrentImagePromotions = {{ action = "s3:GetObject", resources = [local.app_toolchain_promotion_object_arn, local.app_prover_promotion_object_arn] }}
  ReadSelectedImageCandidateVersions = {{ action = "s3:GetObjectVersion", resources = [local.app_toolchain_candidate_records_objects_arn, local.app_prover_candidate_records_objects_arn] }}
 }}
}} }}
output "frontend_artifact_authority" {{ value = {{
 prefix = local.app_retained_static_frontend_artifact_objects_arn
 bucket = local.app_retained_artifact_bucket_arn
 site_key = "arn:aws:ssm:${{var.aws_region}}:${{var.aws_account_id}}:parameter${{local.deployment_shared_names.runtimeConfigReferencePrefix}}/vite-turnstile-site-key"
 runtime_parameters = local.app_runtime_ssm_parameter_arn
 plan_role = "arn:aws:iam::${{var.aws_account_id}}:role/${{aws_iam_role.app_terraform_plan[0].name}}"
 plan = jsondecode(data.aws_iam_policy_document.app_terraform_plan[0].json).Statement
 plan_only = jsondecode(data.aws_iam_policy_document.app_terraform_plan_pipeline_state[0].json).Statement
 apply = jsondecode(data.aws_iam_policy_document.app_terraform_apply[0].json).Statement
 static = jsondecode(data.aws_iam_policy_document.app_static_deploy_common[0].json).Statement
 smoke = jsondecode(data.aws_iam_policy_document.app_terraform_smoke[0].json).Statement
 smoke_boundary = jsondecode(data.aws_iam_policy_document.app_smoke_deploy_permissions_boundary[0].json).Statement
 kms_tags = aws_kms_key.app_pipeline_artifacts[0].tags
 drift = jsondecode(data.aws_iam_policy_document.terraform_drift_runner["app"].json).Statement
 boundary = jsondecode(data.aws_iam_policy_document.app_deploy_permissions_boundary[0].json).Statement
 bucket_policy = jsondecode(data.aws_iam_policy_document.app_pipeline_artifacts_bucket[0].json).Statement
 common = jsondecode(data.aws_iam_policy_document.app_codebuild_common[0].json).Statement
 kms = jsondecode(data.aws_iam_policy_document.app_artifact_kms_key[0].json).Statement
 kms_key = "arn:aws:kms:${{var.aws_region}}:${{var.aws_account_id}}:key/${{aws_kms_alias.app_pipeline_artifacts[0].target_key_id}}"
 roles = [for role in [aws_iam_role.app_terraform_plan[0], aws_iam_role.app_terraform_apply[0], aws_iam_role.app_static_deploy[0], aws_iam_role.app_terraform_smoke[0]] : "arn:aws:iam::${{var.aws_account_id}}:role/${{role.name}}"]
}} }}
output "native_build_inputs" {{ value = flatten([for lane in [
 {{ pipelines = aws_codepipeline.development_foundation, execution_env = "FOUNDATION_PIPELINE_EXECUTION_ID" }},
 {{ pipelines = aws_codepipeline.development_app, execution_env = "APP_PIPELINE_EXECUTION_ID" }},
 {{ pipelines = aws_codepipeline.development_toolchain_release, execution_env = "RELEASE_PIPELINE_EXECUTION_ID" }},
 {{ pipelines = aws_codepipeline.development_prover_release, execution_env = "RELEASE_PIPELINE_EXECUTION_ID" }}
] : [for pipeline in lane.pipelines : [for stage in pipeline.stage : [for action in stage.action : {{
 execution_env = lane.execution_env
 name = action.name
 configuration = action.configuration
 input_artifacts = action.input_artifacts
}} if action.provider == "CodeBuild"]]]]) }}
output "execution_read_authority" {{ value = {{for key, execution in local.managed_codebuild_executions : key => {{
 project = "arn:aws:codebuild:${{var.aws_region}}:${{var.aws_account_id}}:project/${{execution.project}}"
 identity = jsondecode(data.aws_iam_policy_document.managed_execution_read[key].json).Statement
 boundary = ({boundary_expression})[key]
}} }} }}
output "drift_read_boundaries" {{ value = {{for key, policy in data.aws_iam_policy_document.terraform_drift_runner_boundary : key => jsondecode(policy.json).Statement}} }}
output "bootstrap_drift_retained_policy_read" {{ value = {{
 resource = local.foundation_retired_image_boundary_arn
 statements = jsondecode(data.aws_iam_policy_document.terraform_drift_runner_bootstrap_provider["policies"].json).Statement
 actions = ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyTags", "iam:ListPolicyVersions"]
}} }}
output "bootstrap_drift_connection_read" {{ value = {{
 connection = aws_codeconnections_connection.source[0].arn
 statements = jsondecode(data.aws_iam_policy_document.terraform_drift_runner_bootstrap_provider["shared"].json).Statement
 actions = ["codeconnections:GetConnection", "codestar-connections:GetConnection", "codeconnections:ListTagsForResource", "codestar-connections:ListTagsForResource"]
}} }}
output "drift_build_observation" {{ value = {{for key, policy in data.aws_iam_policy_document.terraform_drift_runner : key => [for statement in jsondecode(policy.json).Statement : statement if try(statement.Sid, "") == "ObserveOwningNativeBuilds"]}} }}
output "foundation_release_manifest_bucket_arn" {{ value = local.foundation_release_manifest_bucket_arn }}
output "foundation_apply_boundary_statements" {{ value = jsondecode(data.aws_iam_policy_document.foundation_apply_deploy_permissions_boundary[0].json).Statement }}
output "gateway_logging_statements" {{ value = jsondecode(data.aws_iam_policy_document.gateway_logging.json).Statement }}
output "image_retirement" {{ value = {{
 enabled = local.foundation_image_retirement_enabled
 scoped = flatten([for document in concat(data.aws_iam_policy_document.foundation_image_retirement_read[*].json, data.aws_iam_policy_document.foundation_image_retirement_delete[*].json) : jsondecode(document).Statement])
 resources = [local.foundation_retired_image_function_arn, local.foundation_retired_image_role_arn, local.foundation_retired_image_boundary_arn, local.foundation_retired_image_rule_arn]
 retired_boundary = [for policy in aws_iam_policy.foundation_ecr_retention_boundary : jsondecode(policy.policy).Statement]
 identity = concat(jsondecode(data.aws_iam_policy_document.foundation_terraform_apply[0].json).Statement, jsondecode(data.aws_iam_policy_document.foundation_terraform_apply_workload[0].json).Statement)
 plan = jsondecode(data.aws_iam_policy_document.foundation_terraform_plan[0].json).Statement
 boundary = jsondecode(data.aws_iam_policy_document.foundation_apply_deploy_permissions_boundary[0].json).Statement
 app_logs = local.app_codebuild_log_group_project_names
 active_app = local.app_codebuild_project_names
 retained_app = [local.deployment_shared_names.retainedAppSignaturePreflightApplyProject, local.deployment_shared_names.retainedAppSignaturePreflightPlanProject, local.deployment_shared_names.retainedAppSignaturePreflightVerifyProject]
 log_name = aws_cloudwatch_log_group.ecr_retention.name
 log_retention = aws_cloudwatch_log_group.ecr_retention.retention_in_days
 retire = {{
  "lambda:DeleteFunction" = local.foundation_retired_image_function_arn
  "lambda:RemovePermission" = local.foundation_retired_image_function_arn
  "events:RemoveTargets" = local.foundation_retired_image_rule_arn
  "events:DeleteRule" = local.foundation_retired_image_rule_arn
  "iam:DeleteRolePolicy" = local.foundation_retired_image_role_arn
  "iam:DeleteRolePermissionsBoundary" = local.foundation_retired_image_role_arn
  "iam:DeleteRole" = local.foundation_retired_image_role_arn
 }}
 forbidden = {{
  "lambda:InvokeFunction" = local.foundation_retired_image_function_arn
  "lambda:CreateFunction" = local.foundation_retired_image_function_arn
  "events:PutRule" = local.foundation_retired_image_rule_arn
  "iam:PutRolePolicy" = local.foundation_retired_image_role_arn
  "iam:PassRole" = local.foundation_retired_image_role_arn
  "logs:DeleteLogGroup" = local.foundation_retained_image_log_arn
 }}
}} }}
output "policy_quota_managed" {{ value = {managed_expression} }}
output "policy_quota_attachments" {{ value = {{for p in {attachment_expression} : p.role => p.policy...}} }}
output "policy_quota_inline" {{ value = {{for p in {inline_expression} : p.role => p.bytes...}} }}
''')
tests = root / 'tests'
tests.mkdir()
for target_key, values in inputs.items():
    account, region = values['aws_account_id'], values['aws_region']
    mocks = {
        'aws_iam_policy': {'arn': f'arn:aws:iam::{account}:policy/policy-test'},
        'aws_iam_role': {'arn': f'arn:aws:iam::{account}:role/policy-test'},
        'aws_codeconnections_connection': {'arn': f'arn:aws:codeconnections:{region}:{account}:connection/11111111-2222-3333-4444-555555555555'},
        'aws_iam_openid_connect_provider': {'arn': f'arn:aws:iam::{account}:oidc-provider/token.actions.githubusercontent.com'},
    }
    text = 'mock_provider "aws" {\n' + ''.join(
        f'mock_resource "{kind}" {{\n defaults = {json.dumps(defaults)}\n}}\n'
        for kind, defaults in mocks.items()) + '}\n'
    for name in kms_keys:
        key_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f'offline-policy-test/{target_key}/{name}'))
        values_for_key = {'key_id': key_id, 'arn': f'arn:aws:kms:{region}:{account}:key/{key_id}'}
        text += f'override_resource {{\n target = aws_kms_key.{name}\n values = {json.dumps(values_for_key)}\n}}\n'
    text += ''.join(f'override_resource {{\n target = terraform_data.{name}\n}}\n' for name in waits)
    text += 'run "policy_quotas" {\n command = apply\n variables {\n' + ''.join(
        f'{key} = {json.dumps(value)}\n' for key, value in values.items()) + '}\n'
    expected_promotion_arns = [f'${{output.foundation_release_manifest_bucket_arn}}/{key}' for key in promotions[target_key]]
    text += '''assert {
 condition = output.app_prepare_dependency_authority.attachment_role == output.app_prepare_dependency_authority.role && output.app_prepare_dependency_authority.attachment_policy == output.app_prepare_dependency_authority.policy
 error_message = "Prepare dependency reads must attach to the actual App Plan role."
}
assert {
 condition = alltrue([for sid, grant in output.app_prepare_dependency_authority.grants : anytrue([for s in output.app_prepare_dependency_authority.identity : try(s.Sid, "") == sid && s.Effect == "Allow" && toset(flatten([s.Action])) == toset([grant.action]) && toset(flatten([s.Resource])) == toset(grant.resources) && !can(s.Condition)])])
 error_message = "App Prepare requires exact Foundation checkpoint-version, current promotion and versioned candidate identity grants."
}
assert {
 condition = alltrue([for grant in values(output.app_prepare_dependency_authority.grants) : alltrue([for arn in grant.resources : anytrue([for s in output.app_prepare_dependency_authority.boundary : s.Effect == "Allow" && contains(flatten([s.Action]), grant.action) && contains(flatten([s.Resource]), arn) && !can(s.Condition)])])]) && alltrue([for s in output.app_prepare_dependency_authority.boundary : s.Effect != "Deny"])
 error_message = "Prepare dependency identity grants must also pass the actual role boundary."
}
assert {
 condition = alltrue([for s in output.app_prepare_dependency_authority.identity : alltrue([for action in flatten([s.Action]) : contains(["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucketVersions", "kms:Decrypt", "kms:DescribeKey"], action)]) && (length(setintersection(toset(flatten([s.Action])), toset(["s3:GetObject", "s3:GetObjectVersion"]))) == 0 || contains(keys(output.app_prepare_dependency_authority.grants), try(s.Sid, "")))]) && alltrue([for s in output.app_prepare_dependency_authority.bucket_policy : s.Effect != "Deny" || length(setintersection(toset(flatten([s.Action])), toset(["s3:GetObject", "s3:GetObjectVersion", "s3:*", "*"]))) == 0 || try(s.Condition.Bool["aws:SecureTransport"], "") == "false"])
 error_message = "Dependency object reads must not broaden beyond the reviewed keys or encounter a bucket deny under TLS."
}
assert {
 condition = anytrue([for s in output.foundation_apply_boundary_statements : try(s.Sid, "") == "DenyDeletingImmutableReleaseAuthority" && s.Effect == "Deny" && !can(s.Condition) && !can(s.NotResource) && !can(s.NotAction) && alltrue([for arn in ''' + json.dumps(expected_promotion_arns) + ''' : contains(flatten([s.Resource]), arn)])])
 error_message = "Foundation Smoke requires exact current promotion keys from the image ledger authority in the rendered unconditional delete deny."
}
'''
    welcome_arn = f'arn:aws:logs:{region}:{account}:log-group:/aws/apigateway/welcome'
    text += f'''assert {{
 condition = anytrue([for s in output.gateway_logging_statements : s.Effect == "Allow" && contains(flatten([s.Action]), "logs:CreateLogGroup") && contains(flatten([s.Resource]), "{welcome_arn}")])
 error_message = "API Gateway UpdateAccount must be able to create its exact welcome validation group (observed CloudTrail failure)."
}}
assert {{
 condition = alltrue([for s in output.gateway_logging_statements : !contains(flatten([s.Action]), "logs:CreateLogGroup") || alltrue([for arn in flatten([s.Resource]) : contains(["{welcome_arn}", "{welcome_arn}:*"], arn)])])
 error_message = "Gateway log-group creation must not extend beyond the exact service welcome group."
}}
assert {{
 condition = alltrue(flatten([for s in output.gateway_logging_statements : [for action in flatten([s.Action]) : contains(["logs:CreateLogGroup", "logs:CreateLogStream", "logs:DescribeLogGroups", "logs:DescribeLogStreams", "logs:PutLogEvents"], action)]]))
 error_message = "The Gateway log writer must not read log events or grant wildcard actions."
}}
'''
    text += '''assert {
 condition = anytrue([for s in output.frontend_artifact_authority.plan_only : s.Effect == "Allow" && toset(flatten([s.Action])) == toset(["s3:PutObject"]) && toset(flatten([s.Resource])) == toset([output.frontend_artifact_authority.prefix]) && try(s.Condition.StringEquals["s3:if-none-match"], "") == "*"])
 error_message = "Only App Prepare's own policy must admit create-only publication of its retained frontend archive/manifest/config."
}
assert {
 condition = alltrue([for statements in [output.frontend_artifact_authority.plan, output.frontend_artifact_authority.apply, output.frontend_artifact_authority.static, output.frontend_artifact_authority.drift] : anytrue([for s in statements : s.Effect == "Allow" && alltrue([for action in ["s3:GetObject", "s3:GetObjectVersion"] : contains(flatten([try(s.Action, [])]), action)]) && contains(flatten([try(s.Resource, [])]), output.frontend_artifact_authority.prefix)])])
 error_message = "Prepare, Apply, static publication and local drift must all read exact retained frontend versions."
}
assert {
 condition = alltrue([for statements in [output.frontend_artifact_authority.apply, output.frontend_artifact_authority.static] : alltrue([for s in statements : s.Effect != "Allow" || length(setintersection(toset(flatten([try(s.Action, [])])), toset(["s3:PutObject", "s3:*", "*"]))) == 0 || length(setintersection(toset(flatten([try(s.Resource, [])])), toset([output.frontend_artifact_authority.prefix, "${output.frontend_artifact_authority.bucket}/*", "*"]))) == 0])])
 error_message = "Apply and static publication must not own retained frontend artifact writes."
}
assert {
 condition = anytrue([for s in output.frontend_artifact_authority.smoke : try(s.Sid, "") == "ReadApprovedFrontendManifestForSmoke" && s.Effect == "Allow" && toset(flatten([s.Action])) == toset(["s3:GetObjectVersion"]) && toset(flatten([s.Resource])) == toset(["${trimsuffix(output.frontend_artifact_authority.prefix, "*")}*/*/manifest.json"])]) && anytrue([for s in output.frontend_artifact_authority.smoke_boundary : s.Effect == "Allow" && contains(flatten([s.Action]), "s3:GetObjectVersion") && contains(flatten([s.Resource]), "${output.frontend_artifact_authority.bucket}/*") && !can(s.Condition)]) && alltrue([for s in output.frontend_artifact_authority.smoke_boundary : s.Effect != "Deny"])
 error_message = "Smoke must read only the approved retained manifest version through its boundary, without an unversioned or archive/config grant."
}
assert {
 condition = anytrue([for s in output.frontend_artifact_authority.smoke_boundary : s.Effect == "Allow" && contains(flatten([s.Action]), "kms:Decrypt") && contains(flatten([s.Resource]), "*") && try(s.Condition.StringEquals["aws:ResourceTag/Project"], "") == output.frontend_artifact_authority.kms_tags.Project && try(s.Condition.StringEquals["aws:ResourceTag/StateScope"], "") == output.frontend_artifact_authority.kms_tags.StateScope])
 error_message = "The retained artifact key tags must satisfy Smoke's KMS decryption boundary."
}
assert {
 condition = anytrue([for s in output.frontend_artifact_authority.bucket_policy : try(s.Sid, "") == "DenyStaticFrontendArtifactWritesOutsidePlanRole" && s.Effect == "Deny" && toset(flatten([s.Resource])) == toset([output.frontend_artifact_authority.prefix]) && toset(flatten([s.Condition.ArnNotEquals["aws:PrincipalArn"]])) == toset([output.frontend_artifact_authority.plan_role])]) && anytrue([for s in output.frontend_artifact_authority.bucket_policy : try(s.Sid, "") == "DenyUnconditionalRetainedEvidenceWrites" && contains(flatten([s.Resource]), output.frontend_artifact_authority.prefix) && s.Condition.StringNotEquals["s3:if-none-match"] == "*"])
 error_message = "The retained bucket must deny frontend writes by every role except Plan and reject every non-create-only request."
}
assert {
 condition = startswith(output.frontend_artifact_authority.site_key, trimsuffix(output.frontend_artifact_authority.runtime_parameters, "*")) && anytrue([for s in output.frontend_artifact_authority.plan : s.Effect == "Allow" && contains(flatten([s.Action]), "ssm:GetParameter") && contains(flatten([s.Resource]), output.frontend_artifact_authority.runtime_parameters)]) && alltrue([for s in output.frontend_artifact_authority.static : alltrue([for action in flatten([s.Action]) : !startswith(action, "ssm:")])])
 error_message = "Prepare must read the target browser-public site key; static publication must not reread SSM configuration after approval."
}
assert {
 condition = anytrue([for s in output.frontend_artifact_authority.boundary : s.Effect == "Allow" && contains(flatten([s.Action]), "s3:*") && contains(flatten([s.Resource]), "${output.frontend_artifact_authority.bucket}/*")]) && anytrue([for s in output.frontend_artifact_authority.boundary : s.Effect == "Allow" && alltrue([for action in ["kms:*", "ssm:*"] : contains(flatten([s.Action]), action)]) && contains(flatten([s.Resource]), "*")]) && alltrue([for s in output.frontend_artifact_authority.boundary : s.Effect != "Deny"])
 error_message = "The shared App role boundary must admit the frontend S3, KMS and site-key reads without an intersecting deny."
}
assert {
 condition = alltrue([for statements in [output.frontend_artifact_authority.common, output.frontend_artifact_authority.static] : anytrue([for s in statements : s.Effect == "Allow" && alltrue([for action in ["kms:Decrypt", "kms:GenerateDataKey"] : contains(flatten([s.Action]), action)]) && contains(flatten([s.Resource]), output.frontend_artifact_authority.kms_key)])]) && anytrue([for s in output.frontend_artifact_authority.kms : try(s.Sid, "") == "AllowAppPipelineArtifactKeyUse" && alltrue([for role in output.frontend_artifact_authority.roles : contains(flatten([s.Principal.AWS]), role)]) && alltrue([for action in ["kms:Decrypt", "kms:GenerateDataKey"] : contains(flatten([s.Action]), action)])])
 error_message = "Identity and artifact key policy must jointly support Plan publication and downstream reads; static still encrypts native pipeline output artifacts."
}
'''
    text += '''assert {
 condition = length(output.native_build_inputs) == 12 && alltrue([for action in output.native_build_inputs : action.configuration.PrimarySource == "SourceOutput" && contains(action.input_artifacts, "SourceOutput") && length([for variable in jsondecode(action.configuration.EnvironmentVariables) : variable if variable.name == action.execution_env && variable.type == "PLAINTEXT" && variable.value == "#{codepipeline.PipelineExecutionId}"]) == 1 && length(distinct([for variable in jsondecode(action.configuration.EnvironmentVariables) : variable.name])) == length(jsondecode(action.configuration.EnvironmentVariables))])
 error_message = "All 12 pipeline actions must supply unique native execution-ID environment binding and the primary SourceOutput consumed by runtime admission."
}
assert {
 condition = length([for action in output.native_build_inputs : action if action.name == "PlanAppState"]) == 1 && alltrue([for action in output.native_build_inputs : action.name != "PlanAppState" || length([for variable in jsondecode(action.configuration.EnvironmentVariables) : variable if variable.name == "APP_SOURCE_SHA" && variable.type == "PLAINTEXT" && variable.value == "#{AppSource.CommitId}"]) == 1])
 error_message = "App Plan must receive the Source action commit directly before release resolution; removed resolver exports cannot supply APP_SOURCE_SHA."
}
'''
    text += '''assert {
 condition = alltrue([for name in output.image_retirement.retained_app : contains(output.image_retirement.app_logs, name) == output.image_retirement.enabled && !contains(output.image_retirement.active_app, name)]) && output.image_retirement.log_name == "/aws/lambda/${local.deployment_shared_names.runtimeNamePrefix}-ecr-retention" && output.image_retirement.log_retention == 365
 error_message = "Production keeps all three preflight audit groups without active projects; the Foundation audit group retains its singleton address and retention."
}
assert {
 condition = alltrue([for statement in output.image_retirement.scoped : alltrue([for resource in flatten([statement.Resource]) : contains(output.image_retirement.resources, resource)])])
 error_message = "Controller retirement authority must remain scoped to its exact function, role, boundary and rule identities."
}
assert {
 condition = length(output.image_retirement.retired_boundary) == (output.image_retirement.enabled ? 1 : 0) && alltrue([for statements in output.image_retirement.retired_boundary : length(statements) == 1 && statements[0].Effect == "Deny" && statements[0].Action == "*" && statements[0].Resource == "*"])
 error_message = "The still-attached production retention boundary must remain the same IAM identity with all actions denied; development must not recreate it."
}
assert {
 condition = alltrue([for action, resource in output.image_retirement.retire : alltrue([for policies in [output.image_retirement.identity, output.image_retirement.boundary] : anytrue([for statement in policies : statement.Effect == "Allow" && length(setintersection(toset(flatten([statement.Action])), toset([action, "${split(":", action)[0]}:*", "*"]))) > 0 && length(setintersection(toset(flatten([statement.Resource])), toset([resource, "*"]))) > 0])]) == output.image_retirement.enabled])
 error_message = "Only production Foundation Apply may retire the exact controller resources through both identity and boundary."
}
assert {
 condition = alltrue([for action, resource in output.image_retirement.forbidden : !anytrue([for statement in output.image_retirement.identity : statement.Effect == "Allow" && length(setintersection(toset(flatten([statement.Action])), toset([action, "${split(":", action)[0]}:*", "*"]))) > 0 && length(setintersection(toset(flatten([statement.Resource])), toset([resource, "*"]))) > 0])]) && alltrue([for action, resource in output.image_retirement.retire : !anytrue([for statement in output.image_retirement.plan : statement.Effect == "Allow" && length(setintersection(toset(flatten([statement.Action])), toset([action, "${split(":", action)[0]}:*", "*"]))) > 0 && length(setintersection(toset(flatten([statement.Resource])), toset([resource, "*"]))) > 0])])
 error_message = "Retirement must not restore invocation/creation/PassRole or log deletion, and Plan must remain read-only for retired resources."
}
'''
    text += '''assert {
 condition = length(output.execution_read_authority) == 13 && alltrue([for authority in values(output.execution_read_authority) : length([for s in authority.identity : s if contains(flatten([s.Action]), "codebuild:BatchGetBuilds")]) == 1 && alltrue([for s in authority.identity : !contains(flatten([s.Action]), "codebuild:BatchGetBuilds") || (s.Effect == "Allow" && toset(flatten([s.Resource])) == toset([authority.project]) && !can(s.Condition))])])
 error_message = "All 13 managed builds must read exactly their own project ARN; build ARNs and cross-project/wildcard grants do not admit the native source assertion."
}
assert {
 condition = alltrue([for authority in values(output.execution_read_authority) : anytrue([for s in authority.boundary : s.Effect == "Allow" && length(setintersection(toset(flatten([s.Action])), toset(["*", "codebuild:*", "codebuild:BatchGetBuilds"]))) > 0 && length(setintersection(toset(flatten([s.Resource])), toset(["*", authority.project]))) > 0 && !can(s.Condition)]) && alltrue([for s in authority.boundary : s.Effect != "Deny" || (!can(s.NotAction) && length(setintersection(toset(flatten([try(s.Action, [])])), toset(["*", "codebuild:*", "codebuild:BatchGetBuilds"]))) == 0 || length(setintersection(toset(flatten([try(s.Resource, [])])), toset(["*", authority.project]))) == 0)])])
 error_message = "The attached role boundary must admit BatchGetBuilds on every managed role's own project."
}
assert {
 condition = length(output.drift_build_observation) == 3 && alltrue([for root, statements in output.drift_build_observation : length(statements) == 1 && alltrue([for s in statements : s.Effect == "Allow" && toset(flatten([s.Action])) == toset(["codebuild:ListBuildsForProject", "codebuild:BatchGetBuilds"]) && toset(flatten([s.Resource])) == toset([for key, authority in output.execution_read_authority : authority.project if root == "bootstrap" || (root == "foundation" ? startswith(key, "foundation_terraform_") : startswith(key, "app_"))])])])
 error_message = "Local drift must observe only the root's exact active projects (Bootstrap 13, Foundation 3, App 5), with no build ARNs or wildcard reads."
}
assert {
 condition = alltrue([for statements in values(output.drift_read_boundaries) : anytrue([for s in statements : s.Effect == "Allow" && toset(flatten([try(s.Action, [])])) == toset(["*"]) && toset(flatten([try(s.Resource, [])])) == toset(["*"])]) && alltrue([for s in statements : s.Effect != "Deny" || (can(s.NotAction) ? alltrue([for action in ["codebuild:BatchGetBuilds", "codebuild:ListBuildsForProject"] : contains(flatten([s.NotAction]), action)]) : length(setintersection(toset(flatten([try(s.Action, [])])), toset(["*", "codebuild:*", "codebuild:BatchGetBuilds", "codebuild:ListBuildsForProject"]))) == 0)])])
 error_message = "Local drift NotAction denies must explicitly exempt both native build observation APIs, and no explicit Action deny may block them."
}
assert {
 condition = alltrue([for action in output.bootstrap_drift_retained_policy_read.actions : anytrue([for s in output.bootstrap_drift_retained_policy_read.statements : s.Effect == "Allow" && contains(flatten([s.Action]), action) && contains(flatten([s.Resource]), output.bootstrap_drift_retained_policy_read.resource)]) == output.image_retirement.enabled && alltrue([for s in output.drift_read_boundaries.bootstrap : s.Effect != "Deny" || (can(s.NotAction) ? contains(flatten([s.NotAction]), action) : length(setintersection(toset(flatten([try(s.Action, [])])), toset(["*", "iam:*", action]))) == 0)])])
 error_message = "Bootstrap drift must refresh the retained controller boundary and its versions/tags wherever that resource is owned, without a boundary denial; development must not grant access to an absent resource."
}
assert {
 condition = alltrue([for policy in output.policy_quota_managed : alltrue([for action in output.bootstrap_drift_retained_policy_read.actions : anytrue([for s in output.bootstrap_drift_retained_policy_read.statements : s.Effect == "Allow" && contains(flatten([s.Action]), action) && contains(flatten([s.Resource]), policy.arn)])])])
 error_message = "Bootstrap drift must read every source-owned managed IAM policy and its versions/tags, including newly introduced deployment policies."
}
assert {
 condition = alltrue([for s in output.bootstrap_drift_retained_policy_read.statements : s.Effect == "Allow" && alltrue([for action in flatten([s.Action]) : contains(output.bootstrap_drift_retained_policy_read.actions, action)]) && alltrue([for resource in flatten([s.Resource]) : !strcontains(resource, "*") && !strcontains(resource, "?") && startswith(resource, "arn:aws:iam::${var.aws_account_id}:policy/")])])
 error_message = "Bootstrap policy refresh grants must remain read-only and exact-account/exact-policy scoped; no wildcard or IAM mutation grant is admitted."
}
assert {
 condition = alltrue([for action in output.bootstrap_drift_connection_read.actions : anytrue([for s in output.bootstrap_drift_connection_read.statements : s.Effect == "Allow" && contains(flatten([s.Action]), action) && contains(flatten([s.Resource]), output.bootstrap_drift_connection_read.connection)]) && alltrue([for s in output.bootstrap_drift_connection_read.statements : !contains(flatten([s.Action]), action) || alltrue([for resource in flatten([s.Resource]) : !strcontains(resource, "*") && (!strcontains(resource, ":connection/") || resource == output.bootstrap_drift_connection_read.connection)])]) && alltrue([for s in output.drift_read_boundaries.bootstrap : s.Effect != "Deny" || (can(s.NotAction) ? contains(flatten([s.NotAction]), action) : length(setintersection(toset(flatten([try(s.Action, [])])), toset(["*", "codeconnections:*", "codestar-connections:*", action]))) == 0)])])
 error_message = "Bootstrap drift must read the exact current connection and its tags under both AWS-authorized action namespaces without a boundary denial or wildcard connection grant."
}
assert {
 condition = length(output.policy_quota_managed) > 0 && alltrue([for p in output.policy_quota_managed : p.bytes <= 6144])
 error_message = "Managed IAM policies exceed 6144: ${join(", ", [for p in output.policy_quota_managed : format("%s=%d", p.name, p.bytes) if p.bytes > 6144])}"
}
assert {
 condition = length(output.policy_quota_attachments) > 0 && alltrue([for policies in values(output.policy_quota_attachments) : length(policies) <= 10])
 error_message = "Role managed-policy attachments exceed 10: ${join(", ", [for role, policies in output.policy_quota_attachments : format("%s=%d", role, length(policies)) if length(policies) > 10])}"
}
assert {
 condition = length(output.policy_quota_inline) > 0 && alltrue([for sizes in values(output.policy_quota_inline) : sum(sizes) <= 10240])
 error_message = "Role inline policies exceed 10240: ${join(", ", [for role, sizes in output.policy_quota_inline : format("%s=%d", role, sum(sizes)) if sum(sizes) > 10240])}"
}
}
'''
    (tests / f'{values["account_alias"]}.tftest.hcl').write_text(text)
PY

# No backend, remote state or AWS mutation. terraform test holds mock state in
# memory; the real provider is used only for aws_iam_policy_document.
policy_root="$policy_workspace/infra/terraform/bootstrap"
if ! terraform -chdir="$policy_root" init -backend=false -input=false -no-color >"$policy_workspace/init.log" 2>&1; then
  cat "$policy_workspace/init.log" >&2
  exit 1
fi
# Check the applied ordering as well as final aggregate sizes: shrinking the
# primary App Plan policy must precede growth of its companion inline policy.
terraform -chdir="$policy_root" graph >"$policy_workspace/dependencies.dot"
python3 - "$policy_workspace/dependencies.dot" <<'ORDER'
import pathlib, re, sys
edges = set(re.findall(r'"([^"\n]+)"\s*->\s*"([^"\n]+)"', pathlib.Path(sys.argv[1]).read_text()))
required = ('aws_iam_role_policy.app_terraform_plan_pipeline_state', 'aws_iam_role_policy.app_terraform_plan')
dependencies = {}
for consumer, dependency in edges:
    dependencies.setdefault(consumer, set()).add(dependency)
pending, visited = [required[0]], set()
while pending:
    node = pending.pop()
    if node not in visited:
        visited.add(node)
        pending.extend(dependencies.get(node, ()))
if required[1] not in visited:
    raise SystemExit('App Plan inline policy growth must depend on its primary policy update to prevent transient IAM quota overflow.')
print('App Plan inline policy update ordering passed.')
ORDER

set +e
terraform -chdir="$policy_root" test -no-color >"$policy_workspace/test.log" 2>&1
policy_status=$?
set -e
python3 - "$policy_workspace/test.log" <<'PY'
import pathlib, re, sys
print(re.sub(r'\b[0-9]{12}\b', '[ACCOUNT]', pathlib.Path(sys.argv[1]).read_text()))
PY
exit "$policy_status"
