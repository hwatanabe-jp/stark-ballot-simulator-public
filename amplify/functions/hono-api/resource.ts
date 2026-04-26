import { defineFunction } from '@aws-amplify/backend';

export const honoApi = defineFunction({
  name: 'hono-api',
  entry: './handler.ts',
  timeoutSeconds: 60,
  memoryMB: 1024,
  runtime: 24,
  bundling: {
    minify: true,
  },
});
