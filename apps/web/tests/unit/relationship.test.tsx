import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { freshRelationship, type RelationshipState } from '@jstar/shared/relationship';
import { STAGE_RULES, jstDay } from '@jstar/shared/rules';
import { StoreProvider, useStore, type Actions } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, sanitize, type AppState } from '../../src/lib/state';
import { CARDS } from '../../src/data/cards';
import { ensureLang } from '../../src/i18n';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

let latest: { state: AppState; actions: Actions };
function Spy() { latest = useStore(); return null; }
function renderAt(path: string, patch: Partial<AppState> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, ...patch }}>
      <Spy />
      <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}
const rel = (patch: Partial<RelationshipState>): RelationshipState => ({ ...freshRelationship('2026-11-01T00:00:00.000Z'), ...patch });
/** A prototype-mode chat result: like services/api.ts, it carries the wallet as it was; the store adds the stage's pulls. */
const reply = (xp: number) => ({ reply: 'ok', affinityXp: xp, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: 19, freePulls: latest.state.freePulls });

// The bond lives in her room's 目錄 (A2, #163).
const openIndex = async () => fireEvent.click(await screen.findByTestId('room-index-open', {}, { timeout: 8000 }));

describe('relationship panel on the companion home (#54, prototype mode)', () => {
  it('shows the stage, the days together and her hint in her words — never the thresholds', async () => {
    renderAt('/me/home', { star: 'nana', affinity: { ...initialState().affinity, nana: STAGE_RULES.stages.new.xp }, rel: { nana: rel({ daysTogether: 1, lastDay: '2026-11-01' }) } });
    await openIndex();
    const panel = await screen.findByTestId('relationship');
    expect(screen.getByTestId('stage').textContent).toBe('出会ったばかり');
    expect(screen.getByTestId('rel-days').textContent).toBe('第一章・1日目');
    expect(screen.getByTestId('rel-hint').textContent).toBe('もう少し一緒に過ごしたら…もっと近くなれる気がする');
    expect(panel.textContent).not.toContain(String(STAGE_RULES.stages.new.xp));
    expect(screen.queryByTestId('rel-anniv')).toBeNull();
  });

  it('keeps confession_ready looking like ambiguous, and shows lovers their level and anniversary', async () => {
    // Her confession evening opens once a day (#55): already opened today, so her room stays.
    sessionStorage.setItem(`jstar.confession.eimi.${jstDay()}`, '1');
    renderAt('/me/home', { star: 'eimi', rel: { eimi: rel({ stage: 'confession_ready', daysTogether: 7 }) } });
    await openIndex();
    expect((await screen.findByTestId('stage')).textContent).toBe('気になるふたり');
    expect(screen.getByTestId('rel-hint').textContent).toBe('…あのね、今度ちゃんと話したいことがあるの');
    cleanup();
    await ensureLang('en');
    renderAt('/me/home', { star: 'eimi', lang: 'en', affinity: { ...initialState().affinity, eimi: 1000 },
      rel: { eimi: rel({ stage: 'lover', daysTogether: 12, anniversary: '2026-10-09', loverXp: 1000 - STAGE_RULES.loverXpPerLevel }) } });
    await openIndex();
    expect((await screen.findByTestId('stage')).textContent).toBe('Lovers Lv.2');
    expect(screen.getByTestId('rel-anniv').textContent).toBe('Anniversary 10/9');
    expect(screen.getByTestId('rel-days').textContent).toBe('Chapter 1 · Day 12');
  });

  it('a message a day moves the stage on and pays a free pull per stage, not per level', async () => {
    // One day together already (an earlier day), with plenty of XP: today's message is the second day.
    renderAt('/me/home', { freePulls: 0, rel: { mahiro: rel({ daysTogether: 1, lastDay: '2000-01-01' }) } });
    await openIndex();
    await screen.findByTestId('relationship');
    act(() => latest.actions.applyChat('mahiro', reply(STAGE_RULES.stages.ambiguous.xp)));
    expect(latest.state.rel.mahiro).toMatchObject({ stage: 'familiar', daysTogether: 2, lastDay: jstDay() });
    expect(latest.state.freePulls).toBe(1);
    expect(screen.getByTestId('stage').textContent).toBe('仲良し');
    // More messages the same day: no new day, no new stage, no pull.
    act(() => latest.actions.applyChat('mahiro', reply(STAGE_RULES.stages.ambiguous.xp + 8)));
    expect(latest.state.rel.mahiro).toMatchObject({ stage: 'familiar', daysTogether: 2 });
    expect(latest.state.freePulls).toBe(1);
    expect(latest.state.rel.nana).toBeUndefined();
    act(() => latest.actions.logout());
    expect(latest.state.rel).toEqual({});
  });

  it('opens story episode 2 at the familiar stage, whatever the level', async () => {
    const card = CARDS.find((c) => c.story)!;
    const star = card.star;
    renderAt(`/me/cards/${card.id}`, { owned: { [card.id]: 1 }, affinity: { ...initialState().affinity, [star]: 10_000 } });
    const locked = await screen.findByRole('button', { name: /ストーリー 第2話/ });
    expect((locked as HTMLButtonElement).disabled).toBe(true);
    expect(locked.textContent).toContain('「仲良し」になると解放');
    cleanup();
    renderAt(`/me/cards/${card.id}`, { owned: { [card.id]: 1 }, rel: { [star]: rel({ stage: 'familiar', daysTogether: 2, stageDay: 2 }) } });
    expect(((await screen.findByRole('button', { name: /ストーリー 第2話/ })) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('stored relationship state', () => {
  it('keeps a valid one, drops a tampered one, and never stores the API view', () => {
    const good = rel({ stage: 'ambiguous', daysTogether: 5, stageDay: 4, lastDay: '2026-11-05', rewardRank: 2 });
    const s = sanitize({ v: 1, rel: { alice: good, nana: { stage: 'married' }, eimi: 'x', bogus: good }, relView: { alice: { stage: 'lover' } } });
    expect(s.rel).toEqual({ alice: good });
    expect(s.relView).toEqual({});
    expect(sanitize({ v: 1, rel: { mahiro: { ...good, stageDay: 99 } } }).rel.mahiro?.stageDay).toBe(5);
  });
});
