import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * The immersive layer (#15–#18) as a visitor meets it: full-screen home sections, the PV theatre, the talent
 * pages, the three-step card reveal and the companion home.
 */

const VISITOR = { v: 1, ageOk: true, lang: 'ja' };
const MEMBER = { ...VISITOR, user: { via: 'email', nickname: 'kenta' } };
async function open(page: Page, path: string, state: object = VISITOR) {
  await page.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('jstar.v1', JSON.stringify(s)); sessionStorage.setItem('seeded', '1'); } }, state);
  await page.goto(`/#${path}`);
}
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

test.describe('home: one idea per screen', () => {
  test('deep link opens a section; the keyboard pages; Home returns to the stage', async ({ page }) => {
    await open(page, '/?s=cards');
    await expect(page.locator('#fp-cards')).toBeInViewport({ ratio: 0.6 });
    await expect(page.locator('.home-fp')).toHaveAttribute('data-sec', 'cards');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.home-fp')).toHaveAttribute('data-sec', 'news');
    await expect(page).toHaveURL(/#\/\?s=news$/);
    await page.keyboard.press('Home');
    await expect(page.locator('.home-fp')).toHaveAttribute('data-sec', 'hero');
    await expect(page).toHaveURL(/#\/$/);
  });

  test('sections enter in layers and the header call to action appears after the stage', async ({ page }) => {
    test.skip(!desktop(page), 'the header call to action is a desktop element');
    await open(page, '/');
    const cta = page.locator('.hdr .hdr-cta');
    await expect(cta).toHaveClass(/is-off/);
    await page.locator('#fp-stars').waitFor({ state: 'attached' });
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#fp-stars')).toHaveClass(/\bin\b/);
    await expect(cta).not.toHaveClass(/is-off/);
    await expect(page.locator('#fp-stars .slat')).toHaveCount(5);
  });

  test('the footer reveals a control that returns to the first screen', async ({ page }) => {
    await open(page, '/');
    const backTop = page.locator('.home-back-top');
    await expect(backTop).toHaveAttribute('aria-label', 'ページ上部へ戻る');
    await expect(backTop).not.toHaveClass(/is-visible/);
    await page.locator('.site-foot').scrollIntoViewIfNeeded();
    await expect(backTop).toHaveClass(/is-visible/);
    await backTop.click();
    await expect(page.locator('#fp-hero')).toBeInViewport({ ratio: 0.8 });
    await expect(backTop).not.toHaveClass(/is-visible/);
  });

  test('every screen leads somewhere: talents, how it works, cards, news, footer with legal links', async ({ page }) => {
    await open(page, '/?s=news');
    await expect(page.getByRole('heading', { level: 2, name: '今夜、誰に会いに行く？' })).toBeAttached();
    await expect(page.getByRole('heading', { level: 2, name: 'ふたりの時間は、こうして始まる' })).toBeAttached();
    const legal = page.getByRole('navigation', { name: '規約とポリシー' });
    await legal.scrollIntoViewIfNeeded();
    for (const [name, href] of [['利用規約', '#/legal/terms'], ['プライバシーポリシー', '#/legal/privacy'], ['AIについて', '#/legal/ai'], ['運営者情報', '#/legal/operator'], ['提供割合', '#/legal/rates']]) {
      await expect(legal.getByRole('link', { name })).toHaveAttribute('href', href);
    }
    await page.getByRole('link', { name: '八木奈々' }).click();
    await expect(page).toHaveURL(/#\/stars\?star=nana$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('八木奈々');
  });
});

test.describe('PV theatre', () => {
  test('opens dark over the page, plays the reel, Esc closes and gives focus back', async ({ page }) => {
    await open(page, '/');
    const button = page.getByRole('button', { name: 'PVを見る' }).first();
    await button.click();
    const pv = page.getByRole('dialog', { name: 'PVを見る' });
    await expect(pv).toBeVisible();
    await expect(page.getByRole('button', { name: '閉じる' })).toBeFocused();
    const video = pv.locator('video');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.2);
    // The stage behind it stops, so only the reel decodes.
    await expect(page.locator('.l-scene video')).toHaveCount(0);
    const first = await pv.locator('.pv-name').innerText();
    await page.getByRole('button', { name: '次のひと' }).click();
    await expect(pv.locator('.pv-name')).not.toHaveText(first);
    await page.keyboard.press('Escape');
    await expect(pv).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect(page.locator('.l-scene video')).toHaveCount(1);
  });
});

test.describe('JSTARS', () => {
  test('her colour, her clip beside the copy (desktop) or above it (phone), her best cards, no placeholders', async ({ page }) => {
    await open(page, '/stars?star=eimi');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('深田えいみ');
    const accent = await page.locator('main.stars').evaluate((el) => getComputedStyle(el).getPropertyValue('--accent').trim());
    expect(accent.toLowerCase()).toBe('#efa0b8');
    await expect(page.locator('.stars-media [data-scene^="eimi-hero"]')).toHaveCount(1);
    const media = (await page.locator('.stars-media').boundingBox())!;
    const info = (await page.locator('.stars-info').boundingBox())!;
    if (desktop(page)) expect(info.x).toBeGreaterThanOrEqual(media.x + media.width - 1);
    else expect(page.locator('.stars-h1')).toBeTruthy();
    await expect(page.locator('.stars-cards .cardx')).toHaveCount(3);
    await expect(page.locator('.media-tag')).toHaveCount(0);
    // Her recorded welcome line (public/voice/greet/<star>-welcome.mp3) makes the voice button appear.
    await expect(page.getByRole('button', { name: /の声を聴く$/ })).toHaveCount(1);
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('唯井まひろ');
    await expect(page).toHaveURL(/star=mahiro$/);
  });

  test('pick shows each of the five in her own still', async ({ page }) => {
    await open(page, '/pick');
    await expect(page.locator('.pick-slat.has-still')).toHaveCount(5);
    await expect(page.locator('.pick-slat img').first()).toHaveJSProperty('complete', true);
    const ids = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'];
    for (const [index, id] of ids.entries()) {
      const slat = page.locator('.pick-slat').nth(index);
      await slat.focus();
      await expect(slat.locator(`[data-scene="${id}-idle-16x9"]`)).toHaveCount(1);
    }
  });
});

test.describe('draw presentation', () => {
  const PULL = ['s1-mahiro-03', 's1-nana-12', 's1-unpai-20', 's1-alice-05', 's1-eimi-27', 's1-mahiro-01', 's1-nana-02', 's1-unpai-15', 's1-alice-22', 's1-eimi-30'];
  const state = { ...MEMBER, lastPull: PULL, owned: Object.fromEntries(PULL.map((id) => [id, 1])) };

  test('tap a card: omen in its tier colour, then the face; duplicates are marked', async ({ page }) => {
    await page.addInitScript(() => { (window as unknown as { __REVEAL_SPEED__: number }).__REVEAL_SPEED__ = 5; });
    await open(page, '/me/gacha/result', { ...state, owned: { ...state.owned, 's1-nana-12': 2 } });
    const card = page.locator('[data-reveal="1"]');
    await page.getByRole('button', { name: '2枚目をめくる' }).click();
    await expect(card).toHaveClass(/omen-R/);
    await expect(card).toHaveClass(/is-face/);
    await expect(card).toContainText('R');
    await expect(card.locator('.rv-dup')).toHaveText('重複');
    await expect(page.locator('[data-reveal="0"] .rv-new')).toHaveCount(0);
  });

  test('reveal all ends on the rarest card with her full-screen moment; skip shows everything', async ({ page }) => {
    await open(page, '/me/gacha/result', state);
    await page.getByRole('button', { name: 'すべてめくる' }).click();
    const special = page.getByTestId('special-reveal');
    await expect(special).toBeVisible();
    await expect(special).toHaveClass(/tier-UR/);
    await expect(special.locator('[data-scene^="eimi-"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(special).toHaveCount(0);
    await expect(page.locator('.rv.is-face')).toHaveCount(10);
    await expect(page.getByRole('link', { name: 'カードを見る' })).toBeVisible();
  });

  test('skip turns every card at once, without the full-screen moment', async ({ page }) => {
    await open(page, '/me/gacha/result', state);
    await page.getByRole('button', { name: 'スキップ' }).click();
    await expect(page.locator('.rv.is-face')).toHaveCount(10);
    await expect(page.getByTestId('special-reveal')).toHaveCount(0);
  });
});

test.describe('companion home', () => {
  for (const [hour, slot] of [['08:30', 'morning'], ['13:00', 'day'], ['19:00', 'evening'], ['23:30', 'night']] as const) {
    test(`${slot}: she is there, with a greeting and the check-in`, async ({ page }) => {
      await page.clock.setFixedTime(new Date(`2026-10-02T${hour}:00`));
      await open(page, '/me/home', { ...MEMBER, star: 'alice' });
      await expect(page.locator(`.home.tod-${slot}`)).toHaveCount(1);
      // Her home loop; her listening and talking loops wait under it as stills (A2 room v2: one video decodes at a time).
      await expect(page.locator('.home-stage [data-scene^="alice-"]:not(.room-talk-clip)')).toHaveCount(1);
      await expect(page.locator('.home-stage video')).toHaveCount(1);
      await expect(page.locator('.media-tag')).toHaveCount(0);
      await expect(page.getByTestId('greeting')).not.toBeEmpty();
      // The check-in lives in her room's 目錄.
      await page.getByTestId('room-index-open').click();
      await expect(page.getByTestId('checkin-chip')).toBeVisible();
    });
  }
});

test.describe('desktop 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
  test('the header call to action appears once the stage is left; the dots page the sections', async ({ page }) => {
    await open(page, '/');
    const cta = page.locator('.hdr .hdr-cta');
    await expect(cta).toHaveClass(/is-off/);
    // The stage's calls to action and its PV button all fit on the first screen.
    await expect(page.locator('.top-panel .btn-line')).toBeInViewport();
    await expect(page.getByRole('button', { name: 'PVを見る' }).first()).toBeInViewport();
    await page.locator('#fp-stars').waitFor({ state: 'attached' });
    await page.getByRole('navigation', { name: 'ページ' }).getByRole('button', { name: 'カード図鑑' }).click();
    await expect(page.locator('.home-fp')).toHaveAttribute('data-sec', 'cards');
    await expect(page.locator('#fp-cards')).toHaveClass(/\bin\b/);
    await expect(cta).not.toHaveClass(/is-off/);
  });
  test('JSTARS: the copy sits beside her clip, never over it', async ({ page }) => {
    await open(page, '/stars?star=mahiro');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('唯井まひろ');
    const media = (await page.locator('.stars-media').boundingBox())!;
    const info = (await page.locator('.stars-info').boundingBox())!;
    expect(info.x).toBeGreaterThanOrEqual(media.x + media.width - 1);
  });
  test('talent slats open on hover and play her clip', async ({ page }) => {
    await open(page, '/?s=stars');
    const ids = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'];
    for (const [index, id] of ids.entries()) {
      const slat = page.locator('.slat').nth(index);
      await slat.hover();
      await expect(slat.locator(`[data-scene="${id}-idle-16x9"]`)).toHaveCount(1);
    }
  });
});
