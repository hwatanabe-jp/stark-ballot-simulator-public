import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier/flat';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ignores = [
  '**/.amplify/**',
  '**/.cache/**',
  '**/.next/**',
  '**/.tmp/**',
  '**/.turbo/**',
  '**/amplify_outputs/**',
  '**/amplify_outputs.json',
  '**/coverage/**',
  '**/dist/**',
  '**/node_modules/**',
  '**/output/**',
  '**/playwright-report/**',
  '**/smoke-output/**',
  '**/target/**',
  '**/test-results/**',
  '**/tmp/**',
  '**/*.d.ts',
  '**/public-book/**',
];

const jsFiles = ['**/*.{js,jsx}'];
const tsFiles = ['**/*.{ts,tsx}'];
const nodeFiles = ['**/*.{js,cjs,mjs}'];
export const serverConsoleFiles = [
  'apps/api/src/server/**/*.{ts,tsx}',
  'packages/aws-adapters/src/aws/**/*.ts',
  'packages/application/src/finalize/usecases/**/*.ts',
  'packages/application/src/finalize/finalization-queue.ts',
  'packages/application/src/finalize/proof-bundle-service.ts',
  'packages/node-adapters/src/zkvm/executor.ts',
  'packages/node-adapters/src/zkvm/executor-factory.ts',
  'packages/application/src/zkvm-input/input-builder.ts',
  'packages/aws-adapters/src/store/storeInstance.ts',
  'packages/verification/src/verification/verification-bundle.ts',
  'packages/verification/src/verification/expected-image-id.ts',
  'packages/api-contract/src/errors/errorPayload.ts',
];
const typeCheckedConfigs = tseslint.configs.recommendedTypeChecked.map((config) => {
  const configWithoutPlugins = { ...config };
  delete configWithoutPlugins.plugins;
  return {
    ...configWithoutPlugins,
    files: tsFiles,
  };
});

const rulesCommon = {
  'import/no-anonymous-default-export': 'error',
  'no-case-declarations': 'error',
  'no-empty': 'error',
  'no-useless-escape': 'error',
  'react-hooks/exhaustive-deps': 'error',
  'react-hooks/globals': 'error',
  'react-hooks/purity': 'error',
  'react-hooks/set-state-in-effect': 'error',
  'react-hooks/static-components': 'error',
  'react/display-name': 'error',
};

const rulesTypeScriptExtra = {
  '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
  '@typescript-eslint/explicit-module-boundary-types': 'error',
  '@typescript-eslint/no-non-null-assertion': 'error',
  '@typescript-eslint/no-unnecessary-condition': 'error',
  '@typescript-eslint/no-unused-expressions': 'error',
  '@typescript-eslint/no-unused-vars': 'error',
  '@typescript-eslint/switch-exhaustiveness-check': 'error',
};

const eslintConfig = tseslint.config(
  { ignores },
  { linterOptions: { reportUnusedDisableDirectives: true } },
  js.configs.recommended,
  ...typeCheckedConfigs,
  {
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      import: importPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  {
    files: ['**/*.{jsx,tsx}'],
    rules: {
      ...reactPlugin.configs.flat.recommended.rules,
      ...reactPlugin.configs.flat['jsx-runtime'].rules,
      ...reactHooksPlugin.configs.recommended.rules,
    },
  },
  {
    files: jsFiles,
    rules: rulesCommon,
  },
  {
    files: tsFiles,
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      ...rulesCommon,
      ...rulesTypeScriptExtra,
    },
  },
  {
    files: nodeFiles,
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: serverConsoleFiles,
    ignores: ['**/*.test.*', '**/__tests__/**'],
    rules: {
      'no-console': 'error',
    },
  },
  prettierConfig,
);

export default eslintConfig;
