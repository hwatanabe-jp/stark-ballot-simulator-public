import { defineConfig, devices } from '@playwright/test';
import { PLAYWRIGHT_RUNTIME_PROFILE } from './tests/e2e/runtime-profile';

const E2E_PORT = 3100;
const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

if (process.env['FORCE_COLOR'] && process.env['NO_COLOR']) {
  delete process.env['NO_COLOR'];
}

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// import dotenv from 'dotenv';
// import path from 'path';
// dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: process.env['PLAYWRIGHT_BENCHMARK'] === '1' ? [] : ['**/voting-performance.spec.ts'],
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env['CI'],
  /* Retry on CI only */
  retries: process.env['CI'] ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: 1,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ['html', { open: 'never' }], // Generate HTML report but don't auto-open
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: E2E_BASE_URL,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',

    /* Screenshot on failure */
    screenshot: 'only-on-failure',

    /* Video on failure */
    video: 'retain-on-failure',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },

    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run production build for tests - more stable than dev server */
  webServer: {
    // Dynamic command based on the single resolved runtime profile.
    command: (() => {
      if (PLAYWRIGHT_RUNTIME_PROFILE.proof.executor === 'mock') {
        // Use test server script for Mock zkVM
        // Script exports env vars before the static Hono/Vite test server starts, overriding .env.local
        return 'bash ./scripts/start-test-server.sh';
      }

      const profileEnv = [
        `RUNTIME_PROFILE=${PLAYWRIGHT_RUNTIME_PROFILE.name}`,
        `VITE_RUNTIME_PROFILE=${PLAYWRIGHT_RUNTIME_PROFILE.name}`,
      ].join(' ');
      return `${profileEnv} pnpm build && ${profileEnv} pnpm start`;
    })(),
    env: { PORT: String(E2E_PORT), VERIFIER_PUBLIC_BASE_URL: E2E_BASE_URL },
    url: E2E_BASE_URL,
    reuseExistingServer: false,
    stdout: 'ignore', // Changed back to 'ignore' after diagnostics
    stderr: 'pipe',
    timeout: 180 * 1000, // 3 minutes timeout for build + start
  },

  /* Test timeout based on zkVM mode */
  timeout: (() => {
    if (PLAYWRIGHT_RUNTIME_PROFILE.proof.evidence === 'production') {
      return 420 * 1000; // 420 seconds (7 minutes) for production STARK proofs; observed ~366s for 64 votes
    } else if (PLAYWRIGHT_RUNTIME_PROFILE.proof.evidence === 'development') {
      return 120 * 1000; // 120 seconds for dev mode
    } else {
      return 90 * 1000; // 90 seconds for mock mode
    }
  })(),

  /* Expect timeout */
  expect: {
    timeout: 15 * 1000, // 15 seconds for better reliability
  },
});
