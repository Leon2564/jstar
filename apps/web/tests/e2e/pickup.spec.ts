import { test, expect, passAgeGate, signUpByEmail } from './fixtures';

/**
 * Pickups (#78) in the browser: 提供割合 publishes one with numbers computed from its config (adding up to exactly
 * 100%), and the gacha page shows it as its own pool with the period and no countdown. The offline build runs no
 * Pickup of its own, so the test injects one (window.__PICKUPS__, honoured only with __E2E__).
 */
const DAY = 86_400_000;

test.beforeEach(async ({ page }) => {
  await page.addInitScript((day) => {
    const now = Date.now();
    (window as unknown as { __PICKUPS__: unknown[] }).__PICKUPS__ = [{
      id: 'pickup:s1-eimi-30:20261001', cardId: 's1-eimi-30', star: 'eimi', share: 0.5,
      rates: { N: 0.55, R: 0.28, SR: 0.12, SSR: 0.045, UR: 0.005 },
      startsAt: new Date(now - day).toISOString(), endsAt: new Date(now + 7 * day).toISOString()
    }];
  }, DAY);
});

test('提供割合 publishes the Pickup beside the regular pools, and its tiers add up to 100%', async ({ page }) => {
  // 提供割合 is public, like every legal page: no age gate in front of it.
  await page.goto('/#/legal/rates');
  const box = page.getByTestId('rates-pickup:s1-eimi-30:20261001');
  await expect(box).toBeVisible();
  await expect(box.getByTestId('rates-pickup-row')).toHaveText('ピックアップ対象「ロゼ色の夜」（UR）：2.5%（深田えいみのガチャでは通常 0.5%）。SSR以上が出たときの50%がこのカードです。');
  await expect(box).toContainText('開催中');
  const rates = (await box.locator('tbody tr td:nth-child(2)').allTextContents()).map((s) => Number(s.replace('%', '')));
  expect(rates).toEqual([2.5, 2.5, 12, 28, 55]);
  expect(Math.round(rates.reduce((n, x) => n + x, 0) * 1000)).toBe(100000);
  await expect(page.getByTestId('rates-star:eimi').locator('tbody tr td:nth-child(2)').first()).toHaveText('0.5%');
  // Phone width: nothing scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('the gacha page offers it as its own pool with its rate and period, no countdown', async ({ page }) => {
  await passAgeGate(page);
  await signUpByEmail(page, '/me/gacha');
  await page.getByTestId('pickup-chip').click();
  await expect(page.getByTestId('pickup-rate')).toHaveText('「ロゼ色の夜」2.5%（通常 0.5%）\nSSR以上の合計 5%'); // L5 (v1.1.1): the two figures on two lines
  await expect(page.getByTestId('pickup')).toContainText('開催期間');
  await expect(page.getByTestId('pickup')).not.toContainText('残り');
  await page.getByRole('button', { name: /無料で1回/ }).click();
  await expect(page).toHaveURL(/gacha\/result/);
});
