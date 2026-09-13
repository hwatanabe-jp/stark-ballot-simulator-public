import type { StorybookConfig } from 'storybook/internal/types';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.tsx'],
  framework: {
    name: path.dirname(fileURLToPath(import.meta.resolve('@storybook/react-vite/package.json'))),
    options: {
      builder: {
        viteConfigPath: path.join(import.meta.dirname, 'vite.config.ts'),
        configLoader: 'native',
      },
    },
  },
  core: { disableTelemetry: true },
};

export default config;
