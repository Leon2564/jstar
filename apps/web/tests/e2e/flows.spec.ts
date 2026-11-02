import { test, expect, passAgeGate, signUpByEmail } from './fixtures';

test.describe('age gate', () => {
  test('first visit is gated and returns to the requested page', async ({ page }) => {
    await page.goto('/#/stars');
    await expect(page.getByRole('heading', { name: '18歳以上の方ですか？' })).toBeVisible();
    await page.getByRole('button', { name: 'はい、18歳以上です' }).click();
    await expect(page).toHaveURL(/#\/stars$/, { timeout: 5000 });
  });
  test('declining blocks entry', async ({ page }) => {
    await page.goto('/#/');
    await page.getByRole('button', { name: 'いいえ' }).click();
    await expect(page.getByRole('alert')).toHaveText('18歳未満の方はご利用いただけません。');
    await expect(page.getByRole('button', { name: 'はい、18歳以上です' })).toHaveCount(0);
  });
});

test.describe('flow 1: talk to her', () => {
  test('pick → 3 trial messages → sign-up → conversation carried over', async ({ page }) => {
    await passAgeGate(page);
    await page.getByRole('link', { name: '彼女と話す' }).click();
    await page.getByRole('button', { name: '七瀬アリスと話す' }).click();
    await expect(page.getByText('七瀬アリス').first()).toBeVisible();
    for (const [i, q] of ['なんて呼べばいい？', '仕事終わったところ', '会いたかった'].entries()) {
      await expect(page.getByTestId('trial-left')).toHaveText(`あと${3 - i}通`);
      await page.getByRole('button', { name: q }).click();
      await expect(page.getByTestId('trial-left')).toHaveText(`あと${2 - i}通`);
      await expect(page.getByRole('status', { name: /入力中/ })).toHaveCount(0);
    }
    await expect(page.getByLabel('メッセージ')).toBeDisabled();
    await page.getByTestId('trial-done').click();
    // wrong code first
    await page.getByLabel('メールアドレス').fill('kenta@example.com');
    await page.getByRole('button', { name: '確認コードを送る' }).click();
    await page.getByLabel('確認コード').fill('000000');
    await page.getByRole('button', { name: /登録して/ }).click();
    await expect(page.getByRole('alert')).toContainText('コードが正しくありません');
    await page.getByLabel('確認コード').fill('123456');
    await page.getByRole('button', { name: /登録して/ }).click();
    // H3 (v1.1.1): saved, the conversation goes on in her room; the trial lines are in her history.
    await expect(page).toHaveURL(/#\/me\/home$/);
    await page.goto('/#/me/chat');
    await expect(page.getByText('会いたかった', { exact: true })).toBeVisible();
    await expect(page.getByText('七瀬アリス').first()).toBeVisible();
  });
  test('invalid e-mail is rejected before sending; returning members are told the same address logs them in', async ({ page }) => {
    await passAgeGate(page);
    await page.goto('/#/signup');
    // M2 / A-M5 (v1.1.1): no trial conversation to save — the neutral words, which say a new address signs up.
    await expect(page.getByTestId('su-other')).toHaveText('はじめての方も、このまま無料で登録できます。');
    await page.getByLabel('メールアドレス').fill('not-an-email');
    await page.getByRole('button', { name: '確認コードを送る' }).click();
    await expect(page.getByRole('alert')).toContainText('メールアドレスの形式');
  });
  test('log in from the menu (e-mail only, no LINE); the top page stays the immersive home and leads back to her', async ({ page }) => {
    await passAgeGate(page);
    await page.goto('/#/menu');
    await page.getByRole('link', { name: 'ログイン／無料登録', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'ログイン／無料登録', exact: true })).toBeVisible();
    await expect(page.getByTestId('su-other')).toHaveText('はじめての方も、このまま無料で登録できます。');
    await expect(page.getByRole('button', { name: /LINE/ })).toHaveCount(0);
    await page.getByLabel('メールアドレス').fill('kenta@example.com');
    await page.getByRole('button', { name: '確認コードを送る' }).click();
    await page.getByLabel('確認コード').fill('123456');
    await page.getByRole('button', { name: /のもとへ$/ }).click();
    await expect(page).toHaveURL(/#\/me\/home$/);
    // Members are never redirected away from the front page: the stage is there, the badge for guests is not.
    await page.goto('/#/');
    await expect(page.locator('section.top')).toBeVisible();
    await expect(page.getByText('登録なしで話せる')).toHaveCount(0);
    // Members land in her room (the live video home), not the text chat.
    await page.locator('section.top').getByRole('link', { name: '彼女と話す' }).click();
    await expect(page).toHaveURL(/#\/me\/home$/);
    // The member tab bar's logo returns to the front page.
    await expect(page.locator('.tb-brand')).toHaveAttribute('href', '#/');
  });
  test('logged-in chat: messages, affinity and memory card', async ({ page }) => {
    await passAgeGate(page);
    await signUpByEmail(page, '/me/chat');
    for (const t of ['ただいま', '今日は雨だった', '明日も来るね']) {
      await page.getByLabel('メッセージ').fill(t);
      await page.getByRole('button', { name: '送信' }).click();
      await expect(page.getByText(t, { exact: true })).toBeVisible();
      await expect(page.getByRole('status', { name: /入力中/ })).toHaveCount(0);
    }
    await expect(page.getByText(/思い出カードが生まれました/)).toBeVisible();
    await page.getByRole('link', { name: /思い出カードが生まれました/ }).click();
    await expect(page.getByRole('tab', { name: '思い出カード' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('img', { name: /思い出カード/ })).toHaveCount(1);
  });
});
