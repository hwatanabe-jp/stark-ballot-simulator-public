resource "aws_iam_role" "app_static_fast_pipeline" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_static_fast_pipeline_role_name
  assume_role_policy   = data.aws_iam_policy_document.pipeline_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

resource "aws_iam_role" "app_static_fast_gate_and_build" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_static_fast_gate_and_build_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

resource "aws_iam_role" "app_static_fast_smoke_lite" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_static_fast_smoke_lite_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_smoke_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

data "aws_iam_policy_document" "app_static_fast_pipeline" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "UseSharedSourceConnection"
    effect = "Allow"

    actions = [
      "codeconnections:GetConnection",
      "codeconnections:GetConnectionToken",
      "codeconnections:PassConnection",
      "codeconnections:UseConnection",
      "codestar-connections:GetConnection",
      "codestar-connections:GetConnectionToken",
      "codestar-connections:PassConnection",
      "codestar-connections:UseConnection",
    ]
    resources = local.app_source_connection_arns
  }

  statement {
    sid    = "RunAppStaticFastCodeBuildProjects"
    effect = "Allow"

    actions = [
      "codebuild:BatchGetBuilds",
      "codebuild:StartBuild",
    ]
    resources = [
      aws_codebuild_project.app_static_fast_gate_and_build[0].arn,
      aws_codebuild_project.app_static_deploy[0].arn,
      aws_codebuild_project.app_static_fast_smoke_lite[0].arn,
    ]
  }

  statement {
    sid    = "UseAppStaticFastPipelineArtifacts"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.app_static_fast_pipeline_name}/*"]
  }

  statement {
    sid       = "ListAppStaticFastPipelineArtifacts"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.app_pipeline_artifacts[0].arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        local.app_static_fast_pipeline_name,
        "${local.app_static_fast_pipeline_name}/*",
      ]
    }
  }

  statement {
    sid    = "UseAppStaticFastArtifactKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.app_pipeline_artifacts[0].arn]
  }
}

resource "aws_iam_role_policy" "app_static_fast_pipeline" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_static_fast_pipeline_role_name}-policy"
  role   = aws_iam_role.app_static_fast_pipeline[0].id
  policy = data.aws_iam_policy_document.app_static_fast_pipeline[0].json
}

data "aws_iam_policy_document" "app_static_fast_gate_and_build" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "UseSharedSourceConnection"
    effect = "Allow"

    actions = [
      "codeconnections:UseConnection",
      "codestar-connections:UseConnection",
    ]
    resources = local.app_source_connection_arns
  }

  statement {
    sid    = "WriteAppStaticFastGateLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_static_fast_gate_project_name].arn}:*",
    ]
  }

  statement {
    sid    = "ReadAcceptedAppDeploymentEvidence"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/accepted-deployments/stark-dev/develop/app/current.json",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/accepted-deployments/stark-dev/develop/app/executions/*/attempts/*/authoritative-app-deployment.json",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/accepted-deployments/stark-dev/develop/app/executions/*/attempts/*/apply-outputs.json",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/accepted-deployments/stark-dev/develop/app/executions/*/attempts/*/static-frontend-deploy.json",
    ]
  }

  statement {
    sid    = "ReadAppStaticFastPipelineArtifacts"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = ["${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.app_static_fast_pipeline_name}/*"]
  }

  statement {
    sid       = "WriteAppStaticFastPipelineArtifacts"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.app_static_fast_pipeline_name}/*"]
  }

  statement {
    sid       = "ListAppStaticFastPipelineArtifacts"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.app_pipeline_artifacts[0].arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        local.app_static_fast_pipeline_name,
        "${local.app_static_fast_pipeline_name}/*",
      ]
    }
  }

  statement {
    sid    = "UseAppStaticFastArtifactKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.app_pipeline_artifacts[0].arn]
  }

  statement {
    sid    = "ReadTargetBrowserPublicConfig"
    effect = "Allow"

    actions = [
      "ssm:GetParameter",
    ]
    resources = local.app_browser_public_config_parameter_arns
  }
}

resource "aws_iam_role_policy" "app_static_fast_gate_and_build" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_static_fast_gate_and_build_role_name}-policy"
  role   = aws_iam_role.app_static_fast_gate_and_build[0].id
  policy = data.aws_iam_policy_document.app_static_fast_gate_and_build[0].json
}

data "aws_iam_policy_document" "app_static_fast_smoke_lite" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "WriteAppStaticFastSmokeLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_static_fast_smoke_project_name].arn}:*",
    ]
  }

  statement {
    sid    = "ReadAppStaticFastSmokeArtifacts"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.app_pipeline_artifacts[0].arn,
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/*",
    ]
  }

  statement {
    sid       = "WriteAppStaticFastSmokeArtifacts"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.app_static_fast_pipeline_name}/*"]
  }

  statement {
    sid    = "UseAppStaticFastSmokeArtifactKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.app_pipeline_artifacts[0].arn]
  }
}

resource "aws_iam_role_policy" "app_static_fast_smoke_lite" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_static_fast_smoke_lite_role_name}-policy"
  role   = aws_iam_role.app_static_fast_smoke_lite[0].id
  policy = data.aws_iam_policy_document.app_static_fast_smoke_lite[0].json
}

resource "aws_codebuild_project" "app_static_fast_gate_and_build" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_static_fast_gate_project_name
  service_role  = aws_iam_role.app_static_fast_gate_and_build[0].arn
  build_timeout = 20

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_static_fast_gate_project_name].name
      stream_name = "static-fast-gate-and-build"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      env = {
        "git-credential-helper" = "yes"
      }
      phases = {
        install = {
          "runtime-versions" = {
            nodejs = 24
          }
          commands = [
            "corepack enable",
          ]
        }
        build = {
          commands = [
            <<-STATIC_FAST_GATE
set -eu
mkdir -p .tmp infra/terraform/app/evidence
git ls-files -s -z -- public apps/web > .tmp/static-fast-tracked-files.z
node <<'NODE'
const fs = require("node:fs");
const entries = fs.readFileSync(".tmp/static-fast-tracked-files.z", "utf8").split("\0").filter(Boolean);
const allowedModes = new Set(["100644", "100755"]);
const invalidEntries = [];
for (const entry of entries) {
  const match = entry.match(/^(\d{6}) [0-9a-f]+ \d+\t([\s\S]*)$/);
  if (!match) {
    invalidEntries.push({ mode: "malformed", path: "<unparsed>" });
  } else if (!allowedModes.has(match[1])) {
    invalidEntries.push({ mode: match[1], path: match[2] });
  }
}
if (invalidEntries.length > 0) {
  throw new Error(
    "Static fast lane refuses non-regular tracked entries under public or apps/web: " +
      invalidEntries.map((entry) => entry.mode + ":" + JSON.stringify(entry.path)).join(", ")
  );
}
NODE
aws s3api get-object --bucket "${local.app_pipeline_artifact_bucket_name}" --key "accepted-deployments/stark-dev/develop/app/current.json" --expected-bucket-owner "${var.aws_account_id}" accepted-current.json --output json --no-cli-pager > accepted-current.get-object.json
node infra/terraform/bootstrap/app-pipeline-scripts/app-static-fast-authority.cjs select-current accepted-current.json > .tmp/static-fast-manifest.env
. .tmp/static-fast-manifest.env
export accepted_manifest_path accepted_manifest_version_id accepted_manifest_sha256
aws s3api get-object --bucket "${local.app_pipeline_artifact_bucket_name}" --key "$accepted_manifest_path" --version-id "$accepted_manifest_version_id" --expected-bucket-owner "${var.aws_account_id}" accepted-deployment.json --output json --no-cli-pager > accepted-deployment.get-object.json
node infra/terraform/bootstrap/app-pipeline-scripts/app-static-fast-authority.cjs validate-record accepted-current.json accepted-deployment.json accepted-deployment.get-object.json > .tmp/static-fast-accepted.env
. .tmp/static-fast-accepted.env
export accepted_source_sha accepted_deployment_id apply_outputs_path apply_outputs_sha256 static_frontend_deploy_path
current_source_sha="$${CODEBUILD_RESOLVED_SOURCE_VERSION:-HEAD}"
if ! git rev-parse --verify "$accepted_source_sha^{commit}" >/dev/null 2>&1 ||
   ! git rev-parse --verify "$current_source_sha^{commit}" >/dev/null 2>&1 ||
   ! git merge-base --is-ancestor "$accepted_source_sha" "$current_source_sha"; then
  echo "Static fast lane requires the accepted source SHA to be an ancestor of the current source. Use the full app lane." >&2
  exit 1
fi
git diff --name-status --no-renames -z "$accepted_source_sha" "$current_source_sha" > app-static-fast-diff.z
node <<'NODE'
const fs = require("node:fs");
const entries = fs.readFileSync("app-static-fast-diff.z", "utf8").split("\0").filter(Boolean);
const paths = [];
for (let index = 0; index < entries.length;) {
  const status = entries[index++] || "";
  const path = entries[index++];
  if (path) {
    paths.push(path);
  }
  if (/^[RC]/.test(status)) {
    const newPath = entries[index++];
    if (newPath) {
      paths.push(newPath);
    }
  }
}
const staticPrefixes = ["apps/web/src/", "public/patterns/", "public/textures/"];
const neutralPrefixes = [
  "docs/",
  "public-book/",
  "scripts/__tests__/",
  "infra/terraform/bootstrap/",
  "infra/terraform/foundation/",
];
const neutralFiles = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "SECURITY.md",
  "infra/terraform/app/README.md",
];
const explicitDeniedPrefixes = [
  "apps/api/",
  "packages/",
  "zkvm/",
  "verifier-service/",
  "infra/terraform/app/",
  "infra/docker/",
  "infra/lambdas/",
  "scripts/aws/",
];
const explicitDeniedFiles = [
  "public/imageId-mapping.json",
  "scripts/frontend/scan-static-artifact.ts",
  "scripts/aws/static-frontend-config-authority.ts",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
];
const staticPaths = paths.filter((file) => staticPrefixes.some((prefix) => file.startsWith(prefix)));
const denied = paths.filter((file) => {
  if (explicitDeniedFiles.includes(file)) {
    return true;
  }
  if (staticPrefixes.some((prefix) => file.startsWith(prefix))) {
    return false;
  }
  if (neutralFiles.includes(file) || neutralPrefixes.some((prefix) => file.startsWith(prefix))) {
    return false;
  }
  if (explicitDeniedPrefixes.some((prefix) => file.startsWith(prefix))) {
    return true;
  }
  return true;
});
if (denied.length > 0 || paths.length === 0 || staticPaths.length === 0) {
  const reason =
    denied.length > 0 ? denied.join(", ") : paths.length === 0 ? "(empty diff)" : "(no static frontend paths)";
  throw new Error(
    "Static fast lane default-deny gate rejected this diff. Use the full app lane. Rejected paths: " +
      reason
  );
}
NODE
pnpm install --frozen-lockfile --ignore-scripts
aws s3api get-object --bucket "${local.app_pipeline_artifact_bucket_name}" --key "$apply_outputs_path" --expected-bucket-owner "${var.aws_account_id}" infra/terraform/app/apply-outputs.json --output json --no-cli-pager
aws s3api get-object --bucket "${local.app_pipeline_artifact_bucket_name}" --key "$static_frontend_deploy_path" --expected-bucket-owner "${var.aws_account_id}" accepted-static-frontend-deploy.json --output json --no-cli-pager
node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const applyOutputsBody = fs.readFileSync("infra/terraform/app/apply-outputs.json", "utf8");
const actualApplyOutputsSha256 = crypto.createHash("sha256").update(applyOutputsBody).digest("hex");
if (actualApplyOutputsSha256 !== process.env.apply_outputs_sha256) {
  throw new Error("Static fast lane apply-outputs.json checksum does not match the accepted deployment marker.");
}
const outputs = JSON.parse(applyOutputsBody);
const acceptedStaticDeploy = JSON.parse(fs.readFileSync("accepted-static-frontend-deploy.json", "utf8"));
const acceptedImageIdMappingSha256 = acceptedStaticDeploy.imageIdMapping && acceptedStaticDeploy.imageIdMapping.sha256;
const currentImageIdMappingSha256 = crypto.createHash("sha256").update(fs.readFileSync("public/imageId-mapping.json")).digest("hex");
if (acceptedImageIdMappingSha256 !== currentImageIdMappingSha256) {
  throw new Error("Static fast lane refuses an ImageID mapping checksum mismatch. Use the full app lane.");
}
function requireOutput(name) {
  const output = outputs[name];
  if (!output || typeof output !== "object" || output.value === undefined) {
    throw new Error("apply-outputs.json missing " + name + ". Use the full app lane.");
  }
  return output.value;
}
const stateIdentity = requireOutput("app_state_identity");
const backendKey = requireOutput("app_state_backend_key");
const staticFrontend = requireOutput("static_frontend");
const [accountAlias, deploymentEnvironment, stateScope] = String(stateIdentity).split("/");
if (stateIdentity !== "stark-dev/develop/app") {
  throw new Error("Static fast lane accepted deployment app_state_identity mismatch.");
}
if (backendKey !== "stark-ballot-simulator/stark-dev/develop/app/terraform.tfstate") {
  throw new Error("Static fast lane accepted deployment app_state_backend_key mismatch.");
}
if (accountAlias !== "stark-dev" || deploymentEnvironment !== "develop" || stateScope !== "app") {
  throw new Error("Static fast lane accepted deployment accountAlias/deploymentEnvironment mismatch.");
}
if (!staticFrontend || !staticFrontend.frontend_bucket_name || !staticFrontend.cloudfront_distribution_id) {
  throw new Error("static_frontend output is required before static fast deploy.");
}
const evidence = {
  gateType: "app-static-fast",
  deploymentId: process.env.accepted_deployment_id,
  sourceSha: process.env.CODEBUILD_RESOLVED_SOURCE_VERSION,
  acceptedSourceSha: process.env.accepted_source_sha,
  applyOutputsSha256: actualApplyOutputsSha256,
  imageIdMappingSha256: currentImageIdMappingSha256,
  accountAlias,
  deploymentEnvironment,
  stateIdentity,
  backendKey,
  staticPrefixes: ["apps/web/src/", "public/patterns/", "public/textures/"],
  neutralPrefixes: [
    "docs/",
    "public-book/",
    "scripts/__tests__/",
    "infra/terraform/bootstrap/",
    "infra/terraform/foundation/",
  ],
};
fs.writeFileSync("infra/terraform/app/evidence/static-fast-gate.json", JSON.stringify(evidence, null, 2) + "\n");
NODE
node <<'NODE' > .tmp/static-frontend-config.env
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const outputs = JSON.parse(fs.readFileSync("infra/terraform/app/apply-outputs.json", "utf8"));
const references = outputs.runtime_secret_config_reference_names && outputs.runtime_secret_config_reference_names.value;

function requireString(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(name + " is required before target static frontend build.");
  }
  if (/__MISSING_|<|>|change-me|placeholder/i.test(value)) {
    throw new Error(name + " must not be a placeholder.");
  }
  return value.trim();
}

const siteKeyRef = requireString(
  "VITE_TURNSTILE_SITE_KEY_REF",
  references && references.VITE_TURNSTILE_SITE_KEY_REF
);
if (!siteKeyRef.endsWith("/app/config/vite-turnstile-site-key")) {
  throw new Error("VITE_TURNSTILE_SITE_KEY_REF must point at the target browser-public site-key parameter.");
}
const siteKey = requireString(
  "VITE_TURNSTILE_SITE_KEY",
  execFileSync("aws", ["ssm", "get-parameter", "--name", siteKeyRef, "--query", "Parameter.Value", "--output", "text", "--no-cli-pager"], { encoding: "utf8" })
);
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}
function exportValue(name, value) {
  console.log("export " + name + "=" + shellQuote(value));
}
console.log("unset VITE_API_BASE_URL");
exportValue("VITE_APP_ENV", "develop");
exportValue("VITE_DEPLOYMENT_ID", process.env.accepted_deployment_id);
console.log("unset VITE_CONTRACT_GENERATION");
console.log("unset CONTRACT_GENERATION");
exportValue("TARGET_DEVELOP_OPERATOR_GATE_ENABLED", "true");
exportValue("TARGET_PUBLIC_SESSION_CREATE_ENABLED", "true");
exportValue("SESSION_CREATE_TURNSTILE_REQUIRED", "false");
exportValue("VITE_SESSION_CREATE_TURNSTILE_REQUIRED", "false");
exportValue("VITE_STH_SOURCES", "/api/sth");
exportValue("VITE_STH_MIN_MATCHES", "1");
exportValue("VITE_TURNSTILE_BYPASS", "false");
exportValue("VITE_TURNSTILE_SITE_KEY", siteKey);
exportValue("VITE_USE_MOCK_API", "false");
NODE
. .tmp/static-frontend-config.env
pnpm tsx scripts/aws/static-frontend-config-authority.ts --apply-outputs infra/terraform/app/apply-outputs.json --write-record infra/terraform/app/evidence/static-frontend-config-authority.json
node <<'NODE'
const fs = require("node:fs");
const staticFrontendConfigAuthority = JSON.parse(fs.readFileSync("infra/terraform/app/evidence/static-frontend-config-authority.json", "utf8"));
if (staticFrontendConfigAuthority.browserPublicConfig?.VITE_TURNSTILE_BYPASS?.effectiveValue !== "false" ||
    staticFrontendConfigAuthority.browserPublicConfig?.VITE_USE_MOCK_API?.effectiveValue !== "false") {
  throw new Error("Static fast lane requires disabled browser mock/bypass flags.");
}
if (staticFrontendConfigAuthority.browserPublicConfig?.VITE_API_BASE_URL?.effectiveValue !== "same-origin") {
  throw new Error("Static fast lane requires same-origin browser API config.");
}
NODE
pnpm build:ci
rm -f .tmp/static-frontend-config.env
STATIC_FAST_GATE
          ]
        }
      }
      artifacts = {
        files = [
          "infra/terraform/app/apply-outputs.json",
          "infra/terraform/app/evidence/static-fast-gate.json",
          "infra/terraform/app/evidence/static-frontend-config-authority.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_static_fast_smoke_lite" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_static_fast_smoke_project_name
  service_role  = aws_iam_role.app_static_fast_smoke_lite[0].arn
  build_timeout = 10

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_static_fast_smoke_project_name].name
      stream_name = "static-fast-smoke-lite"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        build = {
          commands = [
            <<-STATIC_FAST_SMOKE
set -eu
test -n "$CODEBUILD_SRC_DIR"
cp "$CODEBUILD_SRC_DIR"/infra/terraform/app/evidence/static-frontend-deploy.json static-frontend-deploy.json
node <<'NODE' > .tmp-static-fast-smoke.env
const fs = require("node:fs");
const evidence = JSON.parse(fs.readFileSync("static-frontend-deploy.json", "utf8"));
const host = evidence.cloudfrontDistributionDomain;
if (typeof host !== "string" || host.length === 0) {
  throw new Error("Static fast SmokeLite requires a CloudFront frontend delivery host.");
}
const operatorGateEnabled = evidence.operatorGateEnabled !== false;
console.log("frontend_host='" + host.replace(/'/g, "'\\''") + "'");
console.log("expected_http_status='" + (operatorGateEnabled ? "403" : "200") + "'");
console.log("operator_gate_enabled='" + (operatorGateEnabled ? "true" : "false") + "'");
NODE
. ./.tmp-static-fast-smoke.env
root_status="$(curl --silent --show-error --output /dev/null --write-out '%%{http_code}' "https://$frontend_host/")"
mapping_status="$(curl --silent --show-error --output /dev/null --write-out '%%{http_code}' "https://$frontend_host/imageId-mapping.json")"
if [ "$root_status" != "$expected_http_status" ] || [ "$mapping_status" != "$expected_http_status" ]; then
  echo "Static fast SmokeLite expected HTTP $expected_http_status but got /=$root_status and /imageId-mapping.json=$mapping_status." >&2
  exit 1
fi
export root_status mapping_status expected_http_status operator_gate_enabled
node <<'NODE'
const fs = require("node:fs");
const evidence = {
  evidenceType: "app-static-fast-smoke",
  operatorGateEnabled: process.env.operator_gate_enabled === "true",
  expectedHttpStatus: Number(process.env.expected_http_status),
  rootStatus: Number(process.env.root_status),
  imageIdMappingStatus: Number(process.env.mapping_status),
};
fs.writeFileSync("app-static-fast-smoke-lite.json", JSON.stringify(evidence, null, 2) + "\n");
NODE
STATIC_FAST_SMOKE
          ]
        }
      }
      artifacts = {
        files = [
          "app-static-fast-smoke-lite.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codepipeline" "app_static_fast" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_static_fast_pipeline_name
  pipeline_type = "V2"
  role_arn      = aws_iam_role.app_static_fast_pipeline[0].arn

  artifact_store {
    location = aws_s3_bucket.app_pipeline_artifacts[0].bucket
    type     = "S3"

    encryption_key {
      id   = aws_kms_key.app_pipeline_artifacts[0].arn
      type = "KMS"
    }
  }

  stage {
    name = "Source"

    action {
      name             = "Source"
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      namespace        = "StaticFastSource"
      output_artifacts = ["SourceOutput"]

      configuration = {
        BranchName           = var.source_branch
        ConnectionArn        = aws_codeconnections_connection.source[0].arn
        DetectChanges        = "false"
        FullRepositoryId     = var.github_full_repository_id
        OutputArtifactFormat = "CODEBUILD_CLONE_REF"
      }
    }
  }

  stage {
    name = "GateAndBuild"

    action {
      name             = "GateAndBuild"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput"]
      output_artifacts = ["ApplyOutput"]

      configuration = {
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.app_static_fast_gate_and_build[0].name
      }
    }
  }

  stage {
    name = "StaticFrontendDeploy"

    action {
      name             = "DeployStaticFrontend"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "ApplyOutput"]
      output_artifacts = ["StaticDeployOutput"]

      configuration = {
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.app_static_deploy[0].name
        EnvironmentVariables = jsonencode([
          {
            name  = "APP_DEPLOYMENT_MODE"
            value = "normal"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_SOURCE_SHA"
            value = "#{StaticFastSource.CommitId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_PIPELINE_EXECUTION_ID"
            value = "#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_STATIC_FAST_MODE"
            value = "true"
            type  = "PLAINTEXT"
          },
        ])
      }
    }
  }

  stage {
    name = "SmokeLite"

    action {
      name            = "SmokeLite"
      category        = "Build"
      owner           = "AWS"
      provider        = "CodeBuild"
      version         = "1"
      input_artifacts = ["StaticDeployOutput"]

      configuration = {
        ProjectName = aws_codebuild_project.app_static_fast_smoke_lite[0].name
      }
    }
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}
