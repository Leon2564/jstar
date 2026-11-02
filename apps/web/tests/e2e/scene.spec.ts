import AxeBuilder from '@axe-core/playwright';
import { test, expect, passAgeGate, signUpByEmail } from './fixtures';

const seriousAxe = async (page: import('@playwright/test').Page) => {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
};

/**
 * Scene engine (#64), prototype mode: the demo scene from the companion home, played end to end.
 * `data-played` on the player lists the beats of the segment it is playing, so a branch is checked without racing
 * the (shortened) subtitles.
 */
test.describe('scene engine: demo scene', () => {
  test('home → scene: a choice branch, a reload that resumes, free talk, and the memory card at the end', async ({ page }) => {
    await passAgeGate(page);
    await signUpByEmail(page);
    await page.getByTestId('room-index-open').click();
    await page.getByTestId('demo-menu-open').click();
    await page.getByTestId('scene-entry').click();
    await expect(page).toHaveURL(/#\/me\/scene\/demo-evening$/);
    const scene = page.getByTestId('scene');
    const choices = page.getByRole('group', { name: 'なんて答える？' });
    await expect(choices).toBeVisible();
    await expect(page.getByTestId('scene-sub')).toContainText('おかえりなさい');
    // Her wide shot, while she waits for his answer: her seated listening loop on the hero frame (#80, stage.tsx baseLoop).
    await expect(scene.locator('.scn-layer.on')).toHaveAttribute('data-clip', /^mahiro-idle-/);

    await choices.getByRole('button', { name: /今日はちょっと疲れた/ }).click();
    await expect(page.getByTestId('scene-affinity')).toHaveText('親密度 +3');
    await expect(scene).toHaveAttribute('data-played', /^ask~tired tired away empty close late talk$/);
    const input = page.getByLabel('あなたの言葉');
    await expect(input).toBeVisible();
    // The bar comes up while her last line still plays: her close talking loop, then her breathing loop (#80).
    await expect(scene.locator('.scn-layer.on')).toHaveAttribute('data-clip', /^mahiro-(breath|talkclose)-/);
    await expect(scene).toHaveAttribute('data-shot', 'close');

    // A reload comes back to the same step: no choices again, her last line and the input.
    await page.reload();
    await expect(page.getByLabel('あなたの言葉')).toBeVisible();
    await expect(page.getByRole('group', { name: 'なんて答える？' })).toHaveCount(0);

    await page.getByLabel('あなたの言葉').fill('今日は雨だった');
    await page.getByRole('button', { name: '送信' }).click();
    const end = page.getByTestId('scene-end');
    await expect(end).toBeVisible();
    await expect(end.getByRole('heading', { name: 'おかえりの夜' })).toBeVisible();
    await expect(end).toContainText('まひろとの親密度 +13');
    await expect(end).toContainText('約束：明日も、ここで待ってるね');

    // The same ending after a reload.
    await page.reload();
    await expect(page.getByTestId('scene-end').getByRole('heading', { name: 'おかえりの夜' })).toBeVisible();

    await page.getByRole('link', { name: '部屋に戻る' }).click();
    // QA #30: back to her room — the scene's star's.
    await expect(page).toHaveURL(/#\/me\/home\?star=mahiro$/);
    await page.goto('/#/me/cards?tab=memory');
    await expect(page.getByRole('img', { name: /おかえりの夜/ })).toHaveCount(1);
  });

  test('375 px: a long title keeps to two lines and clear of ✕ (N-04)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await passAgeGate(page);
    await signUpByEmail(page);
    await page.getByTestId('room-index-open').click();
    await page.getByTestId('demo-menu-open').click();
    await page.getByTestId('scene-entry').click();
    const choices = page.getByRole('group', { name: 'なんて答える？' });
    await expect(choices).toBeVisible();
    // The drafts' longest titles (en, ko, zh-Hant) in the demo scene's header, with the preview tag under them.
    for (const title of ['Reading aloud for you — and praise that means it', '너를 위해 소리 내어 읽기 — 그리고 진심 어린 칭찬', '為你朗讀——還有發自內心的稱讚，一直一直陪著你']) {
      const r = await page.evaluate((text) => {
        const el = document.querySelector<HTMLElement>('.scn-title-text')!;
        el.textContent = text;
        const close = document.querySelector<HTMLElement>('.scn-top .scn-icon')!.getBoundingClientRect();
        const hit = document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2);
        const lines = Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
        const t = el.getBoundingClientRect();
        // L2: on a phone the title has a row of its own under ✕ and CC, the full width.
        return { lines, closeOnTop: !!hit?.closest('.scn-icon'), clear: t.top >= close.bottom - 1, sideways: document.documentElement.scrollWidth - window.innerWidth };
      }, title);
      expect(r.lines, title).toBeLessThanOrEqual(2);
      expect({ ...r, lines: 0 }, title).toEqual({ lines: 0, closeOnTop: true, clear: true, sideways: 0 });
    }
  });

  test('375 px: a Japanese title breaks between phrases only (N-22)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await passAgeGate(page);
    await signUpByEmail(page);
    await page.getByTestId('room-index-open').click();
    await page.getByTestId('demo-menu-open').click();
    await page.getByTestId('scene-entry').click();
    await expect(page.getByRole('group', { name: 'なんて答える？' })).toBeVisible();
    // The title seen breaking as 「罰ゲ｜ーム」: each line ends at a phrase boundary.
    const lines = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.scn-title-text')!;
      // L2: the title's own row is the full width, so a longer one is needed to wrap.
      el.innerHTML = 'おかえりと、<wbr>罰ゲーム、<wbr>それから<wbr>ふたりの夜、<wbr>そして<wbr>おやすみの前に';
      const range = document.createRange();
      const byTop = new Map<number, string>();
      for (const n of [...el.childNodes].filter((c) => c.nodeType === 3)) {
        for (let k = 0; k < n.textContent!.length; k++) {
          range.setStart(n, k); range.setEnd(n, k + 1);
          const top = Math.round(range.getBoundingClientRect().top);
          byTop.set(top, (byTop.get(top) ?? '') + n.textContent![k]);
        }
      }
      return [...byTop.values()];
    });
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines.slice(0, -1)) expect(l).toMatch(/(、|それから|そして)$/);
  });

  test('375 px: the end card never breaks a word in its buttons (N-13)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await passAgeGate(page);
    await signUpByEmail(page);
    await page.getByTestId('room-index-open').click();
    await page.getByTestId('demo-menu-open').click();
    await page.getByTestId('scene-entry').click();
    await page.getByRole('group', { name: 'なんて答える？' }).getByRole('button', { name: /今日はちょっと疲れた/ }).click();
    await page.getByLabel('あなたの言葉').fill('今日は雨だった');
    await page.getByRole('button', { name: '送信' }).click();
    const end = page.getByTestId('scene-end');
    await expect(end).toBeVisible();
    // Korean labels (「방으로 돌아가기」 wrapped its last syllable), then the longer English ones.
    for (const [back, again] of [['방으로 돌아가기', '다시 한 번'], ['Back to her room', 'Play it again']]) {
      const broken = await page.evaluate(([b, a]) => [...document.querySelectorAll<HTMLElement>('.scn-end-actions > *')].map((el, i) => {
        el.textContent = i === 0 ? b : a;
        const range = document.createRange();
        range.selectNodeContents(el);
        const tops = new Set([...range.getClientRects()].map((q) => Math.round(q.top)));
        return tops.size > 1 || el.scrollWidth > el.clientWidth ? el.textContent : null;
      }).filter(Boolean), [back, again]);
      expect(broken).toEqual([]);
    }
  });

  test('the scene catalogue blocked, then back: 「もう一度」 recovers without a reload (N-48, N-61)', async ({ page }) => {
    test.setTimeout(60_000);
    let blocked = true;
    const asked: string[] = [];
    // N-61: the catalogue is a JSON asset now, fetched: every try really goes out (a failed module import did not).
    await page.route(/\/assets\/media\.scene\.gen-[^/]+\.json/, (route) => { asked.push(route.request().url()); return blocked ? route.abort() : route.continue(); });
    await passAgeGate(page);
    await signUpByEmail(page);
    await page.goto('/#/me/scene/demo-evening');
    await expect(page.getByTestId('scene-media-failed')).toBeVisible({ timeout: 20_000 });
    blocked = false;
    // Three real requests (with a backoff), each under its own address after the first.
    expect(asked.length).toBeGreaterThanOrEqual(3);
    expect(new Set(asked).size).toBe(asked.length);
    await page.getByRole('button', { name: 'もう一度' }).click();
    await expect(page.getByRole('group', { name: 'なんて答える？' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('scene').locator('.scn-layer').first()).toBeAttached();
  });

  test('her morning room: the catalogue failing once is tried again, and her morning loop comes back (N-61)', async ({ page }) => {
    test.setTimeout(60_000);
    let blocked = true;
    await page.route(/\/assets\/media\.scene\.gen-[^/]+\.json/, (route) => (blocked ? route.abort() : route.continue()));
    await page.clock.setFixedTime(new Date(2026, 9, 5, 8, 0));
    await passAgeGate(page);
    await signUpByEmail(page);
    const stage = page.locator('.home-stage [data-scene]').first();
    // Failed after its tries: her usual look, never a blank room.
    await expect(stage).toHaveAttribute('data-scene', /^mahiro-/, { timeout: 20_000 });
    await expect(stage).not.toHaveAttribute('data-scene', /morning/);
    blocked = false;
    // The background retry (every 8 s) finds it: her morning loop swaps in, no reload.
    await expect(page.locator('.home-stage [data-scene*="morning"]').first()).toBeAttached({ timeout: 25_000 });
  });

  test('timeout fallback: idle loop, her countdown branch, the "still there?" prompt, and the ending', async ({ page }) => {
    // Every scene timer at 1/20: the 30 s idle loop is 1.5 s, the 45 s countdown 2.25 s, the 60 s prompt 3 s.
    await page.addInitScript(() => { (window as unknown as { __SCENE_TIME_SCALE__: number }).__SCENE_TIME_SCALE__ = 0.05; });
    await passAgeGate(page);
    await signUpByEmail(page);
    await page.getByTestId('room-index-open').click();
    await page.getByTestId('demo-menu-open').click();
    await page.getByTestId('scene-entry').click();
    const scene = page.getByTestId('scene');
    await expect(page.getByRole('group', { name: 'なんて答える？' })).toBeVisible();
    await expect(page.getByTestId('scene-countdown')).toBeVisible();
    // N-54: it says what it counts.
    await expect(page.getByTestId('scene-countdown')).toContainText('返事まで残り');
    // No answer: the stage falls back to her idle loop, then the countdown takes the silent branch.
    await expect(scene).toHaveAttribute('data-idle', 'loop');
    await expect(scene).toHaveAttribute('data-played', /^quiet away empty close late talk$/);
    await expect(page.getByTestId('scene-affinity')).toHaveCount(0);

    // Silent again at free talk: after the idle loop she asks whether he is still there.
    await expect(page.getByLabel('あなたの言葉')).toBeVisible();
    await expect(scene).toHaveAttribute('data-idle', 'prompt');
    await expect(page.getByTestId('scene-sub')).toContainText('まだ、そこにいる？');
    await page.getByRole('button', { name: 'ここにいるよ' }).click();
    await expect(scene).toHaveAttribute('data-idle', 'active');
    // Her patience runs out: she goes on without his words, and the evening still ends with its memory card.
    await expect(scene).toHaveAttribute('data-played', /^sleepy reward bye end$/);
    await expect(page.getByTestId('scene-end').getByRole('heading', { name: 'おかえりの夜' })).toBeVisible();
    await expect(page.getByTestId('scene-end')).toContainText('まひろとの親密度 +10');
  });

  test('keyboard only: choices by number, subtitles can be hidden but stay announced', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await passAgeGate(page);
    await signUpByEmail(page);
    await page.getByTestId('greeting').waitFor();
    await page.goto('/#/me/scene/demo-evening');
    const choices = page.getByRole('group', { name: 'なんて答える？' });
    await expect(choices).toBeVisible();
    await expect(choices.getByRole('button').first()).toBeFocused();
    await page.getByRole('button', { name: '字幕' }).click();
    await expect(page.getByRole('button', { name: '字幕' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('scene-sub').locator('p').first()).toHaveClass('sr-only');
    await page.keyboard.press('1');
    await expect(page.getByTestId('scene')).toHaveAttribute('data-played', /^ask~missed missed /);
    // Reduced motion: the close shot does not push in.
    await expect(page.getByTestId('scene')).toHaveAttribute('data-shot', 'close');
    const anim = await page.locator('.scn-layer.on .scn-media').first().evaluate((el) => getComputedStyle(el).animationName);
    expect(anim).toBe('none');
  });

  test('no serious or critical axe violations at a choice, at free talk and at the memory card', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await passAgeGate(page);
    await signUpByEmail(page);
    // Let her room settle first: jumping away while it is still loading races its own navigation (seen on CI).
    await page.getByTestId('greeting').waitFor();
    await page.goto('/#/me/scene/demo-evening');
    await expect(page.getByRole('group', { name: 'なんて答える？' })).toBeVisible();
    expect(await seriousAxe(page)).toEqual([]);
    await page.keyboard.press('2');
    await expect(page.getByLabel('あなたの言葉')).toBeVisible();
    expect(await seriousAxe(page)).toEqual([]);
    await page.getByLabel('あなたの言葉').fill('ただいま');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('scene-end')).toBeVisible();
    expect(await seriousAxe(page)).toEqual([]);
  });
});

/**
 * C-room N1: an answered invitation never dead-ends. Her invitation is the scene only when it can start now; by day her
 * evening scene is 「今晚見」 — a promise for her evening — and in her evening it is the scene itself, which plays.
 * Prototype mode works it out from the script (the API does the same: apps/api/tests/inviteTonight.test.ts).
 */
test.describe('her invitation: now, or tonight (N1)', () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const MEMBER = { v: 1, ageOk: true, lang: 'zh-Hant', user: { via: 'email', nickname: 'kenta' }, star: 'unpai' };
  const invite = (at: string) => ({
    id: 'inv1', star: 'unpai', kind: 'message', payload: { text: '晚上要不要和我一起窩著、只對你一個人直播喔。', herMessage: 'invite', sceneId: 'private-stream' },
    deliveredAt: new Date(Date.parse(at) - 60_000).toISOString(), readAt: null, createdAt: at
  });
  async function open(page: import('@playwright/test').Page, at: string, path = '/me/home') {
    await page.clock.install({ time: new Date(at) });
    await page.addInitScript(([s, inbox]) => {
      const w = window as unknown as { __E2E__: boolean; __INBOX__: unknown[] };
      w.__E2E__ = true; w.__INBOX__ = inbox as unknown[];
      localStorage.setItem('jstar.v1', JSON.stringify(s));
    }, [MEMBER, [invite(at)]] as const);
    await page.goto(`/#${path}`);
  }

  test('her call answered by day: 「今晚見」 makes a promise for her evening — no link to her locked scene', async ({ page }) => {
    await open(page, '2026-10-05T07:34:00+09:00', '/me/home?star=unpai&inbox=inv1');
    await expect(page.getByTestId('call-incoming')).toBeVisible();
    await page.getByTestId('call-incoming-answer').click();
    // Her line in zh-Hant pauses with ，(N9).
    await expect(page.getByTestId('inbox-line')).toHaveText('晚上要不要和我一起窩著，只對你一個人直播喔。');
    const tonight = page.getByTestId('inbox-tonight');
    await expect(tonight).toHaveText('✦ 今晚見');
    await expect(page.getByTestId('inbox-invite')).toHaveCount(0);
    await tonight.click();
    // Her evening on his clock (20:00 in Japan is 19:00 in Taipei), and her words for it.
    await expect(page.locator('.toast')).toContainText('19:00');
    await expect(page.getByTestId('inbox-tonight')).toHaveCount(0);
    await page.getByTestId('room-index-open').click();
    await expect(page.getByTestId('next-promise')).toContainText('19:00');
    await page.getByTestId('next-promise').click();
    await expect(page.getByTestId('room-promise-sheet')).toContainText('只給你一個人的直播');
    await expect(page).toHaveURL(/#\/me\/home/);
  });

  test('in her evening: her invitation is the scene, and it plays', async ({ page }) => {
    await open(page, '2026-10-05T20:00:00+09:00');
    const into = page.getByTestId('inbox-invite');
    await expect(into).toHaveText('✦ 進入場景');
    await expect(page.getByTestId('inbox-tonight')).toHaveCount(0);
    await into.click();
    await expect(page).toHaveURL(/#\/me\/scene\/private-stream/);
    await expect(page.getByTestId('scene')).toBeVisible();
    await expect(page.getByText('現在還不能進入這個場景')).toHaveCount(0);
  });
});
