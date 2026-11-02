import type { Page } from '@playwright/test';
import { test, expect, passAgeGate, signUpByEmail } from './fixtures';

/**
 * The v1.1.3 verification's public- and member-page items that only a real layout shows (A-L4, A slow-4G LCP,
 * B-L6, B-P1, B-P3), on the built app.
 */
const box = (page: Page, sel: string) => page.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });

test.describe('A-L4: 44 px targets', () => {
  test('desktop: the home\'s section dots and header 和她聊天, the 體驗 pill', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await passAgeGate(page);
    await page.locator('.fp-dots button').first().waitFor();
    for (const h of await page.locator('.fp-dots button').evaluateAll((l) => l.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
    expect((await box(page, '.hdr-cta')).h).toBeGreaterThanOrEqual(44);
    expect((await box(page, '.demo-go')).h).toBeGreaterThanOrEqual(44);
  });

  for (const [w, h] of [[390, 844], [1440, 900]]) {
    test(`${w}×${h}: the sign-up's legal links, their lines kept`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await passAgeGate(page, '/signup');
      const links = page.locator('.login-legal a');
      await links.first().waitFor();
      for (const r of await links.evaluateAll((l) => l.map((e) => e.getBoundingClientRect().height))) expect(r).toBeGreaterThanOrEqual(44);
      // The paragraph keeps its own line height (the margin takes the padding back).
      const lh = await page.locator('.login-legal').evaluate((p) => p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight));
      expect(lh).toBeLessThan(4.6);
    });
  }
});

test('A (slow 4G LCP): her first line and name are there on first paint, no fade; the next star\'s fade in', async ({ page }) => {
  await passAgeGate(page);
  const line = page.locator('.top-line');
  await line.waitFor();
  expect(await line.getAttribute('class')).toBe('top-line');
  expect(await page.locator('.top-name').getAttribute('class')).toBe('top-name');
  expect(await line.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
  await page.locator('.roster button').nth(1).click();
  await expect(page.locator('.top-line')).toHaveClass(/fade-in/);
});

test('B-L6: the sign-up\'s vertical romaji and the iPhone guide\'s step numbers are 12 px or more', async ({ page }) => {
  await passAgeGate(page, '/signup');
  const ro = page.locator('.login-name .js-vname-ro');
  await ro.waitFor();
  expect(parseFloat(await ro.evaluate((e) => getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(12);
  const n = await page.evaluate(() => { const s = document.createElement('span'); s.className = 'push-step-n'; document.body.append(s); const f = getComputedStyle(s).fontSize; s.remove(); return parseFloat(f); });
  expect(n).toBeGreaterThanOrEqual(12);
});

for (const [w, h] of [[320, 640], [390, 844], [1440, 900]]) {
  test(`B-P1 ${w}×${h}: 「ログアウトしました」 sits under the home's 「01 / 05」, never over it`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await passAgeGate(page);
    await signUpByEmail(page, '/me/mypage');
    await page.getByRole('button', { name: 'ログアウト' }).click();
    const toast = page.locator('.toast');
    await toast.waitFor();
    const t = await box(page, '.toast');
    const eyebrow = await box(page, '.top-name .eyebrow');
    expect(t.top).toBeGreaterThanOrEqual(eyebrow.bottom);
    // …and over none of the home's buttons.
    const cta = await box(page, '.top-panel .btn');
    expect(t.bottom).toBeLessThan(cta.top);
  });
}

for (const [w, h] of [[390, 844], [1440, 900]]) {
  test(`B-P3 ${w}×${h}: the gacha result's card titles never leave one character alone on a line`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    const pull = ['s1-mahiro-03', 's1-nana-12', 's1-unpai-20', 's1-alice-05', 's1-eimi-27', 's1-mahiro-01', 's1-nana-02', 's1-unpai-15', 's1-alice-22', 's1-eimi-30'];
    await page.addInitScript((p) => localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'ja', birthdayOk: true, user: { via: 'email', nickname: 'kenta' }, lastPull: p, owned: Object.fromEntries(p.map((id) => [id, 1])) })), pull);
    await page.goto('/#/me/gacha/result');
    await page.getByRole('button', { name: 'スキップ' }).click();
    const titles = page.locator('.rv-grid .card .cap span');
    await expect(titles).toHaveCount(10);
    await page.waitForTimeout(600);
    // Each title's lines, by the characters' own boxes: never a last line of one character.
    const lines = await titles.evaluateAll((all) => all.map((el) => {
      const text = el.firstChild as Text | null;
      if (!text || text.nodeType !== 3) return [];
      const tops: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const r = document.createRange(); r.setStart(text, i); r.setEnd(text, i + 1);
        const b = r.getBoundingClientRect();
        if (b.width > 0) tops.push(Math.round(b.top));
      }
      const rows = [...new Set(tops)];
      return rows.map((t) => tops.filter((x) => x === t).length);
    }));
    for (const rows of lines) if (rows.length > 1) expect(rows[rows.length - 1], JSON.stringify(lines)).toBeGreaterThan(1);
  });
}
