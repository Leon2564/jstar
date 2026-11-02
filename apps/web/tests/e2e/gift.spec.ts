import { test, expect } from './fixtures';

// The gift sheet (#77) at the acceptance viewport (390×844), in the three launch languages (prototype mode: the same
// shared rules as the API). All twenty gifts, the send button and the note fit without pushing the page sideways,
// and giving one puts her reaction in the chat.
const LANGS = {
  ja: { open: 'プレゼント', title: '奈々にプレゼント', sent: '焼肉ディナーを贈りました', known: '奈々の好きなもの' },
  'zh-Hant': { open: '送禮物', title: '送禮物給奈奈', sent: '送出了燒肉晚餐', known: '奈奈喜歡的東西' },
  en: { open: 'Gift', title: 'A gift for Nana', sent: 'You gave her: Yakiniku dinner', known: 'Nana likes' }
} as const;

for (const [lang, l] of Object.entries(LANGS)) {
  test(`${lang}: the gift sheet fits a 390×844 phone and her reaction joins the chat`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((lng) => {
      localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: lng, user: { via: 'email', nickname: 'kenta' }, star: 'nana', points: 1030 }));
    }, lang);
    // Midday JST, like relationship.spec: the flow never depends on the hour (from 17:00 her room may open on #55).
    await page.clock.setFixedTime(new Date('2026-11-01T03:00:00.000Z'));
    await page.goto('/#/me/chat');
    await page.getByTestId('gift-open').click();
    const sheet = page.getByTestId('gift-sheet');
    await expect(sheet).toHaveAttribute('aria-label', l.title);
    await expect(page.getByTestId('gift-yakiniku')).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    for (const id of ['gift-bouquet', 'gift-night-view', 'gift-send', 'gift-points']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.x, id).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, id).toBeLessThanOrEqual(390);
    }
    // The sheet itself stays within the screen; only its own content may scroll.
    const panel = (await page.locator('.gift-sheet').boundingBox())!;
    expect(panel.y).toBeGreaterThanOrEqual(0);
    expect(panel.y + panel.height).toBeLessThanOrEqual(844 + 1);

    await page.getByTestId('gift-yakiniku').click();
    await page.getByTestId('gift-send').click();
    await expect(sheet).toBeHidden();
    await expect(page.locator('.msg.system').last()).toHaveText(l.sent);
    await expect(page.locator('.msg.her').last()).toBeVisible();
    // She loved it: now he knows, and the sheet says so.
    await page.getByTestId('gift-open').click();
    await expect(page.getByTestId('gift-known')).toContainText(l.known);
  });
}
