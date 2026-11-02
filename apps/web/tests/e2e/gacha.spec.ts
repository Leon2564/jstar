import { test, expect, passAgeGate, signUpByEmail } from './fixtures';

test('visitor is sent to sign-up and back to gacha', async ({ page }) => {
  await passAgeGate(page, '/me/gacha');
  // A-M5 (v1.1.1): nothing to save — log in, with her line for the gacha.
  await expect(page.getByRole('heading', { name: 'ログイン／無料登録' })).toBeVisible();
  await page.getByLabel('メールアドレス').fill('a@example.com');
  await page.getByRole('button', { name: '確認コードを送る' }).click();
  await page.getByLabel('確認コード').fill('123456');
  await page.getByRole('button', { name: /のもとへ/ }).click();
  await expect(page).toHaveURL(/#\/me\/gacha$/);
});

test('free pull, 10-pull with points, reveal, collection, detail', async ({ page }) => {
  await passAgeGate(page);
  await signUpByEmail(page, '/me/gacha');
  await expect(page.getByTestId('points')).toHaveText('星石 0');
  // H2 (v1.1.1): out of reach it reads as unavailable; a tap says where points come from (never 「チャージ」).
  await expect(page.getByRole('button', { name: '10回引く' })).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', { name: '10回引く' }).click({ force: true });
  await expect(page.getByTestId('gacha-short')).toContainText('星石が足りません');
  await expect(page.getByTestId('gacha-short').getByRole('link', { name: 'シリアルコードを入力' })).toBeVisible();
  await page.getByRole('button', { name: /無料で1回/ }).click();
  await expect(page).toHaveURL(/gacha\/result/);
  await page.getByRole('button', { name: 'すべてめくる' }).click();
  await page.getByRole('link', { name: 'もう一度引く' }).click();
  await expect(page.getByRole('button', { name: /無料で/ })).toHaveCount(0);
  // Points come from daily login, check-in and codes at launch (the shop is closed); seed them for the draw.
  // (after the app's own save on pagehide, hence an init script for the reload)
  await page.addInitScript(() => {
    if (sessionStorage.getItem('topped')) return;
    sessionStorage.setItem('topped', '1');
    localStorage.setItem('jstar.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('jstar.v1')!), points: 1500 }));
  });
  await page.reload();
  await expect(page.getByTestId('points')).toHaveText('星石 1500');
  await page.getByRole('button', { name: '10回引く' }).click();
  await expect(page.getByText('カードを受け取りました')).toBeVisible();
  await page.getByRole('button', { name: 'すべてめくる' }).click();
  // H1 (v1.1.1): every tier, adding up to the cards drawn.
  await expect(page.getByText(/^10枚：(UR|SSR|SR|R|N) \d+/)).toBeVisible();
  await expect(page.locator('.rv.is-face')).toHaveCount(10);
  await page.getByRole('link', { name: 'カードを見る' }).click();
  await expect(page.getByText(/所持 \d+ \/ 150/)).toBeVisible();
  await page.locator('.cards-grid a.card').first().click();
  await expect(page).toHaveURL(/#\/me\/cards\/s1-[a-z]+-\d\d$/);
  await page.goto('/#/me/gacha');
  await expect(page.getByTestId('points')).toHaveText(/^星石 \d+$/);
});

test('result page without a draw returns to gacha; unknown card id returns to list', async ({ page }) => {
  await passAgeGate(page);
  await signUpByEmail(page, '/me/gacha/result');
  await expect(page).toHaveURL(/#\/me\/gacha$/);
  await page.goto('/#/me/cards/does-not-exist');
  await expect(page).toHaveURL(/#\/me\/cards$/);
});
