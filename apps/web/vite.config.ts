import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';
import { deriveViteAliases, loadRepositoryWorkspaceMetadata } from '../../tooling/workspace/workspace-metadata.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const workspacePackages = loadRepositoryWorkspaceMetadata(repositoryRoot);
const workspaceAliases = deriveViteAliases(workspacePackages, repositoryRoot);
const mockApiSourceRoot = `${path.resolve(repositoryRoot, 'apps/web/src/mock-api').split(path.sep).join('/')}/`;

function isPackageModule(moduleId: string, packageNames: readonly string[]): boolean {
  const normalized = moduleId.split(path.sep).join('/');
  return packageNames.some(
    (packageName) =>
      normalized.includes(`/node_modules/${packageName}/`) ||
      normalized.includes(`/node_modules/.pnpm/${packageName.replace('/', '+')}@`),
  );
}

function normalizeModuleId(moduleId: string): string {
  return moduleId.split(path.sep).join('/').split('?')[0] ?? moduleId;
}

export default defineConfig(({ mode }) => {
  const isTargetBuild = mode === 'target';
  const configuredDeploymentId = process.env['VITE_DEPLOYMENT_ID'];
  const deploymentId =
    configuredDeploymentId && /^dep_[0-9a-f]{32}$/.test(configuredDeploymentId)
      ? configuredDeploymentId
      : 'local-unaccepted';

  return {
    plugins: [
      react(),
      {
        name: 'accepted-deployment-stamp',
        transformIndexHtml(html) {
          return html.replace('__STARK_BALLOT_DEPLOYMENT_ID__', deploymentId);
        },
      },
      {
        name: 'browser-mock-api-module-boundary',
        generateBundle(_options, bundle) {
          if (!isTargetBuild) {
            return;
          }
          const mockApiModuleIds = Object.values(bundle)
            .filter((output) => output.type === 'chunk')
            .flatMap((chunk) => chunk.moduleIds)
            .filter((moduleId) => normalizeModuleId(moduleId).startsWith(mockApiSourceRoot));
          if (mockApiModuleIds.length > 0) {
            throw new Error(`Target build must not include browser mock API module:\n${mockApiModuleIds.join('\n')}`);
          }
        },
      },
    ],
    resolve: {
      alias: [
        ...(isTargetBuild
          ? [
              {
                find: /^@stark-ballot\/web\/mock-api\/fetcher$/,
                replacement: path.resolve(repositoryRoot, 'apps/web/src/api/targetDisabledLocalApi.ts'),
              },
            ]
          : []),
        ...workspaceAliases,
      ],
    },
    server: {
      watch: {
        // Storybook builds and local export fixtures must not reset the demo.
        ignored: ['**/.tmp/**'],
      },
      forwardConsole: {
        unhandledErrors: true,
        logLevels: ['warn', 'error'],
      },
    },
    build: {
      sourcemap: false,
      rolldownOptions: {
        output: {
          strictExecutionOrder: true,
          codeSplitting: {
            groups: [
              {
                name: 'react-vendor',
                test: (moduleId) =>
                  isPackageModule(moduleId, [
                    'react',
                    'react-dom',
                    'react-router',
                    'scheduler',
                    'use-sync-external-store',
                  ]),
                priority: 3,
              },
              {
                name: 'ui-vendor',
                test: (moduleId) => isPackageModule(moduleId, ['@marsidev/react-turnstile', 'lucide-react']),
                priority: 2,
              },
              {
                name: 'vendor',
                test: /node_modules/,
                priority: 1,
                maxSize: 350 * 1024,
              },
            ],
          },
        },
      },
    },
  };
});
