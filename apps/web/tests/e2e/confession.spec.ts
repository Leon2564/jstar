import AxeBuilder from '@axe-core/playwright';
import { test, expect, passAgeGate, signUpByEmail } from './fixtures';

/**
 * Her confession (#55), prototype mode, at the acceptance viewport (390×844): the demo makes today her confession
 * day, the evening opens her room on it, he answers in words, and the home shows lovers and their anniversary.
 * The clock is fixed in JST so "evening" does not depend on when the suite runs.
 */
const EVENING = new Date('2026-11-02T20:30:00+09:00');
const NOON = new Date('2026-11-02T12:30:00+09:00');
const PROMPT = { ja: 'あなたの答えを、声で（文字でも）', 'zh-Hant': '用聲音回答她（也可以打字）', en: 'Answer her in your own voice (or type it)' } as const;

const seriousAxe = async (page: import('@playwright/test').Page) => {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
};
const noSideScroll = async (page: import('@playwright/test').Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

test.describe('her confession', () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 390, height: 844 }); });

  test('evening: her room opens on it, a spoken or typed yes makes them lovers, and today is their anniversary', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.clock.setFixedTime(EVENING);
    await passAgeGate(page);
    await signUpByEmail(page);
    // Her room's 目錄 (A2 room v2) holds the bond and the test site's demo menu.
    await page.getByTestId('room-index-open').click();
    await expect(page.getByTestId('stage')).toHaveText('出会ったばかり');
    // Demo (test site / prototype): today becomes her confession day; the evening opens the room on it.
    await page.getByTestId('demo-menu-open').click();
    await page.getByTestId('confession-demo').click();
    await expect(page).toHaveURL(/#\/me\/scene\/confession-mahiro$/);
    const scene = page.getByTestId('scene');
    await expect(page.getByText(PROMPT.ja)).toBeVisible();
    await expect(scene).toHaveAttribute('data-shot', 'close');
    await expect(scene).toHaveAttribute('data-played', /confess-0 confess-1 ask answer$/);
    await noSideScroll(page);
    expect(await seriousAxe(page)).toEqual([]);

    await page.getByLabel('あなたの言葉').fill('はい、よろしくお願いします');
    await page.getByRole('button', { name: '送信' }).click();
    // N-49: during the hug his answer box and the keep-my-voice box are gone (checked the moment the hug plays).
    const duringHug = await page.waitForFunction(() => {
      const s = document.querySelector('[data-testid="scene"]');
      if (!s || !/\byes(-0)?\b/.test(s.getAttribute('data-played') ?? '')) return null;
      return { input: document.querySelectorAll('.scn-input').length, keep: document.querySelectorAll('[data-testid="confession-keep"]').length };
    });
    expect(await duringHug.jsonValue()).toEqual({ input: 0, keep: 0 });
    const end = page.getByTestId('scene-end');
    await expect(end).toBeVisible();
    // His yes: she steps in to hug him (`<star>-confession-yes`, the `yes` clip, #55), then her words and the memory.
    await expect(scene).toHaveAttribute('data-played', /^yes yes-0 yes-1 yes-2 yes-memory yes-end$/);
    await expect(end.getByRole('heading', { name: '告白' })).toBeVisible();
    await expect(page.getByTestId('confession-anniv')).toHaveText('今日が、まひろとあなたの記念日。');
    await expect(end.getByRole('button', { name: 'もう一度' })).toHaveCount(0);
    await noSideScroll(page);
    expect(await seriousAxe(page)).toEqual([]);

    await page.getByRole('link', { name: '部屋に戻る' }).click();
    // QA #30: back to her room — the scene's star's.
    await expect(page).toHaveURL(/#\/me\/home\?star=mahiro$/);
    await expect(page.getByTestId('greeting')).toBeAttached();
    await expect(page.getByTestId('confession-entry')).toHaveCount(0);
    await page.getByTestId('room-index-open').click();
    await expect(page.getByTestId('stage')).toHaveText('恋人 Lv.1');
    await expect(page.getByTestId('rel-anniv')).toHaveText('記念日 11/2');
    await page.goto('/#/me/cards?tab=memory');
    await expect(page.getByRole('img', { name: /告白/ })).toHaveCount(1);
  });

  test('waiting for his answer, in his silence she stays on her close shot — never her wide idle (N-35)', async ({ page }) => {
    await page.addInitScript(() => { (window as unknown as { __SCENE_TIME_SCALE__: number }).__SCENE_TIME_SCALE__ = 0.05; });
    await page.clock.setFixedTime(EVENING);
    await passAgeGate(page);
    await signUpByEmail(page);
    await page.getByTestId('room-index-open').click();
    await page.getByTestId('demo-menu-open').click();
    await page.getByTestId('confession-demo').click();
    const scene = page.getByTestId('scene');
    await expect(page.getByText(PROMPT.ja)).toBeVisible();
    // His silence: the idle loop phase comes (1.5 s at this scale), and the stage is still her close shot.
    await expect(scene).toHaveAttribute('data-idle', 'loop');
    await expect(scene).toHaveAttribute('data-shot', 'close');
    // Her close shot at sunset is her own confession close (`<star>-confession-close`, also her idle while he answers).
    await expect(scene.locator('.scn-layer.on')).toHaveAttribute('data-clip', /^mahiro-confession-close-/);
    await expect(page.getByTestId('scene-sub')).not.toContainText('もうちょっとだけ');
  });

  test('by day she only hints, and the demo entry opens it anyway', async ({ page }) => {
    await page.clock.setFixedTime(NOON);
    await passAgeGate(page);
    await signUpByEmail(page);
    await page.getByTestId('room-index-open').click();
    await page.getByTestId('demo-menu-open').click();
    await page.getByTestId('confession-demo').click();
    await page.getByTestId('room-index-close').click();
    await expect(page.getByTestId('greeting')).toHaveText('ねえ、今夜……ちゃんと話したいことがあるの。夜になったら、また来てくれる？');
    await expect(page).toHaveURL(/#\/me\/home$/);
    const entry = page.getByTestId('confession-entry');
    await expect(entry).toContainText('まひろの話を聞く');
    await noSideScroll(page);
    await entry.click();
    await expect(page.getByText(PROMPT.ja)).toBeVisible();
  });

  for (const lang of ['ja', 'zh-Hant', 'en'] as const) {
    test(`${lang}: "not yet" is answered gently, never asked again the same day, and fits the phone`, async ({ page }) => {
      await page.clock.setFixedTime(EVENING);
      await page.addInitScript((l) => {
        const rel = { stage: 'confession_ready', stageSince: '2026-11-01T00:00:00.000Z', stageDay: 7, daysTogether: 7, lastDay: '2026-11-01', confessedAt: null, anniversary: null, loverXp: null, rewardRank: 2 };
        if (!sessionStorage.getItem('seeded')) {
          localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: l, user: { via: 'email', nickname: 'kenta' }, star: 'mahiro', affinity: { mahiro: 420 }, rel: { mahiro: rel } }));
          sessionStorage.setItem('seeded', '1');
        }
      }, lang);
      await page.goto('/#/me/home');
      await expect(page).toHaveURL(/#\/me\/scene\/confession-mahiro$/);
      await expect(page.getByText(PROMPT[lang])).toBeVisible();
      await noSideScroll(page);
      await page.locator('#scene-text').fill(lang === 'ja' ? 'まだ考えさせて' : lang === 'en' ? 'Not yet, I need some time' : '讓我再想想');
      await page.locator('.scn-send').click();
      await expect(page.getByTestId('confession-later')).toBeVisible();
      await expect(page.getByTestId('scene')).toHaveAttribute('data-played', /^wait-0 wait-1 wait-end$/);
      await noSideScroll(page);
      for (const id of ['confession-later']) {
        const box = (await page.getByTestId(id).boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(390);
      }
      // Back home the same evening: no second opening, no entry — she waits two days together.
      await page.goto('/#/me/home');
      await expect(page.getByTestId('greeting')).toBeAttached();
      await expect(page).toHaveURL(/#\/me\/home$/);
      await expect(page.getByTestId('confession-entry')).toHaveCount(0);
      await page.getByTestId('room-index-open').click();
      await expect(page.getByTestId('relationship')).toBeVisible();
      await noSideScroll(page);
    });
  }
});
