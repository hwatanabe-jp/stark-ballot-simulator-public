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

test.describe('Legal pages UI', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    if (!baseURL) throw new Error('Legal page tests require the configured E2E baseURL.');
    await page.addInitScript(
      ({ key, value }) => {
        window.localStorage.setItem(key, value);
      },
      { key: LANGUAGE_STORAGE_KEY, value: 'ja' },
    );

    await page.context().addCookies([{ name: LANGUAGE_COOKIE_NAME, value: 'ja', url: baseURL }]);
  });

  for (const { name, path, titleJa } of legalPages) {
    test.describe(`${name} page`, () => {
      test('shows the legal page without voting controls', async ({ page }) => {
        await page.goto(path, { waitUntil: 'domcontentloaded' });

        const h1 = page.locator('h1').first();
        await h1.waitFor();
        await expect(h1).toContainText(titleJa);

        // Step Indicator は data-testid で判定
        const stepIndicator = page.getByTestId('step-indicator');
        await expect(stepIndicator).toHaveCount(0);

        // Legal pages do not mount the knowledge panel.
        await expect(page.getByRole('complementary')).toHaveCount(0);

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
