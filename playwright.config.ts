import { defineConfig, devices } from '@playwright/test';

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
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
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
    baseURL: 'http://localhost:3000',

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
    // Dynamic command based on zkVM mode
    command: (() => {
      const useMockZkVM = process.env.USE_REAL_ZKVM !== 'true' && process.env.USE_MOCK_ZKVM !== 'false';

      if (useMockZkVM) {
        // Use test server script for Mock zkVM
        // Script exports env vars BEFORE Next.js starts, overriding .env.local
        return 'bash ./scripts/start-test-server.sh';
      } else {
        // Real zkVM mode: pass env vars directly in command
        const devMode = process.env.RISC0_DEV_MODE === '1';
        const envVars = ['USE_MOCK_ZKVM=false', 'USE_MOCK_STORE=false'];

        if (devMode) {
          envVars.push('RISC0_DEV_MODE=1');
        }

        const envString = envVars.join(' ');
        return `${envString} pnpm build && pnpm start`;
      }
    })(),
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore', // Changed back to 'ignore' after diagnostics
    stderr: 'pipe',
    timeout: 180 * 1000, // 3 minutes timeout for build + start
  },

  /* Test timeout based on zkVM mode */
  timeout: (() => {
    const isRealZkVM = process.env.USE_REAL_ZKVM === 'true' || process.env.USE_MOCK_ZKVM === 'false';
    const isProductionMode = isRealZkVM && process.env.RISC0_DEV_MODE !== '1';

    if (isProductionMode) {
      return 420 * 1000; // 420 seconds (7 minutes) for production STARK proofs - Phase 8: ~366s for 64 votes
    } else if (isRealZkVM) {
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
