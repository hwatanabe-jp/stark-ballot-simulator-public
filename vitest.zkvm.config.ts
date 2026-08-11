import { defineConfig } from 'vitest/config';
import {
  deriveVitestAliases,
  findRepositoryRoot,
  loadRepositoryWorkspaceMetadata,
} from './tooling/workspace/workspace-metadata.ts';

const repositoryRoot = findRepositoryRoot(import.meta.dirname);
const workspacePackages = loadRepositoryWorkspaceMetadata(repositoryRoot);

export default defineConfig({
  root: repositoryRoot,
  resolve: {
    alias: [...deriveVitestAliases(workspacePackages, repositoryRoot)],
  },
  test: {
    name: 'explicit:zkvm',
    environment: 'node',
    globals: true,
    env: {
      STARK_BALLOT_VITEST_PROJECT: 'explicit:zkvm',
    },
    setupFiles: ['./tooling/vitest/setup-node.ts'],
    include: ['packages/node-adapters/src/zkvm/e2e-zkvm.test.ts'],
  },
});
