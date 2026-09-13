import { describe, expect, it } from 'vitest';
import { classifyFoundationBootstrapImpact } from './foundation-bootstrap-impact.js';

function changedAddress(address: string) {
  return {
    address,
    actionClasses: ['update'],
    changedAttributes: ['policy'],
    replacementAttributes: [],
    sensitiveAttributes: [],
    unknownAttributes: [],
  };
}

function classify(addresses: string[], outputNames: string[] = []) {
  return classifyFoundationBootstrapImpact({
    changedAddresses: addresses.map(changedAddress),
    outputChanges: {
      count: outputNames.length,
      names: outputNames,
      omittedNameCount: 0,
    },
  });
}

describe('Foundation Bootstrap impact classification', () => {
  it('selects exact stable Foundation resource and output authority', () => {
    expect(
      classify(
        [
          'aws_codeconnections_connection.source[0]',
          'aws_codebuild_project.foundation_terraform_plan[0]',
          'aws_codebuild_project.app_deployment_status_publisher[0]',
          'aws_iam_role.foundation_terraform_acceptance_publisher[0]',
          'aws_iam_policy.terraform_drift_coordinator_guardrail["requestShape"]',
          'aws_iam_role_policy_attachment.source_path_start_build_guardrail["foundation"]',
          'data.aws_iam_policy_document.saved_plan_approval_apply_read["foundation_terraform"]',
          'aws_s3_bucket.state',
          'module.foundation_pipeline_codebuild_log_groups.aws_cloudwatch_log_group.codebuild["redacted"]',
        ],
        ['development_foundation_pipeline_name', 'terraform_authority_bucket_name'],
      ),
    ).toEqual({
      changedAddresses: [
        'aws_codebuild_project.app_deployment_status_publisher[0]',
        'aws_codebuild_project.foundation_terraform_plan[0]',
        'aws_codeconnections_connection.source[0]',
        'aws_iam_policy.terraform_drift_coordinator_guardrail["requestShape"]',
        'aws_iam_role.foundation_terraform_acceptance_publisher[0]',
        'aws_iam_role_policy_attachment.source_path_start_build_guardrail["foundation"]',
        'aws_s3_bucket.state',
        'data.aws_iam_policy_document.saved_plan_approval_apply_read["foundation_terraform"]',
        'module.foundation_pipeline_codebuild_log_groups.aws_cloudwatch_log_group.codebuild["redacted"]',
      ],
      changedOutputNames: ['development_foundation_pipeline_name', 'terraform_authority_bucket_name'],
      impactType: 'foundation-bootstrap-impact',
    });
  });

  it('leaves App lane and coordinator cleanup outside the stable contract', () => {
    expect(
      classify(
        [
          'aws_codebuild_project.app_validate[0]',
          'aws_codebuild_project.app_signature_state_refresh_plan[0]',
          'aws_codebuild_project.terraform_drift_coordinator[0]',
          'aws_scheduler_schedule.terraform_drift_weekly[0]',
          'aws_sqs_queue.terraform_drift_missed[0]',
          'data.aws_iam_policy_document.app_deployment_status_publisher_assume_role[0]',
        ],
        ['terraform_drift_report_prefix'],
      ),
    ).toEqual({
      changedAddresses: [],
      changedOutputNames: [],
      impactType: 'foundation-bootstrap-impact',
    });
  });

  it('fails closed on omitted, duplicate, accessor, and unreviewed shapes', () => {
    const omitted = {
      changedAddresses: [],
      outputChanges: { count: 1, names: [], omittedNameCount: 1 },
    };
    expect(() => classifyFoundationBootstrapImpact(omitted)).toThrow(/cannot omit/u);

    const duplicate = {
      changedAddresses: [changedAddress('aws_s3_bucket.state'), changedAddress('aws_s3_bucket.state')],
      outputChanges: { count: 0, names: [], omittedNameCount: 0 },
    };
    expect(() => classifyFoundationBootstrapImpact(duplicate)).toThrow(/duplicate/u);

    const accessor = {
      outputChanges: { count: 0, names: [], omittedNameCount: 0 },
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'changedAddresses', { enumerable: true, get: () => [] });
    expect(() => classifyFoundationBootstrapImpact(accessor)).toThrow(/exact current shape/u);

    expect(() =>
      classifyFoundationBootstrapImpact({
        changedAddresses: [{ ...changedAddress('aws_s3_bucket.state'), actionClasses: ['future'] }],
        outputChanges: { count: 0, names: [], omittedNameCount: 0 },
      }),
    ).toThrow(/action class/u);
  });
});
