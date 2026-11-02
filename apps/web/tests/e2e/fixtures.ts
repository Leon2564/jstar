import { test as base, expect, type Page } from '@playwright/test';

export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await page.addInitScript(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await use(page);
    expect(errors, 'uncaught page errors').toEqual([]);
  }
});
export { expect };

/** Timing budgets are set on a developer laptop; shared 2-vCPU CI runners get 1.5× the headroom. */
export const SLOW = process.env.CI ? 1.5 : 1;

export async function passAgeGate(page: Page, path = '/') {
  await page.goto(`/#${path}`);
  await page.getByRole('button', { name: 'はい、18歳以上です' }).click();
  await page.getByRole('link', { name: 'スキップ' }).click();
}

export async function signUpByEmail(page: Page, next = '/me/home') {
  await page.goto(`/#/signup?next=${encodeURIComponent(next)}`);
  await page.getByLabel('メールアドレス').fill('kenta@example.com');
  await page.getByRole('button', { name: '確認コードを送る' }).click();
  await page.getByLabel('確認コード').fill('123456');
  await page.getByRole('button', { name: /のもとへ/ }).click();
  // Her room starts its own loading and navigation on arrival; a test that jumps away at once races it (seen on CI).
  if (next === '/me/home') await page.getByTestId('greeting').waitFor();
}
