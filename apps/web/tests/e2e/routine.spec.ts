import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * Who's home now (#60) on the companion home at 390×844: five faces, each with her presence on JST, 奈々 asleep at
 * 03:00 and still one tap away, and nothing in the strip ticking between minutes.
 */

const MEMBER = { v: 1, ageOk: true, lang: 'ja', user: { via: 'email', nickname: 'kenta' } };
async function openHome(page: Page, state: object) {
  await page.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('jstar.v1', JSON.stringify(s)); sessionStorage.setItem('seeded', '1'); } }, state);
  await page.goto('/#/me/home');
}
const STARS = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'];

test.describe("who's home now", () => {
  test('03:00 JST: all five have a status, 奈々 sleeps (dimmed, still tappable) and wakes up sleepily', async ({ page }) => {
    // Pinned: the home's own time-of-day moments (the #55 confession opens from 17:00 JST) must not move the test.
    await page.clock.setFixedTime(new Date('2026-10-14T03:00:00+09:00'));
    await openHome(page, { ...MEMBER, star: 'nana' });
    await expect(page.getByTestId('greeting')).toHaveText(/寝てた/);
    // Who's home lives in her room's 目錄 (A2 room v2): under each name of the star switcher.
    await page.getByTestId('room-index-open').click();
    const presences = await Promise.all(STARS.map((s) => page.getByTestId(`presence-${s}`).getAttribute('data-presence')));
    expect(presences).toEqual(['home', 'asleep', 'home', 'home', 'home']);
    await expect(page.getByTestId('presence-nana')).toContainText('おやすみ');
    await expect(page.locator('.js-star.dim')).toHaveCount(1);
    await expect(page.getByTestId('star-rule-nana')).toHaveClass(/dim/);
    await expect(page.getByTestId('now-line')).toContainText('もう寝てる');
    await expect(page.getByTestId('now-line')).toContainText('日本 03:00');

    // Fits a phone: every name and its tag in view, side by side, the menu still there, no sideways scroll.
    const boxes = await Promise.all(STARS.map(async (s) => (await page.getByTestId(`presence-${s}`).boundingBox())!));
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].x, STARS[i]).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width);
    for (const s of STARS) await expect(page.getByTestId(`presence-${s}`)).toBeInViewport();
    await expect(page.getByRole('link', { name: 'メニュー' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/routine-390.png' });

    // Her dimmed name is a button like the others: tapping it opens her room (and the 目錄 closes).
    await page.getByTestId('star-rule-alice').click();
    await expect(page.getByTestId('room-index')).toHaveCount(0);
    await page.getByTestId('room-index-open').click();
    await expect(page.getByTestId('star-rule-alice')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('star-rule-nana').click();
    await expect(page.getByTestId('greeting')).toHaveText(/寝てた/);
    await page.getByTestId('room-index-open').click();
    await expect(page.getByTestId('star-rule-nana')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the strip stays still between minutes', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-14T21:30:10+09:00'));
    await openHome(page, { ...MEMBER, star: 'unpai' });
    await page.getByTestId('room-index-open').click();
    await expect(page.getByTestId('now-line')).toContainText('夜さんぽ配信中');
    const mutations = await page.evaluate(() => new Promise<number>((res) => {
      let n = 0;
      const mo = new MutationObserver((l) => { n += l.length; });
      for (const el of [document.querySelector('.room2-presence'), document.querySelector('[data-testid="now-line"]')]) {
        if (el) mo.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
      }
      setTimeout(() => { mo.disconnect(); res(n); }, 3000);
    }));
    expect(mutations).toBe(0);
  });
});

test.describe('desktop 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
  test("who's home now reads on a desktop", async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-14T14:00:00+09:00'));
    await openHome(page, { ...MEMBER, star: 'eimi' });
    await page.getByTestId('room-index-open').click();
    await expect(page.getByTestId('now-line')).toContainText('お仕事中');
    await expect(page.getByTestId('presence-alice')).toContainText('おうち');
    await page.screenshot({ path: 'test-results/routine-1440.png' });
  });
});
