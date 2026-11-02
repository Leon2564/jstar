import { test, expect } from './fixtures';

/**
 * #162: the visual system's reference page, /#/design — every token and component — is the visual-regression
 * baseline. Fonts are awaited and motion is off; the threshold tolerates antialiasing only.
 */
for (const vp of [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 900 }]) {
  test(`/#/design shows every token and component — ${vp.name}`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: 'zh-TW', reducedMotion: 'reduce' });
    await ctx.addInitScript(() => localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'zh-Hant' })));
    const page = await ctx.newPage();
    await page.goto('/#/design');
    await expect(page.getByTestId('design-page')).toBeVisible();
    // Every component is there.
    for (const css of ['.js-brand', '.js-vname', '.js-label', '.js-btn-rose', '.js-btn-line', '.js-reply', '.js-input', '.js-stars', '.js-rules', '.js-corner', '.js-night', '.js-sparkles', '.js-voice', '.js-print', '.js-panel', '.js-hint', '.js-line']) {
      await expect(page.locator(css).first(), css).toBeAttached();
    }
    await page.evaluate(async () => {
      await document.fonts.ready;
      // Her photos load lazily: load them now, so the baseline has them.
      for (const i of document.images) i.loading = 'eager';
      await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((ok) => { i.onload = ok; i.onerror = ok; }))));
    });
    // Nothing wider than the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page).toHaveScreenshot(`design-${vp.name}.png`, { fullPage: true, animations: 'disabled', maxDiffPixelRatio: 0.02 });
    await ctx.close();
  });
}
// Production (a server-mode site that is not a demo) shows nothing of it: tests/unit/design.test.tsx.

test('zh-Hant: 「，。……」 come from a Traditional Chinese face on this Mac (R02)', async ({ page }) => {
  test.skip(process.platform !== 'darwin', 'the faces it names are the device\'s own: checked where PingFang TC and Songti TC are installed');
  await page.addInitScript(() => localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'zh-Hant' })));
  await page.goto('/#/design');
  await expect(page.getByTestId('design-page')).toBeVisible();
  const r = await page.evaluate(async () => {
    const loaded = async (family: string) => (await document.fonts.load(`16px '${family}'`, '「，。……」')).filter((f) => f.status === 'loaded').length;
    return { serif: await loaded('JStar Punct TC Serif'), sans: await loaded('JStar Punct TC Sans'), lineFont: getComputedStyle(document.querySelector('.js-line')!).fontFamily };
  });
  expect(r.serif).toBeGreaterThan(0);
  expect(r.sans).toBeGreaterThan(0);
  expect(r.lineFont).toMatch(/^"?JStar Punct TC Serif/);
});
