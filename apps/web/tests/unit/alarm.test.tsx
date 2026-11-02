import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AlarmViewT, InboxItemT, WakeOpenResT } from '@jstar/shared/contracts';
import { StoreProvider, useStore } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { ApiError } from '../../src/services/http';
import { deviceTz, fmtRing } from '../../src/pages/alarm';
import { morningWake } from '../../src/pages/me';

const api = vi.hoisted(() => ({
  server: true, alarm: vi.fn(), alarmSet: vi.fn(), wakeOpen: vi.fn(), wakeSnooze: vi.fn(), inbox: vi.fn(), greeting: vi.fn(),
  // Her room also asks for her weather (#63); none here.
  world: vi.fn(async () => ({ asOf: new Date().toISOString(), talents: [], user: null }))
}));
vi.mock('../../src/services/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/http')>()),
  serverMode: () => api.server,
  http: { alarm: api.alarm, alarmSet: api.alarmSet, wakeOpen: api.wakeOpen, wakeSnooze: api.wakeSnooze, inbox: api.inbox, greeting: api.greeting, world: api.world }
}));
// Push is on in the API but not yet in this browser: the opt-in shows its switch.
vi.mock('../../src/lib/push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/push')>()),
  pushStatus: async () => 'off',
  syncPush: vi.fn()
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); api.server = true; });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

let latest: AppState;
function Spy() { latest = useStore().state; return null; }
function renderAt(path: string, patch: Partial<AppState> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, birthdayOk: true, user: { via: 'email', nickname: 'kenta' }, star: 'mahiro', ...patch }}>
      <Spy />
      <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}

const ALARM: AlarmViewT = { star: 'nana', time: '07:30', days: [1, 2, 3, 4, 5], enabled: true, tz: deviceTz() ?? 'Asia/Tokyo', nextAt: '2026-10-05T22:30:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
const wakeItem = (patch: Partial<InboxItemT> = {}): InboxItemT => ({
  id: 'inb_1', star: 'nana', kind: 'wakeup', payload: { text: 'おはよう', lineId: 'rain', day: '2026-10-05' },
  deliveredAt: new Date().toISOString(), readAt: null, createdAt: new Date().toISOString(), ...patch
});
const opened = (patch: Partial<WakeOpenResT> = {}): WakeOpenResT => ({
  id: 'inb_1', star: 'nana', day: '2026-10-05', line: 'おはよう。外、雨だよ。', lineId: 'rain',
  replies: { awake: 'えらいね。', snooze: 'しょうがないなあ、5分だけね。' }, snoozeLeft: 1, snoozeMinutes: 5,
  item: wakeItem({ readAt: '2026-10-05T22:31:00.000Z' }), unread: 0, ...patch
});

describe('the wake-up alarm settings (#57)', () => {
  it('is not offered without the server: nothing could ring', async () => {
    api.server = false;
    renderAt('/me/alarm');
    expect(await screen.findByTestId('alarm-offline')).toBeTruthy();
    expect(api.alarm).not.toHaveBeenCalled();
  });

  it('sets who wakes him, the time and the days in this device’s zone, then offers her notifications', async () => {
    api.alarm.mockResolvedValue({ alarm: null });
    api.alarmSet.mockImplementation(async (body) => ({ alarm: { ...ALARM, ...body, tz: body.tz ?? 'Asia/Tokyo' } }));
    renderAt('/me/alarm');
    await screen.findByTestId('alarm-form');
    // Defaults: the talent he is with, every day.
    expect((screen.getByRole('radio', { name: '唯井まひろ' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId('alarm-push')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: '八木奈々' }));
    fireEvent.change(screen.getByTestId('alarm-time'), { target: { value: '06:45' } });
    fireEvent.click(screen.getByRole('button', { name: '日' }));
    fireEvent.click(screen.getByTestId('alarm-save'));
    await waitFor(() => expect(api.alarmSet).toHaveBeenCalledWith({ star: 'nana', time: '06:45', days: [1, 2, 3, 4, 5, 6], enabled: true, tz: deviceTz() }));
    expect((await screen.findByTestId('alarm-status')).textContent).toMatch(/^保存しました。 次は /);
    expect(await screen.findByTestId('push-optin')).toBeTruthy();
    expect(screen.getByTestId('alarm-push').textContent).toContain('通知をオンにすると');
  });

  it('shows the alarm on file, turns it off, and offers this device’s zone after a move', async () => {
    api.alarm.mockResolvedValue({ alarm: { ...ALARM, tz: 'Pacific/Honolulu' } });
    api.alarmSet.mockImplementation(async (body) => ({ alarm: { ...ALARM, ...body, tz: body.tz, nextAt: body.enabled ? ALARM.nextAt : null } }));
    renderAt('/me/alarm');
    expect((await screen.findByTestId('alarm-tz')).textContent).toContain('Pacific/Honolulu');
    expect((screen.getByRole('radio', { name: '八木奈々' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('alarm-time') as HTMLInputElement).value).toBe('07:30');
    expect(screen.getByRole('button', { name: '土' }).getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByTestId('alarm-tz-use'));
    await waitFor(() => expect(api.alarmSet).toHaveBeenLastCalledWith(expect.objectContaining({ tz: deviceTz() })));
    await waitFor(() => expect(screen.queryByTestId('alarm-tz-use')).toBeNull());

    fireEvent.click(screen.getByTestId('alarm-enabled'));
    fireEvent.click(screen.getByTestId('alarm-save'));
    await waitFor(() => expect(screen.getByTestId('alarm-status').textContent).toContain('目覚ましはオフです。'));
    // Turned off: no reason to ask for notifications.
    expect(screen.queryByTestId('alarm-push')).toBeNull();
  });

  it('says so when saving fails, and needs at least one day', async () => {
    api.alarm.mockResolvedValue({ alarm: null });
    api.alarmSet.mockRejectedValue(new ApiError('network', 0));
    renderAt('/me/alarm');
    await screen.findByTestId('alarm-form');
    fireEvent.click(screen.getByTestId('alarm-save'));
    expect((await screen.findByRole('alert')).textContent).toContain('保存できませんでした');
    for (const d of ['月', '火', '水', '木', '金', '土', '日']) fireEvent.click(screen.getByRole('button', { name: d }));
    expect((screen.getByTestId('alarm-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('formats the next ring in the zone it rings in', () => {
    expect(fmtRing('2026-10-04T23:30:00.000Z', 'Asia/Taipei', 'ja')).toContain('7:30');
    expect(fmtRing('2026-10-04T23:30:00.000Z', 'America/Los_Angeles', 'en')).toContain('16:30');
  });
});

describe('her wake-up moment (#57)', () => {
  // Her morning (his clock at 07:30): N-42 makes the moment follow his hour, so these read it at a morning hour.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 5, 7, 30) }); });

  it('an alarm at night still opens on her morning greeting, never her bedtime line (M12), her room by night (N-42)', async () => {
    vi.setSystemTime(new Date(2026, 9, 5, 4, 6));
    api.wakeOpen.mockResolvedValueOnce(opened());
    renderAt('/me/wake?star=nana&inbox=inb_1');
    const wake = await screen.findByTestId('wake');
    expect(wake.dataset.slot).toBe('night');
    await waitFor(() => expect(screen.getByTestId('scene-sub').textContent).toMatch(/おはよ/));
    expect(screen.getByTestId('scene-sub').textContent).not.toContain('夜は静かだね');
    expect(wake.querySelector('.scn-layer')?.getAttribute('data-clip') ?? '').not.toMatch(/morning/);
  });

  it('opened from the push: her greeting, the morning’s line, 「起きた？」, and 「あと5分」 once', async () => {
    api.wakeOpen.mockResolvedValue(opened());
    api.wakeSnooze.mockResolvedValue({ dueAt: '2026-10-05T22:36:00.000Z', snoozeLeft: 0 });
    renderAt('/me/wake?star=nana&inbox=inb_1', { inbox: [wakeItem()] });
    await waitFor(() => expect(api.wakeOpen).toHaveBeenCalledWith('inb_1', 'ja'));
    // Her recorded morning greeting first (her voice), then the line the push carried.
    await waitFor(() => expect(screen.getByTestId('scene-sub').textContent).toContain('おはよう。今日はどんな一日にしたい？'));
    await waitFor(() => expect(screen.getByTestId('scene-sub').textContent).toContain('おはよう。外、雨だよ。'));
    const ask = await screen.findByRole('group', { name: '起きた？' });
    expect([...ask.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['1起きた', '2あと5分']);
    // Opened = read: the badge on her face goes down.
    expect(latest.inbox[0].readAt).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /あと5分/ }));
    await waitFor(() => expect(api.wakeSnooze).toHaveBeenCalledWith('inb_1'));
    expect((await screen.findByTestId('wake-note')).textContent).toBe('5分後に、もう一度奈々が起こしてくれます。');
    expect(screen.getByTestId('scene-sub').textContent).toContain('しょうがないなあ、5分だけね。');
    expect((await screen.findByTestId('wake-room')).textContent).toBe('奈々の部屋へ');
  });

  it('offers only 「起きた」 on the second call, and her answer to it', async () => {
    api.wakeOpen.mockResolvedValue(opened({ snoozeLeft: 0 }));
    renderAt('/me/wake?star=nana&inbox=inb_1');
    const ask = await screen.findByRole('group', { name: '起きた？' });
    expect(ask.querySelectorAll('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /起きた/ }));
    expect(screen.getByTestId('scene-sub').textContent).toContain('えらいね。');
    expect(await screen.findByTestId('wake-room')).toBeTruthy();
  });

  it('tells him when the snooze is used up, and when the wake-up is gone', async () => {
    api.wakeOpen.mockResolvedValueOnce(opened());
    api.wakeSnooze.mockRejectedValue(new ApiError('snooze_used', 409));
    renderAt('/me/wake?star=nana&inbox=inb_1');
    fireEvent.click(await screen.findByRole('button', { name: /あと5分/ }));
    expect((await screen.findByTestId('wake-note')).textContent).toBe('「あと5分」は、ひと朝に1回までです。');
    expect(screen.queryByRole('button', { name: /あと5分/ })).toBeNull();
    cleanup();

    api.wakeOpen.mockRejectedValueOnce(new ApiError('wake_not_found', 404));
    renderAt('/me/wake?star=nana&inbox=gone');
    expect((await screen.findByRole('alert')).textContent).toContain('この朝の目覚ましは、もう終わりました。');
  });

  it('「あと5分」 on a wake-up the server no longer has: a helpful note, not a bare error (N-37)', async () => {
    api.wakeOpen.mockResolvedValueOnce(opened());
    api.wakeSnooze.mockRejectedValue(new ApiError('wake_not_found', 404));
    renderAt('/me/wake?star=nana&inbox=inb_1');
    fireEvent.click(await screen.findByRole('button', { name: /あと5分/ }));
    expect((await screen.findByTestId('wake-note')).textContent).toBe('この朝の呼び出しは見つかりませんでした。奈々は、また明日の朝に起こしにくるね。');
    expect(screen.queryByRole('button', { name: /あと5分/ })).toBeNull();
  });

  it('previews her morning without the server: her greeting and 「起きた」', async () => {
    api.server = false;
    renderAt('/me/wake?star=alice');
    await waitFor(() => expect(screen.getByTestId('scene-sub').textContent).toContain('おはよう。朝からあなたに会えて、うれしいな。'));
    const ask = await screen.findByRole('group', { name: '起きた？' });
    expect(ask.querySelectorAll('button')).toHaveLength(1);
    expect(api.wakeOpen).not.toHaveBeenCalled();
  });
});

describe('her room in the morning (#57)', () => {
  const at = (h: number) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d; };

  it('plays this morning’s unopened wake-up before 11:00 only', () => {
    const today = wakeItem({ id: 'w1', deliveredAt: at(7).toISOString() });
    expect(morningWake([today], at(8))?.id).toBe('w1');
    expect(morningWake([today], at(11))).toBeNull();
    expect(morningWake([{ ...today, readAt: at(8).toISOString() }], at(9))).toBeNull();
    expect(morningWake([{ ...today, kind: 'message' }], at(9))).toBeNull();
    // N-63: opening another talent's room never plays hers.
    expect(morningWake([today], at(8), today.star)?.id).toBe('w1');
    expect(morningWake([today], at(8), today.star === 'mahiro' ? 'nana' : 'mahiro')).toBeNull();
    const yesterday = new Date(at(7).getTime() - 86_400_000).toISOString();
    expect(morningWake([{ ...today, id: 'w2', deliveredAt: yesterday }], at(8))).toBeNull();
  });

  it('opening her room before 11:00 rings her wake-up call; after it, her name in 目錄 opens her room with it as ②', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: at(8) });
    const item = wakeItem({ id: 'w3', deliveredAt: at(7).toISOString() });
    api.inbox.mockResolvedValue({ items: [item], unread: 1 });
    api.greeting.mockRejectedValue(new Error('offline'));
    api.wakeOpen.mockResolvedValue(opened({ id: 'w3', item: { ...item, readAt: at(8).toISOString() } }));
    // N-63: まひろ's room stays まひろ's — 奈々's wake-up is not played there (her face's badge leads to it).
    renderAt('/me/home', { star: 'mahiro' });
    fireEvent.click(await screen.findByTestId('room-index-open', {}, { timeout: 8000 }));
    expect(await screen.findByTestId('inbox-badge-nana')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByTestId('wake')).toBeNull();
    cleanup();
    // Her own room before 11:00 opens it.
    // ⑥ (#168): her own room before 11:00 rings as her call; 接聽 opens the wake-up and her line is her first words.
    renderAt('/me/home', { star: 'nana' });
    expect(await screen.findByTestId('call-incoming', {}, { timeout: 8000 })).toBeTruthy();
    fireEvent.click(screen.getByTestId('call-incoming-answer'));
    await waitFor(() => expect(api.wakeOpen).toHaveBeenCalledWith('w3', 'ja'));
    cleanup();

    vi.setSystemTime(at(13));
    api.inbox.mockResolvedValue({ items: [{ ...item, id: 'w4' }], unread: 1 });
    renderAt('/me/home');
    fireEvent.click(await screen.findByTestId('room-index-open', {}, { timeout: 8000 }));
    // R18: picking her opens her room, never another page; this morning's wake-up, past its morning, is one of her
    // messages there (②).
    fireEvent.click(await screen.findByRole('button', { name: /未読1件/ }));
    expect(await screen.findByTestId('room-message', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByTestId('wake')).toBeNull();
    expect(api.wakeOpen).not.toHaveBeenCalledWith('w4', 'ja');
  });
});
