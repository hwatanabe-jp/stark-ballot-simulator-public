import { test, expect } from '@playwright/test';
import { HomePage } from './pages';

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`knowledge disclosure stays stable and keyboard accessible with ${reducedMotion} motion`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    const home = new HomePage(page);
    await home.goto('/');
    await home.waitForPageReady();
    await home.clickStart();

    const panel = page.getByRole('complementary');
    const session = panel.getByRole('button', { name: /Session|セッション/ });
    await expect(panel).toHaveCount(1);
    await expect(session).toHaveAttribute('aria-expanded', 'true');
    await session.focus();
    await session.press('Enter');
    await expect(session).toHaveAttribute('aria-expanded', 'false');
    await session.press('Enter');
    await expect(session).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.locator('[data-key="electionId"]')).toBeVisible();
    await expect(session).toBeFocused();
    expect(await panel.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);

    await page.setViewportSize({ width: 320, height: 740 });
    await expect(session).toHaveAttribute('aria-expanded', 'true');
    await expect(session).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await session.press('Enter');
    await expect(session).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.locator('[data-key="electionId"]')).toHaveCount(0);
    await expect(session).toBeFocused();
  });
}
