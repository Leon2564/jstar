import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TtsResT, VoiceStateT } from '@jstar/shared/contracts';
import { VOICE_RULES } from '@jstar/shared/rules';
import { StoreProvider, useStore, type Actions } from '../../src/lib/store';
import { initialState, type AppState } from '../../src/lib/state';
import { ExtendSheet, VoiceMeter, VoiceToday, extendBlock, minutesLeft } from '../../src/components/voiceMinutes';
import { speakLine, splitSentences, type Playback } from '../../src/lib/ttsQueue';
import { ApiError, http } from '../../src/services/http';
import { Choices } from '../../src/scene/ui';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; });

const voiceState = (patch: Partial<VoiceStateT> = {}): VoiceStateT => ({
  day: '2026-11-02', leftSeconds: 7 * 60 + 5, usedSeconds: 175, allowanceSeconds: VOICE_RULES.freeMinutesPerDay * 60, extensions: 0,
  extensionsLeft: VOICE_RULES.extendsPerDay, extendCost: VOICE_RULES.extendCostPoints, extendMinutes: VOICE_RULES.extendMinutes, tts: false, ...patch
});
let latest: { state: AppState; actions: Actions };
function Spy() { latest = useStore(); return null; }
function renderWith(ui: React.ReactNode, patch: Partial<AppState> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, points: 1030, ...patch }}>
      <Spy />
      <MemoryRouter>{ui}</MemoryRouter>
    </StoreProvider>
  );
}

describe('her line, sentence by sentence (#73)', () => {
  it('cuts at sentence ends, joins a tiny piece to the next, and never exceeds one request', () => {
    expect(splitSentences('こんばんは。……閉館後の温室へ、ようこそ。今夜は、少しだけ時間があります。')).toEqual(['こんばんは。', '……閉館後の温室へ、ようこそ。', '今夜は、少しだけ時間があります。']);
    // A long first sentence: her first breath ends at its pause (at the edge of 16 characters), the rest follows.
    expect(splitSentences('……っ。……そんなこと言われたら、断れないじゃないですか。')).toEqual(['……っ。……そんなこと言われたら、', '断れないじゃないですか。']);
    expect(splitSentences('Dance…? Here? …No.')).toEqual(['Dance…?', 'Here? …No.']);
    expect(splitSentences('……聴いていて、くださいね。')).toEqual(['……聴いていて、くださいね。']);
    expect(splitSentences('Stay here until the flowers fall asleep… Please.')).toEqual(['Stay here until the flowers fall asleep…', 'Please.']);
    // A run-on is cut at one breath (70 CJK characters), the first at 16, the next within 2.5× what came before (no
    // pause in it: at the limit), never past one request.
    const long = splitSentences('あ'.repeat(450));
    expect(long.map((p) => p.length)).toEqual([16, 40, 14, 70, 70, 70, 70, 70, 30]);
    expect(Math.max(...long.map((p) => p.length))).toBeLessThanOrEqual(VOICE_RULES.ttsMaxChars);
  });

  it('English and other Latin text is cut at its sentence ends too — not at abbreviations, decimals or a mid-sentence ellipsis', () => {
    expect(splitSentences("Hey… tonight, there's something I want to tell you properly. Will you come back this evening? I'll wait!")).toEqual([
      'Hey… tonight,', "there's something I want to tell you properly.", 'Will you come back this evening?', "I'll wait!"
    ]);
    // (Its first sentence is longer than one first breath: cut at a space within 40 characters.)
    expect(splitSentences('I said: Mr. Tanaka paid 3.50 dollars for e.g. a coffee. I mean... you know. J. K. wrote it.')).toEqual([
      'I said: Mr. Tanaka paid 3.50 dollars for', 'e.g. a coffee.', 'I mean... you know.', 'J. K. wrote it.'
    ]);
    expect(splitSentences('Wait... Here.')).toEqual(['Wait...', 'Here.']);
    // Japanese with ASCII marks, and a word that has ! inside it.
    expect(splitSentences('やった!すごいね!ほんと?')).toEqual(['やった!すごいね!', 'ほんと?']);
    expect(splitSentences('I love Yahoo!Japan.')).toEqual(['I love Yahoo!Japan.']);
  });

  it('her first breath is short in every language: a long first sentence is cut at its first pause within 16 CJK / 40 Latin characters', () => {
    // At its first pause.
    expect(splitSentences('我一直在想，如果能跟我說「歡迎回來」的人，永遠都是你就好了。')).toEqual(['我一直在想，', '如果能跟我說「歡迎回來」的人，', '永遠都是你就好了。']);
    expect(splitSentences('この一週間、毎晩あなたの「ただいま」を聞くのが、いちばんの楽しみだったの。')[0]).toBe('この一週間、');
    expect(splitSentences('이번 한 주, 매일 밤 네 「다녀왔어」를 듣는 게 제일 큰 즐거움이었어.')[0]).toBe('이번 한 주,');
    expect(splitSentences('All this week, hearing you say "I\'m home" every night was what I looked forward to most.')[0]).toBe('All this week,');
    // No pause inside the budget: at the budget (CJK), at the last space before it (Latin), never inside a word.
    expect(splitSentences('あなたが今どこで何をしているのかなって考えていたの。')).toEqual(['あなたが今どこで何をしているのか', 'なって考えていたの。']);
    expect(splitSentences('I keep thinking about the way you smiled at me when we met at the station')[0]).toBe('I keep thinking about the way you smiled');
    // A short first sentence stays whole; nothing changes after it but the ramp.
    expect(splitSentences('今晚給我一點時間好嗎？有件事想跟你說。')).toEqual(['今晚給我一點時間好嗎？', '有件事想跟你說。']);
    // Whatever the language, the first piece is within one breath and the line is all there.
    for (const line of ['早～安～！……起床了嗎？起來了就回我一聲，我會很開心的。', 'Good morning! Are you up yet? If you are, say something, it would make me happy.', 'おはよう。起きた？起きたら、ひとこと返事してね。']) {
      const parts = splitSentences(line);
      expect([...parts[0]].length).toBeLessThanOrEqual(/[A-Za-z]/.test(line) ? 40 : 17);
      expect(parts.join('').replace(/\s/g, '')).toBe(line.replace(/\s/g, ''));
    }
  });

  it('a long sentence is cut at a pause (、，, then a space), up to 70 CJK / 140 Latin characters', () => {
    const en = 'I was thinking about you all day today, and about the flowers by the window, and about the way you laughed when I told you that silly story about the cat that wanted to sleep in the greenhouse.';
    const parts = splitSentences(en);
    expect(parts).toEqual(['I was thinking about you all day today,', 'and about the flowers by the window,', 'and about the way you laughed when I told you that silly story about the cat that wanted to sleep in the greenhouse.']);
    const ja = 'きょうはね、朝からずっと雨で、窓の外を見ながら、あなたが今どこで何をしているのかなって考えていたんだけど、気がついたらもう夕方になっていて、ちょっとびっくりしちゃった。';
    const jp = splitSentences(ja);
    expect(jp.every((p) => [...p].length <= 70)).toBe(true);
    expect(jp.join('')).toBe(ja);
    expect(jp[0].endsWith('、')).toBe(true);
    // No pause in it: cut at a space, never inside a word.
    const run = `${'word '.repeat(60)}end.`;
    const words = splitSentences(run);
    expect(words[0].length).toBeLessThanOrEqual(40);
    expect(words.every((p) => p.length <= 140)).toBe(true);
    expect(words.join(' ')).toBe(run.trim());
  });

  const voiced = (left = 100): TtsResT => ({ mode: 'voice', audio: 'QUJD', mime: 'audio/mpeg', seconds: 1, leftSeconds: left });
  const player = () => {
    const played: string[] = [];
    const ends: (() => void)[] = [];
    const play = (clip: { audio: string }): Playback => {
      played.push(clip.audio);
      let end = () => undefined as void;
      const done = new Promise<void>((r) => { end = r; });
      ends.push(end);
      return { done, stop: end };
    };
    return { played, ends, play };
  };

  it('plays each sentence in order, asks for the next while one plays, and shows each as it starts', async () => {
    const asked: number[] = [];
    const p = player();
    const shown: string[] = [];
    const left: number[] = [];
    const s = speakLine('一つ目です。二つ目です。三つ目です。', { fetch: async (_t, i) => { asked.push(i); return voiced(100 - i); }, play: p.play },
      { onSentence: (i, all) => shown.push(all.slice(0, i + 1).join('')), onLeft: (n) => left.push(n) });
    await waitFor(() => expect(p.played).toHaveLength(1));
    // The next two are already on their way while the first plays; the first was asked for first.
    expect(asked).toEqual([0, 1, 2]);
    expect(shown).toEqual(['一つ目です。']);
    p.ends[0]();
    await waitFor(() => expect(p.played).toHaveLength(2));
    p.ends[1]();
    await waitFor(() => expect(p.played).toHaveLength(3));
    p.ends[2]();
    expect(await s.done).toEqual({ mode: 'voice' });
    expect(shown).toEqual(['一つ目です。', '一つ目です。二つ目です。', '一つ目です。二つ目です。三つ目です。']);
    expect(left).toEqual([100, 99, 98]);
  });

  it('no gap before a long sentence: her first goes out first, the next two follow at once, the rest as she speaks', async () => {
    // Fake synthesis: ready after 0.35 s + 0.35 × the sentence's audio (≈ 7 characters a second), as Fish measures.
    vi.useFakeTimers();
    const line = 'ねえ、聞いて。今日はね、朝からずっと雨で、窓の外を見ながら、あなたが今どこで何をしているのかなって考えていたの。それでね、気がついたらもう夕方になっていたの。不思議だよね。';
    const dur = (t: string) => [...t].length / 7;
    const started: { i: number; at: number }[] = [];
    const t0 = Date.now();
    let open = 0, most = 0;
    let firstSound: number | null = null;
    const gaps: number[] = [];
    let lastEnd: number | null = null;
    const s = speakLine(line, {
      fetch: (t, i) => {
        started.push({ i, at: Date.now() - t0 });
        most = Math.max(most, ++open);
        return new Promise((r) => setTimeout(() => { open--; r({ ...voiced(), seconds: dur(t) }); }, 350 + 350 * dur(t)));
      },
      play: (clip) => {
        if (lastEnd !== null) gaps.push(Date.now() - lastEnd);
        firstSound ??= Date.now() - t0;
        let end = () => undefined as void;
        const done = new Promise<void>((r) => { end = () => { lastEnd = Date.now(); r(); }; });
        setTimeout(() => end(), clip.seconds * 1000);
        return { done, stop: end };
      }
    });
    expect(s.sentences.length).toBeGreaterThan(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(started.map((x) => x.i)).toEqual([0, 1, 2]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await s.done).toEqual({ mode: 'voice' });
    expect(started.map((x) => x.i)).toEqual([...s.sentences.keys()]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(250);
    // Her first sound: as soon as her first (short) piece is synthesized.
    expect(firstSound).toBeLessThanOrEqual(1500);
    // Never more than three of hers open at once.
    expect(most).toBeLessThanOrEqual(3);
    vi.useRealTimers();
  });

  it('her first sound within 1.5 s in every language, even when her first sentence is long (QA: zh 7.2 s → 3.5 s wait)', async () => {
    // Fake synthesis as Fish measures it: 0.35 s + 0.35 × the audio; ≈ 7 characters a second (zh, ja, ko), 15 (en).
    const lines: [string, number][] = [
      ['我一直在想，如果能跟我說「歡迎回來」的人，永遠都是你就好了，所以明天也要來喔。你會來吧？', 7],
      ['あなたが今どこで何をしているのかなって考えていたら、もう夕方になっていたの。不思議だよね。', 7],
      ['이번 한 주, 매일 밤 네 「다녀왔어」를 듣는 게 제일 큰 즐거움이었어. 내일도 와 줄래?', 7],
      ["All this week, hearing you say I'm home every night was what I looked forward to most, you know. Come back tomorrow?", 15]
    ];
    vi.useFakeTimers();
    for (const [line, cps] of lines) {
      const t0 = Date.now();
      let first: number | null = null;
      let lastEnd: number | null = null;
      const gaps: number[] = [];
      const s = speakLine(line, {
        fetch: (t) => new Promise((r) => setTimeout(() => r({ ...voiced(), seconds: [...t].length / cps }), 350 + (350 * [...t].length) / cps)),
        play: (clip) => {
          first ??= Date.now() - t0;
          if (lastEnd !== null) gaps.push(Date.now() - lastEnd);
          let end = () => undefined as void;
          const done = new Promise<void>((r) => { end = () => { lastEnd = Date.now(); r(); }; });
          setTimeout(() => end(), clip.seconds * 1000);
          return { done, stop: end };
        }
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await s.done).toEqual({ mode: 'voice' });
      expect(first, line).toBeLessThanOrEqual(1500);
      expect(Math.max(0, ...gaps), line).toBeLessThanOrEqual(250);
    }
    vi.useRealTimers();
  });

  it('QA ja case (0.94 s, 1.28 s, then 10 s): her first sentence streamed, ≥ 6 s queued ahead, no gap over 250 ms', async () => {
    // Fake time: a stream ticket answers in 60 ms and her streamed audio sounds 330 ms after (Fish's first byte); a
    // whole sentence is ready 0.33 s + 0.37 × its audio after it is asked for; her audio is 7 characters a second.
    vi.useFakeTimers();
    const line = `${'ねえねえ、聞いて'.slice(0, 7)}。あのね、本当にね。${'きょうはずっとあなたのことをかんがえていたの'.repeat(4).slice(0, 69)}。`;
    const cps = 7;
    const dur = (t: string) => [...t].length / cps;
    const t0 = Date.now();
    let firstSound: number | null = null;
    let lastEnd: number | null = null;
    const gaps: number[] = [];
    const askedAt: number[] = [];
    const queuedAtStart: number[] = [];
    let open = 0, most = 0;
    const s = speakLine(line, {
      fetch: (t, i) => {
        askedAt[i] = Date.now() - t0;
        most = Math.max(most, ++open);
        if (i === 0) return new Promise((r) => setTimeout(() => { open--; r({ mode: 'stream', url: '/v1/tts/stream/x', seconds: dur(t), leftSeconds: 100 }); }, 60));
        return new Promise((r) => setTimeout(() => { open--; r({ ...voiced(), seconds: dur(t) }); }, 330 + 370 * dur(t)));
      },
      play: (clip, onPlaying) => {
        const lag = clip.mode === 'stream' ? 330 : 0;
        let end = () => undefined as void;
        const done = new Promise<void>((r) => { end = () => { lastEnd = Date.now(); r(); }; });
        setTimeout(() => {
          const now = Date.now();
          firstSound ??= now - t0;
          if (lastEnd !== null) gaps.push(now - lastEnd);
          onPlaying();
          setTimeout(() => end(), clip.seconds * 1000);
        }, lag);
        return { done, stop: end };
      }
    }, {
      onPlaying: (i, all) => {
        // What is asked for after the one she starts now, in seconds of her audio.
        queuedAtStart[i] = all.slice(i + 1).filter((_, k) => askedAt[i + 1 + k] !== undefined).reduce((n, t) => n + dur(t), 0);
      }
    });
    // QA's shape: two short sentences (≈ 1.1 s, 1.3 s), then ten seconds without a pause (now cut in two).
    const d = s.sentences.map(dur);
    expect([d[0] < 1.3, d[1] < 1.5, Math.abs(d.slice(2).reduce((a, b) => a + b, 0) - 10) < 0.2, d.length]).toEqual([true, true, true, 4]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await s.done).toEqual({ mode: 'voice' });
    expect(firstSound).toBeLessThanOrEqual(1000);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(250);
    expect(most).toBeLessThanOrEqual(4);
    // At every sentence start, at least 6 s of her audio (or all that is left) is already asked for.
    const total = (k: number) => s.sentences.slice(k + 1).reduce((n, t) => n + dur(t), 0);
    queuedAtStart.forEach((q, k) => expect(q, `sentence ${k}`).toBeGreaterThanOrEqual(Math.min(6, total(k)) - 1e-9));
    vi.useRealTimers();
  });

  it('off, out of minutes or offline: nothing plays and the line is a subtitle', async () => {
    const p = player();
    const off = speakLine('こんばんは。', { fetch: async () => ({ mode: 'subtitle', reason: 'off', leftSeconds: 600 }), play: p.play });
    expect(await off.done).toEqual({ mode: 'subtitle', reason: 'off' });
    const offline = speakLine('こんばんは。', { fetch: async () => { throw new ApiError('network', 0); }, play: p.play });
    expect(await offline.done).toEqual({ mode: 'subtitle', reason: 'failed' });
    expect(p.played).toEqual([]);
  });

  it('minutes running out mid-line: what she said stays voiced, the rest is text', async () => {
    const p = player();
    const s = speakLine('一つ目です。二つ目です。', { fetch: async (_t, i) => (i === 0 ? voiced(0) : { mode: 'subtitle', reason: 'no_minutes', leftSeconds: 0 }), play: p.play });
    await waitFor(() => expect(p.played).toHaveLength(1));
    p.ends[0]();
    expect(await s.done).toEqual({ mode: 'cut', said: 1, reason: 'no_minutes' });
  });

  it('he talks over her: she stops at once', async () => {
    const p = player();
    const s = speakLine('一つ目です。二つ目です。', { fetch: async () => voiced(), play: p.play });
    await waitFor(() => expect(p.played).toHaveLength(1));
    s.stop();
    expect(await s.done).toEqual({ mode: 'voice' });
    expect(p.played).toHaveLength(1);
  });
});

describe('voice minutes on the web (#74)', () => {
  it('rounds minutes down (1 while any second is left) and knows when an extension cannot be bought', () => {
    expect([minutesLeft(0), minutesLeft(1), minutesLeft(60), minutesLeft(61), minutesLeft(568)]).toEqual([0, 1, 1, 1, 9]);
    expect(extendBlock(voiceState(), 1000)).toBeNull();
    expect(extendBlock(voiceState(), VOICE_RULES.extendCostPoints - 1)).toBe('voice.short');
    expect(extendBlock(voiceState({ extensionsLeft: 0 }), 99_999)).toBe('voice.limit');
  });

  it('no voice time (prototype mode, visitors): no meter, no panel', () => {
    renderWith(<><VoiceMeter /><VoiceToday /></>);
    expect(screen.queryByTestId('voice-meter')).toBeNull();
    expect(screen.queryByTestId('voice-today')).toBeNull();
  });

  it('the meter shows minutes left; My page shows today\'s use', () => {
    renderWith(<><VoiceMeter /><VoiceToday /></>, { voice: voiceState() });
    // L3 (C-room): what is left rounds down (never more than he has), what was used up — together still the day's.
    expect(screen.getByTestId('voice-meter').textContent).toBe('声 残り7分');
    expect(screen.getByTestId('voice-meter').getAttribute('aria-label')).toBe('今日の声の時間：残り7分。タップで延長できます');
    expect(screen.getByTestId('voice-today').textContent).toContain('使った 3分・残り 7分');
  });

  it('the sheet opens on document.body, never inside her room\'s content layer under the tab bar (N-02)', () => {
    renderWith(<div className="home-content" style={{ position: 'relative', zIndex: 2 }}><VoiceMeter /></div>, { voice: voiceState() });
    fireEvent.click(screen.getByTestId('voice-meter'));
    const sheet = screen.getByTestId('voice-extend');
    expect(sheet.parentElement).toBe(document.body);
    expect(sheet.closest('.home-content')).toBeNull();
  });

  it('the sheet extends once per opening: a retry after a failure repeats the same request id', async () => {
    const ids: string[] = [];
    const spy = vi.spyOn(http, 'voiceExtend')
      .mockImplementationOnce(async (id) => { ids.push(id); throw new ApiError('network', 0); })
      .mockImplementationOnce(async (id) => { ids.push(id); return { voice: voiceState({ extensions: 1, extensionsLeft: 2, leftSeconds: 37 * 60 }), points: 880, replayed: false }; });
    const onClose = vi.fn();
    renderWith(<ExtendSheet onClose={onClose} />, { voice: voiceState() });
    expect(screen.getByTestId('voice-extend').textContent).toContain(`${VOICE_RULES.extendCostPoints} ptで、今日の声の時間を${VOICE_RULES.extendMinutes}分のばします。`);
    expect(screen.getByTestId('voice-extend-meta').textContent).toBe(`所持 1,030 pt ／ 今日あと${VOICE_RULES.extendsPerDay}回`);
    fireEvent.click(screen.getByTestId('voice-extend-go'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByTestId('voice-extend-go'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledTimes(2);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/^ext-/);
    expect([latest.state.points, latest.state.voice?.extensions, latest.state.voice?.leftSeconds]).toEqual([880, 1, 37 * 60]);
  });

  it('without the points, or past today\'s extensions, the button is off and says why', () => {
    renderWith(<ExtendSheet onClose={() => undefined} />, { voice: voiceState(), points: 100 });
    const go = screen.getByTestId('voice-extend-go') as HTMLButtonElement;
    expect([go.disabled, go.textContent]).toEqual([true, `あと${VOICE_RULES.extendCostPoints - 100} pt 足りません`]);
    cleanup();
    renderWith(<ExtendSheet onClose={() => undefined} />, { voice: voiceState({ extensionsLeft: 0 }) });
    expect((screen.getByTestId('voice-extend-go') as HTMLButtonElement).textContent).toBe('今日の延長はここまで。また明日ね');
  });

  it("アリス's paid extension greyed out: neither a tap nor its number key picks it (#69)", () => {
    const onPick = vi.fn();
    renderWith(<Choices label="返事を選ぶ" onPick={onPick} options={[{ id: 'extend', label: '30分延長する（150 pt）', off: true }, { id: 'tomorrow', label: '今日はここまで' }]} />);
    const paid = screen.getByTestId('scene-choice-extend') as HTMLButtonElement;
    expect(paid.disabled).toBe(true);
    fireEvent.keyDown(window, { key: '1' });
    fireEvent.keyDown(window, { key: '2' });
    expect(onPick.mock.calls).toEqual([['tomorrow']]);
  });
});
