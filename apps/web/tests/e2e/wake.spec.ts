import AxeBuilder from '@axe-core/playwright';
import { test, expect, passAgeGate, signUpByEmail } from './fixtures';

/**
 * Her wake-up moment (#57), prototype mode: the preview the screen plays without a server (the alarm itself, the
 * ring and 「あと5分」 need the API: apps/api/tests/alarm.test.ts and tests/unit/alarm.test.tsx cover them).
 * The default device is an iPhone 13 (390×844), the size the issue asks to be readable at.
 */
test.describe('wake-up moment', () => {
  test('her morning clip, her greeting, 「起きた？」, then her room; readable at 390×844 and on a desktop', async ({ page }) => {
    // A morning on his clock (N-42: the moment follows his hour).
    await page.clock.setFixedTime(new Date(2026, 9, 5, 7, 30));
    await passAgeGate(page);
    await signUpByEmail(page);
    await page.goto('/#/me/wake?star=nana');
    const wake = page.getByTestId('wake');
    await expect(wake).toBeVisible();
    // Her morning room (an empty shot) is mounted, and the stage cuts to her as she speaks.
    await expect(wake.locator('.scn-layer[data-clip="nana-morning-9x16"]')).toHaveCount(1);
    await expect(wake.locator('.scn-layer.on')).toHaveAttribute('data-clip', /^nana-hero-/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('奈々のおはよう');
    await expect(page.getByTestId('scene-sub')).toContainText('おはよう');
    const ask = page.getByRole('group', { name: '起きた？' });
    await expect(ask).toBeVisible();
    // Everything he needs sits inside the phone screen.
    const box = (await ask.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);

    await ask.getByRole('button', { name: /起きた/ }).click();
    await page.getByTestId('wake-room').click();
    await expect(page).toHaveURL(/#\/me\/home$/);
    await expect(page.getByTestId('greeting')).toBeVisible();
    // Her room in the morning plays her morning loop, from the lazy catalogue her room waits for (src/data/media.ts).
    await expect(page.locator('.home-stage [data-scene]:not(.room-talk-clip)')).toHaveAttribute('data-scene', /-hero-morning-9x16$/);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/me/wake?star=alice');
    await expect(page.getByRole('group', { name: '起きた？' })).toBeVisible();
    await expect(page.getByTestId('wake')).toHaveClass(/wake-wide/);
  });

  test('at night: her room by night (N-42), and still her morning greeting — a wake-up is his morning (M12)', async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 9, 5, 22, 30));
    await passAgeGate(page);
    await signUpByEmail(page);
    await page.goto('/#/me/wake?star=nana');
    const wake = page.getByTestId('wake');
    await expect(wake).toHaveAttribute('data-slot', 'night');
    await expect(wake.locator('.scn-layer[data-clip^="nana-morning"]')).toHaveCount(0);
    await expect(page.getByRole('group', { name: '起きた？' })).toBeVisible();
    await expect(page.getByTestId('scene-sub')).toContainText('おはよう');
  });

  test('the alarm settings say they need the server in the prototype', async ({ page }) => {
    await passAgeGate(page);
    await signUpByEmail(page);
    await page.goto('/#/me/alarm');
    await expect(page.getByTestId('alarm-offline')).toBeVisible();
    // Nothing points there without a server: the home chip and the My page row are server-only.
    await page.goto('/#/me/home');
    await expect(page.getByTestId('greeting')).toBeVisible();
    await expect(page.getByTestId('alarm-chip')).toHaveCount(0);
  });
});

/**
 * C-room N2: her call while he is in another star's room is a 「奈奈來電 ›」 line there — no ringtone there, never her
 * call over this face — and her snooze's second call keeps him in the room he chose. A tap on the line is her call.
 */
test.describe('her call from another room (N2)', () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const MEMBER = { v: 1, ageOk: true, lang: 'zh-Hant', user: { via: 'email', nickname: 'kenta' } };
  const MORNING = '2026-10-05T07:00:00+08:00';
  const wake = { id: 'w1', star: 'nana', kind: 'wakeup', payload: { text: '醒了嗎？……我泡好茶了喔。' }, deliveredAt: new Date(Date.parse(MORNING) - 60_000).toISOString(), readAt: null, createdAt: MORNING };
  async function open(page: import('@playwright/test').Page, star: string) {
    await page.clock.install({ time: new Date(MORNING) });
    await page.addInitScript(([s, inbox]) => {
      const w = window as unknown as { __E2E__: boolean; __INBOX__: unknown[]; __rang: string[]; Audio: typeof Audio };
      w.__E2E__ = true; w.__INBOX__ = inbox as unknown[];
      localStorage.setItem('jstar.v1', JSON.stringify(s));
      // Every sound made, by its file: her ringtone must not sound in another's room.
      w.__rang = [];
      const A = w.Audio;
      w.Audio = function (src?: string) { if (src) w.__rang.push(src); return new A(src); } as unknown as typeof Audio;
    }, [{ ...MEMBER, star }, [wake]] as const);
    await page.goto('/#/me/home');
    await expect(page.getByTestId('room-composer').or(page.getByTestId('call-incoming')).first()).toBeAttached();
  }
  const rang = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __rang: string[] }).__rang.filter((s) => s.includes('nana')));

  test('a fresh wake call of hers in まひろ\'s room: her line there, no ring, no call; a tap is her call', async ({ page }) => {
    await open(page, 'mahiro');
    const line = page.getByTestId('call-elsewhere');
    await expect(line).toContainText('奈奈來電');
    await expect(page.getByTestId('call-incoming')).toHaveCount(0);
    await expect(page.getByTestId('room')).toHaveAttribute('data-star', 'mahiro');
    await page.waitForTimeout(1500);
    expect(await rang(page)).toEqual([]);
    await line.click();
    await expect(page.getByTestId('call-incoming')).toBeVisible();
    await expect(page.getByTestId('call-incoming')).toContainText('八木奈奈');
  });

  test('再睡5分鐘, then まひろ\'s room: her second call keeps him there, with her line — never pulled back', async ({ page }) => {
    await open(page, 'nana');
    await expect(page.getByTestId('call-incoming')).toBeVisible();
    await page.getByTestId('call-incoming-later').click();
    await expect(page.getByTestId('call-incoming')).toHaveCount(0);
    await page.getByTestId('room-index-open').click();
    await page.getByTestId('star-rule-mahiro').click();
    await expect(page.getByTestId('room')).toHaveAttribute('data-star', 'mahiro');
    const before = (await rang(page)).length;
    await page.clock.runFor(5 * 60_000 + 1000);
    const line = page.getByTestId('call-elsewhere');
    await expect(line).toContainText('奈奈來電');
    await expect(page.getByTestId('room')).toHaveAttribute('data-star', 'mahiro');
    await expect(page.getByTestId('call-incoming')).toHaveCount(0);
    await expect(page).toHaveURL(/star=mahiro|#\/me\/home$/);
    expect((await rang(page)).length).toBe(before);
    await line.click();
    await expect(page.getByTestId('call-incoming')).toBeVisible();
    await expect(page.getByTestId('room')).toHaveAttribute('data-star', 'nana');
  });
});
