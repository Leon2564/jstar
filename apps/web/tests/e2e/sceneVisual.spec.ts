import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * #17, #21: the scene player and the log-in page in A2「夜畫廊」 (docs/design-system.md), as her room's visual test does it
 * (tests/e2e/roomVisual.spec.ts): her clip and pictures hidden over a flat night, the layer compared — the top band, her
 * words in the subtitle band, his numbered hairline choices, the input; the log-in column and its one rose block.
 * And the rule that matters most, measured: nothing of the scene's layer reaches her face, and うんぱい's stream runs
 * his comments in lanes under it.
 */
const MEMBER = { v: 1, ageOk: true, lang: 'zh-Hant', user: { via: 'email', nickname: 'kenta' }, star: 'mahiro' };
const NIGHT = new Date('2026-10-01T23:50:00+08:00');
const FLAT = '.scn-stage, .scn-stage *, .scn-lipsync, .login-art { visibility: hidden !important; } .scn, .login, body { background: #1b1e3d !important; }';

async function open(page: Page, path: string, state: object = MEMBER) {
  await page.clock.setFixedTime(NIGHT);
  await page.addInitScript((s) => {
    (window as unknown as { __E2E__: boolean }).__E2E__ = true;
    localStorage.setItem('jstar.v1', JSON.stringify(s));
  }, state);
  await page.goto(`/#${path}`);
}
async function shot(page: Page, name: string, mask: string[] = []) {
  await page.evaluate(() => document.fonts.ready);
  const tag = await page.addStyleTag({ content: FLAT });
  await expect(page).toHaveScreenshot(name, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.003, mask: mask.map((m) => page.locator(m)), maskColor: '#c2185b' });
  await tag.evaluate((el) => el.remove());
}

for (const [w, h] of [[390, 844], [1440, 900]] as const) {
  test.describe(`${w}×${h}`, () => {
    test.use({ viewport: { width: w, height: h }, locale: 'zh-TW', timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' });

    test('the scene: her words in the subtitle band, his numbered choices on hairlines', async ({ page }) => {
      await open(page, '/me/scene/demo-evening');
      const choices = page.getByTestId('scene-choices');
      await expect(choices).toBeVisible({ timeout: 15_000 });
      // A2: numbered double-rule lines, ≥ 44 px, no pills; hairline icons in 44 px targets at the top.
      const look = await page.evaluate(() => {
        const r = [...document.querySelectorAll<HTMLElement>('[data-testid="scene-choices"] button')].map((b) => ({ h: b.getBoundingClientRect().height, radius: parseFloat(getComputedStyle(b).borderTopLeftRadius), n: b.querySelector('kbd')?.textContent }));
        const icons = [...document.querySelectorAll<HTMLElement>('.scn-top .scn-icon')].map((b) => b.getBoundingClientRect()).map((q) => Math.min(q.width, q.height));
        return { r, icons };
      });
      expect(look.r.length).toBeGreaterThan(1);
      for (const [i, c] of look.r.entries()) expect(c).toEqual({ h: expect.any(Number), radius: 2, n: String(i + 1) });
      expect(Math.min(...look.r.map((c) => c.h))).toBeGreaterThanOrEqual(44);
      expect(Math.min(...look.icons)).toBeGreaterThanOrEqual(44);
      await shot(page, `scene-choice-${w}.png`, ['[data-testid="scene-countdown"]']);
    });

    test('うんぱい\'s stream: his comments run under her face', async ({ page }) => {
      await open(page, '/me/scene/private-stream', { ...MEMBER, star: 'unpai' });
      await expect(page.locator('.scn-dm')).toBeAttached({ timeout: 15_000 });
      // Her face box in the stream's clips ends at 53 % (9:16) / 54 % (16:9) of the clip, cropped to cover at 50 % 30 %.
      const r = await page.evaluate(() => {
        const W = innerWidth, H = innerHeight, portrait = H >= W, ar = portrait ? 9 / 16 : 16 / 9;
        const ih = Math.max(W, H * ar) / ar;
        const face = (H - ih) * 0.3 + (portrait ? 0.53 : 0.54) * ih;
        return { face, lanes: document.querySelector('.scn-dm')!.getBoundingClientRect().top };
      });
      expect(r.lanes).toBeGreaterThan(r.face);
    });

    test('log-in: her picture and line on the night, the e-mail form, legal text ≥ 12 px', async ({ page }) => {
      await open(page, '/signup?mode=login', { v: 1, ageOk: true, lang: 'zh-Hant' });
      await expect(page.getByRole('button', { name: '傳送驗證碼' })).toBeVisible();
      const sizes = await page.evaluate(() => ({
        legal: Math.min(...[...document.querySelectorAll<HTMLElement>('.login-legal, .login-legal a')].map((e) => parseFloat(getComputedStyle(e).fontSize))),
        note: parseFloat(getComputedStyle(document.querySelector('.login-note')!).fontSize)
      }));
      expect(sizes.legal).toBeGreaterThanOrEqual(12);
      expect(sizes.note).toBeGreaterThanOrEqual(14);
      await shot(page, `login-${w}.png`);
    });
  });
}
