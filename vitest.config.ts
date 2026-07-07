import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

function verificationAlias(moduleName: string, target: string): { find: RegExp; replacement: string } {
  return {
    find: new RegExp(`^@stark-ballot/verification/${moduleName}$`),
    replacement: path.resolve(__dirname, './packages/verification/src', target),
  };
}

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
  verificationAlias('public-audit-artifact-consistency', './verification/public-audit-artifact-consistency.ts'),
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

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/.tmp/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      '**/*e2e*.test.ts',
      '**/*e2e*.test.tsx',
      '**/tests/e2e/**',
      '**/*.spec.ts',
      '**/*.spec.tsx',
    ],
  },
  resolve: {
    alias: [
      {
        find: /^@stark-ballot\/api\/server$/,
        replacement: path.resolve(__dirname, './apps/api/src/server/index.ts'),
      },
      { find: '@stark-ballot/api-contract', replacement: path.resolve(__dirname, './packages/api-contract/src') },
      { find: '@stark-ballot/application', replacement: path.resolve(__dirname, './packages/application/src') },
      { find: '@stark-ballot/aws-adapters', replacement: path.resolve(__dirname, './packages/aws-adapters/src') },
      { find: '@stark-ballot/diagnostics', replacement: path.resolve(__dirname, './packages/diagnostics/src') },
      { find: '@stark-ballot/domain/bot', replacement: path.resolve(__dirname, './packages/domain/src/lib/bot') },
      {
        find: '@stark-ballot/domain/bulletin',
        replacement: path.resolve(__dirname, './packages/domain/src/lib/bulletin'),
      },
      { find: '@stark-ballot/domain/constants', replacement: path.resolve(__dirname, './packages/domain/src/shared') },
      {
        find: '@stark-ballot/domain/contract',
        replacement: path.resolve(__dirname, './packages/domain/src/lib/contract'),
      },
      { find: '@stark-ballot/domain/crypto', replacement: path.resolve(__dirname, './packages/domain/src/lib/crypto') },
      {
        find: '@stark-ballot/domain/finalize',
        replacement: path.resolve(__dirname, './packages/domain/src/lib/finalize'),
      },
      { find: '@stark-ballot/domain/http', replacement: path.resolve(__dirname, './packages/domain/src/lib/http') },
      {
        find: '@stark-ballot/domain/performance',
        replacement: path.resolve(__dirname, './packages/domain/src/lib/performance'),
      },
      {
        find: '@stark-ballot/domain/scenarios',
        replacement: path.resolve(__dirname, './packages/domain/src/lib/scenarios'),
      },
      {
        find: '@stark-ballot/domain/security',
        replacement: path.resolve(__dirname, './packages/domain/src/lib/security'),
      },
      {
        find: '@stark-ballot/domain/session',
        replacement: path.resolve(__dirname, './packages/domain/src/lib/session'),
      },
      { find: '@stark-ballot/domain/shared', replacement: path.resolve(__dirname, './packages/domain/src/shared') },
      { find: '@stark-ballot/domain/types', replacement: path.resolve(__dirname, './packages/domain/src/types') },
      { find: '@stark-ballot/domain/utils', replacement: path.resolve(__dirname, './packages/domain/src/lib/utils') },
      { find: '@stark-ballot/domain/vote', replacement: path.resolve(__dirname, './packages/domain/src/lib/vote') },
      { find: '@stark-ballot/domain', replacement: path.resolve(__dirname, './packages/domain/src') },
      { find: '@stark-ballot/merkle', replacement: path.resolve(__dirname, './packages/merkle/src') },
      { find: '@stark-ballot/node-adapters', replacement: path.resolve(__dirname, './packages/node-adapters/src') },
      { find: '@stark-ballot/runtime-config', replacement: path.resolve(__dirname, './packages/runtime-config/src') },
      { find: '@stark-ballot/test-support', replacement: path.resolve(__dirname, './packages/test-support/src') },
      { find: '@stark-ballot/validation', replacement: path.resolve(__dirname, './packages/validation/src') },
      ...verificationExplicitAliases,
      { find: '@stark-ballot/verification', replacement: path.resolve(__dirname, './packages/verification/src') },
      { find: '@stark-ballot/web', replacement: path.resolve(__dirname, './apps/web/src') },
      { find: '@stark-ballot/zkvm-contract', replacement: path.resolve(__dirname, './packages/zkvm-contract/src') },
    ],
  },
});
