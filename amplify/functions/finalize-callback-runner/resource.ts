import { defineFunction } from '@aws-amplify/backend';

export const finalizeCallbackRunner = defineFunction({
  name: 'finalize-callback-runner',
  entry: './handler.ts',
  timeoutSeconds: 60,
  memoryMB: 512,
  runtime: 24,
  bundling: {
    minify: true,
  },
});
