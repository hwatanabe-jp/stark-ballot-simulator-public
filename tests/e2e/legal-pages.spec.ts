import { test, expect } from '@playwright/test';

/**
 * 法務ページ（プライバシーポリシー・利用規約）のUIテスト
 *
 * 検証項目:
 * - Step Indicator が非表示
 * - Knowledge Panel が非表示
 * - 「トップに戻る」リンクが表示・動作
 * - 言語切替で文言が切り替わる
 */

const legalPages = [
  { name: 'privacy', path: '/privacy', titleJa: 'プライバシーポリシー', titleEn: 'Privacy Policy' },
  { name: 'terms', path: '/terms', titleJa: '利用規約', titleEn: 'Terms of Service' },
];

const LANGUAGE_STORAGE_KEY = 'stark-ballot-lang';
const LANGUAGE_COOKIE_NAME = 'stark-ballot-lang';
const BASE_URL = 'http://localhost:3000';

test.describe('Legal pages UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ key, value }) => {
        window.localStorage.setItem(key, value);
      },
      { key: LANGUAGE_STORAGE_KEY, value: 'ja' },
    );

    await page.context().addCookies([{ name: LANGUAGE_COOKIE_NAME, value: 'ja', url: BASE_URL }]);
  });

  for (const { name, path, titleJa } of legalPages) {
    test.describe(`${name} page`, () => {
      test('hides Step Indicator', async ({ page }) => {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await page.locator('h1').first().waitFor();

        // Step Indicator は data-testid で判定
        const stepIndicator = page.getByTestId('step-indicator');
        await expect(stepIndicator).toHaveCount(0);
      });

      test('hides Knowledge Panel', async ({ page }) => {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await page.locator('h1').first().waitFor();

        // Knowledge Panel のセンチネル/スペーサー/ボトムシートは非表示
        const dockSentinel = page.getByTestId('knowledge-dock-sentinel');
        await expect(dockSentinel).toHaveCount(0);
        const spacer = page.getByTestId('knowledge-panel-spacer');
        await expect(spacer).toHaveCount(0);
        const bottomSheet = page.getByTestId('knowledge-bottom-sheet');
        await expect(bottomSheet).toHaveCount(0);
      });

      test('shows Back to Home link', async ({ page }) => {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await page.locator('h1').first().waitFor();

        // 「トップに戻る」リンクが表示されている
        const backLink = page.getByTestId('legal-back-to-home');
        await expect(backLink).toBeVisible();
        await expect(backLink).toContainText(/トップに戻る|Back to Home/);
      });

      test('Back to Home link navigates to home', async ({ page }) => {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await page.locator('h1').first().waitFor();

        const backLink = page.getByTestId('legal-back-to-home');
        await backLink.click();

        await expect(page).toHaveURL('/');
      });

      test('displays correct title in Japanese', async ({ page }) => {
        await page.goto(path, { waitUntil: 'domcontentloaded' });

        const h1 = page.locator('h1').first();
        await expect(h1).toContainText(titleJa);
      });
    });
  }

  test('language switch changes Back to Home text', async ({ page }) => {
    await page.goto('/privacy', { waitUntil: 'domcontentloaded' });
    await page.locator('h1').first().waitFor();

    // 初期状態（日本語）
    const backLink = page.getByTestId('legal-back-to-home');
    await expect(backLink).toContainText('トップに戻る');

    // 言語切替ボタンをクリック
    const langButton = page.getByRole('button', { name: /英語に切り替え|Switch to English/ });
    await expect(langButton).toBeVisible();
    await langButton.click();

    // 英語に切り替わる
    await expect(backLink).toContainText('Back to Home');
  });
});
