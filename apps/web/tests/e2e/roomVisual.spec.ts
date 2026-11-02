import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * #172: visual regression of her room against the A2 layout (docs/design/room-v2/A2-gallery-night.png): ① opening,
 * ② her messages, ③ mid-conversation, ④ her invitation, ⑤ pure view, ⑥ her call and 目錄 at 390×844, and the
 * desktop frame at 1440×900. Her clip is hidden (it moves; the poster is media, not layout): what is compared is the
 * layer over it, its positions, type and rules, over a flat night. Words that come from her (a reply in prototype
 * mode) and the clock lines are masked: their place is compared, not their words.
 * Fonts are awaited, motion is off, the clock is fixed; over a flat night 0.3 % of the pixels is antialiasing; a 12 px shift of her words is more. Darwin baselines,
 * like /#/design (tests/e2e/design.spec.ts).
 */
const MEMBER = { v: 1, ageOk: true, lang: 'zh-Hant', user: { via: 'email', nickname: 'kenta' }, star: 'mahiro' };
const NIGHT = new Date('2026-10-01T23:50:00+08:00');
const MORNING = new Date('2026-10-02T07:00:00+08:00');
const item = (id: string, patch: Record<string, unknown>) => ({
  id, star: 'mahiro', kind: 'message', payload: { text: '午休中～今天的便當是自己做的喔。' }, deliveredAt: '2026-10-01T04:10:00.000Z', readAt: null, createdAt: '2026-10-01T04:10:00.000Z', ...patch
});

async function open(page: Page, opts: { at?: Date; state?: object; inbox?: object[] } = {}) {
  await page.clock.setFixedTime(opts.at ?? NIGHT);
  await page.addInitScript(([s, inbox]) => {
    const w = window as unknown as { __E2E__: boolean; __INBOX__?: unknown[] };
    w.__E2E__ = true;
    if (inbox) w.__INBOX__ = inbox as unknown[];
    localStorage.setItem('jstar.v1', JSON.stringify(s));
  }, [{ ...MEMBER, ...opts.state }, opts.inbox ?? null] as const);
  await page.goto('/#/me/home');
  await expect(page.getByTestId('room-composer').or(page.getByTestId('call-incoming')).first()).toBeAttached();
}
/** Her line has typed out and his choices have taken its place (B), fonts are in, and her still photos have loaded. */
async function settle(page: Page, typed = true) {
  if (typed) await expect(page.getByTestId('room')).toHaveAttribute('data-choose', '', { timeout: 15_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((ok) => { i.onload = ok; i.onerror = ok; }))));
  });
}
/** Her clip and her photos are hidden for the shot (a flat night behind the layer): the layer is what is compared. */
const NO_MEDIA = '.home-stage, .home-stage * { visibility: hidden !important; } .home, body { background: #1b1e3d !important; }';
async function shot(page: Page, name: string, mask: string[] = []) {
  // toHaveScreenshot takes a style file only (`stylePath`): the night goes in as a tag, for this shot.
  const tag = await page.addStyleTag({ content: NO_MEDIA });
  await expect(page).toHaveScreenshot(name, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.003, mask: mask.map((m) => page.locator(m)), maskColor: '#c2185b' });
  await tag.evaluate((el) => el.remove());
}

test.describe('her room v2 against A2 — 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' });

  test('① opening', async ({ page }) => {
    await open(page);
    await settle(page);
    await shot(page, 'room-1-opening.png');
  });

  test('② her messages while he was away', async ({ page }) => {
    await open(page, { inbox: [item('m1', {}), item('m2', { payload: { text: '下雨了，記得帶傘。' }, deliveredAt: '2026-10-01T02:00:00.000Z' })] });
    await expect(page.getByTestId('room-message')).toBeAttached();
    await expect(page.getByTestId('room-message-next')).toBeVisible();
    await settle(page, false);
    await page.waitForTimeout(1500);
    await shot(page, 'room-2-away.png', ['.js-print']);
  });

  test('③ mid-conversation', async ({ page }) => {
    await open(page);
    await settle(page);
    await page.getByTestId('room-replies').getByRole('button').nth(1).click();
    await expect(page.getByTestId('room-her')).toBeAttached({ timeout: 15_000 });
    await settle(page);
    // Her reply and the replies to it are hers to choose in prototype mode: their place is compared, not their words.
    await shot(page, 'room-3-mid.png', ['.room2-echo', '[data-testid="room-replies"] .js-reply']);
  });

  test('④ her invitation', async ({ page }) => {
    // By day her confession day only offers it: her line and ✦ (the test site's demo makes today the day).
    await open(page, { at: new Date('2026-10-01T13:00:00+08:00') });
    await page.getByTestId('room-index-open').click();
    await page.getByTestId('demo-menu-open').click();
    await page.getByTestId('confession-demo').click();
    await page.getByTestId('room-index-close').click();
    await expect(page.getByTestId('confession-entry')).toBeVisible();
    // The demo's note sits under the label row, never over ✦ (room.css); it comes and goes, so it is let go first.
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 8000 });
    await settle(page);
    await shot(page, 'room-4-invitation.png');
  });

  test('⑤ pure view', async ({ page }) => {
    await open(page);
    await settle(page);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('room-pure-line')).toBeVisible();
    await page.waitForTimeout(1200);
    await shot(page, 'room-5-pure.png');
  });

  test('⑥ her call', async ({ page }) => {
    await open(page, { at: MORNING, state: { star: 'nana' }, inbox: [item('w1', { star: 'nana', kind: 'wakeup', payload: { text: '醒了嗎？……我泡好茶了喔。' }, deliveredAt: '2026-10-01T22:59:00.000Z' })] });
    await expect(page.getByTestId('call-incoming')).toBeVisible();
    await settle(page, false);
    await shot(page, 'room-6-call.png');
    // 接聽: her room, her line as her first words.
    await page.getByTestId('call-incoming-answer').click();
    await expect(page.getByTestId('greeting')).toHaveText('醒了嗎？……我泡好茶了喔。');
  });

  test('目錄', async ({ page }) => {
    await open(page);
    await settle(page);
    await page.keyboard.press('m');
    await expect(page.getByTestId('room-index')).toBeVisible();
    await settle(page, false);
    // Her clock and who's home move with the real hour in Japan: compared by place.
    await shot(page, 'room-7-index.png', ['[data-testid="now-line"]', '.room2-presence']);
  });
});

test.describe('her room v2 against A2 — desktop 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1, locale: 'zh-TW', timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' });

  test('desktop: the bands (B), the key line', async ({ page }) => {
    await open(page);
    await settle(page);
    await expect(page.getByLabel('鍵盤')).toBeVisible();
    await shot(page, 'room-desktop.png');
  });

  test('desktop keys (#170, B): 1–3 answer her, M and Esc open and close 目錄, Space (nothing left to page) her pure view, Esc never leaves', async ({ page }) => {
    await open(page);
    await settle(page);
    const first = (await page.getByTestId('room-replies').getByRole('button').first().innerText()).replace(/^\d\s*/, '');
    await page.keyboard.press('1');
    await expect(page.getByTestId('room-mine')).toHaveText(`「${first}」`);
    await expect(page.getByTestId('room-her')).toBeAttached({ timeout: 15_000 });
    await settle(page);
    await page.keyboard.press('m');
    await expect(page.getByTestId('room-index')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('room-index')).toHaveCount(0);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('room-pure-line')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('room-composer')).toBeVisible();
    // Typing in her input is typing: Space and M are letters there.
    await page.locator('#room-input').fill('');
    await page.locator('#room-input').pressSequentially('m m');
    await expect(page.locator('#room-input')).toHaveValue('m m');
    await expect(page.getByTestId('room-index')).toHaveCount(0);
    await page.locator('#room-input').blur();
    // Esc never ends the call — pressed again and again she stays (owner, 10/3).
    for (let i = 0; i < 4; i++) await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
    await expect(page.getByTestId('room')).toBeVisible();
    // 離開通話 in 目錄 does; opened straight into her room, it lands on the menu, never off the site.
    await page.keyboard.press('m');
    await page.getByTestId('room-leave').click();
    await expect(page).toHaveURL(/#\/menu$/);
  });

  test('desktop 目錄', async ({ page }) => {
    await open(page);
    await settle(page);
    await page.keyboard.press('m');
    await expect(page.getByTestId('room-index')).toBeVisible();
    await settle(page, false);
    await shot(page, 'room-desktop-index.png', ['[data-testid="now-line"]', '.room2-presence']);
  });
});

/**
 * B「電影字幕」 (owner, 10/3): three bands that never meet, at every size, with her longest realistic reply (120 zh
 * characters, paged with ▼) and three choices. Her face box (data/faces.gen.json, placed through her clip's own crop)
 * is never under a word, a button, the top veil or the subtitle band's night; the name, the status, her subtitle, his
 * choices and his input never touch; the page never scrolls sideways.
 */
const LONG = '說不上來也沒關係的。有時候一整天就是這樣，淡淡的，沒有什麼特別的。 那就不用說了。現在只要待在這裡就好，我陪你一起把今天慢慢收尾。……要不要喝點溫熱的東西？我這邊正泡著一杯呢。';
// H2 (C-room 47b0fcb): 844×390, a phone on its side — her face fills the height; her words keep to the side away from it.
const SIZES = [[390, 844], [430, 932], [740, 675], [768, 1024], [1024, 768], [1280, 720], [1440, 900], [1680, 700], [1920, 1080], [844, 390]] as const;
/** In the page: her face on screen and every problem with the bands. */
const geometry = (root = '.room2') => {
  const R = (el: Element) => el.getBoundingClientRect();
  const hit = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const shown = (el: Element | null): el is HTMLElement => !!el && R(el).width > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const base = document.querySelector<HTMLElement>('.home-stage .scene.depth-enter')!;
  const img = base.querySelector<HTMLElement>('.scene-poster')!;
  const box = R(img), cs = getComputedStyle(base);
  const ar = parseFloat(cs.getPropertyValue('--ar'));
  const iw = Math.max(box.width, box.height * ar), ih = iw / ar;
  const [ox, oy] = getComputedStyle(img).objectPosition.split(' ').map(parseFloat);
  const [x0, y0, x1, y1] = cs.getPropertyValue('--face').trim().split(/\s+/).map(Number);
  const face = { left: box.left + ox + x0 * iw, top: box.top + oy + y0 * ih, right: box.left + ox + x1 * iw, bottom: box.top + oy + y1 * ih };
  const problems: string[] = [];
  if (!(face.right > face.left && face.bottom > face.top && face.top >= 0 && face.left >= 0 && face.right <= innerWidth)) problems.push('face off screen');
  const fade = parseFloat(getComputedStyle(document.querySelector('.home.room-v2')!).getPropertyValue('--fade'));
  const over: [string, DOMRect | { left: number; right: number; top: number; bottom: number }][] = [];
  document.querySelectorAll(`${root} .room2-head > *, .room2-keys, ${root} > .js-sparkles span, .room2-sub`).forEach((e) => { if (shown(e)) over.push([e.className || e.tagName, R(e)]); });
  // Her name with the soft wash under it (room.css: 32 px above and below, 112 px wide about its middle, P3).
  const lane = document.querySelector(`${root} .room2-vname`);
  if (shown(lane)) { const r = R(lane), mid = (r.left + r.right) / 2; over.push(['her name and its wash', { left: mid - 56, right: mid + 56, top: r.top - 32, bottom: r.bottom + 32 }]); }
  // The band's night is its ::before: the full width under the band, or (H2, a short landscape window) its side.
  const band = document.querySelector(`${root} .room2-bottom`);
  if (band) {
    const b = getComputedStyle(band, '::before'), r = R(band), w = parseFloat(b.width);
    const left = Number.isFinite(parseFloat(b.left)) ? r.left + parseFloat(b.left) : r.right - parseFloat(b.right) - w;
    over.push(['subtitle band and its night', w > 0 && w < innerWidth - 1 ? { left, right: left + w, top: r.top + parseFloat(b.top), bottom: innerHeight } : { left: 0, right: innerWidth, top: r.top - fade, bottom: innerHeight }]);
  }
  const night = document.querySelector(`${root} > .js-night`);
  if (night && getComputedStyle(night).backgroundImage !== 'none') over.push(['top veil', { left: 0, right: innerWidth, top: 0, bottom: parseFloat(getComputedStyle(night).getPropertyValue('--veil')) }]);
  for (const [n, r] of over) if (hit(face, r)) problems.push(`over her face: ${n}`);
  const parts = ([['status', '.room2-head'], ['name', '.room2-vname'], ['subtitle', '.room2-cap'], ['choices', '.room2-choose'], ['input', '[data-testid="room-composer"]'], ['answers', '.room2-acts'], ['keys', '.room2-keys']] as const)
    .map(([n, sel]) => [n, document.querySelector(n === 'keys' ? sel : `${root} ${sel}`)] as const).filter(([, e]) => shown(e)).map(([n, e]) => [n, R(e!)] as const);
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (hit(parts[i][1], parts[j][1])) problems.push(`${parts[i][0]} × ${parts[j][0]}`);
  const line = document.querySelector<HTMLElement>(`${root} .room2-cap .js-line`);
  if (line && line.scrollHeight > line.clientHeight + 1) problems.push('her subtitle runs past three lines');
  // H2: two lines at most in a short landscape window (room.css --sub-lines), three elsewhere.
  if (shown(line)) {
    const cap = parseInt(getComputedStyle(line).getPropertyValue('--sub-lines'), 10) || 3, lh = parseFloat(getComputedStyle(line).lineHeight);
    if (Math.round(line.clientHeight / lh) > cap) problems.push(`her subtitle is ${Math.round(line.clientHeight / lh)} lines (at most ${cap})`);
    if (innerHeight <= 500 && cap !== 2) problems.push('a short landscape window keeps three lines');
  }
  if (document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight || scrollY !== 0) problems.push('the page scrolls');
  return problems;
};

test.describe('B「電影字幕」 geometry', () => {
  test.use({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  for (const [width, height] of SIZES) {
    test(`${width}×${height}: her face is never covered and the bands never meet — her longest reply, paged, then his choices`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width, height }, locale: 'zh-TW', timezoneId: 'Asia/Taipei', ...(width < 800 || height < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { deviceScaleFactor: 1 }) });
      await ctx.addInitScript(([s, reply]) => {
        const w = window as unknown as { __E2E__: boolean; __REPLY__: string };
        w.__E2E__ = true; w.__REPLY__ = reply;
        localStorage.setItem('jstar.v1', JSON.stringify(s));
      }, [MEMBER, LONG] as const);
      const page = await ctx.newPage();
      await page.clock.setFixedTime(NIGHT);
      await page.goto('/#/me/home');
      await expect(page.getByTestId('room-replies')).toBeVisible({ timeout: 15_000 });
      await page.locator('#room-input').fill('我也說不上來');
      await page.locator('#room-input').press('Enter');
      await expect(page.getByTestId('room-her')).toHaveText(LONG.trim(), { timeout: 15_000 });
      await page.locator('#room-input').blur();
      await settle(page, false);
      // Her first page: ▼, more than one page, no choices yet.
      await expect(page.locator('.room2-cap .js-more')).toBeVisible({ timeout: 15_000 });
      expect(await page.locator('.room2-pages .js-rules i').count()).toBeGreaterThan(1);
      await expect(page.getByTestId('room-replies')).toHaveCount(0);
      expect(await page.evaluate(geometry), `${width}×${height} speaking`).toEqual([]);
      // ▼ through her pages: his choices take her subtitle's place.
      for (let i = 0; i < 6 && !(await page.getByTestId('room-replies').count()); i++) {
        // Her choices may come on their own while he pages (her last page read): then there is nothing left to click.
        await page.locator('.room2-cap .js-line').click({ timeout: 2000 }).catch(() => undefined);
        await page.waitForTimeout(300);
      }
      await expect(page.getByTestId('room-replies')).toBeVisible({ timeout: 8000 });
      await expect(page.getByTestId('room-replies').getByRole('button')).toHaveCount(3);
      expect(await page.evaluate(geometry), `${width}×${height} choices`).toEqual([]);
      await ctx.close();
    });
  }

  test('pure view and her invitation keep off her face too (390×844, 1440×900, 844×390)', async ({ browser }) => {
    for (const [width, height] of [[390, 844], [1440, 900], [844, 390]] as const) {
      const ctx = await browser.newContext({ viewport: { width, height }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
      await ctx.addInitScript((s) => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; localStorage.setItem('jstar.v1', JSON.stringify(s)); }, MEMBER);
      const page = await ctx.newPage();
      await page.clock.setFixedTime(new Date('2026-10-01T13:00:00+08:00'));
      await page.goto('/#/me/home');
      await settle(page);
      await page.keyboard.press('h');
      await expect(page.getByTestId('room-pure-line')).toBeVisible();
      expect(await page.evaluate(geometry), `${width} pure`).toEqual([]);
      await page.keyboard.press('h');
      await page.getByTestId('room-index-open').click();
      await page.getByTestId('demo-menu-open').click();
      await page.getByTestId('confession-demo').click();
      await page.getByTestId('room-index-close').click();
      await expect(page.getByTestId('confession-entry')).toBeVisible({ timeout: 10_000 });
      expect(await page.evaluate(geometry), `${width} invitation`).toEqual([]);
      await ctx.close();
    }
  });
});

/** QA #16: her call in B's bands at every size — the hour, what it is, her name, her line and the two answers apart. */
test('her call keeps her face clear and its bands apart at 390, 740, 1440 and 844×390 (QA #16, H2)', async ({ browser }) => {
  for (const [width, height] of [[390, 844], [740, 675], [1440, 900], [844, 390]] as const) {
    const ctx = await browser.newContext({ viewport: { width, height }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
    await ctx.addInitScript(([s, inbox]) => {
      const w = window as unknown as { __E2E__: boolean; __INBOX__: unknown[] };
      w.__E2E__ = true; w.__INBOX__ = inbox as unknown[];
      localStorage.setItem('jstar.v1', JSON.stringify(s));
    }, [{ ...MEMBER, star: 'nana' }, [item('w1', { star: 'nana', kind: 'wakeup', payload: { text: '醒了嗎？……我泡好茶了喔。' }, deliveredAt: '2026-10-01T22:59:00.000Z' })]] as const);
    const page = await ctx.newPage();
    await page.clock.setFixedTime(MORNING);
    await page.goto('/#/me/home');
    await expect(page.getByTestId('call-incoming')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.home-stage img')].every((i) => i.complete));
    expect(await page.evaluate(geometry, '.room2-call'), `${width}×${height} call`).toEqual([]);
    await ctx.close();
  }
});

/** QA #7: a real touch swipe in pure view (not a mouse drag): down hides the room, up brings it back. */
test('pure view by touch: a swipe down shows only her, a swipe up brings the room back (QA #7)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  await ctx.addInitScript((s) => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; localStorage.setItem('jstar.v1', JSON.stringify(s)); }, MEMBER);
  const page = await ctx.newPage();
  await page.clock.setFixedTime(NIGHT);
  await page.goto('/#/me/home');
  await settle(page);
  const cdp = await ctx.newCDPSession(page);
  const swipe = async (from: number, to: number) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: from }] });
    for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: from + ((to - from) * k) / 6 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await swipe(300, 460);
  await expect(page.getByTestId('room-pure-line')).toBeVisible();
  // QA #5, C-room P2: a touch on her face answers, and its ripple lands beside her face — never on it, nor under her
  // chin on her neckline.
  const face = await page.evaluate(() => {
    const s = document.querySelector<HTMLElement>('.home-stage .scene.depth-enter')!, i = s.querySelector<HTMLElement>('.scene-poster')!;
    const c = getComputedStyle(s), r = i.getBoundingClientRect(), ar = parseFloat(c.getPropertyValue('--ar'));
    const [ox, oy] = getComputedStyle(i).objectPosition.split(' ').map(parseFloat), f = c.getPropertyValue('--face').trim().split(/\s+/).map(Number);
    const w = Math.max(r.width, r.height * ar), h = w / ar;
    return { left: r.left + ox + f[0] * w, top: r.top + oy + f[1] * h, right: r.left + ox + f[2] * w, bottom: r.top + oy + f[3] * h };
  });
  await page.touchscreen.tap((face.left + face.right) / 2, (face.top + face.bottom) / 2);
  const ripple = (await page.locator('.room2-tap').boundingBox())!;
  const off = ripple.x + ripple.width <= face.left + 1 || ripple.x >= face.right - 1;
  expect(off, `the ripple ${JSON.stringify(ripple)} is beside her face ${JSON.stringify(face)}`).toBe(true);
  expect(ripple.x).toBeGreaterThanOrEqual(0);
  expect(ripple.x + ripple.width).toBeLessThanOrEqual(390);
  await swipe(460, 300);
  await expect(page.getByTestId('room-composer')).toBeVisible();
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await ctx.close();
});

/**
 * H1 (C-room 47b0fcb): opened straight into her room (a link, a push), a star switch (目錄 or a swipe) is a replace —
 * 離開通話 still lands on the menu, never off the site (it went to about:blank).
 */
test('a deep link, another star, then 離開通話: the menu, never off the site (H1)', async ({ browser }) => {
  for (const how of ['index', 'swipe'] as const) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
    await ctx.addInitScript((s) => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; localStorage.setItem('jstar.v1', JSON.stringify(s)); }, MEMBER);
    const page = await ctx.newPage();
    await page.clock.setFixedTime(NIGHT);
    await page.goto('/#/me/home?star=mahiro');
    await expect(page.getByTestId('room-composer')).toBeVisible({ timeout: 15_000 });
    if (how === 'index') {
      await page.getByTestId('room-index-open').click();
      await page.getByTestId('star-rule-nana').click();
    } else {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 400 }] });
      for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 300 - 30 * k, y: 400 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await expect(page.getByTestId('room')).toHaveAttribute('data-star', 'nana');
    await expect(page).toHaveURL(/star=nana/);
    await page.getByTestId('room-index-open').click();
    await page.getByTestId('room-leave').click();
    await expect(page, how).toHaveURL(/#\/menu$/, { timeout: 5000 });
    await ctx.close();
  }
});

/**
 * M8 / H2 (C-room 47b0fcb): 目錄 on a phone and on a phone on its side — every entry can be reached and pressed (it fits,
 * or scrolls with a cue), its words under each entry show, her unread badge keeps off FIRST FIVE, the status line is
 * not cut (en), and her face stays clear of it.
 */
test('目錄 on a phone and on its side: every entry is reachable, nothing cut, her face clear (M8, H2)', async ({ browser }) => {
  for (const [width, height, lang] of [[390, 844, 'zh-Hant'], [390, 844, 'en'], [844, 390, 'zh-Hant']] as const) {
    const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
    await ctx.addInitScript(([s, inbox]) => {
      const w = window as unknown as { __E2E__: boolean; __INBOX__: unknown[] };
      w.__E2E__ = true; w.__INBOX__ = inbox as unknown[];
      localStorage.setItem('jstar.v1', JSON.stringify(s));
    }, [{ ...MEMBER, lang }, [item('n1', { star: 'nana' })]] as const);
    const page = await ctx.newPage();
    await page.clock.setFixedTime(NIGHT);
    await page.goto('/#/me/home');
    await settle(page);
    await page.getByTestId('room-index-open').click();
    await expect(page.getByTestId('room-index')).toBeFocused();
    const at = `${width}×${height} ${lang}`;
    for (const id of ['gift-open', 'room-promise', 'alarm-chip', 'room-history', 'room-memories', 'room-gacha']) {
      const cell = page.getByTestId(id);
      await cell.scrollIntoViewIfNeeded();
      const r = await cell.evaluate((el) => {
        const b = el.getBoundingClientRect(), box = el.closest('.room2-index-scroll')!.getBoundingClientRect(), sub = el.querySelector('small')!.getBoundingClientRect();
        const top = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
        return { inside: b.top >= box.top - 1 && b.bottom <= box.bottom + 1 && b.bottom <= innerHeight, sub: sub.bottom <= box.bottom + 1, hit: !!top && el.contains(top) };
      });
      expect(r, `${at} ${id}`).toEqual({ inside: true, sub: true, hit: true });
    }
    const checks = await page.evaluate(() => {
      const R = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const badge = R('[data-testid="inbox-badge-nana"]'), label = R('.room2-sec');
      const lab = [...document.querySelectorAll('.room2-index > .room2-lab > *')].map((e) => e.getBoundingClientRect());
      return { badgeOffLabel: badge.top >= label.bottom - 0.5, labInView: lab.every((b) => b.right <= innerWidth + 0.5 && b.left >= -0.5), scroll: document.documentElement.scrollHeight > innerHeight };
    });
    expect(checks, at).toEqual({ badgeOffLabel: true, labInView: true, scroll: false });
    // Her face is clear of the 目錄's own body.
    const clear = await page.evaluate(() => {
      const s = document.querySelector<HTMLElement>('.home-stage .scene.depth-enter')!, i = s.querySelector<HTMLElement>('.scene-poster')!;
      const c = getComputedStyle(s), r = i.getBoundingClientRect(), ar = parseFloat(c.getPropertyValue('--ar'));
      const [ox, oy] = getComputedStyle(i).objectPosition.split(' ').map(parseFloat), f = c.getPropertyValue('--face').trim().split(/\s+/).map(Number);
      const w = Math.max(r.width, r.height * ar), h = w / ar;
      const face = { left: r.left + ox + f[0] * w, top: r.top + oy + f[1] * h, right: r.left + ox + f[2] * w, bottom: r.top + oy + f[3] * h };
      const b = document.querySelector('.room2-index-body')!.getBoundingClientRect();
      return !(b.left < face.right && face.left < b.right && b.top < face.bottom && face.top < b.bottom);
    });
    expect(clear, at).toBe(true);
    await ctx.close();
  }
});
