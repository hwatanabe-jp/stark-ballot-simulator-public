import { test, expect } from '@playwright/test';
import { HomePage, VotePage, AggregatePage, ResultPage, VerifyPage } from './pages';
import {
  TEST_SCENARIOS,
  validateVerificationResult,
  measurePerformance,
  generateTestReport,
} from './helpers/test-helpers';
import type { VerificationCheckId, VerificationStepId } from './pages';

// Test configuration
const USE_REAL_ZKVM = process.env.USE_REAL_ZKVM === 'true';
const IS_PRODUCTION_MODE = USE_REAL_ZKVM && process.env.RISC0_DEV_MODE !== '1';
const IS_CI = process.env.CI === 'true';
const isRecordValue = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

// Increase timeout based on zkVM mode
if (IS_PRODUCTION_MODE) {
  test.setTimeout(180000); // 3 minutes per test for production STARK
} else if (USE_REAL_ZKVM) {
  test.setTimeout(120000); // 2 minutes for dev mode
} else {
  test.setTimeout(90000); // 1.5 minutes for mock mode
}

test.describe('STARK Ballot Simulator E2E Voting Flow', () => {
  let homePage: HomePage;
  let votePage: VotePage;
  let aggregatePage: AggregatePage;
  let resultPage: ResultPage;
  let verifyPage: VerifyPage;
  const testResults: Array<{ scenario: string; passed: boolean; duration: number; errors?: string[] }> = [];

  test.beforeEach(async ({ page, context }) => {
    // Initialize page objects
    homePage = new HomePage(page);
    votePage = new VotePage(page);
    aggregatePage = new AggregatePage(page);
    resultPage = new ResultPage(page);
    verifyPage = new VerifyPage(page);

    // Mock zkVM uses random bot votes (production-like behavior)
    // E2E tests validate total vote count (sum = 64) instead of exact distribution
    if (!USE_REAL_ZKVM) {
      console.log('[E2E] Using Mock zkVM with random bot votes');
    }

    // Set testMode at context level (applies to all pages in this context)
    await context.addInitScript(() => {
      localStorage.setItem('testMode', 'true');
      (globalThis as { __STH_SOURCES?: string[] }).__STH_SOURCES = ['/api/sth', '/api/sth?auditor=b'];
    });

    // Also set via page.addInitScript for redundancy
    await page.addInitScript(() => {
      localStorage.setItem('testMode', 'true');
      (globalThis as { __STH_SOURCES?: string[] }).__STH_SOURCES = ['/api/sth', '/api/sth?auditor=b'];
    });

    // Start fresh with no localStorage
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      // Clear all rate limiting data to ensure tests can run
      localStorage.removeItem('zkVmExecutions');
      localStorage.removeItem('starkBallotSession');
      // Ensure testMode is set (redundant but safe)
      localStorage.setItem('testMode', 'true');
    });

    // Capture browser console logs
    page.on('console', (msg) => console.log(`[browser] ${msg.type()} ${msg.text()}`));
  });

  test.afterAll(() => {
    // Generate and display test report
    if (testResults.length > 0) {
      const report = generateTestReport(testResults);
      console.log(report);
    }
  });

  // Run test for each scenario
  for (const scenario of TEST_SCENARIOS) {
    const testName = `${scenario.name}${scenario.smoke ? ' @smoke' : ''}`;
    test(testName, async ({ page }) => {
      test.skip(IS_CI && !scenario.smoke, 'Non-smoke scenarios are skipped in CI');
      const testStart = Date.now();
      const errors: string[] = [];

      try {
        console.log(`\n🧪 Testing: ${scenario.name}`);

        // Step 1: Start from home page
        await test.step('Navigate to home page and start', async () => {
          await homePage.goto('/');
          await homePage.waitForPageReady();

          // Verify we're on the home page
          const title = await homePage.getPageTitle();
          expect(title).toContain('STARK Ballot Simulator');

          // Click start button (this should call /api/session and save sessionId)
          console.log('  Clicking Start button...');
          await homePage.clickStart();

          // Try to wait for session to be created
          try {
            await page.waitForFunction(
              () => {
                const sessionData = localStorage.getItem('starkBallotSession');
                if (!sessionData) return false;
                try {
                  const isRecordValue = (value: unknown): value is Record<string, unknown> =>
                    typeof value === 'object' && value !== null;
                  const parsed: unknown = JSON.parse(sessionData);
                  if (!isRecordValue(parsed)) return false;
                  const sessionId = parsed.sessionId;
                  return typeof sessionId === 'string' && sessionId.length > 0;
                } catch {
                  return false;
                }
              },
              { timeout: 3000 },
            );

            const sessionData = await page.evaluate(() => {
              const data = localStorage.getItem('starkBallotSession');
              if (!data) return null;
              const isRecordValue = (value: unknown): value is Record<string, unknown> =>
                typeof value === 'object' && value !== null;
              try {
                const parsed: unknown = JSON.parse(data);
                return isRecordValue(parsed) ? parsed : null;
              } catch {
                return null;
              }
            });
            const sessionRecord = isRecordValue(sessionData) ? sessionData : null;
            const sessionId = typeof sessionRecord?.sessionId === 'string' ? sessionRecord.sessionId : 'unknown';
            console.log(`  ✓ Session created: ${sessionId}`);
          } catch {
            console.log('  ⚠️ Session not found in localStorage, checking page state...');

            // Check if we're on the vote page anyway
            const currentUrl = page.url();
            console.log(`  Current URL: ${currentUrl}`);

            // Check all localStorage contents
            const localStorageData = await page.evaluate(() => {
              const data: Record<string, string | null> = {};
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key) {
                  data[key] = localStorage.getItem(key);
                }
              }
              return data;
            });
            console.log('  All localStorage:', JSON.stringify(localStorageData, null, 2));
          }
        });

        // Step 2: Submit vote
        await test.step(`Submit vote for choice ${scenario.userChoice}`, async () => {
          // Verify we're on the vote page
          expect(page.url()).toContain('/vote');

          // Log API requests
          page.on('request', (request) => {
            if (request.url().includes('/api/')) {
              console.log(`  → API Request: ${request.method()} ${request.url()}`);
            }
          });

          page.on('response', (response) => {
            if (response.url().includes('/api/')) {
              console.log(`  ← API Response: ${response.status()} ${response.url()}`);
            }
          });

          // Select choice
          await votePage.selectChoice(scenario.userChoice);

          // Verify selection
          const selected = await votePage.getSelectedChoice();
          expect(selected).toBe(scenario.userChoice);

          // Submit vote
          await votePage.submitVote();

          // Wait for navigation to complete (either to #waiting or error)
          await page.waitForLoadState('networkidle');

          // Give a moment for localStorage to be updated
          await page.waitForTimeout(1000);

          // Debug localStorage contents
          const localStorageData = await page.evaluate(() => {
            const sessionData = localStorage.getItem('starkBallotSession');
            if (sessionData) {
              try {
                const isRecordValue = (value: unknown): value is Record<string, unknown> =>
                  typeof value === 'object' && value !== null;
                const parsed: unknown = JSON.parse(sessionData);
                return isRecordValue(parsed) ? parsed : null;
              } catch {
                return null;
              }
            }
            return null;
          });
          console.log('  Session data after vote:', JSON.stringify(localStorageData, null, 2));

          // Store vote data for verification - read directly without waiting
          const commitment = await votePage.getVoteCommitment();
          console.log(
            `  ✓ Vote submitted: ${scenario.userChoice} (commitment: ${commitment ? commitment.slice(0, 8) + '...' : 'N/A'})`,
          );
        });

        // Step 3: Wait for bot voting
        await test.step('Wait for bot voting to complete', async () => {
          const currentUrl = page.url();
          console.log(`  Current URL: ${currentUrl}`);

          // Check if we're on the waiting page
          if (currentUrl.includes('#waiting') || currentUrl.includes('/vote')) {
            console.log('  ⏳ Waiting for bot voting...');

            // Wait for bot voting to complete and auto-navigation
            await votePage.waitForBotVotingComplete();
            console.log('  ✓ Bot voting complete, navigated to aggregate page');
          } else if (currentUrl.includes('/aggregate')) {
            console.log('  ✓ Already on aggregate page');
          } else {
            console.log('  ⚠️ Unexpected page state, navigating to aggregate');
            await page.goto('/aggregate');
          }

          // Ensure we're on the aggregate page
          await page.waitForLoadState('domcontentloaded');
          expect(page.url()).toContain('/aggregate');
        });

        // Step 4: Apply tamper scenario and run aggregation
        await test.step('Apply tamper scenario and run aggregation', async () => {
          // Verify we're on the aggregate page
          expect(page.url()).toContain('/aggregate');
          await aggregatePage.waitForPageReady();

          // localStorage の状態を確認（デバッグ用）
          const storage = await page.evaluate(() => ({
            origin: window.location.origin,
            testMode: localStorage.getItem('testMode'),
            session: localStorage.getItem('starkBallotSession'),
          }));
          console.log('[E2E] Before aggregation:', storage);

          // Select tamper scenario (single-select radio)
          await aggregatePage.selectScenario(scenario.scenarioId);
          console.log(`  ✓ Tamper scenario selected: ${scenario.scenarioId}`);

          // Run aggregation with zkVM
          console.log(
            `  ⏳ Running zkVM (${USE_REAL_ZKVM ? (IS_PRODUCTION_MODE ? 'production STARK' : 'dev mode') : 'mock'})...`,
          );
          const zkStart = Date.now();
          await aggregatePage.runAggregation();
          const zkDuration = Date.now() - zkStart;
          console.log(`  ✓ zkVM execution complete (${(zkDuration / 1000).toFixed(1)}s)`);
        });

        // Step 5: Check result page and start verification
        await test.step('Check results and start verification', async () => {
          expect(page.url()).toContain('/result');
          await resultPage.waitForPageReady();

          const tallyCounts = await resultPage.getTallyCounts();
          const totalVotes = await resultPage.getTotalVotes();
          const tallySum = tallyCounts.reduce((sum, count) => sum + count, 0);

          console.log('\n  📊 Result Summary:');
          console.log(`    - Tally: [${tallyCounts.join(', ')}]`);
          console.log(`    - Total votes (UI): ${totalVotes}`);
          console.log(`    - Total votes (sum): ${tallySum}`);

          expect(totalVotes).toBeGreaterThan(0);
          expect(tallySum).toBe(totalVotes);

          await resultPage.startVerification();
        });

        // Step 6: Verify results
        await test.step('Verify results', async () => {
          expect(page.url()).toContain('/verify');
          const trackedCheckIds = Object.keys(scenario.expectedCheckStatuses) as VerificationCheckId[];
          const trackedStepIds = Object.keys(scenario.expectedStepStatuses ?? {}) as VerificationStepId[];
          await verifyPage.waitForVerificationComplete(trackedCheckIds);

          const result = await verifyPage.getVerificationResult(trackedCheckIds, trackedStepIds);
          console.log('\n  📊 Verification Results:');
          console.log(`    - Summary visible: ${result.summaryVisible ? '✅' : '❌'}`);
          for (const [checkId, status] of Object.entries(result.checkStatuses)) {
            console.log(`    - ${checkId}: ${status ?? 'unknown'}`);
          }
          for (const [stepId, status] of Object.entries(result.stepStatuses)) {
            console.log(`    - ${stepId}: ${status ?? 'unknown'}`);
          }

          const validation = validateVerificationResult(result, scenario);

          if (!validation.passed) {
            errors.push(...validation.errors);
            console.log('\n  ❌ Validation errors:');
            validation.errors.forEach((e) => console.log(`    - ${e}`));
          } else {
            console.log('\n  ✅ All validations passed');
          }

          expect(validation.passed).toBe(true);
        });

        // Record test result
        testResults.push({
          scenario: scenario.name,
          passed: errors.length === 0,
          duration: Date.now() - testStart,
          errors: errors.length > 0 ? errors : undefined,
        });
      } catch (error) {
        // Record failure
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push(errorMessage);
        testResults.push({
          scenario: scenario.name,
          passed: false,
          duration: Date.now() - testStart,
          errors: [errorMessage],
        });

        // Take screenshot on failure
        await page.screenshot({
          path: `test-results/failure-${scenario.name.replace(/[^a-zA-Z0-9]/g, '-')}.png`,
          fullPage: true,
        });

        throw error;
      }
    });
  }

  // Performance benchmark test
  test('Performance Benchmark', async ({ page }) => {
    test.skip(IS_CI, 'Skip performance benchmark in CI environments');

    console.log('\n⚡ Performance Benchmark');
    console.log('========================');

    const benchmarkResults = {
      pageLoads: {} as Record<string, number>,
      operations: {} as Record<string, number>,
      zkvm: {} as Record<string, number>,
    };

    // Measure page load times
    await measurePerformance('Home Page Load', async () => {
      await homePage.goto('/');
      await homePage.waitForPageReady();
      return null;
    }).then(({ duration }) => {
      benchmarkResults.pageLoads['home'] = duration;
    });

    // Start voting flow
    await homePage.clickStart();

    // Measure vote submission
    await measurePerformance('Vote Submission', async () => {
      await votePage.selectChoice('A');
      await votePage.submitVote();
      return null;
    }).then(({ duration }) => {
      benchmarkResults.operations['voteSubmission'] = duration;
    });

    // Wait for bot voting
    const botStart = Date.now();
    try {
      await votePage.waitForBotVotingComplete();
      benchmarkResults.operations['botVoting'] = Date.now() - botStart;
    } catch {
      console.log('  ⚠️ Bot voting wait timed out in benchmark');
      await page.goto('/aggregate');
      benchmarkResults.operations['botVoting'] = Date.now() - botStart;
    }

    // Measure zkVM execution
    await aggregatePage.waitForPageReady();
    await aggregatePage.selectScenario('S0');
    const zkStart = Date.now();
    await aggregatePage.runAggregation();
    benchmarkResults.zkvm[USE_REAL_ZKVM ? (IS_PRODUCTION_MODE ? 'production' : 'dev') : 'mock'] = Date.now() - zkStart;

    // Display benchmark results
    console.log('\n📊 Benchmark Results:');
    console.log('Page Loads:', benchmarkResults.pageLoads);
    console.log('Operations:', benchmarkResults.operations);
    console.log('zkVM:', benchmarkResults.zkvm);

    // Assert performance thresholds
    const maxHomeLoadMs = IS_CI ? 8000 : 5000;
    const maxVoteSubmissionMs = IS_CI ? 7000 : 3000;
    expect(benchmarkResults.pageLoads.home).toBeLessThan(maxHomeLoadMs); // 5s local / 8s CI
    expect(benchmarkResults.operations.voteSubmission).toBeLessThan(maxVoteSubmissionMs); // 3s local / 7s CI

    if (!IS_PRODUCTION_MODE) {
      expect(benchmarkResults.zkvm[USE_REAL_ZKVM ? 'dev' : 'mock']).toBeLessThan(10000); // 10s for mock/dev
    }
  });
});
