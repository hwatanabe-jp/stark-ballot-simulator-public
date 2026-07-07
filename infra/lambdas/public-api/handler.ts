import { handle } from 'hono/aws-lambda';
import { createHonoApp } from '@stark-ballot/api/server';
import { ensureAwsRuntimeConfigReferencesLoaded } from '@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver';

const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
const honoHandler = handle(app);

export const handler: typeof honoHandler = async (...args) => {
  await ensureAwsRuntimeConfigReferencesLoaded('public_api');
  return await honoHandler(...args);
};
