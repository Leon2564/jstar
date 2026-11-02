import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * R18: switching to another of the five — a swipe on her room or her name in 目錄 — always lands in that star's room,
 * whatever she left unread; what she left presents there as A2 has it: her messages and the day's notes as ②, an item
 * with a scene as her line and ✦, her due alarm as ⑥, her confession day's message as her line and ✦. Nothing leaves
 * the room without his tap. Prototype mode, his inbox handed in (`__INBOX__`, tests/e2e/roomVisual.spec.ts).
 */
const MEMBER = { v: 1, ageOk: true, lang: 'zh-Hant', user: { via: 'email', nickname: 'kenta' }, star: 'mahiro' };
const item = (patch: Record<string, unknown>) => ({
  id: 'x1', star: 'nana', kind: 'message', payload: { text: '午休中～今天的便當是自己做的喔。' }, deliveredAt: '2026-10-14T04:00:00.000Z', readAt: null, createdAt: '2026-10-14T04:00:00.000Z', ...patch
});
const EVENING = new Date('2026-10-14T20:00:00+08:00');
const CASES: { kind: string; at: Date; inbox: object; shows: string }[] = [
  { kind: 'her message', at: EVENING, inbox: item({}), shows: 'room-message' },
  { kind: 'a calendar note', at: EVENING, inbox: item({ id: 'cal_demo_1', kind: 'event', payload: { text: '聖誕快樂！', calendar: 'season', season: 'christmas' } }), shows: 'room-message' },
  { kind: 'an item with a scene', at: EVENING, inbox: item({ id: 'inv1', payload: { text: '今晚有空嗎？', sceneId: 'read-aloud' } }), shows: 'inbox-invite' },
  { kind: 'her confession day', at: EVENING, inbox: item({ id: 'conf1', payload: { text: '今晚，給我一點時間好嗎？', scene: 'confession-nana' } }), shows: 'confession-entry' },
  { kind: 'her due alarm', at: new Date('2026-10-14T08:00:00+08:00'), inbox: item({ id: 'w1', kind: 'wakeup', payload: { text: '醒了嗎？' }, deliveredAt: '2026-10-13T23:59:00.000Z' }), shows: 'call-incoming' },
  { kind: 'a past alarm', at: new Date('2026-10-14T14:00:00+08:00'), inbox: item({ id: 'w2', kind: 'wakeup', payload: { text: '早安。' }, deliveredAt: '2026-10-13T23:00:00.000Z' }), shows: 'room-message' }
];

async function open(page: Page, at: Date, inbox: object) {
  await page.clock.setFixedTime(at);
  await page.addInitScript(([s, i]) => {
    const w = window as unknown as { __E2E__: boolean; __INBOX__?: unknown[] };
    w.__E2E__ = true;
    w.__INBOX__ = [i];
    localStorage.setItem('jstar.v1', JSON.stringify(s));
  }, [MEMBER, inbox] as const);
  await page.goto('/#/me/home');
  await expect(page.getByTestId('room-composer')).toBeAttached();
  await expect(page.getByTestId('room')).toHaveAttribute('data-star', 'mahiro');
}
async function inHerRoom(page: Page, shows: string) {
  await expect(page).toHaveURL(/#\/me\/home(\?star=nana)?$/);
  await expect(page.getByTestId('room')).toHaveAttribute('data-star', 'nana');
  await expect(page.getByTestId(shows)).toBeAttached({ timeout: 8000 });
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(/#\/me\/home(\?star=nana)?$/);
}

test.describe('switching star lands in her room, whatever she left unread (R18)', () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  for (const c of CASES) {
    test(`目錄 pick — ${c.kind}`, async ({ page }) => {
      await open(page, c.at, c.inbox);
      await page.getByTestId('room-index-open').click();
      await page.getByTestId('star-rule-nana').click();
      await inHerRoom(page, c.shows);
    });

    test(`swipe — ${c.kind}`, async ({ page }) => {
      await open(page, c.at, c.inbox);
      // A swipe to the left across her (the empty video), to the next of the five: 奈奈.
      await page.mouse.move(330, 360);
      await page.mouse.down();
      await page.mouse.move(200, 365, { steps: 4 });
      await page.mouse.move(60, 368, { steps: 4 });
      await page.mouse.up();
      await inHerRoom(page, c.shows);
    });
  }
});

test.describe('a link to her room opened inside the app lands in HER room (U-67)', () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  test('menu → /me/home?star=eimi without a reload → 詠美, and the address stays hers', async ({ page }) => {
    await page.addInitScript((s) => { localStorage.setItem('jstar.v1', JSON.stringify({ ...s, star: 'alice' })); }, MEMBER);
    await page.goto('/#/menu');
    await expect(page.locator('body')).toHaveAttribute('data-route', '/menu');
    // A push tapped while the app is open, or a link: the hash changes, the page is not reloaded.
    await page.evaluate(() => { window.location.hash = '#/me/home?star=eimi'; });
    await expect(page.getByTestId('room')).toHaveAttribute('data-star', 'eimi', { timeout: 8000 });
    await expect(page.getByTestId('room')).toContainText('深田詠美');
    await page.waitForTimeout(600);
    await expect(page).toHaveURL(/#\/me\/home\?star=eimi$/);
    await expect(page.getByTestId('room')).toHaveAttribute('data-star', 'eimi');
  });
});
