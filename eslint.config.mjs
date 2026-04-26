import js from '@eslint/js';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import prettierConfig from 'eslint-config-prettier/flat';
import globals from 'globals';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import tseslint from 'typescript-eslint';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ignores = [
  '**/.amplify/**',
  '**/.cache/**',
  '**/.next/**',
  '**/.tmp/**',
  '**/.turbo/**',
  '**/amplify/**',
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
const serverConsoleFiles = [
  'src/server/**/*.{ts,tsx}',
  'src/lib/aws/**/*.ts',
  'src/lib/finalize/usecases/**/*.ts',
  'src/lib/finalize/finalization-queue.ts',
  'src/lib/finalize/proof-bundle-service.ts',
  'src/lib/zkvm/executor.ts',
  'src/lib/zkvm/executor-factory.ts',
  'src/lib/zkvm/input-builder.ts',
  'src/lib/store/amplifySessionStore.ts',
  'src/lib/store/storeInstance.ts',
  'src/lib/verification/verification-bundle.ts',
  'src/lib/verification/expected-image-id.ts',
  'src/lib/errors/errorPayload.ts',
];
const typeCheckedConfigs = tseslint.configs.recommendedTypeChecked.map((config) => ({
  ...config,
  files: tsFiles,
}));

const rulesCommon = {
  '@next/next/no-assign-module-variable': 'error',
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
  ...nextCoreWebVitals,
  ...typeCheckedConfigs,
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
