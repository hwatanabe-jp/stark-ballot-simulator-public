import { expect, type Page, type Locator } from '@playwright/test';
import { getRecordProperty, getStringProperty } from '@stark-ballot/validation/unknown-value-guards';
import { BasePage } from './BasePage';
import { PLAYWRIGHT_RUNTIME_PROFILE } from '../runtime-profile';

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
    await expect(this.runButton).toBeEnabled();

    // Determine timeout based on zkVM mode
    const proofEvidence = PLAYWRIGHT_RUNTIME_PROFILE.proof.evidence;
    const apiTimeout =
      proofEvidence === 'production'
        ? 150000 // 2.5 minutes for production STARK proofs
        : proofEvidence === 'development'
          ? 30000 // 30 seconds for dev mode
          : 15000; // 15 seconds for mock mode

    console.log(`    [AggregatePage] proof evidence: ${proofEvidence} (timeout: ${apiTimeout}ms)`);

    // Set up response listener before clicking
    const responsePromise = this.page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return response.request().method() === 'POST' && /^\/api\/sessions\/[^/]+\/finalizations$/.test(url.pathname);
      },
      { timeout: apiTimeout },
    );

    // Click the run button
    await this.runButton.click();
    console.log('    [AggregatePage] Clicked Run button');

    // Wait for finalize API response
    try {
      const response = await responsePromise;
      console.log(`    [AggregatePage] Finalization API response: ${response.status()}`);

      if (response.ok()) {
        console.log(`    [AggregatePage] Finalization request completed successfully`);
      } else {
        // Error response
        const body = await response.text().catch(() => 'Could not read response body');
        console.error(`    [AggregatePage] API error response: ${body}`);

        // Try to parse error details
        try {
          const errorPayload: unknown = JSON.parse(body);
          const errorCode = getStringProperty(getRecordProperty(errorPayload, 'error'), 'code');
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
    await this.waitForPageLoad();
  }
}
