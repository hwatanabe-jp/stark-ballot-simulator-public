import { projectNormalAppExecutionAuthority } from '../app-execution-authority.js';
import {
  canonicalRecordJson,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  resolveImageSigningIdentity,
} from '../index.js';
import { admitImageCandidate, admitImagePromotion, candidateKey, promotionKey } from '../release-ledger.js';
import { buildTerraformBaselineNonsecretInputs } from '../terraform-authority.js';
import { admitRootCheckpoint, deriveRootCheckpointKey } from '../root-checkpoint.js';
import { PLAN_TERRAFORM_RUNTIME, storedBytesSha256 } from '../plan-package.js';
import { computeFoundationSourceContract, FOUNDATION_CONSUMER_REQUIREMENTS } from '../foundation-contract.js';
export function createAppReleaseSelectionFixture(targetKey = 'stark-dev/develop') {
  const target = resolveAllowedDeploymentTarget(targetKey);
  const names = resolveDeploymentLaneAuthority(target, 'foundation').names;
  const lane = resolveDeploymentLaneAuthority(target, 'foundation');
  const signer = resolveImageSigningIdentity(target);
  const sourceSha = 'b'.repeat(40);
  const executionId = '11111111-1111-4111-8111-111111111111';
  const inputValues = {
    account_alias: target.accountLabel,
    aws_account_id: target.accountId,
    aws_region: target.region,
    deployment_environment: target.environmentId,
    project_name: target.projectId,
    public_hostname_disposition: 'external-dns-acm',
    state_backend_key: lane.backendKey,
    state_scope: 'foundation',
  };
  const consumerContract = computeFoundationSourceContract({
    nonsecretInputs: {
      accountAlias: target.accountLabel,
      awsAccountId: target.accountId,
      awsRegion: target.region,
      deploymentEnvironment: target.environmentId,
      deploymentTargetKey: targetKey,
      projectName: target.projectId,
      publicHostnameDisposition: 'external-dns-acm',
      stateBackendKey: lane.backendKey,
      stateScope: 'foundation',
    },
    requirements: FOUNDATION_CONSUMER_REQUIREMENTS,
  });
  const repository = (kind: 'prover' | 'toolchain') => ({
    name: names[`${kind}Repository`],
    url: `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${names[`${kind}Repository`]}`,
  });
  const checkpoint = admitRootCheckpoint(
    {
      targetKey,
      root: 'foundation',
      sourceSha,
      execution: {
        kind: 'pipeline',
        executionId,
        pipelineName: lane.names.pipeline,
        planActionExecutionId: executionId,
        buildId: `${names.terraformPlanProject}:${executionId}`,
      },
      backend: {
        bucketName: names.terraformStateBucket,
        backendKey: lane.backendKey,
        kmsKeyArn: `arn:aws:kms:${target.region}:${target.accountId}:key/11111111-1111-1111-1111-111111111111`,
        region: target.region,
      },
      planPackage: {
        key: `deployment/${targetKey}/foundation/plan-packages/${executionId}.json`,
        versionId: 'plan-version',
        sha256: 'a'.repeat(64),
      },
      acceptedAt: '2026-10-11T00:00:00.000Z',
      recipe: {
        runtime: PLAN_TERRAFORM_RUNTIME,
        providerLock:
          '# This file is maintained automatically by "terraform init".\n# Manual edits may be lost in future updates.\n\nprovider "registry.terraform.io/hashicorp/aws" {\n  version = "6.70.0"\n  hashes = [\n    "h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",\n  ]\n}\n',
        nonsecretInputs: buildTerraformBaselineNonsecretInputs('foundation', {
          variables: Object.fromEntries(Object.entries(inputValues).map(([key, value]) => [key, { value }])),
        }),
        artifacts: [],
      },
      outputs: {
        consumerContract,
        networking: {
          vpcId: `vpc-${'1'.repeat(8)}`,
          proverSubnetIds: [`subnet-${'1'.repeat(8)}`, `subnet-${'2'.repeat(8)}`],
          proverSecurityGroupIds: [`sg-${'1'.repeat(8)}`],
          networkAuthority: 'foundation-owned',
          publicSubnetException:
            target.environmentId === 'develop'
              ? 'accepted-for-develop-prover-egress'
              : 'accepted-for-production-prover-egress',
        },
        imageAuthority: {
          repositories: { prover: repository('prover'), toolchain: repository('toolchain') },
          signingProfileName: signer.signingProfileName,
          signingProfileArn: signer.signingProfileArn,
          signingRepositoryFilters: [{ filter: names.proverRepository, filterType: 'WILDCARD_MATCH' }],
          tagMutability: 'IMMUTABLE',
          scanOnPush: true,
          proverSigningStatusRequired: 'COMPLETE',
          retentionPolicy: 'newest-five-images',
        },
      },
    },
    targetKey,
    'foundation',
  );
  const foundation = {
    checkpoint,
    reference: {
      key: deriveRootCheckpointKey(targetKey, 'foundation'),
      versionId: 'foundation-version',
      sha256: storedBytesSha256(canonicalRecordJson(checkpoint)),
    },
    etag: '"foundation"',
  };
  const base = {
    targetKey,
    sourceSha,
    executionId,
    metadataSha256: 'a'.repeat(64),
    imageTag: 'candidate',
    scan: { status: 'PASS', criticalHighCount: 0 },
  };
  const toolchainCandidate = admitImageCandidate(
    {
      ...base,
      kind: 'toolchain',
      approvalEvidenceId: `toolchain-build/${executionId}`,
      imageUri: `${repository('toolchain').url}@sha256:${'c'.repeat(64)}`,
      evidence: { risc0Version: '3.0.6', rustVersion: '1.99.0', rustToolchainTag: 'stable' },
    },
    targetKey,
  );
  function promotion<Candidate extends ReturnType<typeof admitImageCandidate>>(candidate: Candidate) {
    const kind = candidate.kind;
    const record = admitImagePromotion(
      {
        kind,
        targetKey,
        candidate: {
          key: candidateKey(candidate),
          versionId: `${kind}-candidate-version`,
          sha256: storedBytesSha256(canonicalRecordJson(candidate)),
        },
        sourceSha,
        selectionMode: 'build',
        executionId,
        candidateApprovalEvidenceId: `${kind}-candidate-selection/${executionId}`,
        promotionApprovalEvidenceId: `${kind}-promotion/${executionId}`,
        revalidation:
          kind === 'toolchain'
            ? { imageUri: candidate.imageUri, scan: candidate.scan }
            : {
                imageUri: candidate.imageUri,
                scan: candidate.scan,
                foundation: {
                  reference: foundation.reference,
                  consumerContractSha256: consumerContract.foundationContractHash,
                },
                toolchainImageUri: toolchainCandidate.imageUri,
                managedSigning: 'COMPLETE',
              },
      },
      targetKey,
      kind,
    );
    return {
      candidate,
      promotion: record,
      reference: {
        key: promotionKey(targetKey, kind),
        versionId: `${kind}-promotion-version`,
        sha256: storedBytesSha256(canonicalRecordJson(record)),
      },
      etag: `"${kind}"`,
    };
  }
  if (toolchainCandidate.kind !== 'toolchain') throw new Error('Wrong Toolchain fixture kind');
  const toolchain = promotion(toolchainCandidate);
  const proverCandidate = admitImageCandidate(
    {
      ...base,
      kind: 'prover',
      approvalEvidenceId: `prover-build/${executionId}`,
      imageUri: `${repository('prover').url}@sha256:${'d'.repeat(64)}`,
      evidence: {
        foundation: {
          reference: foundation.reference,
          consumerContractSha256: consumerContract.foundationContractHash,
        },
        toolchain: { promotion: toolchain.reference, imageUri: toolchainCandidate.imageUri },
        imageId: `0x${'e'.repeat(64)}`,
        methodVersion: 4,
        variant: 'default',
        zkvmContractHash: 'f'.repeat(64),
        failureMarkerContractSha256: 'a'.repeat(64),
        posture: 'PASS',
        failureMarker: 'PASS',
        managedSigning: 'COMPLETE',
      },
    },
    targetKey,
  );
  if (proverCandidate.kind !== 'prover') throw new Error('Wrong Prover fixture kind');
  return { selectedSourceSha: sourceSha, foundation, toolchain, prover: promotion(proverCandidate) };
}

export function createAppExecutionAuthorityFixture(targetKey = 'stark-dev/develop') {
  const selection = createAppReleaseSelectionFixture(targetKey);
  const app = resolveDeploymentLaneAuthority(resolveAllowedDeploymentTarget(targetKey), 'app');
  const release = selection.prover.candidate;
  return projectNormalAppExecutionAuthority(
    {
      controlSourceSha: selection.selectedSourceSha,
      selectedApplicationSourceSha: selection.selectedSourceSha,
      releaseSelection: selection,
      verifier: {
        confirmedImageIdMapping: {
          proverReleaseKey: selection.prover.reference.key,
          proverImageDigest: release.imageUri.split('@')[1],
          expectedImageId: release.evidence.imageId,
          methodVersion: release.evidence.methodVersion,
          imageIdVariant: release.evidence.variant,
          imageIdMappingSha256: '4'.repeat(64),
          zkvmContractHash: release.evidence.zkvmContractHash,
        },
        signaturePreflight: {
          result: 'passed',
          selectedApplicationSourceSha: selection.selectedSourceSha,
          proverReleaseKey: selection.prover.reference.key,
          proverImageUri: release.imageUri,
          managedSigningStatus: 'COMPLETE',
          evidence: { key: 'signature-preflight/result.json', versionId: 'preflight-version', sha256: '1'.repeat(64) },
          verifierIdentitySha256: '2'.repeat(64),
          verifierPackage: {
            bucket: app.names.appRetainedArtifactBucket,
            key: `${app.names.lambdaArtifactPrefix}/${selection.selectedSourceSha}/image-signature-verifier.zip`,
            versionId: 'verifier-package-version',
            sha256: '3'.repeat(64),
            sourceCodeHash: Buffer.from('3'.repeat(64), 'hex').toString('base64'),
            assetManifestSha256: '4'.repeat(64),
            trustRootSha256: '5'.repeat(64),
          },
        },
      },
    },
    targetKey,
  );
}
