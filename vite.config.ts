import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

function verificationAlias(moduleName: string, target: string): { find: RegExp; replacement: string } {
  return {
    find: new RegExp(`^@stark-ballot/verification/${moduleName}$`),
    replacement: path.resolve(__dirname, './packages/verification/src', target),
  };
}

function isPackageModule(moduleId: string, packageNames: readonly string[]): boolean {
  const normalized = moduleId.split(path.sep).join('/');
  return packageNames.some(
    (packageName) =>
      normalized.includes(`/node_modules/${packageName}/`) ||
      normalized.includes(`/node_modules/.pnpm/${packageName.replace('/', '+')}@`),
  );
}

export default defineConfig(({ mode }) => {
  const isTargetBuild = mode === 'target';
  const configuredDeploymentId = process.env['VITE_DEPLOYMENT_ID'];
  const deploymentId =
    configuredDeploymentId && /^dep_[0-9a-f]{32}$/.test(configuredDeploymentId)
      ? configuredDeploymentId
      : 'local-unaccepted';
  const webSrcDir = path.resolve(__dirname, './apps/web/src');
  const domainSrcDir = path.resolve(__dirname, './packages/domain/src');
  const applicationSrcDir = path.resolve(__dirname, './packages/application/src');
  const awsAdaptersSrcDir = path.resolve(__dirname, './packages/aws-adapters/src');
  const diagnosticsSrcDir = path.resolve(__dirname, './packages/diagnostics/src');
  const nodeAdaptersSrcDir = path.resolve(__dirname, './packages/node-adapters/src');
  const runtimeConfigSrcDir = path.resolve(__dirname, './packages/runtime-config/src');
  const apiContractSrcDir = path.resolve(__dirname, './packages/api-contract/src');
  const testSupportSrcDir = path.resolve(__dirname, './packages/test-support/src');
  const verificationSrcDir = path.resolve(__dirname, './packages/verification/src');
  const zkvmContractSrcDir = path.resolve(__dirname, './packages/zkvm-contract/src');
  const verificationExplicitAliases = [
    verificationAlias('bitmap-proof-types', './verification/bitmap-proof-types.ts'),
    verificationAlias('bitmap-root', './verification/bitmap-root.ts'),
    verificationAlias('bitmap-verifier', './verification/bitmap-verifier.ts'),
    verificationAlias('bundle', './verification/verification-bundle.ts'),
    verificationAlias('check-evaluator', './verification/engine/evaluate-checks.ts'),
    verificationAlias('check-results', './verification/build-verification-checks.ts'),
    verificationAlias('checks', './verification/verification-checks.ts'),
    verificationAlias('engine-types', './verification/engine/types.ts'),
    verificationAlias('excluded-count', './verification/excluded-count.ts'),
    verificationAlias('fail-closed-status', './verification/fail-closed-status.ts'),
    verificationAlias('image-id', './verification/expected-image-id.ts'),
    verificationAlias('image-id-policy', './verification/image-id-policy.js'),
    verificationAlias('image-id-types', './verification/image-id-types.ts'),
    verificationAlias('included-bitmap-artifact', './verification/included-bitmap-artifact.ts'),
    verificationAlias('merkle', './verification/merkle.ts'),
    verificationAlias('public-audit-artifacts', './verification/public-audit-artifacts.ts'),
    verificationAlias('public-input', './verification/public-input-contract.ts'),
    verificationAlias('public-result', './verification/public-verification-result.ts'),
    verificationAlias('receipt-normalizer', './verification/receipt-normalizer.ts'),
    verificationAlias('seen-bitmap-artifact', './verification/seen-bitmap-artifact.ts'),
    verificationAlias('stage-evaluators', './verification/engine/stage-evaluators.ts'),
    verificationAlias('stage-status', './verification/engine/derive-stages.ts'),
    verificationAlias('steps', './verification/build-verification-steps.ts'),
    verificationAlias('sth-verifier', './verification/sth-verifier.ts'),
    verificationAlias('summary', './verification/verification-summary.ts'),
    verificationAlias('tamper-detection', './verification/tamperDetection.ts'),
    verificationAlias('three-stage', './verification/three-stage.ts'),
    verificationAlias('types', './verification/types.ts'),
  ];

  return {
    plugins: [
      react(),
      {
        name: 'accepted-deployment-stamp',
        transformIndexHtml(html) {
          return html.replace('__STARK_BALLOT_DEPLOYMENT_ID__', deploymentId);
        },
      },
    ],
    resolve: {
      alias: [
        {
          find: /^@stark-ballot\/api\/server$/,
          replacement: path.resolve(__dirname, './apps/api/src/server/index.ts'),
        },
        ...(isTargetBuild
          ? [
              {
                find: /^@stark-ballot\/web\/mock-api\/config$/,
                replacement: path.resolve(webSrcDir, './api/targetDisabledLocalApiConfig.ts'),
              },
            ]
          : []),
        { find: '@stark-ballot/api-contract', replacement: apiContractSrcDir },
        { find: '@stark-ballot/application', replacement: applicationSrcDir },
        { find: '@stark-ballot/aws-adapters', replacement: awsAdaptersSrcDir },
        { find: '@stark-ballot/diagnostics', replacement: diagnosticsSrcDir },
        { find: '@stark-ballot/domain/bot', replacement: path.resolve(domainSrcDir, './lib/bot') },
        { find: '@stark-ballot/domain/bulletin', replacement: path.resolve(domainSrcDir, './lib/bulletin') },
        { find: '@stark-ballot/domain/constants', replacement: path.resolve(domainSrcDir, './shared') },
        { find: '@stark-ballot/domain/contract', replacement: path.resolve(domainSrcDir, './lib/contract') },
        { find: '@stark-ballot/domain/crypto', replacement: path.resolve(domainSrcDir, './lib/crypto') },
        { find: '@stark-ballot/domain/finalize', replacement: path.resolve(domainSrcDir, './lib/finalize') },
        { find: '@stark-ballot/domain/http', replacement: path.resolve(domainSrcDir, './lib/http') },
        { find: '@stark-ballot/domain/performance', replacement: path.resolve(domainSrcDir, './lib/performance') },
        { find: '@stark-ballot/domain/scenarios', replacement: path.resolve(domainSrcDir, './lib/scenarios') },
        { find: '@stark-ballot/domain/security', replacement: path.resolve(domainSrcDir, './lib/security') },
        { find: '@stark-ballot/domain/session', replacement: path.resolve(domainSrcDir, './lib/session') },
        { find: '@stark-ballot/domain/shared', replacement: path.resolve(domainSrcDir, './shared') },
        { find: '@stark-ballot/domain/types', replacement: path.resolve(domainSrcDir, './types') },
        { find: '@stark-ballot/domain/utils', replacement: path.resolve(domainSrcDir, './lib/utils') },
        { find: '@stark-ballot/domain/vote', replacement: path.resolve(domainSrcDir, './lib/vote') },
        { find: '@stark-ballot/domain', replacement: domainSrcDir },
        { find: '@stark-ballot/node-adapters', replacement: nodeAdaptersSrcDir },
        { find: '@stark-ballot/runtime-config', replacement: runtimeConfigSrcDir },
        { find: '@stark-ballot/test-support', replacement: testSupportSrcDir },
        ...verificationExplicitAliases,
        { find: '@stark-ballot/verification', replacement: verificationSrcDir },
        { find: '@stark-ballot/web', replacement: webSrcDir },
        { find: '@stark-ballot/zkvm-contract', replacement: zkvmContractSrcDir },
      ],
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
