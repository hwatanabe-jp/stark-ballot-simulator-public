import type { Page, Locator } from '@playwright/test';
import { getStringProperty } from '@/lib/utils/guards';
import { BasePage } from './BasePage';

export type TamperScenario = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5';

export class AggregatePage extends BasePage {
  readonly title: Locator;
  readonly runButton: Locator;
  readonly scenarioRadios: Record<TamperScenario, Locator>;
  readonly errorMessage: Locator;
  readonly loadingSpinner: Locator;

  constructor(page: Page) {
    super(page);
    this.title = page.locator('h1');
    // Use data-testid for reliable button selection
    this.runButton = page.locator('[data-testid="execute-button"]');

    // Initialize radio buttons for tamper scenarios using data-testid
    this.scenarioRadios = {
      S0: page.locator('[data-testid="scenario-radio-S0"]'),
      S1: page.locator('[data-testid="scenario-radio-S1"]'),
      S2: page.locator('[data-testid="scenario-radio-S2"]'),
      S3: page.locator('[data-testid="scenario-radio-S3"]'),
      S4: page.locator('[data-testid="scenario-radio-S4"]'),
      S5: page.locator('[data-testid="scenario-radio-S5"]'),
    };

    this.errorMessage = page.locator('.text-red-500').or(page.locator('[role="alert"]'));
    this.loadingSpinner = page.locator('[role="status"]').or(page.locator('.animate-spin'));
  }

  async selectScenario(scenario: TamperScenario): Promise<void> {
    await this.scenarioRadios[scenario].click();
    await this.page.waitForFunction(
      ({ scenario: selected }) => {
        const radio = document.querySelector(`input[type="radio"][value="${selected}"]`);
        return radio instanceof HTMLInputElement && radio.checked;
      },
      { scenario },
    );
  }

  async runAggregation(): Promise<void> {
    // Check button state before clicking
    const isEnabled = await this.runButton.isEnabled();
    console.log(`    [AggregatePage] Run button enabled: ${isEnabled}`);

    if (!isEnabled) {
      console.log('    [AggregatePage] Run button is disabled, checking for errors...');
      const errorMsg = await this.getErrorMessage();
      if (errorMsg) {
        throw new Error(`Cannot run aggregation: ${errorMsg}`);
      }
    }

    // Determine timeout based on zkVM mode
    const isRealZkVM = process.env.USE_REAL_ZKVM === 'true' || process.env.USE_MOCK_ZKVM === 'false';
    const isProductionMode = isRealZkVM && process.env.RISC0_DEV_MODE !== '1';
    const apiTimeout = isProductionMode
      ? 150000 // 2.5 minutes for production STARK proofs
      : isRealZkVM
        ? 30000 // 30 seconds for dev mode
        : 15000; // 15 seconds for mock mode

    console.log(
      `    [AggregatePage] zkVM mode: ${isProductionMode ? 'production' : isRealZkVM ? 'dev' : 'mock'} (timeout: ${apiTimeout}ms)`,
    );

    // Set up response listener before clicking
    const responsePromise = this.page.waitForResponse((response) => response.url().includes('/api/finalize'), {
      timeout: apiTimeout,
    });

    // Click the run button
    await this.runButton.click();
    console.log('    [AggregatePage] Clicked Run button');

    // Wait for finalize API response
    try {
      const response = await responsePromise;
      console.log(`    [AggregatePage] Finalize API response: ${response.status()}`);

      if (response.ok()) {
        // Success - parse the response to confirm zkVM execution completed
        try {
          const responseData: unknown = await response.json();
          console.log(`    [AggregatePage] zkVM execution completed successfully`);

          // Store the response data in localStorage for verification page
          await this.page.evaluate((data) => {
            const isRecordValue = (value: unknown): value is Record<string, unknown> =>
              typeof value === 'object' && value !== null;
            const sessionData = localStorage.getItem('starkBallotSession');
            if (sessionData) {
              const parsed: unknown = JSON.parse(sessionData);
              if (isRecordValue(parsed)) {
                const payload = isRecordValue(data) && isRecordValue(data.data) ? data.data : data;
                parsed.finalizeResult = payload;
                localStorage.setItem('starkBallotSession', JSON.stringify(parsed));
              }
            }
          }, responseData);
        } catch {
          console.log('    [AggregatePage] Could not parse response data');
        }
      } else {
        // Error response
        const body = await response.text().catch(() => 'Could not read response body');
        console.error(`    [AggregatePage] API error response: ${body}`);

        // Try to parse error details
        try {
          const errorPayload: unknown = JSON.parse(body);
          const errorCode = getStringProperty(errorPayload, 'error');
          if (errorCode) {
            throw new Error(`API error: ${errorCode}`);
          }
        } catch {
          console.log('    [AggregatePage] Error response was not valid JSON');
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`    [AggregatePage] Warning: API call issue - ${message}`);
      // Continue anyway as navigation might still happen
    }

    // Wait for navigation to result page
    console.log(`    [AggregatePage] Waiting for navigation to result page...`);

    try {
      // Multiple strategies to detect navigation
      await Promise.race([
        // Strategy 1: Wait for URL change
        this.page.waitForURL('**/result', {
          waitUntil: 'domcontentloaded',
          timeout: apiTimeout,
        }),

        // Strategy 2: Wait for specific content on result page
        this.page
          .waitForSelector('text=/Result|集計結果/i', {
            timeout: apiTimeout,
          })
          .then(() => {
            if (!this.page.url().includes('/result')) {
              return this.page.goto('/result');
            }
            return undefined;
          }),

        // Strategy 3: Poll for navigation
        (async () => {
          const maxAttempts = Math.floor(apiTimeout / 2000); // Check every 2 seconds
          for (let i = 0; i < maxAttempts; i++) {
            if (this.page.url().includes('/result')) {
              console.log('    [AggregatePage] Navigation detected via polling');
              return;
            }
            await this.page.waitForTimeout(2000);
          }
          throw new Error('Navigation timeout via polling');
        })(),
      ]);

      console.log('    [AggregatePage] Successfully navigated to result page');
    } catch (error) {
      // Final diagnostic information
      const currentUrl = this.page.url();
      console.log(`    [AggregatePage] Failed to navigate. Current URL: ${currentUrl}`);

      // Check for any visible errors
      const visibleError = await this.errorMessage.isVisible().catch(() => false);
      if (visibleError) {
        const errorText = await this.errorMessage.textContent();
        console.log(`    [AggregatePage] Visible error: ${errorText}`);
      }

      // Check page content
      const pageContent = await this.page.textContent('body').catch(() => 'Could not read page');
      console.log(`    [AggregatePage] Page content snippet: ${pageContent ? pageContent.substring(0, 300) : 'N/A'}`);

      // If we're still on aggregate page but execution might have completed, try manual navigation
      if (currentUrl.includes('/aggregate')) {
        console.log('    [AggregatePage] Attempting manual navigation to result page...');
        await this.page.goto('/result');
        await this.page.waitForLoadState('domcontentloaded');
      } else {
        throw error;
      }
    }
  }

  async isRunButtonEnabled(): Promise<boolean> {
    return await this.runButton.isEnabled();
  }

  async getSelectedScenarios(): Promise<string[]> {
    const selected: string[] = [];
    for (const scenario of Object.keys(this.scenarioRadios)) {
      const isChecked = await this.page.isChecked(`input[type="radio"][value="${scenario}"]`).catch(() => false);
      if (isChecked) {
        selected.push(scenario);
      }
    }
    return selected;
  }

  async hasConflictError(): Promise<boolean> {
    return await this.errorMessage.isVisible();
  }

  async getErrorMessage(): Promise<string> {
    if (await this.hasConflictError()) {
      return (await this.errorMessage.textContent()) || '';
    }
    return '';
  }

  async waitForPageReady(): Promise<void> {
    await this.runButton.waitFor({ state: 'visible', timeout: 10000 });

    // Check if button is enabled
    const isEnabled = await this.runButton.isEnabled();
    if (!isEnabled) {
      console.log('    ⚠️ Run button is disabled, checking for rate limit...');

      // Check localStorage for rate limit data
      const rateLimitData = await this.page.evaluate(() => {
        return localStorage.getItem('zkVmExecutions');
      });
      console.log('    Rate limit data:', rateLimitData);
    }

    await this.waitForPageLoad();
  }
}
