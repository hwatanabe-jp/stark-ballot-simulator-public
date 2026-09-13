import type { Page } from '@playwright/test';

export class BasePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(path = ''): Promise<void> {
    await this.page.goto(path);
  }
}
