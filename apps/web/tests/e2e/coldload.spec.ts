import { test, expect } from './fixtures';

/**
 * B-N1: a member page opened straight from a link (a cold load, nothing rendered before it) must be readable. boot.js
 * marked every /me route as her room, which paints the whole document navy for good, and the light member pages
 * drew their navy text on it (1.1:1). Each page is loaded cold and every piece of its text is measured against what
 * is actually behind it (the first opaque background up its ancestors, else the document's): at least 4.5:1.
 */
const PAGES = ['/me/mypage', '/me/shop', '/me/redemptions', '/me/account/delete', '/me/gacha/history'];

for (const path of PAGES) {
  test(`cold load of ${path} keeps its text readable (≥ 4.5:1)`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, user: { via: 'email', nickname: 'kenta' } }));
    });
    await page.goto(`/#${path}`);
    await expect(page.locator('#root .page').first()).toBeVisible();
    // Past the page's fade-in, and the lazy page itself (not the Suspense fallback).
    await page.waitForFunction(() => document.querySelectorAll('#root .page h1, #root .page .hdr-title').length > 0);
    await page.waitForTimeout(400);
    expect.soft(await page.evaluate(() => document.documentElement.dataset.boot), 'boots as her room').not.toBe('room');
    const worst = await page.evaluate(() => {
      const rgba = (c: string) => { const m = c.match(/[\d.]+/g)!.map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
      const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
        const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const bgOf = (el: Element | null): { r: number; g: number; b: number } => {
        for (let e = el; e; e = e.parentElement) {
          const c = rgba(getComputedStyle(e).backgroundColor);
          if (c.a >= 0.9) return c;
        }
        return { r: 255, g: 255, b: 255 };
      };
      const out: { text: string; ratio: number }[] = [];
      const walker = document.createTreeWalker(document.querySelector('#root')!, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement!;
        const text = (n.textContent ?? '').trim();
        if (!text || el.closest('[aria-hidden="true"], .sr-only, button:disabled, svg, option')) continue;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (!r.width || !r.height || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const bg = bgOf(el);
        const fg0 = rgba(cs.color);
        // Text drawn with alpha is blended into what is behind it.
        const fg = { r: fg0.r * fg0.a + bg.r * (1 - fg0.a), g: fg0.g * fg0.a + bg.g * (1 - fg0.a), b: fg0.b * fg0.a + bg.b * (1 - fg0.a) };
        const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
        out.push({ text: text.slice(0, 30), ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 });
      }
      return out.sort((a, b) => a.ratio - b.ratio).slice(0, 5);
    });
    expect(worst.length, 'some text was measured').toBeGreaterThan(0);
    expect(worst[0].ratio, `lowest contrast: ${JSON.stringify(worst)}`).toBeGreaterThanOrEqual(4.5);
  });
}
