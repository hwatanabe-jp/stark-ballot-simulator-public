import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import {
  deriveVitestAliases,
  deriveVitestProjectRecords,
  findRepositoryRoot,
  loadRepositoryWorkspaceMetadata,
} from './tooling/workspace/workspace-metadata.ts';

const repositoryRoot = findRepositoryRoot(import.meta.dirname);
const workspacePackages = loadRepositoryWorkspaceMetadata(repositoryRoot);
const projectRecords = deriveVitestProjectRecords(workspacePackages, repositoryRoot);
const resolverAliases = [...deriveVitestAliases(workspacePackages, repositoryRoot)];

const defaultExcludes = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.{idea,git,cache,output,temp}/**',
  '**/.tmp/**',
  '**/*e2e*.test.ts',
  '**/*e2e*.test.tsx',
] as const;

export default defineConfig({
  root: repositoryRoot,
  plugins: [react()],
  resolve: {
    alias: resolverAliases,
  },
  test: {
    projects: projectRecords.map((project) => ({
      resolve: {
        alias: resolverAliases,
      },
      test: {
        name: project.name,
        root: repositoryRoot,
        environment: project.environment,
        globals: true,
        env: {
          STARK_BALLOT_VITEST_PROJECT: project.name,
        },
        setupFiles: [
          project.environment === 'jsdom' ? './tooling/vitest/setup-web.ts' : './tooling/vitest/setup-node.ts',
        ],
        include: project.roots.map((root) => `${root}/**/*.test.{ts,tsx}`),
        exclude: [...defaultExcludes],
      },
    })),
  },
});
