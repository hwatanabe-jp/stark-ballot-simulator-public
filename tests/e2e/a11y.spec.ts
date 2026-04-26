import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

type AxeBuilderInstance = InstanceType<typeof AxeBuilder>;
type AxeViolation = Awaited<ReturnType<AxeBuilderInstance['analyze']>>['violations'][number];

const HIGH_IMPACTS = new Set(['critical', 'serious']);

const pages = [
  { name: 'vote', path: '/vote' },
  { name: 'aggregate', path: '/aggregate' },
  { name: 'privacy', path: '/privacy' },
  { name: 'terms', path: '/terms' },
];

const disableMotion = async (page: Page): Promise<void> => {
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
      }
    `,
  });
};

const formatViolations = (violations: AxeViolation[]): string => {
  if (violations.length === 0) {
    return '';
  }

  return violations
    .map((violation) => {
      const targets = violation.nodes
        .map((node) => node.target.join(', '))
        .filter((target) => target.length > 0)
        .join('\n      ');

      return `- ${violation.id} (${violation.impact ?? 'unknown'}): ${violation.description}\n      ${targets}`;
    })
    .join('\n');
};

test.describe('A11y smoke (@axe)', () => {
  for (const { name, path } of pages) {
    test(`@axe ${name} page`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await page.locator('h1').first().waitFor();
      await disableMotion(page);

      const results = await new AxeBuilder({ page }).analyze();
      const violations = results.violations.filter((violation) =>
        violation.impact ? HIGH_IMPACTS.has(violation.impact) : false,
      );

      expect(violations, formatViolations(violations)).toEqual([]);
    });
  }
});
