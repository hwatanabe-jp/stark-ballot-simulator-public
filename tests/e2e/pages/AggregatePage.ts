import { expect, type Page, type Locator } from '@playwright/test';
import { getObjectProperty, getStringProperty } from '@stark-ballot/validation/unknown-value-guards';
import { BasePage } from './BasePage';
import { PLAYWRIGHT_RUNTIME_PROFILE } from '../runtime-profile';

export type TamperScenario = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5';

export class AggregatePage extends BasePage {
  readonly runButton: Locator;
  readonly scenarioRadios: Record<TamperScenario, Locator>;

  constructor(page: Page) {
    super(page);
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

    const response = await responsePromise;
    console.log(`    [AggregatePage] Finalization API response: ${response.status()}`);
    if (!response.ok()) {
      const body = await response.text();
      let errorCode: string | undefined;
      try {
        const errorPayload: unknown = JSON.parse(body);
        errorCode = getStringProperty(getObjectProperty(errorPayload, 'error'), 'code');
      } catch {
        // The status and raw body below still make this a hard failure.
      }
      throw new Error(
        errorCode
          ? `Finalization API error: ${errorCode}`
          : `Finalization API returned ${response.status()}: ${body || '(empty response body)'}`,
      );
    }
    console.log('    [AggregatePage] Finalization request completed successfully');

    console.log(`    [AggregatePage] Waiting for navigation to result page...`);
    await this.page.waitForURL('**/result', {
      waitUntil: 'domcontentloaded',
      timeout: apiTimeout,
    });
    console.log('    [AggregatePage] Successfully navigated to result page');
  }

  async waitForPageReady(): Promise<void> {
    await expect(this.runButton).toBeVisible({ timeout: 10000 });
    await expect(this.scenarioRadios.S0).toBeVisible({ timeout: 10000 });
  }
}
