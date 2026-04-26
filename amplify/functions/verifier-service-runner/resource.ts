import { defineFunction } from '@aws-amplify/backend';

export const verifierServiceRunner = defineFunction({
  name: 'verifier-service-runner',
  entry: './handler.ts',
  timeoutSeconds: 900,
  memoryMB: 2048,
  runtime: 24,
  bundling: {
    minify: true,
  },
});
