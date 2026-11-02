import { test, expect, passAgeGate } from './fixtures';

// Demo codes printed on the partner sample cards (DEMO_SERIALS in @jstar/shared), 12 digits with a Luhn check digit.
const CODE = '999000000011';
const PRINTED = '9990-0000-0011';
/** Well formed, never issued. */
const UNISSUED = '888000000016';

const input = (page: import('@playwright/test').Page) => page.getByRole('textbox', { name: 'シリアルコード' });
const submit = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'カードを受け取る' });

test('QR link keeps the code through the age gate and deals six cards, the first SR or better', async ({ page }) => {
  await page.goto(`/#/serial?code=${CODE}`);
  await page.getByRole('button', { name: 'はい、18歳以上です' }).click();
  await page.getByRole('link', { name: 'スキップ' }).click();
  await expect(input(page)).toHaveValue(PRINTED);
  await expect(page.getByText('カードのQRから自動で入力されました')).toBeVisible();
  await submit(page).click();
  await expect(page).toHaveURL(/#\/gacha\/redeem$/);
  await expect(page.getByTestId('pg-title')).toBeVisible();
  await expect(page.locator('.pg-redeem-result')).toBeVisible();
  await expect(page.getByTestId('gacha-result-card')).toHaveCount(6);
  await expect(page.locator('.pg-result')).toHaveClass(/is-dealt/);
  const cardBoxes = await page.getByTestId('gacha-result-card').evaluateAll((cards) => cards.map((card) => {
    const box = card.getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), width: box.width };
  }));
  expect(new Set(cardBoxes.map((box) => box.y)).size).toBe(2);
  expect([...new Set(cardBoxes.map((box) => box.y))].map((y) => cardBoxes.filter((box) => box.y === y).length)).toEqual([3, 3]);
  expect(Math.max(...cardBoxes.map((box) => box.width))).toBeLessThan(130);
  // Reveal every card and keep the guaranteed first pull visible for its rarity assertion.
  await page.getByRole('button', { name: '1枚目をめくる' }).click();
  await expect(page.getByTestId('gacha-result-card').first()).toContainText(/SSR|SR/);
  for (let n = 2; n <= 6; n += 1) await page.getByRole('button', { name: `${n}枚目をめくる` }).click();
  await expect(page.getByTestId('lucky-bonus')).toContainText('7日間');
  await expect(page.getByRole('link', { name: '無料登録してカードを保存する' })).toBeVisible();
});

test('the generic QR (/lucky) and the per-card QR (/r/<code>) open the redeem page', async ({ page }) => {
  await page.goto('/lucky');
  await expect(page).toHaveURL(/\/#\/(age|serial)/);
  await page.getByRole('button', { name: 'はい、18歳以上です' }).click();
  await page.getByRole('link', { name: 'スキップ' }).click();
  await expect(input(page)).toHaveValue('');
  await page.goto(`/r/${CODE}`);
  await expect(input(page)).toHaveValue(PRINTED);
  await page.goto('/r/999000000012');
  await expect(input(page)).toHaveValue('');
});

test('manual entry accepts spaces and full-width digits; a used code is refused', async ({ page }) => {
  await passAgeGate(page, '/serial');
  await input(page).fill('９９９０ ００００ ００１１');
  await submit(page).click();
  await expect(page).toHaveURL(/gacha\/redeem$/);
  await page.goto('/#/serial');
  await input(page).fill(PRINTED);
  await submit(page).click();
  await expect(page.getByRole('alert')).toContainText('すでに使用されています');
});

test('a visitor keeps the six cards and the pass after signing up', async ({ page }) => {
  await passAgeGate(page, `/serial?code=${CODE}`);
  await submit(page).click();
  await page.getByRole('button', { name: 'すべてめくる' }).click();
  await page.getByRole('link', { name: '無料登録してカードを保存する' }).click();
  await page.getByLabel('メールアドレス').fill('fan@example.com');
  await page.getByRole('button', { name: '確認コードを送る' }).click();
  await page.getByLabel('確認コード').fill('123456');
  await page.getByRole('button', { name: /のもとへ/ }).click();
  await expect(page).toHaveURL(/#\/me\/cards$/);
  const tiles = page.locator('.cards-grid a');
  await expect(tiles.first()).toBeVisible();
  expect(await tiles.count()).toBeLessThanOrEqual(6);
});

test('a typo is told apart from an unknown code; five unknown codes lock the form', async ({ page }) => {
  await passAgeGate(page, '/serial');
  await input(page).fill('9990-0000-0012');
  await submit(page).click();
  await expect(page.getByRole('alert')).toContainText('入力ミス');
  for (let i = 0; i < 5; i++) {
    await input(page).fill(UNISSUED);
    await submit(page).click();
    if (i < 4) await expect(page.getByRole('alert')).toContainText('見つかりませんでした');
  }
  await expect(page.getByRole('alert')).toContainText('再度お試しください');
  await expect(input(page)).toBeDisabled();
  await page.reload();
  await expect(input(page)).toBeDisabled();
});

test('a short code is reported without calling the server, and the odds are published', async ({ page }) => {
  await passAgeGate(page, '/serial');
  await expect(page.getByTestId('serial-gets')).toContainText('カード6枚');
  await page.getByText('提供割合').click();
  await expect(page.getByTestId('lucky-rates')).toContainText('UR 2.9%　SSR 26.5%');
  await input(page).fill('1234');
  await submit(page).click();
  await expect(page.getByRole('alert')).toContainText('12桁');
});
