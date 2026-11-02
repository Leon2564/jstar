import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { InboxItemT, PromiseItemT } from '@jstar/shared/contracts';
import { inviteTiming, jstSlot, sceneById } from '@jstar/shared/scenes';
import { routineNow } from '@jstar/shared/world';
import { jstDay } from '@jstar/shared/rules';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { ensureLang } from '../../src/i18n';
import * as api from '../../src/services/api';
import { http } from '../../src/services/http';
import { rippleAt, roomText } from '../../src/pages/roomV2';
import { itemText, zhComma } from '../../src/lib/lines';
import { promiseAt, promiseWhen } from '../../src/components/promise';

/**
 * The re-test of v1.1.2 in her room (C-room N1–N10, L3, L9, L10, P2; B-L4, B-L7), in the real component.
 */
beforeAll(async () => {
  (window as unknown as { __E2E__: boolean }).__E2E__ = true;
  Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  await ensureLang('zh-Hant');
});
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

let where = '';
function Where() { const l = useLocation(); where = `${l.pathname}${l.search}`; return null; }
function renderAt(patch: Partial<AppState> = {}, path = '/me/home') {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, lang: 'zh-Hant', user: { via: 'email', nickname: 'kenta' }, star: 'mahiro', ...patch } as AppState}>
      <MemoryRouter initialEntries={[path]}><Where /><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}
const TITLE = { ja: 'あなただけの配信', 'zh-Hant': '只給你一個人的直播', en: 'A stream just for you', ko: '너만을 위한 방송' };

describe('her invitation: into the scene now, or 「今晚見」 (N1)', { timeout: 20_000 }, () => {
  it('the scene her hour and routine allow: うんぱい\'s stream by day is tonight, in her evening it is now', () => {
    const meta = sceneById('private-stream')!.meta;
    const ctx = (at: number) => ({ slot: jstSlot(at), weather: null, stage: 'new' as const, owns: () => false, routine: routineNow('unpai', new Date(at)) });
    const morning = Date.parse('2026-10-05T07:34:00+09:00');
    expect(inviteTiming(meta, ctx(morning), morning)).toEqual({ ready: false, dueAt: Date.parse('2026-10-05T20:00:00+09:00'), tonight: true });
    const evening = Date.parse('2026-10-05T19:00:00+09:00');
    expect(inviteTiming(meta, ctx(evening), evening)).toEqual({ ready: true, dueAt: null, tonight: false });
    // A card he does not have: nothing to promise.
    expect(inviteTiming(sceneById('variant-unpai-1')!.meta, ctx(morning), morning)).toBeNull();
  });

  it('answered by day, her invitation offers 今晚見 — a promise for her evening — never a locked scene', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    const at = new Date('2026-10-05T07:34:00+09:00');
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    const due = '2026-10-05T11:00:00.000Z';
    vi.spyOn(http, 'sceneRoom').mockResolvedValue({ offer: null, invite: { sceneId: 'private-stream', title: TITLE, ready: false, dueAt: due, tonight: true } });
    const invite: InboxItemT = { id: 'u1', star: 'unpai', kind: 'message', payload: { text: '晚上要不要和我一起窩著、只對你一個人直播喔。', herMessage: 'invite', sceneId: 'private-stream' }, deliveredAt: new Date(at.getTime() - 60_000).toISOString(), readAt: null, createdAt: at.toISOString() };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [invite], unread: 1 });
    const promise: PromiseItemT = { id: 'p1', star: 'unpai', text: '只給你一個人的直播', kind: 'scene', status: 'open', source: 'proposal', dueAt: due, madeAt: at.toISOString(), keptAt: null, sceneId: 'private-stream' };
    const make = vi.spyOn(http, 'promiseTonight').mockResolvedValue({ promise });
    renderAt({ star: 'unpai', inbox: [invite] }, '/me/home?star=unpai&inbox=u1');
    await screen.findByTestId('call-incoming', {}, { timeout: 8000 });
    await act(async () => { fireEvent.click(screen.getByTestId('call-incoming-answer')); });
    // N9: her line in zh-Hant pauses with ，.
    await waitFor(() => expect(screen.getByTestId('inbox-line').textContent).toBe('晚上要不要和我一起窩著，只對你一個人直播喔。'), { timeout: 4000 });
    const tonight = await screen.findByTestId('inbox-tonight', {}, { timeout: 4000 });
    expect(tonight.textContent).toBe('✦ 今晚見');
    expect(screen.queryByTestId('inbox-invite')).toBeNull();
    expect(screen.getByTestId('inbox-invite-no').textContent).toBe('下次吧');
    await act(async () => { fireEvent.click(tonight); });
    await waitFor(() => expect(make).toHaveBeenCalledWith('unpai', 'private-stream', 'u1', 'zh-Hant'));
    expect(document.body.textContent).toContain(`說好了。${promiseWhen(due, 'zh-Hant')}，只給你一個人的直播`);
  });

  it('a scene no time can be promised for: her invitation is one of her messages, no ✦ at all', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    vi.spyOn(http, 'sceneRoom').mockResolvedValue({ offer: null });
    const now = new Date();
    const invite: InboxItemT = { id: 'u2', star: 'unpai', kind: 'message', payload: { text: '想讓你看看另一個我。', sceneId: 'variant-unpai-1' }, deliveredAt: now.toISOString(), readAt: null, createdAt: now.toISOString() };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [invite], unread: 1 });
    renderAt({ star: 'unpai', inbox: [invite] });
    expect((await screen.findByTestId('room-message', {}, { timeout: 8000 })).textContent).toBe('想讓你看看另一個我。');
    expect(screen.queryByTestId('inbox-invite')).toBeNull();
    expect(screen.queryByTestId('inbox-tonight')).toBeNull();
  });
});

describe('her call from another room (N2)', { timeout: 20_000 }, () => {
  it('a fresh wake call of hers while he is in another\'s room: 「奈奈來電 ›」 there, no call over this face; a tap, hers', async () => {
    const at = new Date(); at.setHours(8, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    const wake: InboxItemT = { id: 'w9', star: 'nana', kind: 'wakeup', payload: { text: '起床囉！' }, deliveredAt: new Date(at.getTime() - 60_000).toISOString(), readAt: null, createdAt: at.toISOString() };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [wake], unread: 1 });
    renderAt({ star: 'mahiro', inbox: [wake] });
    const line = await screen.findByTestId('call-elsewhere', {}, { timeout: 8000 });
    expect(line.textContent).toContain('奈奈來電');
    expect(screen.queryByTestId('call-incoming')).toBeNull();
    expect(screen.getByTestId('room').getAttribute('data-star')).toBe('mahiro');
    fireEvent.click(line);
    expect((await screen.findByTestId('call-incoming', {}, { timeout: 8000 })).textContent).toContain('八木奈奈');
    expect(screen.getByTestId('room').getAttribute('data-star')).toBe('nana');
  });

  it('再睡5分鐘, then another\'s room: her second call keeps him there, with her line — never pulled back to hers', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: new Date('2026-10-03T08:00:00+09:00'), shouldAdvanceTime: true });
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    const at = Date.now();
    const wake: InboxItemT = { id: 'w4', star: 'nana', kind: 'wakeup', payload: { text: '起床囉', lineId: 'x', day: '2026-10-03' }, deliveredAt: new Date(at - 60_000).toISOString(), readAt: null, createdAt: new Date(at).toISOString() };
    const next: InboxItemT = { id: 'w5', star: 'nana', kind: 'wakeup', payload: { text: '再五分鐘到了喔！', lineId: 'y', day: '2026-10-03', snooze: true }, deliveredAt: new Date(at + 300_000).toISOString(), readAt: null, createdAt: new Date(at).toISOString() };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [wake], unread: 1 });
    vi.spyOn(http, 'wakeSnooze').mockResolvedValue({ dueAt: new Date(at + 300_000).toISOString(), snoozeLeft: 0, next });
    const ring = vi.spyOn(http, 'wakeRing').mockResolvedValue({ item: next });
    renderAt({ star: 'nana', inbox: [wake] });
    await screen.findByTestId('call-incoming', {}, { timeout: 8000 });
    await act(async () => { fireEvent.click(screen.getByTestId('call-incoming-later')); });
    await waitFor(() => expect(screen.queryByTestId('call-incoming')).toBeNull());
    // He goes to まひろ's room.
    fireEvent.keyDown(window, { key: 'm' });
    fireEvent.click(await screen.findByTestId('star-rule-mahiro'));
    await waitFor(() => expect(screen.getByTestId('room').getAttribute('data-star')).toBe('mahiro'));
    await act(async () => { vi.advanceTimersByTime(301_000); });
    expect(ring).toHaveBeenCalledWith('w5');
    const line = await screen.findByTestId('call-elsewhere', {}, { timeout: 4000 });
    expect(screen.getByTestId('room').getAttribute('data-star')).toBe('mahiro');
    expect(screen.queryByTestId('call-incoming')).toBeNull();
    fireEvent.click(line);
    expect((await screen.findByTestId('call-incoming-line', {}, { timeout: 8000 })).textContent).toBe('「再五分鐘到了喔！」');
    expect(where).toContain('/me/home');
  });
});

describe('her words and the room\'s counts', () => {
  it('N7: English counts its nouns', () => {
    expect(roomText('away', 'en', { first: 'Mahiro', n: 1 })).toBe('While you were away, Mahiro left 1 message');
    expect(roomText('away', 'en', { first: 'Mahiro', n: 3 })).toBe('While you were away, Mahiro left 3 messages');
    expect(roomText('lines', 'en', { n: 1 })).toBe('1 line');
    expect(roomText('lines', 'zh-Hant', { n: 1 })).toBe('共 1 句');
  });

  it('N5 / N9: her item in his language, else as the server wrote it for his account; zh-Hant pauses with ，', () => {
    const payload = { text: 'メリークリスマス。', texts: { ja: 'メリークリスマス。', en: 'Merry Christmas.' } };
    expect(itemText(payload, 'en')).toBe('Merry Christmas.');
    expect(itemText({ text: 'Merry Christmas.' }, 'ko')).toBe('Merry Christmas.');
    expect(zhComma('泡茶、看書', 'zh-Hant')).toBe('泡茶，看書');
    expect(zhComma('お茶、読書', 'ja')).toBe('お茶、読書');
  });

  it('L9: her wake-up promise is the morning she wakes him — his alarm\'s ring, else that morning at 07:00 — never 「今天 14:32」', () => {
    const now = new Date(2026, 9, 5, 2, 32).getTime();
    const p = { kind: 'wakeup' as const, star: 'nana' as const, dueAt: new Date(2026, 9, 5, 14, 32).toISOString() };
    expect(promiseAt(p, 'zh-Hant', null, now)).toBe(promiseWhen(new Date(2026, 9, 5, 7, 0).toISOString(), 'zh-Hant', now));
    const alarm = { star: 'nana' as const, enabled: true, nextAt: new Date(2026, 9, 5, 6, 45).toISOString() };
    expect(promiseAt(p, 'zh-Hant', alarm, now)).toBe(promiseWhen(alarm.nextAt, 'zh-Hant', now));
    expect(promiseAt({ ...p, kind: 'free' }, 'zh-Hant', alarm, now)).toBe(promiseWhen(p.dueAt, 'zh-Hant', now));
  });

  it('P2: his touch ripples beside her face, never on it or her neckline', () => {
    const face = [140, 200, 250, 330];
    expect(rippleAt(190, 260, face, 390)).toEqual({ x: 140 - 110 * 0.45 - 34, y: 260 });
    expect(rippleAt(220, 420, face, 390)).toEqual({ x: 250 + 110 * 0.45 + 34, y: 420 });
    // Far from her: where he touched.
    expect(rippleAt(60, 700, face, 390)).toEqual({ x: 60, y: 700 });
    // No room on the left: the right.
    expect(rippleAt(60, 260, [40, 200, 150, 330], 390).x).toBeGreaterThan(150 + 33);
    // Her close face on a phone (92–298 of 390): in the gap beside it, inside the screen.
    const close = rippleAt(195, 330, [92, 230, 298, 435], 390);
    expect(close.x === 34 || close.x === 356).toBe(true);
    // A face across the whole width: above it.
    expect(rippleAt(195, 330, [20, 230, 370, 435], 390)).toEqual({ x: 195, y: 196 });
  });
});

describe('目錄\'s 約定 and 記錄 in her room (L9), one 親密度 (L10)', { timeout: 20_000 }, () => {
  it('記錄 opens her log in her room, his lines and hers', async () => {
    renderAt({ chats: { ...initialState().chats, mahiro: [{ id: 'a', from: 'me', text: '我回來了' }, { id: 'b', from: 'her', text: '歡迎回來。' }] } } as Partial<AppState>);
    fireEvent.keyDown(window, { key: 'm' });
    fireEvent.click(await screen.findByTestId('room-history', {}, { timeout: 8000 }));
    const sheet = await screen.findByTestId('room-log-sheet');
    expect(sheet.textContent).toContain('「我回來了」');
    expect(sheet.textContent).toContain('「歡迎回來。」');
    expect(where).toBe('/me/home');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('room-log-sheet')).toBeNull());
  });

  it('約定 without one says so in her room', async () => {
    renderAt();
    fireEvent.keyDown(window, { key: 'm' });
    fireEvent.click(await screen.findByTestId('room-promise', {}, { timeout: 8000 }));
    expect((await screen.findByTestId('room-promise-none')).textContent).toContain('還沒有約定');
  });

  it('her chat page reads 親密度 as 目錄 does (0–100), never a level', async () => {
    renderAt({}, '/me/chat');
    const c = await screen.findByTestId('chat-closeness', {}, { timeout: 8000 });
    expect(c.textContent).toMatch(/^親密度 \d{1,3}$/);
  });
});

describe('her notifications offered after her words (N3)', { timeout: 20_000 }, () => {
  it('never over her line as it types: once her last page is done and his choices are up', async () => {
    const at: (boolean | null)[] = [];
    const on = () => at.push(!!document.querySelector('[data-testid="room-replies"]') && !document.querySelector('[data-testid="room-typing"]'));
    window.addEventListener('jstar:replied', on);
    try {
      renderAt();
      fireEvent.click((await screen.findByTestId('room-replies', {}, { timeout: 8000 })).querySelector('button')!);
      await screen.findByTestId('room-her', {}, { timeout: 8000 });
      await waitFor(() => expect(at.length).toBe(1), { timeout: 8000 });
      expect(at).toEqual([true]);
    } finally {
      window.removeEventListener('jstar:replied', on);
    }
  });
});

describe('the limit and his voice minutes (B-L4, B-L7)', { timeout: 20_000 }, () => {
  it('out of messages for today: no mic in her room, the limit panel says why', async () => {
    renderAt({ chatDay: jstDay(), chatUsed: 999, passUntil: null } as Partial<AppState>);
    expect(await screen.findByTestId('room-limit', {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.queryByTestId('mic')).toBeNull();
  });

  it('his voice minutes in the input are a tap from the extension sheet', async () => {
    const voice = { day: '2026-10-02', leftSeconds: 600, usedSeconds: 0, allowanceSeconds: 600, extensions: 0, extensionsLeft: 3, extendCost: 150, extendMinutes: 30, tts: true };
    renderAt({ voice } as Partial<AppState>);
    fireEvent.click(await screen.findByTestId('voice-left', {}, { timeout: 8000 }));
    expect(await screen.findByTestId('voice-extend')).toBeTruthy();
  });
});
