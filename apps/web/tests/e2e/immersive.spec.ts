import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * The immersive home and the generated media, tested the way a visitor meets them:
 * something beautiful paints at once, it moves without getting in the way, it never breaks,
 * and it holds back for reduced motion, hidden tabs and slow connections.
 */

async function enter(page: Page, path = '/') {
  await page.addInitScript(() => {
    try {
      const s = JSON.parse(localStorage.getItem('jstar.v1') || 'null') || {};
      if (!s.ageOk) localStorage.setItem('jstar.v1', JSON.stringify({ ...s, v: 1, ageOk: true, lang: 'ja' }));
    } catch { /* storage blocked */ }
  });
  await page.goto(`/#${path}`);
}
const current = (page: Page) => page.locator('nav[aria-label="ご本人を選ぶ"] button[aria-pressed="true"]');
const scenes = (page: Page) => page.locator('.l-scene [data-scene]');
/**
 * Real entrance clips (`<star>-enter-*`, #24) play once before her hero loop; jump each to its last frame so the
 * loop takes over, the way it does on its own after five seconds.
 */
async function pastEntrance(page: Page, star = '') {
  // (An empty [attr^=""] never matches in CSS, so the talent prefix is added only when given.)
  const who = star ? `[data-scene^="${star}-"]` : '';
  const hero = page.locator(`.l-scene [data-scene*="-hero"]${who}`); // -hero- or -herohd- (#24)
  const enter = page.locator(`.l-scene [data-scene*="-enter-"]${who} video`);
  await expect.poll(async () => {
    // Finish the entrance the way the page hears it: an `ended` event. A seek does nothing while a slow CI runner
    // has not loaded the clip yet; the page's own 5 s stall and 20 s cap are the fallbacks the timeout covers.
    if (await enter.count()) await enter.first().evaluate((v: HTMLVideoElement) => v.dispatchEvent(new Event('ended'))).catch(() => {});
    return hero.count();
  }, { timeout: 25_000 }).toBe(1);
}

test.describe('home stage', () => {
  test('paints a poster immediately, then plays a muted inline loop', async ({ page }) => {
    await enter(page);
    const poster = page.locator('.l-scene img.scene-poster').last();
    await expect(poster).toBeVisible();
    await expect.poll(() => poster.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await pastEntrance(page);
    const video = page.locator('.l-scene video');
    await expect(video).toHaveCount(1);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.2);
    expect(await video.evaluate((v: HTMLVideoElement) => ({ muted: v.muted, inline: v.playsInline, loop: v.loop }))).toEqual({ muted: true, inline: true, loop: true });
  });

  test('decodes one video at a time, even while switching', async ({ page }) => {
    await enter(page);
    await expect(page.locator('.l-scene video')).toHaveCount(1);
    await page.keyboard.press('ArrowRight');
    expect(await page.locator('.l-scene video').count()).toBeLessThanOrEqual(1);
    await page.waitForTimeout(1000);
    await expect(scenes(page)).toHaveCount(1);
  });

  test('arrow keys switch the whole screen; the name is announced', async ({ page }) => {
    await enter(page);
    await expect(current(page)).toHaveAccessibleName('唯井まひろ');
    await page.keyboard.press('ArrowRight');
    await expect(current(page)).toHaveAccessibleName('八木奈々');
    await expect(page.locator('section.top')).toHaveAttribute('data-star', 'nana');
    await expect(page.locator('p[aria-live="polite"]').filter({ hasText: '八木奈々' })).toHaveCount(1);
    await page.waitForTimeout(950);
    await page.keyboard.press('ArrowLeft');
    await expect(current(page)).toHaveAccessibleName('唯井まひろ');
  });

  test('a burst of wheel events turns one screen, not five, and the talent stays', async ({ page }) => {
    test.skip(!!page.viewportSize() && page.viewportSize()!.width < 700, 'wheel paging is a desktop gesture');
    await enter(page);
    await expect(current(page)).toHaveAccessibleName('唯井まひろ');
    await page.locator('#fp-stars').waitFor({ state: 'attached' });
    await page.mouse.move(400, 400);
    for (let k = 0; k < 5; k++) await page.mouse.wheel(0, 120);
    await expect(page.locator('.home-fp')).toHaveAttribute('data-sec', 'stars');
    await page.waitForTimeout(600);
    await expect(page.locator('.home-fp')).toHaveAttribute('data-sec', 'stars');
    await expect(page).toHaveURL(/#\/\?s=stars$/);
    await expect(current(page)).toHaveAccessibleName('唯井まひろ');
  });

  test('swipe switches on a phone; tapping the call to action does not', async ({ page }) => {
    await enter(page);
    const main = page.locator('section.top');
    const box = (await main.boundingBox())!;
    const swipe = async (fromX: number, toX: number, y: number) => {
      await main.dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: fromX, clientY: y }], changedTouches: [{ identifier: 1, clientX: fromX, clientY: y }] });
      await main.dispatchEvent('touchend', { touches: [], changedTouches: [{ identifier: 1, clientX: toX, clientY: y }] });
    };
    await swipe(box.width * 0.8, box.width * 0.2, box.height * 0.35);
    await expect(current(page)).toHaveAccessibleName('八木奈々');
    await page.waitForTimeout(950);
    await swipe(box.width * 0.2, box.width * 0.8, box.height * 0.35);
    await expect(current(page)).toHaveAccessibleName('唯井まひろ');
    await page.getByRole('link', { name: '彼女と話す' }).first().click();
    await expect(page).toHaveURL(/#\/pick$/);
  });

  test('rotation holds while the visitor reads the panel', async ({ page }) => {
    test.skip(!!page.viewportSize() && page.viewportSize()!.width < 700, 'hover is a desktop behaviour');
    await page.clock.install();
    await enter(page);
    await expect(current(page)).toHaveAccessibleName('唯井まひろ');
    await page.locator('.top-panel').hover();
    await page.clock.runFor(20_000);
    await expect(current(page)).toHaveAccessibleName('唯井まひろ');
    await page.mouse.move(5, 5);
    await page.clock.runFor(7_500);
    await expect(current(page)).toHaveAccessibleName('八木奈々');
  });

  test('reduced motion: stills only, no video, no rotation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await enter(page);
    await expect(page.locator('.l-scene img.scene-poster')).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.locator('video')).toHaveCount(0);
    await expect(current(page)).toHaveAccessibleName('唯井まひろ');
    const px = await page.locator('section.top').evaluate((el) => getComputedStyle(el).getPropertyValue('--px').trim());
    expect(px === '' || px === '0').toBe(true);
  });

  test('pauses the video while the tab is hidden', async ({ page }) => {
    await enter(page);
    const video = page.locator('.l-scene video');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused), { timeout: 10_000 }).toBe(true);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  });

  test('a missing video leaves the poster in place and breaks nothing', async ({ page }) => {
    await page.route('**/media/**/*.mp4', (r) => r.fulfill({ status: 404, body: '' }));
    await enter(page);
    const poster = page.locator('.l-scene img.scene-poster');
    await expect(poster).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.locator('.scene.is-playing')).toHaveCount(0);
    await expect(page.getByRole('link', { name: '彼女と話す' }).first()).toBeVisible();
  });

  test('pointer parallax moves the layers (desktop)', async ({ page }) => {
    test.skip(!!page.viewportSize() && page.viewportSize()!.width < 700, 'no pointer parallax on touch');
    await enter(page);
    await page.mouse.move(10, 10);
    await page.mouse.move(page.viewportSize()!.width - 10, page.viewportSize()!.height - 10, { steps: 5 });
    await expect.poll(() => page.locator('.home-fp').evaluate((el) => Number(el.style.getPropertyValue('--px')))).toBeGreaterThan(0.3);
  });

  test('keeps a phone visit light: posters and one small video', async ({ page }) => {
    test.skip(!!page.viewportSize() && page.viewportSize()!.width > 700, 'mobile budget');
    let bytes = 0;
    const videos: string[] = [];
    page.on('response', async (r) => {
      if (!r.url().includes('/media/')) return;
      if (r.url().endsWith('.mp4')) videos.push(r.url());
      bytes += Number(r.headers()['content-length'] ?? 0);
    });
    await enter(page);
    // Her 5 s entrance is the only clip at first; the loop is fetched when it ends. Measure only while the entrance
    // is still on stage: on a busy machine it can start (and end) before enter() returns, so a fixed wait after
    // enter() sometimes counted the loop as well. Snapshots taken during the entrance are what a phone loads first.
    const onStage = page.locator('.l-scene [data-scene*="-enter-"]');
    let seen = { videos: [...videos], bytes };
    for (let t = 0; t < 3000; t += 200) {
      if (await onStage.count()) seen = { videos: [...videos], bytes };
      await page.waitForTimeout(200);
    }
    expect(new Set(seen.videos.map((u) => u.split('/').slice(-2, -1)[0])).size).toBeLessThanOrEqual(1);
    expect(seen.videos.some((u) => /av1-1920/.test(u) && !/16x9/.test(u))).toBe(false);
    expect(seen.bytes).toBeLessThan(3 * 1024 * 1024);
  });
});

test('every talent appears in person in her own scene, one after another', async ({ page }) => {
  await enter(page);
  const top = page.locator('section.top');
  // Hold the auto-rotation (it pauses while the pointer is on the panel): with entrance clips the first talent
  // can already have rotated on by the time a slow CI page has loaded, so step to each one with the arrow key.
  await page.locator('.top-panel').hover();
  const stars = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'];
  for (const [i, star] of stars.entries()) {
    for (let n = 0; n < stars.length && (await top.getAttribute('data-star')) !== star; n++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(950); }
    await expect(top).toHaveAttribute('data-star', star);
    await expect(page.locator('section.top')).toHaveClass(/in-scene/);
    await pastEntrance(page, star);
    await expect(page.locator(`.l-scene [data-scene^="${star}-hero"]`)).toHaveCount(1);
    if (i < stars.length - 1) { await page.waitForTimeout(950); await page.keyboard.press('ArrowRight'); }
  }
});

test.describe('layout holds at every size', () => {
  for (const vp of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    test(`${vp.width}×${vp.height}: the call to action is on screen and nothing overflows`, async ({ page }) => {
      await page.setViewportSize(vp);
      await enter(page);
      const cta = page.getByRole('link', { name: '彼女と話す' }).last();
      await expect(cta).toBeInViewport();
      await expect(page.getByRole('link', { name: 'シリアルコードを入力' }).first()).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      // With her in the scene there is no separate frame; otherwise the frame never covers the copy.
      if (await page.locator('section.top.in-scene').count()) {
        await expect(page.locator('.talent-frame')).toHaveCount(0);
        return;
      }
      const panel = await page.locator('.top-panel').boundingBox();
      const frame = await page.locator('.talent-frame').boundingBox();
      if (vp.width >= 1024 && panel && frame) expect(frame.x).toBeGreaterThanOrEqual(panel.x + panel.width - 1);
      const news = page.locator('.top-news');
      if (vp.width >= 1280 && frame) {
        const n = (await news.boundingBox())!;
        expect(frame.x + frame.width <= n.x || frame.y + frame.height <= n.y).toBe(true);
      }
    });
  }
});

test.describe('generated assets elsewhere', () => {
  test('JSTARS: costume and keepsake turn around by drag and by keyboard', async ({ page }) => {
    await enter(page, '/stars');
    const costume = page.getByRole('slider', { name: 'まひろの衣装' });
    await expect(costume).toBeVisible();
    await expect(costume).toHaveAttribute('aria-valuenow', '1');
    await costume.focus();
    await page.keyboard.press('ArrowRight');
    await expect(costume).toHaveAttribute('aria-valuenow', '2');
    const box = (await costume.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(costume).not.toHaveAttribute('aria-valuenow', '2');
    // Turning must not also switch the talent (arrow keys are shared with the page).
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('唯井まひろ');
    await expect(page.getByText('AI').first()).toBeVisible();
    // Only confirmed profile data is shown: no pending placeholders, no empty autograph box.
    await expect(page.getByText('事務所確認中')).toHaveCount(0);
    await expect(page.getByText('直筆サイン')).toHaveCount(0);
    await expect(page.getByText('[　　]')).toHaveCount(0);
  });

  test('companion home in the morning: she is there (never an empty room), graded for the hour', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-02T08:30:00'));
    await page.addInitScript(() => localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'ja', user: { via: 'email', nickname: 'kenta' }, star: 'mahiro' })));
    await page.goto('/#/me/home');
    await expect(page.locator('[data-scene^="mahiro-hero"], [data-scene="mahiro-breath-9x16"]')).toHaveCount(1);
    await expect(page.locator('.home.tod-morning')).toHaveCount(1);
    await expect(page.locator('.media-tag')).toHaveCount(0);
  });

  test('companion home at night shows her in her own scene', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-02T22:30:00'));
    await page.addInitScript(() => localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'ja', user: { via: 'email', nickname: 'kenta' }, star: 'nana' })));
    await page.goto('/#/me/home');
    await expect(page.locator('[data-scene="nana-herohd-9x16"], [data-scene="nana-hero-9x16"]')).toHaveCount(1);
    // She is in the video, so the empty-scene placeholder frame is gone.
    await expect(page.locator('.home-talent')).toHaveCount(0);
  });

  test('the loading screen sits in the starry night and still lets you skip', async ({ page }) => {
    // The screen advances by itself in about a second: stop the clock (install() alone keeps it running) to look at it.
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 1000);
    await enter(page, '/loading?next=/stars');
    await expect(page.locator('[data-scene="loading-stars"]')).toHaveCount(1);
    await page.getByRole('link', { name: 'スキップ' }).click();
    await expect(page).toHaveURL(/#\/stars$/);
  });

  test('the draw result plays the star burst once, behind the cards', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'ja', user: { via: 'email', nickname: 'kenta' }, lastPull: ['s1-mahiro-01'], owned: { 's1-mahiro-01': 1 } })));
    await page.goto('/#/me/gacha/result');
    const burst = page.locator('[data-scene="reveal-burst"] video');
    await expect(burst).toHaveCount(1);
    expect(await burst.evaluate((v: HTMLVideoElement) => v.loop)).toBe(false);
    await page.getByRole('button', { name: 'すべてめくる' }).click();
    await expect(page.getByRole('link', { name: 'カードを見る' })).toBeVisible();
  });
});
