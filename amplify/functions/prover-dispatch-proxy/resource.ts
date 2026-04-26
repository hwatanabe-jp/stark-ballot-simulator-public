import { defineFunction } from '@aws-amplify/backend';

export const proverDispatchProxy = defineFunction({
  name: 'prover-dispatch-proxy',
  entry: './handler.ts',
  timeoutSeconds: 30,
  memoryMB: 512,
  runtime: 24,
  bundling: {
    minify: true,
  },
});
