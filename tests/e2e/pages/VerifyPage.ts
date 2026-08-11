import { expect, type Page, type Locator } from '@playwright/test';
import { BasePage } from './BasePage';

// UI-facing statuses are normalized before they reach data-status.
// Internal "not_run" states are rendered as "pending" in the verification card.
export type CheckStatus = 'pending' | 'running' | 'success' | 'failed';
export type SummaryStatus = 'verified' | 'warning' | 'failed' | 'in_progress' | 'demo_only';
export type VerificationCheckId =
  | 'recorded_sth_third_party'
  | 'counted_input_sanity'
  | 'counted_unique_indices'
  | 'counted_unique_commitments'
  | 'counted_tally_consistent'
  | 'counted_missing_indices_zero'
  | 'counted_expected_vs_tree_size'
  | 'counted_election_manifest_consistent'
  | 'counted_close_statement_consistent'
  | 'counted_my_vote_included'
  | 'counted_input_commitment_match'
  | 'stark_image_id_match'
  | 'stark_receipt_verify';
export type VerificationStepId = 'counted_as_recorded' | 'stark_verification';

export interface VerificationResult {
  summaryVisible: boolean;
  summaryStatus: SummaryStatus | null;
  checkStatuses: Partial<Record<VerificationCheckId, CheckStatus | null>>;
  stepStatuses: Partial<Record<VerificationStepId, CheckStatus | null>>;
}

export class VerifyPage extends BasePage {
  readonly title: Locator;
  readonly summaryBanner: Locator;

  constructor(page: Page) {
    super(page);
    this.title = page.locator('h1');
    this.summaryBanner = page.getByTestId('result-summary');
  }

  async getVerificationResult(
    checkIds: readonly VerificationCheckId[] = ['counted_missing_indices_zero'],
    stepIds: readonly VerificationStepId[] = [],
  ): Promise<VerificationResult> {
    const summaryVisible = await this.summaryBanner.isVisible().catch(() => false);
    const summaryStatus = await this.getSummaryStatus();
    const checkStatuses = await this.getCheckStatuses(checkIds);
    const stepStatuses = await this.getStepStatuses(stepIds);

    return {
      summaryVisible,
      summaryStatus,
      checkStatuses,
      stepStatuses,
    };
  }

  async waitForVerificationComplete(
    checkIds: readonly VerificationCheckId[] = ['counted_missing_indices_zero', 'stark_receipt_verify'],
  ): Promise<void> {
    for (const checkId of checkIds) {
      await this.waitForTerminalStatus(`check-${checkId}`);
    }
    await this.summaryBanner.waitFor({ state: 'visible', timeout: 20000 });
  }

  private async getSummaryStatus(): Promise<SummaryStatus | null> {
    const attr = await this.summaryBanner.getAttribute('data-status').catch(() => null);
    if (
      attr === 'verified' ||
      attr === 'warning' ||
      attr === 'failed' ||
      attr === 'in_progress' ||
      attr === 'demo_only'
    ) {
      return attr;
    }
    return null;
  }

  private async getCheckStatuses(
    checkIds: readonly VerificationCheckId[],
  ): Promise<Partial<Record<VerificationCheckId, CheckStatus | null>>> {
    const entries = await Promise.all(
      checkIds.map(async (checkId) => [checkId, await this.getStatus(`check-${checkId}`)] as const),
    );
    return Object.fromEntries(entries);
  }

  private async getStepStatuses(
    stepIds: readonly VerificationStepId[],
  ): Promise<Partial<Record<VerificationStepId, CheckStatus | null>>> {
    const entries = await Promise.all(
      stepIds.map(async (stepId) => [stepId, await this.getStatus(`step-${stepId}`)] as const),
    );
    return Object.fromEntries(entries);
  }

  private async getStatus(testId: string): Promise<CheckStatus | null> {
    const locator = this.page.getByTestId(testId);
    if ((await locator.count()) === 0) {
      return null;
    }
    const attr = await locator.getAttribute('data-status');
    if (attr === 'pending' || attr === 'running' || attr === 'success' || attr === 'failed') {
      return attr;
    }
    return null;
  }

  private async waitForTerminalStatus(testId: string): Promise<void> {
    const locator = this.page.getByTestId(testId);
    await expect(locator).toBeVisible({ timeout: 20000 });
    await expect(locator).toHaveAttribute('data-status', /^(success|failed)$/, { timeout: 20000 });
  }

  async getPageTitle(): Promise<string> {
    return (await this.title.textContent()) || '';
  }

  isOnVerifyPage(): Promise<boolean> {
    const url = this.page.url();
    return Promise.resolve(url.includes('/verify'));
  }
}
