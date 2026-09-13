import { test, expect } from '@playwright/test';
import { HomePage } from './pages';
import { VoteResponseSchema } from '@stark-ballot/api-contract/schemas/votes';

test('recovers the same vote after response loss and reload @smoke', async ({ page }) => {
  const home = new HomePage(page);
  await home.goto('/');
  await home.waitForPageReady();
  await home.clickStart();
  const lost = Promise.withResolvers<unknown>();
  const requests: string[] = [];
  await page.route('**/api/sessions/*/votes', async (route) => {
    requests.push(route.request().postData() ?? '');
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (requests.length === 1) {
      lost.resolve(await response.json());
      await route.abort('connectionreset');
    } else {
      await route.fulfill({ response });
    }
  });
  await page.getByTestId('vote-option-A').click();
  await page.getByTestId('submit-vote').click();
  const original = VoteResponseSchema.parse(await lost.promise).data;
  await expect(page.getByTestId('submit-vote')).toBeEnabled();
  await page.reload();
  await expect(page.getByTestId('vote-option-B').locator('input')).toBeDisabled();
  await page.getByTestId('submit-vote').click();
  await expect(page).toHaveURL(/\/vote#waiting|\/aggregate/);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  const stored: unknown = await page.evaluate(() => JSON.parse(localStorage.getItem('starkBallotSession') ?? 'null'));
  expect(stored).toMatchObject({
    voteId: original.voteId,
    bulletinIndex: original.bulletinIndex,
    bulletinRootAtCast: original.bulletinRootAtCast,
    myCommit: original.commitment,
  });
});
