import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import type { InboxItemT } from '@jstar/shared/contracts';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { ensureLang } from '../../src/i18n';
import * as api from '../../src/services/api';
import { ApiError, http } from '../../src/services/http';
import { answerReplies, awayWhen, callKind, clipLook, intentOf, lastWords, pageEnds, sentenceEnds } from '../../src/pages/roomV2';
import { followStar } from '../../src/pages/me';
import { setHerVoicePref } from '../../src/lib/herVoice';
import { resetSceneLoader, setSceneLoader } from '../../src/data/media';
import { SCENE_MEDIA } from '../../src/data/media.scene.gen';

/**
 * Her room v2, A2「夜畫廊」 (#163–#169): the states of docs/design/room-v2/A2-gallery-night.png in the real component.
 * ① opening · ③ mid-conversation · ⑤ pure view · ⑥ her call · 目錄. ② is in inbox.test, ④ in sceneTriggers.test.
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
const room = () => screen.findByTestId('room', {}, { timeout: 8000 });
/** Her line has typed out and his choices are there (QA #8). */
const ready = async () => { const r = await room(); await screen.findByTestId('room-replies', {}, { timeout: 4000 }); return r; };

describe('her room v2 (A2, #163)', { timeout: 20_000 }, () => {
  it('① opens on her line, three replies and the hairline input; her name stands vertical, in zh-Hant', async () => {
    renderAt();
    const r = await ready();
    expect(r.textContent).toContain('唯井真尋');
    expect(r.textContent).toContain('HER ROOM');
    expect((await screen.findByTestId('greeting')).textContent).toBeTruthy();
    const replies = screen.getByTestId('room-replies').querySelectorAll('button');
    expect(replies.length).toBe(3);
    expect(screen.getByPlaceholderText('用自己的話說…')).toBeTruthy();
    // The old home's furniture is gone from her room: no faces row, no tab bar in view.
    expect(document.querySelector('.partners')).toBeNull();
  });

  it('③ a reply is his line with 已讀, she answers, and new replies follow her answer', async () => {
    renderAt();
    await ready();
    const first = screen.getByTestId('room-replies').querySelector('button')!;
    const said = first.textContent!.replace(/^\d/, '');
    fireEvent.click(first);
    expect((await screen.findByTestId('room-mine')).textContent).toBe(`「${said}」`);
    expect(await screen.findByTestId('room-her', {}, { timeout: 8000 })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('room-mine-row').textContent).toContain('已讀'));
    expect((await screen.findByTestId('room-replies', {}, { timeout: 4000 })).querySelectorAll('button').length).toBeGreaterThan(0);
  });

  it('⑤ Space (or a tap on the empty video) shows only her and one line; Esc brings the room back', async () => {
    renderAt();
    await ready();
    fireEvent.keyDown(window, { key: ' ' });
    expect(await screen.findByTestId('room-pure-line')).toBeTruthy();
    expect(screen.queryByTestId('room-composer')).toBeNull();
    expect(screen.queryByTestId('room-replies')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(await screen.findByTestId('room-composer')).toBeTruthy();
  });

  it('⑤ a tap on her in pure view: her line for being touched, in his language — never a greeting (QA #5, U-36)', async () => {
    renderAt();
    await ready();
    fireEvent.keyDown(window, { key: ' ' });
    await screen.findByTestId('room-pure-line');
    const surface = screen.getByTestId('room-surface');
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400, height: 800, right: 400, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    // jsdom has no PointerEvent: a mouse event of that type carries the position.
    fireEvent(surface, new MouseEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 300 }));
    fireEvent(surface, new MouseEvent('pointerup', { bubbles: true, clientX: 200, clientY: 300 }));
    // While her reaction types out, never her greeting in its place.
    const seen: string[] = [];
    const watch = new MutationObserver(() => { seen.push(screen.queryByTestId('room-pure-line')?.textContent ?? ''); });
    watch.observe(screen.getByTestId('room-pure-line'), { subtree: true, childList: true, characterData: true });
    // (B: her subtitle ends with ▼ once it has typed out.)
    const pureLine = () => screen.getByTestId('room-pure-line').textContent!.replace(/▼$/, '');
    await waitFor(() => expect(pureLine()).toBe('「咦？……怎麼了，突然碰我。」'), { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 600));
    watch.disconnect();
    expect(pureLine()).toBe('「咦？……怎麼了，突然碰我。」');
    expect(seen.join('|')).not.toMatch(/まひろ|初次見面/);
  });

  it('a send that did not go keeps her last line and its replies — never her opening greeting again (QA #11)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-01T20:30:00+09:00') });
    vi.spyOn(api, 'chat').mockResolvedValueOnce({ reply: '今天下雨了。', affinityXp: 8, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: 19, freePulls: 0 })
      .mockRejectedValueOnce(new ApiError('bad_request', 400));
    renderAt();
    await ready();
    const opening = [...screen.getByTestId('room-replies').querySelectorAll('button')].map((b) => b.textContent);
    fireEvent.click(screen.getByRole('button', { name: /我回來了/ }));
    await waitFor(() => expect(screen.getByTestId('room-her').textContent).toBe('今天下雨了。'), { timeout: 8000 });
    fireEvent.click((await screen.findByTestId('room-replies', {}, { timeout: 4000 })).querySelector('button')!);
    expect(await screen.findByTestId('room-failed', {}, { timeout: 8000 })).toBeTruthy();
    // Her line is still her last one; his line stays on screen with 再送一次 (F-14: never hidden under choices).
    expect(screen.getByTestId('room-her').textContent).toBe('今天下雨了。');
    expect(screen.queryByTestId('greeting')).toBeNull();
    await new Promise((r) => setTimeout(r, 1800));
    expect(screen.getByTestId('room').hasAttribute('data-choose')).toBe(false);
    expect(screen.queryByTestId('room-replies')).toBeNull();
    expect(screen.getByTestId('room-failed').textContent).toContain('再送一次');
    expect(screen.getByTestId('room-mine-row').textContent).not.toContain('已讀');
    expect(opening.length).toBe(3);
  });

  it('a send that does not go while her ✦ invitation leads keeps his line with 沒有送出 / 再送一次 (F-14)', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    // N1: her invitation's scene can start now (the server says so): ✦ into it.
    vi.spyOn(http, 'sceneRoom').mockResolvedValue({ offer: null, invite: { sceneId: 'private-stream', title: { ja: '配信', 'zh-Hant': '直播', en: 'Stream', ko: '방송' }, ready: true, dueAt: null, tonight: false } });
    const now = new Date();
    const invite: InboxItemT = { id: 'v1', star: 'unpai', kind: 'message', payload: { text: '今晚留下來陪我好嗎。', sceneId: 'private-stream' }, deliveredAt: now.toISOString(), readAt: null, createdAt: now.toISOString() };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [invite], unread: 1 });
    vi.spyOn(api, 'chat').mockRejectedValue(new ApiError('bad_request', 400));
    renderAt({ star: 'unpai', inbox: [invite] });
    await screen.findByTestId('inbox-invite', {}, { timeout: 8000 });
    fireEvent.change(screen.getByPlaceholderText('用自己的話說…'), { target: { value: '等一下，先聊聊。' } });
    fireEvent.submit(screen.getByTestId('room-composer'));
    const failed = await screen.findByTestId('room-failed', {}, { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 1800));
    expect(screen.getByTestId('room').hasAttribute('data-choose')).toBe(false);
    expect(screen.getByTestId('room-mine').textContent).toBe('「等一下，先聊聊。」');
    expect(failed.textContent).toContain('沒有送出');
    expect(failed.textContent).toContain('再送一次');
  });

  it('her #56 question — may she call him differently — is asked in her room too, and answered there (#15)', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [], unread: 0 });
    vi.spyOn(api, 'bondOf').mockResolvedValue({ star: 'mahiro', callName: 'ケンタさん', callStage: 'new', ask: { to: 'familiar', text: '……ねえ、これからはケンタくんって呼んでもいい？' }, praise: {} } as never);
    const answer = vi.spyOn(api, 'answerCallName').mockResolvedValue({ reply: 'ふふ、ありがとう。ケンタくん。', callName: 'ケンタくん' } as never);
    renderAt();
    expect((await screen.findByTestId('call-ask', {}, { timeout: 8000 })).textContent).toBe('……ねえ、これからはケンタくんって呼んでもいい？');
    fireEvent.click(await screen.findByTestId('call-yes', {}, { timeout: 8000 }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith('mahiro', 'familiar', true, 'zh-Hant'));
    await waitFor(() => expect(screen.getByTestId('greeting').textContent).toBe('ふふ、ありがとう。ケンタくん。'));
    expect(screen.queryByTestId('call-yes')).toBeNull();
  });

  it('目錄 (M) holds the five, the bond, six cells, his voice time and leaving; Esc closes it', async () => {
    renderAt();
    await ready();
    fireEvent.keyDown(window, { key: 'm' });
    const index = await screen.findByTestId('room-index');
    expect(screen.getByRole('group', { name: '換人' }).querySelectorAll('button')).toHaveLength(5);
    for (const id of ['relationship', 'gift-open', 'room-promise', 'alarm-chip', 'room-history', 'room-memories', 'room-gacha', 'voice-meter', 'room-leave']) {
      expect(index.contains(screen.getByTestId(id))).toBe(true);
    }
    expect(index.textContent).toContain('送禮物');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('room-index')).toBeNull());
    // Picking another star from 目錄 opens her room.
    fireEvent.click(screen.getByTestId('room-index-open'));
    fireEvent.click(screen.getByTestId('star-rule-nana'));
    await waitFor(() => expect(screen.getByTestId('room').textContent).toContain('八木奈奈'));
  });

  it('an open room reads his inbox again: her alarm rings when it comes, and a pushed item it lacks is fetched (QA #1)', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    const at = new Date(); at.setHours(8, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    const wake: InboxItemT = { id: 'w7', star: 'nana', kind: 'wakeup', payload: {}, deliveredAt: new Date(at.getTime() - 60_000).toISOString(), readAt: null, createdAt: at.toISOString() };
    const box = vi.spyOn(api, 'inbox').mockResolvedValue({ items: [], unread: 0 });
    renderAt({ star: 'nana' });
    await ready();
    expect(screen.queryByTestId('call-incoming')).toBeNull();
    // The tick rang it while he was here; he comes back to the tab.
    box.mockResolvedValue({ items: [wake], unread: 1 });
    fireEvent(window, new Event('focus'));
    expect(await screen.findByTestId('call-incoming', {}, { timeout: 4000 })).toBeTruthy();
    cleanup();

    // A tapped push hands the open window her room with ?inbox= for an item delivered after the room loaded.
    const invite: InboxItemT = { ...wake, id: 'm8', star: 'mahiro', kind: 'message', payload: { text: '今晚有空嗎？' } };
    box.mockResolvedValueOnce({ items: [], unread: 0 }).mockResolvedValue({ items: [invite], unread: 1 });
    renderAt({ star: 'mahiro' }, '/me/home?inbox=m8');
    expect(await screen.findByTestId('call-incoming', {}, { timeout: 4000 })).toBeTruthy();
  });

  it('her replies follow her line: hers when her reply brought them, else keyed on what she did, never his own words (QA #4)', async () => {
    // Her opening replies follow the hour; 「我回來了」 is the evening set's, so pin an evening.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-01T20:30:00+09:00') });
    const send = vi.spyOn(api, 'chat').mockResolvedValueOnce({ reply: '要不要一起看星星？', affinityXp: 8, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: 19, freePulls: 0, replies: ['好啊，現在嗎？', '我回來了', '會冷嗎？'] })
      .mockResolvedValueOnce({ reply: '好啊是什麼意思？', affinityXp: 8, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: 18, freePulls: 0 });
    renderAt();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /我回來了/ }));
    await screen.findByTestId('room-her', {}, { timeout: 8000 });
    expect(send.mock.calls[0][5]).toBe(true);
    // Her own suggestions, without what he just said.
    await waitFor(() => expect([...screen.getByTestId('room-replies').querySelectorAll('button')].map((b) => b.textContent!.replace(/^\d/, ''))).toEqual(['好啊，現在嗎？', '會冷嗎？']), { timeout: 4000 });
    fireEvent.click(screen.getByRole('button', { name: /好啊，現在嗎？/ }));
    await waitFor(() => expect(screen.getByTestId('room-her').textContent).toBe('好啊是什麼意思？'));
    // No suggestions with this one: the fallback for an open question, not 「嗯，好啊」 again.
    const now = [...(await screen.findByTestId('room-replies', {}, { timeout: 4000 })).querySelectorAll('button')].map((b) => b.textContent!.replace(/^\d/, ''));
    expect(now).toHaveLength(3);
    for (const r of now) expect(['說來話長…', '你猜猜看', '其實是這樣的', '我也說不上來', '等等跟你說']).toContain(r);
  });

  it('the fallback reads her line: an offer, an open question, a question, a telling; never his last words', () => {
    expect(intentOf('要不要一起看星星？')).toBe('offer');
    expect(intentOf("Shall we watch the stars?")).toBe('offer');
    expect(intentOf('好啊是什麼意思？')).toBe('open');
    expect(intentOf('What do you mean?')).toBe('open');
    expect(intentOf('今天累嗎？')).toBe('asked');
    expect(intentOf('今天下雨了。')).toBe('said');
    for (const her of ['Sure?', 'Really? You mean it?', 'Are you tired?']) expect(answerReplies(her, 'en', ['Yeah'])).not.toContain('Yeah');
    expect(answerReplies('Are you tired?', 'en')).toHaveLength(3);
  });

  it('no Japanese 「・」 in her zh-Hant room or 目錄 (QA #6)', async () => {
    renderAt();
    await ready();
    fireEvent.keyDown(window, { key: 'm' });
    await screen.findByTestId('room-index');
    expect(screen.getByTestId('room').textContent).not.toContain('・');
    expect(screen.getByTestId('rel-days').textContent).toBe('第一章 · 第1天');
  });

  it('the address follows the room: ?star= names her after switching (QA #7)', async () => {
    renderAt({}, '/me/home?star=mahiro');
    await ready();
    fireEvent.click(screen.getByTestId('room-index-open'));
    fireEvent.click(screen.getByTestId('star-rule-nana'));
    await waitFor(() => expect(where).toBe('/me/home?star=nana'));
    expect(screen.getByTestId('room').textContent).toContain('八木奈奈');
  });

  it('in-app navigation to her room by ?star= opens HER room, not the one open before (U-67)', async () => {
    let go: (to: string) => void = () => {};
    function Go() { const n = useNavigate(); go = n; return null; }
    render(
      <StoreProvider initial={{ ...initialState(), ageOk: true, lang: 'zh-Hant', user: { via: 'email', nickname: 'kenta' }, star: 'alice' } as AppState}>
        <MemoryRouter initialEntries={['/menu']}><Where /><Go /><AppRoutes /></MemoryRouter>
      </StoreProvider>
    );
    // The menu, then (no reload) a link or a push that names 詠美.
    await waitFor(() => expect(where).toBe('/menu'));
    act(() => go('/me/home?star=eimi'));
    await waitFor(() => expect(screen.getByTestId('room').getAttribute('data-star')).toBe('eimi'), { timeout: 8000 });
    expect(screen.getByTestId('room').textContent).toContain('深田詠美');
    expect(where).toBe('/me/home?star=eimi');
    // And the address still follows him when he moves on (QA #7).
    await screen.findByTestId('room-replies', {}, { timeout: 4000 });
    fireEvent.click(screen.getByTestId('room-index-open'));
    fireEvent.click(screen.getByTestId('star-rule-nana'));
    await waitFor(() => expect(where).toBe('/me/home?star=nana'));
  });

  it('the address rule: a star named on arrival is where he goes; after he moves, the address follows him', () => {
    expect(followStar('eimi', 'alice', false)).toBeNull();
    expect(followStar('eimi', 'eimi', false)).toBeNull();
    expect(followStar('mahiro', 'nana', true)).toBe('/me/home?star=nana');
    expect(followStar('nobody', 'nana', false)).toBe('/me/home?star=nana');
    expect(followStar(null, 'nana', true)).toBeNull();
  });

  it('his choices wait for her line to type out (QA #8)', async () => {
    renderAt();
    await room();
    await screen.findByTestId('greeting');
    expect(document.querySelector('.room2-bottom .js-cursor')).not.toBeNull();
    expect(screen.queryByTestId('room-replies')).toBeNull();
    fireEvent.keyDown(window, { key: '1' });
    expect(screen.queryByTestId('room-mine')).toBeNull();
    await screen.findByTestId('room-replies', {}, { timeout: 4000 });
    expect(document.querySelector('.room2-bottom .js-more')).not.toBeNull();
  });

  it('a scene opens only by his ✦: 「我回來了」 is said to her, even when she would start the scene (QA #9)', async () => {
    // Her opening replies follow the hour; 「我回來了」 is the evening set's, so pin an evening.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-01T20:30:00+09:00') });
    vi.spyOn(api, 'chat').mockResolvedValue({ reply: '歡迎回來。', affinityXp: 8, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: 19, freePulls: 0,
      scene: { sceneId: 'demo-evening', action: 'start', title: { ja: 'おかえりの夜', 'zh-Hant': '歡迎回家的夜晚', en: 'A Night Back Home' } } });
    renderAt();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /我回來了/ }));
    const yes = await screen.findByTestId('room-scene', {}, { timeout: 8000 });
    expect(yes.textContent).toContain('✦');
    await new Promise((r) => setTimeout(r, 2200));
    expect(where).toBe('/me/home');
    fireEvent.click(yes);
    await waitFor(() => expect(where).toMatch(/^\/me\/scene\/demo-evening/));
  });

  it('her call says what it is by its kind and his hour: no MORNING CALL at 03:27 (QA #11)', () => {
    expect(callKind(3, true)).toEqual({ label: 'wakeCall', when: 'late' });
    expect(callKind(7, true)).toEqual({ label: 'morningCall', when: 'morning' });
    expect(callKind(14, true)).toEqual({ label: 'wakeCall', when: 'daytime' });
    expect(callKind(22, false)).toEqual({ label: 'call', when: 'night' });
    expect(callKind(0, false).when).toBe('late');
  });

  it('her voice time is named for what uses it: scene voice while her runtime voice is off; her room\'s mic is not metered (R09)', async () => {
    const voice = { day: '2026-10-02', leftSeconds: 600, usedSeconds: 0, allowanceSeconds: 600, extensions: 0, extensionsLeft: 3, extendCost: 150, extendMinutes: 30, tts: false };
    renderAt({ voice } as Partial<AppState>);
    await ready();
    expect(screen.queryByTestId('voice-left')).toBeNull();
    fireEvent.keyDown(window, { key: 'm' });
    expect((await screen.findByTestId('room-index')).textContent).toContain('場景語音');
    cleanup();
    renderAt({ voice: { ...voice, tts: true } } as Partial<AppState>);
    await ready();
    expect(screen.getByTestId('voice-left').textContent).toContain('10');
  });

  it('desktop keys (#170): 1–3 answer her, Space on a focused button presses it, Esc closes but never leaves her room', async () => {
    renderAt();
    await ready();
    const said = screen.getByTestId('room-replies').querySelectorAll('button')[1].textContent!.replace(/^\d/, '');
    fireEvent.keyDown(window, { key: '2' });
    expect((await screen.findByTestId('room-mine')).textContent).toBe(`「${said}」`);
    await screen.findByTestId('room-her', {}, { timeout: 8000 });
    // A focused button keeps Space for itself (keyboard users press it); no pure view.
    const btn = screen.getByTestId('room-index-open');
    btn.focus();
    fireEvent.keyDown(btn, { key: ' ' });
    expect(screen.queryByTestId('room-pure-line')).toBeNull();
    // ⌘M / Ctrl+M are the browser's.
    fireEvent.keyDown(window, { key: 'm', metaKey: true });
    expect(screen.queryByTestId('room-index')).toBeNull();
    // The key line names them (desktop shows it).
    expect(screen.getByLabelText('鍵盤').textContent).toBe('1–3回覆SPACE下一頁H純淨模式M目錄ESC關閉');
    // Esc closes 目錄, then the pure view; pressed again and again it stays home (owner, 10/3).
    fireEvent.keyDown(window, { key: 'm' });
    expect(await screen.findByTestId('room-index')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('room-index')).toBeNull());
    for (let i = 0; i < 5; i++) fireEvent.keyDown(window, { key: 'Escape' });
    await new Promise((r) => setTimeout(r, 1200));
    expect(where).toBe('/me/home');
    expect(document.body.textContent).not.toContain('下次再聊喔');
    // 離開通話 leaves once, however often it is pressed: one step back, never past home.
    fireEvent.keyDown(window, { key: 'm' });
    const out = await screen.findByTestId('room-leave');
    fireEvent.click(out); fireEvent.click(out); fireEvent.click(out);
    await waitFor(() => expect(where).toBe('/menu'), { timeout: 3000 });
  });

  it('B「電影字幕」: her line in pages of three lines at whole sentences; a sentence longer than a page is cut where it stops fitting', () => {
    const LONG = '說不上來也沒關係的。有時候一整天就是這樣，淡淡的，沒有什麼特別的。 那就不用說了。現在只要待在這裡就好，我陪你一起把今天慢慢收尾。……要不要喝點溫熱的東西？我這邊正泡著一杯呢。';
    expect(sentenceEnds('好啊。你呢？「嗯。」走吧')).toEqual([3, 6, 10, 12]);
    expect(sentenceEnds('Hi there. How are you?')).toEqual([10, 22]);
    // Three lines of 22: whole sentences only, never a page that ends mid-sentence.
    const fits = (s: string) => s.length <= 66;
    const ends = pageEnds(LONG, fits);
    expect(ends[ends.length - 1]).toBe(LONG.length);
    for (const e of ends.slice(0, -1)) expect('。？！ '.includes(LONG[e - 1])).toBe(true);
    let at = 0;
    for (const e of ends) { expect(fits(LONG.slice(at, e))).toBe(true); at = e; }
    expect(ends.length).toBe(2);
    // One sentence longer than a page: cut where it stops fitting, every piece fits.
    const run = '啊'.repeat(150) + '。';
    const cut = pageEnds(run, fits);
    expect(cut).toEqual([66, 132, 151]);
    // Everything fits: one page.
    expect(pageEnds(LONG, () => true)).toEqual([LONG.length]);
    // Her last words over his choices: the sentences she ends on, short.
    expect(lastWords(LONG)).toBe('……要不要喝點溫熱的東西？我這邊正泡著一杯呢。');
    expect(lastWords('好。')).toBe('好。');
  });

  it('B: each clip is cropped around her face from the manifest; a clip without one takes its ratio\'s default', () => {
    const e = (id: string, ratio: string) => ({ id, ratio, category: 'character' as const, poster: '', sources: [] });
    const a = clipLook(e('mahiro-talk-16x9', '16:9'), { 'mahiro-talk-16x9': [0.6, 0.2, 0.8, 0.5] });
    expect(a.className).toBe(' clip-169');
    expect(a.style).toMatchObject({ '--fx': '0.700', '--fy': '0.350', '--face': '0.6 0.2 0.8 0.5' });
    // Her talk loop and its lip-synced sentence get the same look from the same entry: they line up.
    expect(clipLook(e('mahiro-talk-16x9', '16:9'), { 'mahiro-talk-16x9': [0.6, 0.2, 0.8, 0.5] })).toEqual(a);
    expect(clipLook(e('mahiro-talkclose-9x16', '9:16'), {}).className).toBe(' clip-916');
  });

  it('B: a long reply pages with ▼ (a tap on her words, Space); his choices take her subtitle\'s place only after the last page', async () => {
    const LONG = '說不上來也沒關係的。有時候一整天就是這樣，淡淡的，沒有什麼特別的。 那就不用說了。現在只要待在這裡就好，我陪你一起把今天慢慢收尾。……要不要喝點溫熱的東西？我這邊正泡著一杯呢。';
    vi.spyOn(api, 'chat').mockResolvedValue({ reply: LONG, affinityXp: 0, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: null, freePulls: 0 });
    // jsdom lays nothing out: her subtitle's measure is 22 characters a line of 34 px.
    const style = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, p) => {
      const s = style(el, p);
      return (el as HTMLElement).classList?.contains('room2-measure') ? new Proxy(s, { get: (t, k) => (k === 'lineHeight' ? '34px' : Reflect.get(t, k)) }) : s;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('room2-measure') ? Math.ceil((this.textContent ?? '').length / 22) * 34 : 0;
    });
    renderAt();
    await ready();
    fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
    await screen.findByTestId('room-her', {}, { timeout: 8000 });
    const shown = () => screen.getByTestId('room-cap').querySelector('.js-line > span[aria-hidden]')!.textContent!;
    await waitFor(() => expect(document.querySelector('.room2-bottom .js-more')).not.toBeNull(), { timeout: 4000 });
    // Page 1 of 2: its own sentences, ▼, the page rules — and no choices, however long he waits on it.
    expect(shown()).toBe('「說不上來也沒關係的。有時候一整天就是這樣，淡淡的，沒有什麼特別的。 那就不用說了。▼');
    expect(document.querySelectorAll('.room2-pages .js-rules i')).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 2600));
    expect(screen.queryByTestId('room-replies')).toBeNull();
    // ▼ (a tap on her words): page 2, her line's end and its 」.
    fireEvent.click(screen.getByTestId('room-cap').querySelector('.js-line')!);
    await waitFor(() => expect(shown()).toBe('現在只要待在這裡就好，我陪你一起把今天慢慢收尾。……要不要喝點溫熱的東西？我這邊正泡著一杯呢。」▼'), { timeout: 4000 });
    // Space on the last page: his choices, in her subtitle's place; her last words stay over them.
    fireEvent.keyDown(window, { key: ' ' });
    expect(await screen.findByTestId('room-replies')).toBeTruthy();
    expect(screen.getByTestId('room').hasAttribute('data-choose')).toBe(true);
    expect(document.querySelector('.room2-echo')!.textContent).toBe('「……要不要喝點溫熱的東西？我這邊正泡著一杯呢。」');
    expect(screen.queryByTestId('room-pure-line')).toBeNull();
    // Nothing left to turn: Space is her pure view, as before.
    fireEvent.keyDown(window, { key: ' ' });
    expect(await screen.findByTestId('room-pure-line')).toBeTruthy();
  });

  it('QA #27: her 402 (today\'s messages used up) shows the limit in his choices\' place and takes his input away with it', async () => {
    vi.spyOn(api, 'chat').mockRejectedValue(new ApiError('daily_limit', 402));
    renderAt();
    await ready();
    fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
    expect(await screen.findByTestId('room-limit', {}, { timeout: 6000 })).toBeTruthy();
    expect((document.getElementById('room-input') as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById('room-input') as HTMLInputElement).placeholder).toBe('今天的聊天就到這裡');
    for (const b of screen.getByTestId('room-composer').querySelectorAll('button')) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('room-replies')).toBeNull();
  });

  it('QA #20, #22: 目錄 has one ≡ (關閉 is a word), no INDEX twice in English, the log counts lines', async () => {
    renderAt();
    await ready();
    fireEvent.keyDown(window, { key: 'm' });
    const index = await screen.findByTestId('room-index');
    expect(screen.getByTestId('room-index-close').querySelector('svg')).toBeNull();
    expect(screen.getByTestId('room-history').textContent).toMatch(/共 \d+ 句/);
    expect(index.querySelector('.room2-ttl')!.textContent).toBe('目錄INDEX');
  });

  it('⑥ her wake-up rings as her call: 再睡5分鐘 snoozes it (and says so), 接聽 opens her room on her line', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    const at = new Date(); at.setHours(8, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    const wake: InboxItemT = { id: 'w1', star: 'nana', kind: 'wakeup', payload: {}, deliveredAt: new Date(at.getTime() - 3600_000).toISOString(), readAt: null, createdAt: at.toISOString() };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [wake], unread: 1 });
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    const snooze = vi.spyOn(http, 'wakeSnooze').mockResolvedValue({ item: wake, line: '好啦，再五分鐘。', snoozeLeft: 0 } as never);
    const open = vi.spyOn(http, 'wakeOpen').mockResolvedValue({ item: { ...wake, readAt: at.toISOString() }, line: '醒了嗎？……我泡好茶了喔。' } as never);
    renderAt({ star: 'nana', inbox: [wake] });
    const call = await screen.findByTestId('call-incoming', {}, { timeout: 8000 });
    expect(call.textContent).toContain('八木奈奈');
    // Her call is all there is over her video: the room's layer waits under it, unseen (room.css .room2.ringing).
    expect(screen.getByTestId('room').classList.contains('ringing')).toBe(true);
    expect(screen.getByTestId('call-incoming-later').textContent).toBe('再睡5分鐘');
    fireEvent.click(screen.getByTestId('call-incoming-later'));
    await waitFor(() => expect(snooze).toHaveBeenCalledWith('w1'));
    await waitFor(() => expect(screen.queryByTestId('call-incoming')).toBeNull());
    expect(document.body.textContent).toContain('5分鐘後再叫你');
    cleanup();

    // A wake-up rings once per visit: the next morning's (another item) rings again.
    const next = { ...wake, id: 'w2' };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [next], unread: 1 });
    renderAt({ star: 'nana', inbox: [next] });
    await screen.findByTestId('call-incoming', {}, { timeout: 8000 });
    await act(async () => { fireEvent.click(screen.getByTestId('call-incoming-answer')); });
    await waitFor(() => expect(open).toHaveBeenCalledWith('w2', 'zh-Hant'));
    expect((await screen.findByTestId('greeting')).textContent).toBe('醒了嗎？……我泡好茶了喔。');
    expect(where).toBe('/me/home');
  });

  it('接聽 on her wake call: her wake line leads, her ② messages a tap after it (F-30)', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    const at = new Date(); at.setHours(8, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    const wake: InboxItemT = { id: 'w30', star: 'nana', kind: 'wakeup', payload: { text: '起床囉', lineId: 'x', day: '2026-10-03' }, deliveredAt: new Date(at.getTime() - 60_000).toISOString(), readAt: null, createdAt: at.toISOString() };
    const note: InboxItemT = { id: 'm30', star: 'nana', kind: 'message', payload: { text: '昨天的書好好看。' }, deliveredAt: new Date(at.getTime() - 3600_000).toISOString(), readAt: null, createdAt: at.toISOString() };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [wake, note], unread: 2 });
    vi.spyOn(http, 'wakeOpen').mockResolvedValue({ item: { ...wake, readAt: at.toISOString() }, line: '醒了嗎？……我泡好茶了喔。' } as never);
    renderAt({ star: 'nana', inbox: [wake, note] });
    await screen.findByTestId('call-incoming', {}, { timeout: 8000 });
    await act(async () => { fireEvent.click(screen.getByTestId('call-incoming-answer')); });
    await waitFor(() => expect(screen.getByTestId('greeting').textContent).toBe('醒了嗎？……我泡好茶了喔。'));
    expect(screen.queryByTestId('room-message')).toBeNull();
    fireEvent.click(await screen.findByTestId('room-message-more', {}, { timeout: 4000 }));
    expect((await screen.findByTestId('room-message')).textContent).toBe('昨天的書好好看。');
  });

  it('再睡5分鐘: she rings again from the room at her time, about five minutes later, once (F-04)', async () => {
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
    await act(async () => { vi.advanceTimersByTime(299_000); });
    expect(screen.queryByTestId('call-incoming')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect((await screen.findByTestId('call-incoming-line')).textContent).toBe('「再五分鐘到了喔！」');
    expect(ring).toHaveBeenCalledWith('w5');
    // Her second call: no third 再睡5分鐘.
    expect(screen.queryByTestId('call-incoming-later')).toBeNull();
  });

  it('her message from before today says its date, today\'s only its time (Low 11)', () => {
    const now = new Date('2026-10-04T10:00:00');
    expect(awayWhen(new Date('2026-10-04T08:05:00').toISOString(), 'en', now)).toBe('08:05');
    expect(awayWhen(new Date('2026-10-03T16:31:00').toISOString(), 'en', now)).toBe('10/3　16:31');
  });

  it('M opens 目錄 from her pure view too (Low 9)', async () => {
    renderAt();
    await ready();
    fireEvent.keyDown(window, { key: 'h' });
    await screen.findByTestId('room-pure-line');
    fireEvent.keyDown(window, { key: 'm' });
    expect(await screen.findByTestId('room-index')).toBeTruthy();
  });

  it('her second call of the morning has no 再睡5分鐘, and a refused snooze ends her call without ringing again (U-41)', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    const at = new Date(); at.setHours(8, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    const again: InboxItemT = { id: 'w9', star: 'nana', kind: 'wakeup', payload: { text: '起床囉', lineId: 'x', day: '2026-10-03', snooze: true }, deliveredAt: new Date(at.getTime() - 60_000).toISOString(), readAt: null, createdAt: at.toISOString() };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [again], unread: 1 });
    renderAt({ star: 'nana', inbox: [again] });
    await screen.findByTestId('call-incoming', {}, { timeout: 8000 });
    expect(screen.queryByTestId('call-incoming-later')).toBeNull();
    expect(screen.getByTestId('call-incoming-answer')).toBeTruthy();
    cleanup();

    // A first call whose snooze the server refuses (another device used it): a note, read, and no ring again.
    const first: InboxItemT = { ...again, id: 'w10', payload: { text: '起床囉', lineId: 'x', day: '2026-10-03' } };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [first], unread: 1 });
    const snooze = vi.spyOn(http, 'wakeSnooze').mockRejectedValue(new ApiError('snooze_used', 409));
    const read = vi.spyOn(api, 'readInbox').mockResolvedValue({ item: { ...first, readAt: at.toISOString() }, unread: 0 });
    renderAt({ star: 'nana', inbox: [first] });
    await screen.findByTestId('call-incoming', {}, { timeout: 8000 });
    fireEvent.click(screen.getByTestId('call-incoming-later'));
    await waitFor(() => expect(snooze).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(read).toHaveBeenCalledWith('w10'));
    await waitFor(() => expect(screen.queryByTestId('call-incoming')).toBeNull());
    expect(document.body.textContent).toContain('每天早上只能用一次');
  });

  it('her invitation from a push rings as 接聽 / 下次吧; answered, her line and ✦ lead, her messages a tap away (#14)', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    const at = new Date('2026-10-03T17:50:00+09:00');
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    vi.spyOn(http, 'sceneRoom').mockResolvedValue({ offer: null, invite: { sceneId: 'read-aloud', title: { ja: '朗読', 'zh-Hant': '朗讀', en: 'Reading', ko: '낭독' }, ready: true, dueAt: null, tonight: false } });
    const invite: InboxItemT = { id: 'm9', star: 'nana', kind: 'message', payload: { text: '到了晚上，來見我吧。', herMessage: 'invite', sceneId: 'read-aloud' }, deliveredAt: new Date(at.getTime() - 60_000).toISOString(), readAt: null, createdAt: at.toISOString() };
    const old: InboxItemT = { id: 'w3', star: 'nana', kind: 'wakeup', payload: { text: '起來起來！午睡時間結束囉！' }, deliveredAt: new Date(at.getTime() - 3 * 3600_000).toISOString(), readAt: null, createdAt: at.toISOString() };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [invite, old], unread: 2 });
    renderAt({ star: 'nana', inbox: [invite, old] }, '/me/home?star=nana&inbox=m9');
    await screen.findByTestId('call-incoming', {}, { timeout: 8000 });
    expect(screen.getByTestId('call-incoming-later').textContent).toBe('下次吧');
    expect(screen.getByTestId('call-incoming').textContent).not.toContain('再睡5分鐘');
    await act(async () => { fireEvent.click(screen.getByTestId('call-incoming-answer')); });
    // Her invitation, with ✦ — not the stale wake-up in its place.
    await waitFor(() => expect(screen.getByTestId('inbox-line').textContent).toBe('到了晚上，來見我吧。'), { timeout: 4000 });
    expect((await screen.findByTestId('inbox-invite', {}, { timeout: 4000 })).textContent).toContain('✦');
    expect(screen.queryByTestId('room-message')).toBeNull();
    // Her messages are not hidden: a tap away.
    fireEvent.click(await screen.findByTestId('room-message-more'));
    expect((await screen.findByTestId('room-message')).textContent).toBe('起來起來！午睡時間結束囉！');
  });

  it('an invitation never hides her messages: they come first, then her line with ✦ (U-29)', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    vi.spyOn(http, 'sceneRoom').mockResolvedValue({ offer: null });
    const now = new Date();
    const invite: InboxItemT = { id: 'c1', star: 'alice', kind: 'message', payload: { text: '今晚有很重要的話…', scene: 'confession-alice' }, deliveredAt: now.toISOString(), readAt: null, createdAt: now.toISOString() };
    const note: InboxItemT = { id: 'n1', star: 'alice', kind: 'message', payload: { text: '今天的花開得很好。' }, deliveredAt: now.toISOString(), readAt: null, createdAt: now.toISOString() };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [invite, note], unread: 2 });
    renderAt({ star: 'alice', inbox: [invite, note] });
    expect((await screen.findByTestId('room-message', {}, { timeout: 8000 })).textContent).toBe('今天的花開得很好。');
    fireEvent.click(await screen.findByTestId('room-message-next'));
    await waitFor(() => expect(screen.getByTestId('inbox-line').textContent).toBe('今晚有很重要的話…'));
  });

  describe('her runtime voice in her room (#73)', () => {
    const voice = { day: '2026-10-02', leftSeconds: 600, usedSeconds: 0, allowanceSeconds: 600, extensions: 0, extensionsLeft: 3, extendCost: 150, extendMinutes: 30, tts: true, ttsStars: ['mahiro'] };
    const fakeAudio = () => {
      // jsdom has no media: a clip "plays" and ends at once.
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
        setTimeout(() => this.dispatchEvent(new Event('ended')), 5);
        return Promise.resolve();
      });
      vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    };
    // The switch is remembered per device (and per page): each test starts with it on. These tests take the
    // whole-file path (a vendor that cannot stream: ticket 404); the streamed first sentence has its own test.
    beforeEach(() => {
      setHerVoicePref(true);
      vi.spyOn(http, 'ttsTicket').mockRejectedValue(Object.assign(new Error('no_stream'), { status: 404 }));
    });
    afterEach(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; });
    /** Her reply as the server sends it with her runtime voice on: signed for him (only her own words are spoken). */
    const REPLY = '今晚給我一點時間好嗎？有件事想跟你說。';
    const signedReply = (sig: string | undefined = 'c2lnbmVkLWZvci1oaW0tMTIz') => vi.spyOn(api, 'chat').mockResolvedValue({
      reply: REPLY, affinityXp: 0, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: null, freePulls: 0, ...(sig ? { voiceSig: sig } : {})
    });

    it('her message is a voice note in her voice (#13): asked for and spoken only when he plays it', async () => {
      (window as unknown as { __E2E__: boolean }).__E2E__ = false;
      fakeAudio();
      vi.spyOn(api, 'serverMode').mockReturnValue(true);
      vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
      const msg: InboxItemT = { id: 'n1', star: 'mahiro', kind: 'message', payload: { text: '今天的晚霞好漂亮。', herMessage: 'daily' }, deliveredAt: new Date().toISOString(), readAt: null, createdAt: new Date().toISOString() };
      vi.spyOn(api, 'inbox').mockResolvedValue({ items: [msg], unread: 1 });
      const ask = vi.spyOn(http, 'inboxVoice').mockResolvedValue({ mode: 'voice', line: '今天的晚霞好漂亮。', sig: 'bm90ZS1zaWctZm9yLWhpbTEy' });
      const tts = vi.spyOn(http, 'tts').mockResolvedValue({ mode: 'voice', audio: 'UklGRg==', mime: 'audio/wav', seconds: 1.2, leftSeconds: 590 });
      renderAt({ voice, inbox: [msg] } as Partial<AppState>);
      expect((await screen.findByTestId('room-message', {}, { timeout: 8000 })).textContent).toBe('今天的晚霞好漂亮。');
      const note = await screen.findByTestId('room-note');
      // Low 6: its length, as long as her line takes to say.
      expect(note.querySelector('.js-voice-time')!.textContent).toBe('0:01');
      // Nothing is asked for, nothing synthesized, until he plays it.
      expect(ask).not.toHaveBeenCalled();
      expect(tts).not.toHaveBeenCalled();
      fireEvent.click(note.querySelector('button')!);
      await waitFor(() => expect(ask).toHaveBeenCalledWith('n1'));
      await waitFor(() => expect(tts).toHaveBeenCalled());
      expect(tts.mock.calls[0][0]).toMatchObject({ star: 'mahiro', line: '今天的晚霞好漂亮。', sig: 'bm90ZS1zaWctZm9yLWhpbTEy', index: 0 });
      // Played again: from this page's cache — not signed, synthesized or charged twice.
      const calls = tts.mock.calls.length;
      await new Promise((r) => setTimeout(r, 300));
      fireEvent.click(screen.getByTestId('room-note').querySelector('button')!);
      await new Promise((r) => setTimeout(r, 500));
      expect(ask).toHaveBeenCalledTimes(1);
      expect(tts.mock.calls.length).toBe(calls);
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
    });

    it('no voice note for her message while her voice is off', async () => {
      setHerVoicePref(false);
      vi.spyOn(api, 'serverMode').mockReturnValue(true);
      vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
      const msg: InboxItemT = { id: 'n2', star: 'mahiro', kind: 'message', payload: { text: '晚安。' }, deliveredAt: new Date().toISOString(), readAt: null, createdAt: new Date().toISOString() };
      vi.spyOn(api, 'inbox').mockResolvedValue({ items: [msg], unread: 1 });
      renderAt({ voice, inbox: [msg] } as Partial<AppState>);
      await screen.findByTestId('room-message', {}, { timeout: 8000 });
      expect(screen.queryByTestId('room-note')).toBeNull();
    });

    it('C-room L3: once her voice is done, his meter reads the server\'s count — the input\'s and 目錄\'s alike', async () => {
      (window as unknown as { __E2E__: boolean }).__E2E__ = false;
      fakeAudio();
      signedReply();
      vi.spyOn(http, 'tts').mockResolvedValue({ mode: 'voice', audio: 'UklGRg==', mime: 'audio/wav', seconds: 1.2, leftSeconds: 590 });
      const counted = vi.spyOn(http, 'voice').mockResolvedValue({ ...voice, leftSeconds: 415, usedSeconds: 185 });
      renderAt({ voice } as Partial<AppState>);
      await ready();
      fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
      await screen.findByTestId('room-her', {}, { timeout: 8000 });
      await waitFor(() => expect(counted).toHaveBeenCalled(), { timeout: 8000 });
      await waitFor(() => expect(screen.getByTestId('voice-left').textContent).toContain('6'));
      fireEvent.keyDown(window, { key: 'm' });
      expect((await screen.findByTestId('voice-meter')).textContent).toContain('6');
    });

    it('her reply is spoken in her voice, sentence by sentence, and his minutes follow; 目錄 switches it off', async () => {
      (window as unknown as { __E2E__: boolean }).__E2E__ = false;
      fakeAudio();
      signedReply();
      const tts = vi.spyOn(http, 'tts').mockImplementation(async (b) => ({ mode: 'voice', audio: 'UklGRg==', mime: 'audio/wav', seconds: 1.2, leftSeconds: b.requestId.endsWith(':0') ? 540 : 480 }));
      renderAt({ voice } as Partial<AppState>);
      await ready();
      expect(screen.getByTestId('voice-left').textContent).toContain('10');
      fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
      const her = await screen.findByTestId('room-her', {}, { timeout: 8000 });
      await waitFor(() => expect(tts).toHaveBeenCalled());
      // Her signed reply, sentence by sentence (the server cuts the line it signed the same way).
      await waitFor(() => expect(tts.mock.calls.map((c) => c[0].index).sort()).toEqual([0, 1]));
      const first = tts.mock.calls.find((c) => c[0].index === 0)![0];
      expect(first).toMatchObject({ star: 'mahiro', lang: 'zh-Hant', line: REPLY, sig: 'c2lnbmVkLWZvci1oaW0tMTIz', index: 0 });
      // No stream from this vendor: her first sentence comes whole, under its own request id.
      expect(first.requestId).toMatch(/^line-.+:0s$/);
      expect(her.textContent).toContain(REPLY);
      // Each answer carries his voice time left: the meter follows it.
      await waitFor(() => expect(screen.getByTestId('voice-left').textContent).toMatch(/9|8/));

      // 目錄: her voice switch; off, the next reply is not spoken and the meter leaves the input.
      fireEvent.keyDown(window, { key: 'm' });
      const sw = await screen.findByTestId('room-voice-switch');
      expect(sw.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(sw);
      expect(sw.getAttribute('aria-pressed')).toBe('false');
      expect(sw.textContent).toContain('關');
      expect(localStorage.getItem('jstar.herVoice')).toBe('off');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByTestId('voice-left')).toBeNull();
      const asked = tts.mock.calls.length;
      fireEvent.click((await screen.findByTestId('room-replies', {}, { timeout: 6000 })).querySelector('button')!);
      await screen.findByTestId('room-mine');
      await waitFor(() => expect(screen.getByTestId('room-mine-row').textContent).toContain('已讀'), { timeout: 8000 });
      expect(tts.mock.calls.length).toBe(asked);
    });

    it('never for a talent without a cloned voice, nor for words the server did not sign; a failure leaves her words as subtitles', async () => {
      (window as unknown as { __E2E__: boolean }).__E2E__ = false;
      fakeAudio();
      const chat = signedReply();
      const tts = vi.spyOn(http, 'tts').mockRejectedValue(new Error('offline'));
      renderAt({ voice: { ...voice, ttsStars: ['nana'] } } as Partial<AppState>);
      await ready();
      expect(screen.queryByTestId('voice-left')).toBeNull();
      fireEvent.keyDown(window, { key: 'm' });
      await screen.findByTestId('room-index');
      expect(screen.queryByTestId('room-voice-switch')).toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
      expect(await screen.findByTestId('room-her', {}, { timeout: 8000 })).toBeTruthy();
      expect(tts).not.toHaveBeenCalled();
      cleanup();

      // A reply without its signature is never spoken.
      chat.mockResolvedValue({ reply: REPLY, affinityXp: 0, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: null, freePulls: 0 });
      renderAt({ voice } as Partial<AppState>);
      await ready();
      fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
      await screen.findByTestId('room-her', {}, { timeout: 8000 });
      expect(tts).not.toHaveBeenCalled();
      cleanup();
      signedReply();

      renderAt({ voice } as Partial<AppState>);
      await ready();
      fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
      const her = await screen.findByTestId('room-her', {}, { timeout: 8000 });
      await waitFor(() => expect(tts).toHaveBeenCalled());
      expect(her.textContent).toBeTruthy();
      expect(document.querySelector('[role="alert"]')).toBeNull();
    });

    it('her talking loop and her subtitle follow her audio: silent until it sounds, a sentence typed over its own length, idle between sentences', async () => {
      (window as unknown as { __E2E__: boolean }).__E2E__ = false;
      // A fake <audio>: nothing sounds until the test says so (playing, ended, pause), as a real one.
      class FakeAudio {
        static all: FakeAudio[] = [];
        paused = true; preload = ''; src: string;
        onplaying: (() => void) | null = null; onended: (() => void) | null = null; onpause: (() => void) | null = null; onerror: (() => void) | null = null;
        constructor(src: string) { this.src = src; FakeAudio.all.push(this); }
        load() {}
        play() { this.paused = false; return Promise.resolve(); }
        pause() { if (!this.paused) { this.paused = true; this.onpause?.(); } }
        sound() { this.onplaying?.(); }
        end() { this.paused = true; this.onended?.(); }
      }
      vi.stubGlobal('Audio', FakeAudio);
      signedReply();
      // Each sentence is 0.6 s of her voice.
      vi.spyOn(http, 'tts').mockImplementation(async (b) => ({ mode: 'voice', audio: `QQ${b.index}`, mime: 'audio/mpeg', seconds: 0.6, leftSeconds: 590 }));
      renderAt({ voice } as Partial<AppState>);
      await ready();
      const room = screen.getByTestId('room');
      const shown = () => (screen.getByTestId('room-cap').querySelector('.js-line span[aria-hidden]')?.textContent ?? '').replace(/^「|」$/g, '');
      fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
      // Her reply has come, her voice not yet: no words, no talking loop.
      await waitFor(() => expect(room.getAttribute('data-voice')).toBe('waiting'));
      expect(room.hasAttribute('data-talking')).toBe(false);
      expect(screen.queryByTestId('room-replies')).toBeNull();
      const playing = () => FakeAudio.all.find((a) => !a.paused && a.src.includes('QQ'))!;
      await waitFor(() => expect(playing()).toBeTruthy());
      expect(playing().src).toContain('QQ0');
      expect(shown()).toBe('');

      // Her first sentence sounds: the loop starts a hair later; the sentence types out over its 0.6 s.
      act(() => playing().sound());
      expect(room.getAttribute('data-voice')).toBe('playing');
      await waitFor(() => expect(room.hasAttribute('data-talking')).toBe(true), { timeout: 300 });
      await new Promise((r) => setTimeout(r, 250));
      const mid = shown().length;
      expect(mid).toBeGreaterThan(1);
      expect(mid).toBeLessThan(11);
      await waitFor(() => expect(shown()).toBe('今晚給我一點時間好嗎？'), { timeout: 900 });
      // Its audio has not ended: nothing of the next sentence yet.
      await new Promise((r) => setTimeout(r, 150));
      expect(shown()).toBe('今晚給我一點時間好嗎？');

      // The sentence ends: back to her idle loop until the next one sounds (fetched ahead: it is ready).
      const first = playing();
      act(() => first.end());
      await waitFor(() => expect(room.getAttribute('data-voice')).toBe('gap'));
      expect(room.hasAttribute('data-talking')).toBe(false);
      await waitFor(() => expect(playing()?.src).toContain('QQ1'));
      expect(FakeAudio.all.filter((a) => a.src.includes('QQ1'))).toHaveLength(1);
      act(() => playing().sound());
      await waitFor(() => expect(room.hasAttribute('data-talking')).toBe(true), { timeout: 300 });
      await waitFor(() => expect(shown()).toBe(REPLY), { timeout: 900 });
      act(() => playing().end());
      // Done: idle again, the whole line there, his replies back.
      await waitFor(() => expect(room.hasAttribute('data-voice')).toBe(false));
      expect(room.hasAttribute('data-talking')).toBe(false);
      expect(await screen.findByTestId('room-replies', {}, { timeout: 3000 })).toBeTruthy();
      vi.unstubAllGlobals();
    });

    it('B: her voice turns her pages as she says them — no ▼ while she speaks; ▼ and his choices once she is done', async () => {
      (window as unknown as { __E2E__: boolean }).__E2E__ = false;
      class FakeAudio {
        static all: FakeAudio[] = [];
        paused = true; preload = ''; src: string;
        onplaying: (() => void) | null = null; onended: (() => void) | null = null; onpause: (() => void) | null = null; onerror: (() => void) | null = null;
        constructor(src: string) { this.src = src; FakeAudio.all.push(this); }
        load() {}
        play() { this.paused = false; return Promise.resolve(); }
        pause() { if (!this.paused) { this.paused = true; this.onpause?.(); } }
      }
      vi.stubGlobal('Audio', FakeAudio);
      const LONG = '說不上來也沒關係的。有時候一整天就是這樣，淡淡的，沒有什麼特別的。那就不用說了。現在只要待在這裡就好，我陪你一起把今天慢慢收尾。……要不要喝點溫熱的東西？我這邊正泡著一杯呢。';
      vi.spyOn(api, 'chat').mockResolvedValue({ reply: LONG, affinityXp: 0, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: null, freePulls: 0, voiceSig: 'c2lnbmVkLWZvci1oaW0tMTIz' });
      vi.spyOn(http, 'tts').mockImplementation(async (b) => ({ mode: 'voice', audio: `PG${b.index}`, mime: 'audio/mpeg', seconds: 0.25, leftSeconds: 590 }));
      const style = window.getComputedStyle;
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el, p) => {
        const st = style(el, p);
        return (el as HTMLElement).classList?.contains('room2-measure') ? new Proxy(st, { get: (t, k) => (k === 'lineHeight' ? '34px' : Reflect.get(t, k)) }) : st;
      });
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('room2-measure') ? Math.ceil((this.textContent ?? '').length / 22) * 34 : 0;
      });
      renderAt({ voice } as Partial<AppState>);
      await ready();
      const room = screen.getByTestId('room');
      const shown = () => screen.getByTestId('room-cap').querySelector('.js-line > span[aria-hidden]')?.textContent ?? '';
      fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
      await waitFor(() => expect(room.getAttribute('data-voice')).toBe('waiting'), { timeout: 8000 });
      const seen: string[] = [];
      // Each sentence sounds and ends; nobody taps.
      for (let k = 0; k < 12 && room.hasAttribute('data-voice'); k++) {
        const now = await waitFor(() => { const a = FakeAudio.all.find((x) => !x.paused && x.src.includes('PG')); expect(a).toBeTruthy(); return a!; }, { timeout: 3000 }).catch(() => null);
        if (!now) break;
        act(() => now.onplaying?.());
        await new Promise((r) => setTimeout(r, 320));
        seen.push(shown());
        expect(shown()).not.toContain('▼');
        act(() => { now.paused = true; now.onended?.(); });
      }
      // Page 2 came by itself, as her voice reached it.
      expect(seen.some((t) => t.startsWith('「說不上來'))).toBe(true);
      expect(seen.some((t) => t.startsWith('現在只要'))).toBe(true);
      await waitFor(() => expect(room.hasAttribute('data-voice')).toBe(false), { timeout: 3000 });
      expect(await screen.findByTestId('room-replies', {}, { timeout: 3000 })).toBeTruthy();
      vi.unstubAllGlobals();
    });

    it('B: her lip-synced sentence takes her talk loop\'s own crop and box — the same clip look, so her mouth lands on her mouth', async () => {
      (window as unknown as { __E2E__: boolean }).__E2E__ = false;
      setSceneLoader(async () => SCENE_MEDIA);
      class FakeAudio {
        static all: FakeAudio[] = [];
        paused = true; preload = ''; src: string;
        onplaying: (() => void) | null = null; onended: (() => void) | null = null; onpause: (() => void) | null = null; onerror: (() => void) | null = null;
        constructor(src: string) { this.src = src; FakeAudio.all.push(this); }
        load() {}
        play() { this.paused = false; return Promise.resolve(); }
        pause() { if (!this.paused) { this.paused = true; this.onpause?.(); } }
      }
      vi.stubGlobal('Audio', FakeAudio);
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
      vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
      vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
      URL.createObjectURL = (b: Blob | MediaSource) => (b instanceof Blob && b.type === 'video/mp4' ? 'blob:render' : `blob:audio-${Math.random()}`);
      URL.revokeObjectURL = () => undefined;
      // Her lip-sync service renders each sentence onto her talk loop (a silent MP4).
      const real = globalThis.fetch;
      const asked: string[] = [];
      vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
        if (String(url).includes('/v1/lipsync?')) { asked.push(String(url)); return Promise.resolve(new Response(new Blob(['mp4']), { status: 200, headers: { 'content-type': 'video/mp4', 'x-end-frame': '12' } })); }
        if (String(url).includes('/v1/lipsync/warm')) return Promise.resolve(new Response(''));
        return real(url, init);
      });
      signedReply();
      vi.spyOn(http, 'tts').mockImplementation(async (b) => ({ mode: 'voice', audio: `LS${b.index}`, mime: 'audio/mpeg', seconds: 0.6, leftSeconds: 590, lipsync: 'dG9rZW4' }));
      renderAt({ voice } as Partial<AppState>);
      await ready();
      fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
      const now = await waitFor(() => { const a = FakeAudio.all.find((x) => !x.paused); expect(a).toBeTruthy(); return a!; }, { timeout: 8000 });
      act(() => now.onplaying?.());
      const shot = await screen.findByTestId('lipsync', {}, { timeout: 4000 });
      expect(asked[0]).toMatch(/clip=mahiro-talk-(16x9|9x16)/);
      const talk = document.querySelector<HTMLElement>(`.home-stage [data-scene="${decodeURIComponent(/clip=([^&]+)/.exec(asked[0])![1])}"]`)!;
      expect(talk).not.toBeNull();
      // The same clip look as the loop it was rendered onto: ratio class, face centre and face box, the same box rules.
      const clipClass = (el: Element) => [...el.classList].filter((c) => /^clip-/.test(c));
      expect(clipClass(shot)).toEqual(clipClass(talk));
      expect(clipClass(shot)).toHaveLength(1);
      for (const k of ['--fx', '--fy', '--face', 'visibility']) expect(shot.style.getPropertyValue(k), k).toBe(talk.style.getPropertyValue(k));
      expect(shot.classList.contains('scene') && shot.classList.contains('top-media')).toBe(true);
      expect(shot.querySelector('video')!.classList.contains('scene-video')).toBe(true);
      act(() => { now.paused = true; now.onended?.(); });
      vi.unstubAllGlobals();
      resetSceneLoader();
      delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    });

    it('stopped mid-sentence (he speaks): her loop stops at once and the rest of her words type out at their own pace', async () => {
      (window as unknown as { __E2E__: boolean }).__E2E__ = false;
      class FakeAudio {
        static all: FakeAudio[] = [];
        paused = true; preload = ''; src: string;
        onplaying: (() => void) | null = null; onended: (() => void) | null = null; onpause: (() => void) | null = null; onerror: (() => void) | null = null;
        constructor(src: string) { this.src = src; FakeAudio.all.push(this); }
        load() {}
        play() { this.paused = false; return Promise.resolve(); }
        pause() { if (!this.paused) { this.paused = true; this.onpause?.(); } }
      }
      vi.stubGlobal('Audio', FakeAudio);
      signedReply();
      vi.spyOn(http, 'tts').mockImplementation(async (b) => ({ mode: 'voice', audio: `QQ${b.index}`, mime: 'audio/mpeg', seconds: 5, leftSeconds: 590 }));
      renderAt({ voice } as Partial<AppState>);
      await ready();
      const room = screen.getByTestId('room');
      fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
      await waitFor(() => expect(FakeAudio.all.some((a) => !a.paused && a.src.includes('QQ0'))).toBe(true));
      act(() => FakeAudio.all.find((a) => !a.paused && a.src.includes('QQ0'))!.onplaying?.());
      await waitFor(() => expect(room.hasAttribute('data-talking')).toBe(true), { timeout: 300 });
      // His mic (or leaving) hushes her: stopVoice() — the clip pauses, she is silent at once.
      const { stopVoice } = await import('../../src/lib/sound');
      act(() => stopVoice());
      await waitFor(() => expect(room.hasAttribute('data-voice')).toBe(false));
      expect(room.hasAttribute('data-talking')).toBe(false);
      // Her words are not lost: the subtitle finishes on its own, well before her 10 s of audio would have.
      await waitFor(() => expect(screen.getByTestId('room-cap').textContent).toContain('有件事想跟你說'), { timeout: 2500 });
      vi.unstubAllGlobals();
    });

    it('her first sentence streams: a ticket, then her <audio> plays the stream URL; a stream that fails before a sound comes whole', async () => {
      (window as unknown as { __E2E__: boolean }).__E2E__ = false;
      class FakeAudio {
        static all: FakeAudio[] = [];
        paused = true; preload = ''; src: string;
        onplaying: (() => void) | null = null; onended: (() => void) | null = null; onpause: (() => void) | null = null; onerror: (() => void) | null = null;
        constructor(src: string) { this.src = src; FakeAudio.all.push(this); }
        load() {}
        play() { this.paused = false; return Promise.resolve(); }
        pause() { if (!this.paused) { this.paused = true; this.onpause?.(); } }
      }
      vi.stubGlobal('Audio', FakeAudio);
      signedReply();
      const ticket = vi.spyOn(http, 'ttsTicket').mockResolvedValue({ mode: 'stream', url: '/v1/tts/stream/AbCdEfGhIjKlMnOpQrStUvWx', leftSeconds: 590 });
      // (Payloads of its own: clips preloaded by earlier tests stay in the channel's small cache under their URL.)
      const tts = vi.spyOn(http, 'tts').mockImplementation(async (b) => ({ mode: 'voice', audio: `ZS${b.index}`, mime: 'audio/mpeg', seconds: 0.6, leftSeconds: 590 }));
      renderAt({ voice } as Partial<AppState>);
      await ready();
      const room = screen.getByTestId('room');
      fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
      // The ticket for sentence 0; sentence 1 comes whole, ahead of her.
      await waitFor(() => expect(ticket).toHaveBeenCalledWith(expect.objectContaining({ star: 'mahiro', line: REPLY, index: 0, requestId: expect.stringMatching(/:0$/) })));
      await waitFor(() => expect(tts.mock.calls.map((c) => c[0].index)).toEqual([1]));
      const streamed = () => FakeAudio.all.find((a) => a.src.endsWith('/v1/tts/stream/AbCdEfGhIjKlMnOpQrStUvWx'));
      await waitFor(() => expect(streamed()?.paused).toBe(false));
      // It sounds: her talk loop and her subtitle follow, as for a whole clip.
      act(() => streamed()!.onplaying?.());
      await waitFor(() => expect(room.hasAttribute('data-talking')).toBe(true), { timeout: 300 });
      act(() => { streamed()!.paused = true; streamed()!.onended?.(); });
      await waitFor(() => expect(FakeAudio.all.some((a) => a.src.includes('ZS1') && !a.paused)).toBe(true));
      act(() => { const a = FakeAudio.all.find((x) => x.src.includes('ZS1'))!; a.onplaying?.(); a.paused = true; a.onended?.(); });
      await waitFor(() => expect(room.hasAttribute('data-voice')).toBe(false));
      cleanup();

      // A stream that ends without a sound (blocked, gone): sentence 0 comes whole instead, never silence.
      FakeAudio.all = [];
      tts.mockClear();
      renderAt({ voice } as Partial<AppState>);
      await ready();
      fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
      await waitFor(() => expect(streamed()?.paused).toBe(false));
      act(() => streamed()!.onerror?.());
      await waitFor(() => expect(tts.mock.calls.map((c) => c[0].requestId).some((r) => /:0f$/.test(r))).toBe(true));
      await waitFor(() => expect(FakeAudio.all.some((a) => a.src.includes('ZS0') && !a.paused)).toBe(true));
      vi.unstubAllGlobals();
    });
  });
});
