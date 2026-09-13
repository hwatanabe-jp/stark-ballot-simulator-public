import { test, expect } from '@playwright/test';
import { HomePage, VotePage, AggregatePage, ResultPage, VerifyPage } from './pages';
import { TEST_SCENARIOS, validateVerificationResult, generateTestReport } from './helpers/test-helpers';
import type { VerificationCheckId, VerificationStepId } from './pages';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { PLAYWRIGHT_RUNTIME_PROFILE } from './runtime-profile';

// Test configuration
const USES_RISC0_EXECUTOR = PLAYWRIGHT_RUNTIME_PROFILE.proof.executor === 'risc0';
const IS_PRODUCTION_MODE = PLAYWRIGHT_RUNTIME_PROFILE.proof.evidence === 'production';
const isRecordValue = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

test.describe('STARK Ballot Simulator E2E Voting Flow', () => {
  let homePage: HomePage;
  let votePage: VotePage;
  let aggregatePage: AggregatePage;
  let resultPage: ResultPage;
  let verifyPage: VerifyPage;
  const testResults: Array<{ scenario: string; passed: boolean; duration: number; errors?: string[] }> = [];

  test.beforeEach(({ page }) => {
    // Initialize page objects
    homePage = new HomePage(page);
    votePage = new VotePage(page);
    aggregatePage = new AggregatePage(page);
    resultPage = new ResultPage(page);
    verifyPage = new VerifyPage(page);

    // Mock zkVM uses random bot votes (production-like behavior)
    // E2E tests validate total vote count (sum = 64) instead of exact distribution
    if (!USES_RISC0_EXECUTOR) {
      console.log('[E2E] Using Mock zkVM with random bot votes');
    }

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
      const testStart = Date.now();
      const errors: string[] = [];

      try {
        console.log(`\nTesting: ${scenario.name}`);

        // Step 1: Start from home page
        await test.step('Navigate to home page and start', async () => {
          await homePage.goto('/');
          await homePage.waitForPageReady();

          // Click start button (this should call /api/sessions and save sessionId)
          console.log('  Clicking Start button...');
          await homePage.clickStart();

          await page.waitForFunction(
            () => {
              const sessionData = localStorage.getItem('starkBallotSession');
              if (!sessionData) return false;
              const isRecordValue = (value: unknown): value is Record<string, unknown> =>
                typeof value === 'object' && value !== null;
              try {
                const parsed: unknown = JSON.parse(sessionData);
                if (!isRecordValue(parsed)) return false;
                const sessionId = parsed['sessionId'];
                return typeof sessionId === 'string' && sessionId.length > 0;
              } catch {
                return false;
              }
            },
            undefined,
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
          const sessionId = sessionRecord?.['sessionId'];
          expect(sessionId).toEqual(expect.any(String));
          console.log(`  OK Session created: ${String(sessionId)}`);
        });

        // Step 2: Submit vote
        await test.step(`Submit vote for choice ${scenario.userChoice}`, async () => {
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

          // Submit vote
          await votePage.submitVote();

          await expect.poll(() => votePage.getVoteCommitment()).not.toBe('');
          const commitment = await votePage.getVoteCommitment();
          console.log(
            `  OK Vote submitted: ${scenario.userChoice} (commitment: ${commitment ? commitment.slice(0, 8) + '...' : 'N/A'})`,
          );
        });

        // Step 3: Wait for bot voting
        await test.step('Wait for bot voting to complete', async () => {
          await votePage.waitForBotVotingComplete();
        });

        // Step 4: Apply tamper scenario and run aggregation
        await test.step('Apply tamper scenario and run aggregation', async () => {
          await aggregatePage.waitForPageReady();

          // Select tamper scenario (single-select radio)
          await aggregatePage.selectScenario(scenario.scenarioId);
          console.log(`  OK Tamper scenario selected: ${scenario.scenarioId}`);

          // Run aggregation with zkVM
          console.log(
            `  Running zkVM (${USES_RISC0_EXECUTOR ? (IS_PRODUCTION_MODE ? 'production STARK' : 'dev mode') : 'mock'})...`,
          );
          const zkStart = Date.now();
          await aggregatePage.runAggregation();
          const zkDuration = Date.now() - zkStart;
          console.log(`  OK zkVM execution complete (${(zkDuration / 1000).toFixed(1)}s)`);
        });

        // Step 5: Check result page and start verification
        await test.step('Check results and start verification', async () => {
          await resultPage.waitForPageReady();

          const tallyCounts = await resultPage.getTallyCounts();
          const totalVotes = await resultPage.getTotalVotes();
          const tallySum = tallyCounts.reduce((sum, count) => sum + count, 0);

          console.log('\n  Result Summary:');
          console.log(`    - Tally: [${tallyCounts.join(', ')}]`);
          console.log(`    - Total votes (UI): ${totalVotes}`);
          console.log(`    - Total votes (sum): ${tallySum}`);

          expect(totalVotes).toBeGreaterThan(0);
          expect(tallySum).toBe(totalVotes);

          await resultPage.startVerification();
        });

        // Step 6: Verify results
        await test.step('Verify results', async () => {
          const trackedCheckIds = Object.keys(scenario.expectedCheckStatuses) as VerificationCheckId[];
          const trackedStepIds = Object.keys(scenario.expectedStepStatuses ?? {}) as VerificationStepId[];
          await verifyPage.waitForVerificationComplete(trackedCheckIds);

          if (scenario.scenarioId === 'S0') {
            const check = page.getByTestId('check-cast_commitment_match');
            await check.focus();
            await check.press('Enter');
            await expect(check).toHaveAttribute('aria-expanded', 'true');
            await expect(page.getByRole('complementary').locator('[data-key="user.commitment"]')).toBeVisible();
            const evidence = page.locator('#evidence-cast_commitment_match');
            await expect(evidence.locator('[data-key="user.commitment"] code')).toHaveText(/^0x[0-9a-f]{64}$/i);
            await expect(evidence.locator('[data-key="sessionId"]')).toHaveCount(0);
            await page.setViewportSize({ width: 320, height: 740 });
            await expect(check).toHaveAttribute('aria-expanded', 'true');
            await expect(check).toBeFocused();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            await check.press('Enter');
            await expect(evidence).toHaveCount(0);
          }

          const result = await verifyPage.getVerificationResult(trackedCheckIds, trackedStepIds);
          console.log('\n  Verification Results:');
          console.log(`    - Summary visible: ${result.summaryVisible ? 'YES' : 'NO'}`);
          for (const [checkId, status] of Object.entries(result.checkStatuses)) {
            console.log(`    - ${checkId}: ${status ?? 'unknown'}`);
          }
          for (const [stepId, status] of Object.entries(result.stepStatuses)) {
            console.log(`    - ${stepId}: ${status ?? 'unknown'}`);
          }

          const validation = validateVerificationResult(result, scenario);

          if (!validation.passed) {
            errors.push(...validation.errors);
            console.log('\n  FAIL Validation errors:');
            validation.errors.forEach((e) => console.log(`    - ${e}`));
          } else {
            console.log('\n  PASS All validations passed');
          }

          expect(validation.passed).toBe(true);
        });

        // Record test result
        testResults.push({
          scenario: scenario.name,
          passed: errors.length === 0,
          duration: Date.now() - testStart,
          ...omitUndefinedProperties({ errors: errors.length > 0 ? errors : undefined }),
        });
      } catch (error) {
        // Record failure
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push(errorMessage);
        testResults.push({
          scenario: scenario.name,
          passed: false,
          duration: Date.now() - testStart,
          ...omitUndefinedProperties({ errors: [errorMessage] }),
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
});
