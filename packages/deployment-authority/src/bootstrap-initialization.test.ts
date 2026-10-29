import { describe, expect, it } from 'vitest';
import { admitBootstrapConstructionPlan, BOOTSTRAP_BACKEND_RESOURCES } from './bootstrap-initialization.js';
const target = 'stark-dev/develop';
function plan(address: string, actions: string[]) {
  return { complete: true, errored: false, resource_changes: [{ address, mode: 'managed', change: { actions } }] };
}
describe('explicit initial construction', () => {
  it.each(BOOTSTRAP_BACKEND_RESOURCES)('allows first creation of backend resource %s', (address) => {
    expect(admitBootstrapConstructionPlan(plan(address, ['create']), 'backend', target).actionCounts.create).toBe(1);
  });
  it('does not expand backend creation into ordinary control-plane resources', () => {
    expect(() => admitBootstrapConstructionPlan(plan('aws_iam_role.other', ['create']), 'backend', target)).toThrow(
      'only create',
    );
  });
  it.each([{ actions: ['delete'] }, { actions: ['delete', 'create'] }, { actions: ['create', 'delete'] }])(
    'rejects destructive initialization action %j',
    ({ actions }) => {
      expect(() =>
        admitBootstrapConstructionPlan(plan('aws_iam_role.other', actions), 'control-plane', target),
      ).toThrow('delete or replace');
    },
  );
  it('only lets the second phase update resources created by the backend phase', () => {
    expect(
      admitBootstrapConstructionPlan(plan('aws_s3_bucket_policy.state', ['update']), 'control-plane', target)
        .actionCounts.update,
    ).toBe(1);
    expect(() =>
      admitBootstrapConstructionPlan(plan('aws_iam_role.other', ['update']), 'control-plane', target),
    ).toThrow('newly created');
  });
  it('rejects a failed or incomplete plan', () => {
    expect(() =>
      admitBootstrapConstructionPlan(
        { ...plan('aws_s3_bucket.state', ['create']), complete: false },
        'backend',
        target,
      ),
    ).toThrow('incomplete');
  });
});
