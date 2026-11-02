import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { loaderPosters } from '../../src/data/heroMedia';

/**
 * The 3D home (#home-3d): depth layers over the approved first screen, her entrance and reactions (with and without
 * the clips the video stream is still producing), tapping her, the playable draw, replies that start a chat, voices.
 */

const VISITOR = { v: 1, ageOk: true, lang: 'ja' };
async function open(page: Page, path: string, extra: Record<string, unknown> = {}) {
  await page.addInitScript(({ s, media }) => {
    const w = window as unknown as { __MEDIA__?: unknown };
    if (media) w.__MEDIA__ = media;
    if (!sessionStorage.getItem('seeded')) { localStorage.setItem('jstar.v1', JSON.stringify(s)); sessionStorage.setItem('seeded', '1'); }
  }, { s: VISITOR, media: extra });
  await page.goto(`/#${path}`);
}
/** Stand-ins for clips not delivered yet: her breathing loop under the new id (7 s, portrait). */
const fake = (id: string) => ({
  id, category: 'character', star: 'mahiro', ratio: '9:16', poster: '/media/mahiro-breath-9x16/poster.jpg',
  sources: [{ src: '/media/mahiro-breath-9x16/h264-720x1280.mp4', type: 'video/mp4; codecs="avc1.640028"', width: 720, height: 1280 }]
});
const toEnd = (page: Page, sel: string) => page.locator(sel).evaluate((v: HTMLVideoElement) => { v.currentTime = Math.max(0, (v.duration || 7) - 0.15); });

/** Her real entrance clip (#24) plays first; jump it to its last frame so the hero loop takes over. */
/** Her hero loop: the HD loop (`<star>-herohd-*`, #24) when present, else the v1 hero. */
const heroSel = (star = 'mahiro', r = '16x9') => `.l-scene [data-scene="${star}-idle-${r}"], .l-scene [data-scene="${star}-herohd-${r}"], .l-scene [data-scene="${star}-hero-${r}"]`;
async function settle(page: Page, star = 'mahiro', r = '16x9') {
  await expect.poll(async () => {
    const sel = `.l-scene [data-scene="${star}-enter-${r}"] video`;
    // Finish it the way the page hears it (`ended`): a seek does nothing before a slow runner has loaded the clip.
    if (await page.locator(sel).count()) await page.locator(sel).evaluate((v: HTMLVideoElement) => v.dispatchEvent(new Event('ended'))).catch(() => {});
    return page.locator(heroSel(star, r)).count();
  }, { timeout: 25_000 }).toBe(1);
}

test('at rest the first screen is the approved one; depth layers sit behind and in front of her', async ({ page }) => {
  await open(page, '/');
  await settle(page);
  await expect(page.locator(heroSel())).toHaveCount(1);
  await expect(page.locator('.stage-cam .l-world img.world-img')).toHaveCount(1);
  await expect(page.locator('.stage-cam .l-front .rays')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('唯井まひろ');
  await expect(page.getByRole('link', { name: '彼女と話す' }).last()).toBeInViewport();
});

test('tap her: her line appears beside her with her voice; the hint shows once; taps cool down', async ({ page }) => {
  await open(page, '/');
  const voice = page.waitForRequest(/\/voice\/greet\/mahiro-(morning|day|evening|night)\.mp3/);
  const her = page.getByRole('button', { name: 'まひろに触れる' });
  await expect(her.getByText('タップしてみて')).toBeAttached();
  await her.click();
  await voice;
  const say = page.getByTestId('say');
  await expect(say).toBeVisible();
  await expect(say).not.toBeEmpty();
  await expect(her.getByText('タップしてみて')).toHaveCount(0);
  const first = await say.innerText();
  await her.click({ force: true }); // inside the cool-down: nothing changes
  await expect(say).toHaveText(first);
  // She is not covered by her own words: the subtitle stays clear of the face area.
  const b = (await say.boundingBox())!;
  const h = (await her.boundingBox())!;
  expect(b.y).toBeGreaterThan(h.y + h.height * 0.35);
  await page.reload();
  await expect(page.getByRole('button', { name: 'まひろに触れる' }).getByText('タップしてみて')).toHaveCount(0);
});

test('with reaction clips, a tap crossfades one in and returns to her loop when it ends', async ({ page }) => {
  await open(page, '/', { 'mahiro-react-a-9x16': fake('mahiro-react-a-9x16') });
  // Reactions wait for her entrance (a real clip since #24) to hand over to the hero loop.
  await settle(page);
  const idleBefore = page.locator(`${heroSel()} video`);
  await idleBefore.evaluate((video: HTMLVideoElement) => {
    video.currentTime = Math.min(3, Math.max(0, (video.duration || 7) / 2));
  });
  await page.getByRole('button', { name: 'まひろに触れる' }).click();
  await expect(page.locator('.l-scene .react-clip')).toHaveCount(1);
  await expect(page.locator('.l-scene .react-clip video')).toHaveCount(1);
  await toEnd(page, '.l-scene .react-clip video');
  await expect(page.locator('.l-scene .react-clip')).toHaveCount(0);
  await expect(page.locator(heroSel())).toHaveCount(1);
  const idleAfter = page.locator(`${heroSel()} video`);
  await expect.poll(() => idleAfter.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeLessThan(1.5);
});

test('an active interaction clip never carries over to another talent', async ({ page }) => {
  await open(page, '/');
  await settle(page);
  await page.locator('.tap-her[data-zone="eyes"]').click();
  await expect(page.locator('.l-scene .react-clip[data-scene^="mahiro-react-"]')).toHaveCount(1);
  await page.getByRole('radio', { name: '深田えいみ' }).click();
  await expect(page.locator('.l-scene .depth-enter .react-clip[data-scene^="mahiro-react-"]')).toHaveCount(0);
  await expect(page.locator('.l-scene .depth-enter [data-scene="eimi-idle-16x9"]')).toHaveCount(1);
});

test('Mahiro keeps the entrance visible until the poster-free idle produces a playback frame', async ({ page }) => {
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.closest('[data-scene="mahiro-enter-16x9"]')) return Promise.resolve();
      return play.call(this);
    };
  });
  await open(page, '/');
  const enter = page.locator('.l-scene [data-scene="mahiro-enter-16x9"]');
  const idle = page.locator('.l-scene [data-scene="mahiro-idle-16x9"]');
  await expect(enter).toHaveCount(1);
  await expect(idle).toHaveCount(1);
  const [enterPosition, idlePosition] = await Promise.all([
    enter.locator('video').evaluate((video) => getComputedStyle(video).objectPosition),
    idle.locator('video').evaluate((video) => getComputedStyle(video).objectPosition)
  ]);
  expect(enterPosition).toBe(idlePosition);
  await expect(idle.locator('.scene-poster')).toHaveCount(0);
  await expect(idle.locator('video')).not.toHaveAttribute('poster', /.+/);
  await expect.poll(() => idle.locator('video').evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 10_000 }).toBeGreaterThan(1);
  await expect.poll(() => idle.locator('video').evaluate((v: HTMLVideoElement) => v.paused && v.currentTime < 0.05)).toBe(true);
  await enter.locator('video').evaluate((v: HTMLVideoElement) => v.dispatchEvent(new Event('ended')));
  await expect(enter).not.toHaveClass(/is-dissolving/);
  await expect(enter).toHaveCount(1);
  await expect(idle).toHaveCount(1);
  await expect.poll(() => idle.locator('video').evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 0)).toBe(true);
  await expect(enter).toHaveCount(0);
});

test('Eimi primes her idle first frame and dissolves into it after the entrance', async ({ page }) => {
  await open(page, '/');
  await settle(page);
  await page.getByRole('radio', { name: '深田えいみ' }).click();
  const enter = page.locator('.l-scene [data-scene="eimi-enter-16x9"]');
  const idle = page.locator('.l-scene [data-scene="eimi-idle-16x9"]');
  await expect(enter).toHaveCount(1);
  await expect(enter.locator('.scene-poster')).toHaveAttribute('src', '/media/eimi-feedback/enter-poster.png');
  await expect(idle).toHaveCount(1);
  await expect.poll(() => idle.locator('video').evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 10_000 }).toBeGreaterThan(1);
  await expect.poll(() => idle.locator('video').evaluate((v: HTMLVideoElement) => v.paused && v.currentTime < 0.05)).toBe(true);
  await enter.locator('video').evaluate((v: HTMLVideoElement) => v.dispatchEvent(new Event('ended')));
  await expect(enter).toHaveClass(/is-dissolving/);
  await expect(enter).toHaveCount(0);
  await expect(idle).toHaveCount(1);
  await expect.poll(() => idle.locator('video').evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 0)).toBe(true);
});

test('a talent switch without an entrance clip is a camera push (no clip, no stall)', async ({ page }) => {
  await open(page, '/');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.l-scene .depth-enter [data-scene^="nana-"]')).toHaveCount(1);
  await expect(page.locator('.l-scene .depth-leave')).toHaveCount(0);
  await expect(page.locator('.l-scene .hero-clip')).toHaveCount(1);
  await expect(page.locator('.l-front .push-flash')).toHaveCount(1);
});

test('talent buttons keep exactly one visual layer while switching among Mahiro, Nana and Unpai', async ({ page }) => {
  await open(page, '/');
  for (const name of ['八木奈々', 'うんぱい', '唯井まひろ']) {
    await page.getByRole('radio', { name }).click();
    await expect(page.locator('.l-scene .depth-leave')).toHaveCount(0);
    await expect(page.locator('.l-scene .hero-clip')).toHaveCount(1);
  }
});

test('try a draw: a real reveal labelled as a demo, then the way to the real one', async ({ page }) => {
  await open(page, '/?s=cards');
  await page.getByRole('button', { name: /引いてみる/ }).click();
  const demo = page.getByTestId('demo');
  await expect(demo).toContainText('体験');
  await page.getByRole('button', { name: '1枚目をめくる' }).click();
  const special = page.getByTestId('special-reveal');
  if (await special.isVisible().catch(() => false)) await page.keyboard.press('Escape');
  await expect(demo.locator('.rv.is-face')).toHaveCount(1);
  await expect(demo.getByText('体験版：結果は保存されません')).toBeVisible();
  await expect(demo.getByRole('link', { name: '無料登録して集める' })).toHaveAttribute('href', '#/signup?next=/me/gacha');
  await demo.getByRole('button', { name: 'もう一度' }).click();
  await expect(demo.locator('.rv.is-face')).toHaveCount(0);
});

test('a reply picked on the home page starts the trial chat with it', async ({ page }) => {
  await open(page, '/?s=how');
  await page.getByTestId('talk').getByRole('button', { name: 'なんて呼べばいい？' }).click();
  await expect(page).toHaveURL(/#\/trial$/);
  await expect(page.locator('.msg.me')).toHaveText('なんて呼べばいい？');
  await expect(page.getByTestId('trial-left')).toHaveText('あと2通');
});

test('for a member, a reply picked on the home page is sent in her chat', async ({ page }) => {
  // Signed in: seeded before open()'s visitor state, which then leaves it alone.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'ja', user: { via: 'email', nickname: 'k' } }));
    sessionStorage.setItem('seeded', '1');
  });
  await open(page, '/?s=how');
  await page.getByTestId('talk').getByRole('button', { name: 'なんて呼べばいい？' }).click();
  await expect(page).toHaveURL(/#\/me\/chat$/);
  await expect(page.locator('.msg.me').last()).toHaveText('なんて呼べばいい？');
  await expect(page.locator('#chat-input')).toHaveValue('');
  // Her answer arrives, and a reload does not send it again.
  await expect(page.locator('.msg.her').last()).not.toHaveText('');
  await page.reload();
  await expect(page.locator('.msg.me')).toHaveCount(1);
});

test('each talent on the STARS slats has her voice', async ({ page }) => {
  await open(page, '/?s=stars');
  const voice = page.waitForRequest(/\/voice\/greet\/nana-welcome\.mp3/);
  await page.getByRole('button', { name: '八木奈々の声を聴く' }).click();
  await voice;
});

test('the loader turns around a real percentage and opens on the stage', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'ja' })));
  // Hold back exactly what the loader waits for — the poster of the clip it loads (src/data/heroMedia.ts, both
  // orientations) — until the ring has been seen: on a fast machine it could otherwise finish before we look.
  const held = new Set([...loaderPosters(true), ...loaderPosters(false)]);
  expect(held.size).toBeGreaterThan(0);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route((url) => held.has(url.pathname), async (route) => { await gate; await route.continue(); });
  // index.html preloads that poster too, so the page's load event waits for the gate: don't wait for it here.
  await page.goto('/#/loading?next=/', { waitUntil: 'domcontentloaded' });
  const bar = page.getByRole('progressbar', { name: '読み込み' });
  await expect(bar.locator('.ring textPath')).toContainText('STAR GENESIS');
  // Real progress: without her poster it has not finished.
  expect(Number(await bar.getAttribute('aria-valuenow'))).toBeLessThan(100);
  release();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('唯井まひろ', { timeout: 8000 });
});

test.describe('desktop 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
  test('the pointer moves the layers at different depths; her words sit left of her face', async ({ page }) => {
    await open(page, '/');
    await page.mouse.move(10, 10);
    await page.mouse.move(1430, 890, { steps: 6 });
    await expect.poll(() => page.locator('.home-fp').evaluate((el) => Number(el.style.getPropertyValue('--px')))).toBeGreaterThan(0.3);
    const her = page.getByRole('button', { name: 'まひろに触れる' });
    await her.click();
    const b = (await page.getByTestId('say').boundingBox())!;
    const h = (await her.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(h.x + h.width / 2);
    const panel = (await page.locator('.top-panel').boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(panel.x + panel.width - 1);
  });
});
