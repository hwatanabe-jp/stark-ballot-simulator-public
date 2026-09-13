import { deepFreeze } from './internal.js';

export const CURRENT_APP_STATUS_PIPELINE_ACTION = deepFreeze({
  category: 'Build',
  execution: 'required',
  inputArtifacts: ['SourceOutput'],
  operation: 'publish-current-status',
  outputArtifacts: [],
  predecessors: ['smoke-runtime-and-publish-acceptance'],
  primarySource: 'SourceOutput',
  provider: 'CodeBuild',
  stage: 'PublishCurrentStatus',
});
