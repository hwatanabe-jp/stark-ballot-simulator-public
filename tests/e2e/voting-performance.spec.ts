import { test, expect } from '@playwright/test';
import { HomePage, VotePage, AggregatePage } from './pages';
import { measurePerformance } from './helpers/test-helpers';
import { PLAYWRIGHT_RUNTIME_PROFILE } from './runtime-profile';

test('Voting performance @benchmark', async ({ page }, testInfo) => {
  const homePage = new HomePage(page);
  const votePage = new VotePage(page);
  const aggregatePage = new AggregatePage(page);

  const pageLoad = await measurePerformance('Home Page Load', async () => {
    await homePage.goto('/');
    await homePage.waitForPageReady();
  });

  await homePage.clickStart();

  const voteSubmission = await measurePerformance('Vote Submission', async () => {
    await votePage.selectChoice('A');
    await votePage.submitVote();
  });

  const botVoting = await measurePerformance('Bot Voting', async () => {
    await votePage.waitForBotVotingComplete();
  });

  await aggregatePage.waitForPageReady();
  await aggregatePage.selectScenario('S0');
  const aggregation = await measurePerformance('Aggregation', async () => {
    await aggregatePage.runAggregation();
  });

  const measurements = {
    runtimeProfile: PLAYWRIGHT_RUNTIME_PROFILE.name,
    milliseconds: {
      homePageReady: pageLoad.duration,
      voteSubmission: voteSubmission.duration,
      botVoting: botVoting.duration,
      aggregation: aggregation.duration,
    },
  };
  console.log('Voting benchmark:', measurements);
  await testInfo.attach('voting-performance.json', {
    body: JSON.stringify(measurements, null, 2),
    contentType: 'application/json',
  });

  expect(pageLoad.duration).toBeLessThan(5000);
  expect(voteSubmission.duration).toBeLessThan(3000);
  if (PLAYWRIGHT_RUNTIME_PROFILE.proof.evidence !== 'production') {
    expect(aggregation.duration).toBeLessThan(10000);
  }
});
