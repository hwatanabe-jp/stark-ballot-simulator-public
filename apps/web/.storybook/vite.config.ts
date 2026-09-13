import path from 'node:path';
import { deriveViteAliases, loadRepositoryWorkspaceMetadata } from '../../../tooling/workspace/workspace-metadata.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

export default {
  resolve: {
    alias: deriveViteAliases(loadRepositoryWorkspaceMetadata(repositoryRoot), repositoryRoot),
  },
  css: { postcss: repositoryRoot },
  server: { watch: { ignored: ['**/.tmp/**'] } },
  plugins: [
    {
      name: 'storybook-preview-size-budget',
      // Run after the builder supplies its defaults. Storybook's prebundled runtime
      // dominates the 1.12 MB entry; the application's 500 kB budget stays separate.
      config: () => ({ build: { chunkSizeWarningLimit: 1200 } }),
    },
  ],
};
