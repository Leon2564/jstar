import { test, expect, passAgeGate } from './fixtures';

const EXPECT = {
  'zh-Hant': { talk: '和她聊天', age: '您已年滿18歲嗎？', gacha: '抽10次', tab: '抽卡', name: '唯井真尋' },
  en: { talk: 'Talk to her', age: 'Are you 18 or older?', gacha: 'Draw 10', tab: 'Draw', name: 'Mahiro Tadai' }
} as const;
// Korean is offered since v1.1 (SELECTABLE_LANGS); a Korean browser gets Korean.

for (const [lang, e] of Object.entries(EXPECT)) {
  test(`${lang}: switch from the menu, persists, translates flows`, async ({ page }) => {
    await passAgeGate(page, '/menu');
    await page.getByLabel('言語').selectOption(lang);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await page.goto('/#/');
    await expect(page.getByRole('link', { name: e.talk }).first()).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(e.name);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await expect(page.getByRole('link', { name: e.talk }).first()).toBeVisible();
    // no untranslated dictionary keys leak into the page
    await expect(page.locator('body')).not.toContainText(/\b(top|nav|trial|gacha|su|serial|cards)\.[a-z]+/);
    // Japanese kana should not appear in UI chrome in English (names are romanised)
    if (lang !== 'zh-Hant') expect(await page.locator('.top-panel').innerText()).not.toMatch(/[\u3040-\u30ff]/);
  });
}

test('a Korean browser gets Korean, and Korean is offered in the picker', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'ko-KR' });
  const page = await ctx.newPage();
  await page.goto('/#/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.locator('select option[value="ko"]').first()).toHaveCount(1);
  await ctx.close();
});

test('first visit follows the browser language (Traditional Chinese)', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'zh-TW' });
  const page = await ctx.newPage();
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: EXPECT['zh-Hant'].age })).toBeVisible();
  await ctx.close();
});

test('language can be changed on the age gate and member pages are translated', async ({ page }) => {
  await page.goto('/#/');
  await page.getByLabel('言語').selectOption('en');
  await expect(page.getByRole('heading', { name: EXPECT.en.age })).toBeVisible();
  await page.getByRole('button', { name: 'Yes, I am 18 or older' }).click();
  await page.getByRole('link', { name: 'Skip' }).click();
  await page.goto('/#/signup?next=/me/gacha');
  await page.getByLabel('Email address').fill('a@example.com');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('Verification code').fill('123456');
  await page.getByRole('button', { name: /^Go to / }).click();
  await expect(page.getByRole('button', { name: /Draw 10/ })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: EXPECT.en.tab, exact: true })).toBeVisible();
});

test('chat replies come back in the selected language', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'en', user: { via: 'email', nickname: 'k' } }));
  });
  await page.goto('/#/me/chat');
  await page.getByLabel('Message').fill('hello');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.msg.her')).toHaveCount(2);
  await expect(page.locator('.msg.her').last()).not.toContainText(/[\u3040-\u30ff]/);
});
