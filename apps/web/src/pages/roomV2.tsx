/**
 * Her room v2, A2「夜畫廊」 (owner, 2026-10-02; docs/design/room-v2/A2-gallery-night.html; epic #161, #163–#169).
 * Her video fills the screen; its lower half sinks into the night, and what is said floats there — no cards, no
 * pills. ✦ JSTAR and 目錄 at the top, 「HER ROOM 01 / 05」 with the call timer, the date / city / sky / ♥ day, the
 * ┌ corner and her vertical name; at the bottom his line (已讀), her line in Shippori Mincho typing out as it streams
 * (▼ when done), up to three double-rule replies and the hairline input with the mic and her voice minutes.
 * States: ① she speaks first · ② her messages while he was away (1 / 3) · ③ mid-conversation · ④ her invitation
 * (✦ the rose block, 下次吧 as text) · ⑤ pure view (only her and one line; a tap on her, a reaction) · ⑥ her call
 * (再睡5分鐘 / 接聽) · 目錄 (the five, the bond, gift / promise / alarm / log / memories / gacha, voice, leave).
 * Sending is her chat page's own path (useChatSend). Lazy, with the member pages; its words are here, in four languages.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { timelessPromise } from '@jstar/shared/promises';
import { Icon, OfflineLine } from '../components/ui';
import { Link, useNavigate } from 'react-router-dom';
import type { ChatSendResT, GiftSendResT, InboxItemT, PromiseItemT } from '@jstar/shared/contracts';
import { localText, type StarId } from '@jstar/shared/domain';
import { useStore, useT } from '../lib/store';
import { dotSep } from '../i18n';
import { ExtendSheet, minutesLeft } from '../components/voiceMinutes';
import { useVoice } from '../components/voice';
import { GiftSheet } from '../components/gift';
import { PromiseMade } from '../components/promise';
import { SceneVideo, mediaFor, media, preloadClips } from '../components/stage';
import { playVoice, stopVoice, useSound } from '../lib/sound';
import { useHerVoice, type HerVoice, type LipsyncShot, type VoiceCaption } from '../lib/herVoice';
import { warmLipsync } from '../lib/lipsync';
import { itemText, pageEnds, quoteLine, quoteMarks, sentenceEnds } from '../lib/lines';
import { noteVoice, useNoteTime } from '../lib/voiceNote';
import { estimateSeconds } from '../lib/ttsQueue';
import type { MediaEntry } from '../data/media.gen';
// Her face in each clip (tools/media `npm run media:faces`): a file fetched with her room, not bundled as code.
import facesUrl from '../data/faces.gen.json?url';
import { offerClips, sceneLink, type Offer } from '../scene/offer';
import { BrandMark, BtnLine, BtnRose, CornerFrame, HairlineInput, NightFade, PrintPhoto, ReplyChoice, RuleCounter, Sparkles, SpacedLabel, StarRuleSwitcher, VerticalName, Waveform } from '../system';
import { REPLIED, SEND_FAILED, useChatSend } from './chatSend';
import { connectLiveAvatar, type LiveAvatarConnection } from '../lib/viduLive';
import { LIVE_COVERS, ResponsiveLiveCover, liveLayoutForViewport } from '../components/liveCover';
import { CARDS, cardArt, cardTitle } from '../data/cards';
import { EIMI_BONUS_CARD_ID, EIMI_BONUS_REACTIONS, eimiBonusIdle, eimiBonusReaction } from '../data/eimiBonusMedia';
import { getToken } from '../services/http';
import './room.css';

type Lang4 = 'zh-Hant' | 'ja' | 'en' | 'ko';
const L = (zh: string, ja: string, en: string, ko: string) => ({ 'zh-Hant': zh, ja, en, ko }) as Record<Lang4, string>;
/** The room's own words (zh-Hant first: the owner reviews in it). */
export const ROOM = {
  index: L('目錄', '目録', 'Index', '목록'),
  close: L('關閉', '閉じる', 'Close', '닫기'),
  room: L('HER ROOM', 'HER ROOM', 'HER ROOM', 'HER ROOM'),
  onCall: L('通話中', '通話中', 'On call', '통화 중'),
  listening: L('仍在聽', '聞いてるよ', 'still listening', '듣는 중'),
  day: L('第{n}天', '{n}日目', 'Day {n}', '{n}일째'),
  // M4: the two clocks in the status line, labelled as 目錄 labels them: hers (Japan) and, when it differs, his.
  jst: L('日本 {t}', '日本 {t}', 'Japan {t}', '일본 {t}'),
  yours: L('你 {t}', 'あなた {t}', 'You {t}', '나 {t}'),
  you: L('你', 'あなた', 'You', '나'),
  read: L('已讀', '既読', 'Read', '읽음'),
  say: L('用自己的話說…', '自分の言葉で話す…', 'Say it your way…', '내 말로 하기…'),
  voiceLeft: L('聲音 剩{n}分', '声 残り{n}分', 'Voice {n} min', '음성 {n}분'),
  mic: L('語音輸入', '音声入力', 'Voice input', '음성 입력'),
  // N7: English counts its nouns ("1 message", "2 messages": roomText writes `(s)` by {n}).
  away: L('你不在的時候，{first}留了 {n} 則訊息', 'いない間に、{first}から {n} 件のメッセージ', 'While you were away, {first} left {n} message(s)', '네가 없는 동안 {first}가 메시지 {n}개를 남겼어'),
  awayLabel: L('WHILE YOU WERE AWAY', 'WHILE YOU WERE AWAY', 'WHILE YOU WERE AWAY', 'WHILE YOU WERE AWAY'),
  awayMeta: L('{when}　留言', '{when}　メッセージ', '{when}  Message', '{when}  메시지'),
  next: L('NEXT　輕觸看下一則 ▼', 'NEXT　タップで次へ ▼', 'NEXT  Tap for the next ▼', 'NEXT  탭해서 다음 ▼'),
  done: L('看完了 ▼', '読み終えた ▼', 'All read ▼', '다 읽었어 ▼'),
  invitation: L('INVITATION', 'INVITATION', 'INVITATION', 'INVITATION'),
  notNow: L('下次吧', 'また今度', 'Not now', '다음에'),
  morningCall: L('MORNING CALL', 'MORNING CALL', 'MORNING CALL', 'MORNING CALL'),
  call: L('CALL', 'CALL', 'CALL', 'CALL'),
  wakeCall: L('WAKE-UP CALL', 'WAKE-UP CALL', 'WAKE-UP CALL', 'WAKE-UP CALL'),
  late: L('深夜時間', '真夜中の時間', 'late night', '한밤중'),
  incoming: L('來電', '着信', 'Incoming', '수신'),
  callingNow: L('{first}來電', '{first}から着信', '{first} is calling', '{first}의 전화'),
  videoCall: L('視訊通話 · {when}', 'ビデオ通話 · {when}', 'Video call · {when}', '영상 통화 · {when}'),
  morning: L('早安時間', 'おはようの時間', 'good morning', '굿모닝'),
  night: L('晚安時間', 'おやすみの時間', 'good night', '굿나잇'),
  daytime: L('午後時間', 'お昼の時間', 'afternoon', '오후'),
  ringing: L('RINGING　鈴聲是她的聲音', 'RINGING　着信音は彼女の声', 'RINGING  Her voice is the ringtone', 'RINGING  벨소리는 그녀의 목소리'),
  ringTap: L('RINGING　輕觸聽她的鈴聲 ♪', 'RINGING　タップで彼女の着信音 ♪', 'RINGING  Tap to hear her ringtone ♪', 'RINGING  탭해서 그녀의 벨소리 듣기 ♪'),
  snooze: L('再睡5分鐘', 'あと5分', '5 more minutes', '5분만 더'),
  answer: L('接聽', '応答', 'Answer', '받기'),
  answerHint: L('接聽後直接回到她的房間', '応答するとそのまま彼女の部屋へ', 'Answering takes you straight to her room', '받으면 바로 그녀의 방으로'),
  snoozed: L('5分鐘後再叫你', '5分後にまた起こすね', "I'll call you again in 5 minutes", '5분 뒤에 다시 깨울게'),
  firstFive: L('FIRST FIVE', 'FIRST FIVE', 'FIRST FIVE', 'FIRST FIVE'),
  playNote: L('播放她的語音', '声を聞く', 'Play her voice note', '음성 메모 듣기'),
  hear: L('聽她說', '話を聞く', 'Hear her out', '이야기 듣기'),
  // M6: her answered invitation's ✦ (the scene it names, in her room — never her chat page).
  enterScene: L('進入場景', 'シーンへ', 'Into the scene', '장면으로'),
  // N1: her invitation's scene cannot start yet — a promise for when it can (her evening: 今晚見).
  tonight: L('今晚見', '今夜会おう', 'See you tonight', '오늘 밤에 봐'),
  seeYou: L('到時候見', 'その時に会おう', 'See you then', '그때 봐'),
  more: L('還有 {n} 則留言 ▸', 'まだ{n}件のメッセージ ▸', '{n} more from her ▸', '메시지 {n}개 더 ▸'),
  keyReply: L('回覆', '返事', 'Reply', '답장'),
  keyPure: L('純淨模式', '彼女だけ', 'Just her', '그녀만'),
  keyNext: L('下一頁', '次へ', 'Next', '다음'),
  keys: L('鍵盤', 'キーボード', 'Keyboard', '키보드'),
  menu: L('選單', 'メニュー', 'Menu', '메뉴'),
  switchStar: L('換人', '交代', 'Switch', '바꾸기'),
  chapter: L('第一章 · 第{n}天', '第一章・{n}日目', 'Chapter 1 · Day {n}', '1장 · {n}일째'),
  closeness: L('親密度 {n}', '親密度 {n}', 'Closeness {n}', '친밀도 {n}'),
  gift: L('送禮物', 'プレゼント', 'Gift', '선물'),
  promise: L('約定', '約束', 'Promise', '약속'),
  alarm: L('鬧鐘', '目覚まし', 'Alarm', '알람'),
  log: L('記錄', '記録', 'Log', '기록'),
  memories: L('思念', '想い出', 'Memories', '추억'),
  gacha: L('抽卡', 'ガチャ', 'Gacha', '뽑기'),
  lines: L('共 {n} 句', '{n} 言', '{n} line(s)', '{n}마디'),
  noPromise: L('還沒有約定', 'まだ約束はない', 'None yet', '아직 없어'),
  noAlarm: L('未設定', '未設定', 'Not set', '미설정'),
  unread: L('{n} 則未讀', '未読 {n} 件', '{n} unread', '안 읽음 {n}'),
  allRead: L('都看過了', 'すべて既読', 'All read', '모두 읽음'),
  /** 思念 before she has written him anything (a new member): not 「都看過了」. */
  noneYet: L('還沒有', 'まだありません', 'None yet', '아직 없어요'),
  freeToday: L('今日 {n} 次', '今日 {n} 回', '{n} today', '오늘 {n}회'),
  leave: L('離開通話', '通話を終える', 'Leave the call', '통화 나가기'),
  ended: L('通話 {n} 分鐘 · 下次再聊喔', '通話 {n}分 · また話そうね', 'Call {n} min · Talk again soon', '통화 {n}분 · 또 이야기하자'),
  voice: L('聲音', '声', 'Voice', '음성'),
  voiceScene: L('場景語音', 'シーンの声', 'Scene voice', '장면 음성'),
  voiceLeftShort: L('剩{n}分', '残り{n}分', '{n} min', '{n}분'),
  voiceOff: L('關', 'オフ', 'Off', '끔'),
  voiceSwitch: L('她的聲音', '彼女の声', 'Her voice', '그녀의 목소리'),
  // C-room L9: 約定 and 記錄 as her room's own sheets.
  promiseTitle: L('和{first}的約定', '{first}との約束', 'Promises with {first}', '{first}와의 약속'),
  promiseOpen: L('她在等你', 'あなたを待ってる', 'She is waiting for you', '그녀가 기다리고 있어'),
  promiseKept: L('約定守住了', '約束、守れたね', 'Kept', '약속을 지켰어'),
  promiseMissed: L('這次錯過了', '今回は逃しちゃった', 'Missed this time', '이번엔 놓쳤어'),
  promiseNone: L('還沒有約定。她提起「下次」的時候，答應她就好。', 'まだ約束はない。彼女が「また今度」と言ったら、応えてあげて。', 'No promise yet. When she talks about next time, say yes.', '아직 약속이 없어. 그녀가 「다음에」를 꺼내면 대답해 줘.'),
  logTitle: L('和{first}的記錄', '{first}との記録', 'Your log with {first}', '{first}와의 기록'),
  logNone: L('還沒有說過話', 'まだ話していない', 'Nothing said yet', '아직 나눈 말이 없어')
} as const;
export const roomText = (k: keyof typeof ROOM, lang: string, v: Record<string, string | number> = {}) =>
  Object.entries(v).reduce((s, [a, b]) => s.split(`{${a}}`).join(String(b)), (ROOM[k] as Record<string, string>)[lang] ?? ROOM[k]['zh-Hant'])
    .replace(/(\w+)\(s\)/g, (_, w: string) => (v.n === 1 ? w : `${w}s`));

// ---------------------------------------------------------------- replies (up to three)

type Slot = 'morning' | 'day' | 'night';
const lang4 = (lang: string): Lang4 => (lang === 'ja' || lang === 'en' || lang === 'ko' ? lang : 'zh-Hant');
/** For her first line: by the part of her day; the third is hers alone. */
const OPENING: Record<Slot, Record<Lang4, [string, string]>> = {
  morning: { 'zh-Hant': ['早安', '剛起床'], ja: ['おはよう', 'いま起きた'], en: ['Good morning', 'Just woke up'], ko: ['좋은 아침', '방금 일어났어'] },
  day: { 'zh-Hant': ['午安', '在休息中'], ja: ['こんにちは', 'いま休憩中'], en: ['Hi there', 'On a break'], ko: ['안녕', '지금 쉬는 중'] },
  night: { 'zh-Hant': ['我回來了', '有點累'], ja: ['ただいま', 'ちょっと疲れた'], en: ["I'm home", 'A bit tired'], ko: ['나 왔어', '좀 피곤해'] }
};
/** M2: his answers once he picked up her wake-up call (her first words are her wake-up line, not her greeting). */
const WAKE: Record<Lang4, string[]> = {
  'zh-Hant': ['起床了', '謝謝你叫我', '還想再睡一下'],
  ja: ['起きたよ', '起こしてくれてありがとう', 'まだ眠い…'],
  en: ["I'm up", 'Thanks for waking me', 'Still sleepy…'],
  ko: ['일어났어', '깨워 줘서 고마워', '아직 졸려…']
};
export const wakeReplies = (lang: string): string[] => WAKE[lang4(lang)];
const HERS: Record<StarId, Record<Lang4, string>> = {
  mahiro: L('想聽你的聲音', '声が聞きたくて', 'Wanted to hear your voice', '목소리 듣고 싶어서'),
  nana: L('今天也很有精神嗎？', '今日も元気？', 'Full of energy today?', '오늘도 기운 넘쳐?'),
  eimi: L('別再捉弄我了啦', 'からかわないでよ', "Don't tease me", '놀리지 마'),
  alice: L('今天的花開得好嗎？', '今日のお花はどう？', 'How are the flowers today?', '오늘 꽃은 어때?'),
  unpai: L('今晚也要熬夜嗎？', '今夜も夜ふかし？', 'Staying up late again?', '오늘도 밤샐 거야?')
};
/**
 * QA #4, the fallback when her reply brought no suggestions of his next words (the agent writes them with her reply):
 * keyed on what her line does — offers something, asks what / why / how, asks anything else, or tells — five each,
 * three shown (which three turns with her line), never the reply he just used.
 */
type Intent = 'offer' | 'open' | 'asked' | 'said';
const ANSWER: Record<Intent, Record<Lang4, string[]>> = {
  offer: {
    'zh-Hant': ['好啊，就這麼說定', '下次吧', '你決定就好', '聽起來不錯', '我考慮一下'],
    ja: ['うん、そうしよう', 'また今度ね', 'まかせるよ', 'いいね、それ', 'ちょっと考えさせて'],
    en: ["Yes, let's", 'Maybe next time', 'You decide', 'Sounds good', 'Let me think'],
    ko: ['좋아, 그러자', '다음에 하자', '네가 정해', '좋은데?', '조금만 생각해 볼게']
  },
  open: {
    'zh-Hant': ['說來話長…', '你猜猜看', '其實是這樣的', '我也說不上來', '等等跟你說'],
    ja: ['話すと長いよ', '当ててみて', '実はね…', 'うまく言えないな', 'あとで話すね'],
    en: ["It's a long story", 'Guess', 'Well, actually…', "I can't quite say", "I'll tell you later"],
    ko: ['얘기하면 길어', '맞혀 봐', '사실은…', '잘 모르겠어', '이따 말해 줄게']
  },
  asked: {
    'zh-Hant': ['嗯，是啊', '不太確定耶', '你呢？', '當然', '有一點'],
    ja: ['うん、そうだよ', 'どうかな', 'きみは？', 'もちろん', 'ちょっとね'],
    en: ['Yeah', 'Not sure', 'What about you?', 'Of course', 'A little'],
    ko: ['응, 맞아', '잘 모르겠어', '너는?', '당연하지', '조금']
  },
  said: {
    'zh-Hant': ['真的嗎？', '然後呢？', '謝謝你', '我懂', '好可愛'],
    ja: ['ほんと？', 'それで？', 'ありがとう', 'わかるよ', 'かわいいね'],
    en: ['Really?', 'And then?', 'Thank you', 'I get it', "That's cute"],
    ko: ['진짜?', '그래서?', '고마워', '알 것 같아', '귀엽다']
  }
};
/** The waveform's bars (a voice note's shape; its sound is the recording itself). */
const BARS = [3, 6, 9, 5, 11, 7, 4, 8, 12, 6, 3, 7, 10, 5, 8, 4, 6, 9, 3, 5];
const ASKS = /[？?]\s*[」』"]?\s*$/;
const OFFERS = /要不要|好不好|一起|可以嗎|來.{0,6}吧|吧[？?]|しよう|しない[？?]|どう[？?]|一緒に|shall we|want to|how about|let's|wanna|할래|하자|어때|같이/i;
const OPEN = /什麼|怎麼|為什麼|哪|誰|幾|なに|何|どう|なんで|どこ|だれ|いつ|\bwhat\b|\bwhy\b|\bhow\b|\bwhere\b|\bwho\b|\bwhen\b|뭐|왜|어떻게|어디|누구|언제/i;
export function intentOf(her: string): Intent {
  const t = her.trim();
  if (ASKS.test(t) && OFFERS.test(t)) return 'offer';
  if (ASKS.test(t) && OPEN.test(t)) return 'open';
  if (ASKS.test(t)) return 'asked';
  return OFFERS.test(t) ? 'offer' : 'said';
}
/** To one of her messages. */
const TO_MESSAGE: Record<Lang4, [string, string]> = { 'zh-Hant': ['謝謝你的留言', '好想見你'], ja: ['メッセージありがとう', '会いたかった'], en: ['Thanks for the message', 'I missed you'], ko: ['메시지 고마워', '보고 싶었어'] };
export const openingReplies = (star: StarId, slot: Slot, lang: string): string[] => [...OPENING[slot][lang4(lang)], HERS[star][lang4(lang)]];
/** Three of the fallback replies to her line, which three turning with it, never one he just said (`not`). */
export function answerReplies(her: string, lang: string, not: string[] = []): string[] {
  const set = ANSWER[intentOf(her)][lang4(lang)].filter((r) => !not.some((n) => n.trim() === r));
  const at = [...her].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % set.length;
  return [...set.slice(at), ...set.slice(0, at)].slice(0, 3);
}

// ---------------------------------------------------------------- clips

/** Her talking loop for the look her room shows: her close one when the room is on her face. */
export function talkClipFor(star: string, look: string, portrait: boolean): MediaEntry | undefined {
  if (star === 'eimi' && look === EIMI_BONUS_CARD_ID) return eimiBonusIdle();
  // Eimi's approved feedback set is silent performance footage; keep her new idle master under generated speech.
  if (star === 'eimi') return mediaFor('eimi-idle', portrait);
  return (look === 'face' && portrait ? media(`${star}-talkclose-9x16`) : undefined) ?? mediaFor(`${star}-talk`, portrait);
}
/** Her listening loop (her idle loop) while he types or speaks. */
export const listenClipFor = (star: string, portrait: boolean): MediaEntry | undefined => mediaFor(`${star}-idle`, portrait);

/**
 * B「電影字幕」 (owner, 10/3): her 9:16 clips below 17:20 (P), her 16:9 clips from there (M, W) — room.css's own line.
 * No matchMedia (tests): wide, as the orientation query answered before.
 */
const WIDE = '(min-aspect-ratio: 17/20)';
const wideNow = () => typeof window === 'undefined' || !window.matchMedia || window.matchMedia(WIDE).matches;
export function useStagePortrait(): boolean {
  const [wide, setWide] = useState(wideNow);
  useEffect(() => {
    const m = window.matchMedia?.(WIDE);
    const on = () => setWide(m.matches);
    m?.addEventListener?.('change', on);
    return () => m?.removeEventListener?.('change', on);
  }, []);
  return !wide;
}
type Faces = Record<string, number[]>;
let faces: Faces | null = null;
const facesLoad = typeof window === 'undefined' ? null
  : fetch(facesUrl).then((r) => (r.ok ? r.json() : {})).catch(() => ({})).then((f: Faces) => { faces = f; });
/** Her face in each of her clips (null until the file is here; {} when it cannot load: each ratio's default). */
export function useFaces(): Faces | null {
  const [f, setF] = useState(faces);
  useEffect(() => { if (!f) void facesLoad?.then(() => setF(faces)); }, [f]);
  return f;
}
/**
 * What a clip on her stage takes (room.css crops it around her face): its ratio, and her face's centre and box in it.
 * Her talk loop, her listening loop and her lip-synced sentence get it from the same entry, so they line up exactly.
 */
export function clipLook(e: MediaEntry | undefined, f: Faces | null): { className: string; style: CSSProperties } {
  const wide = e?.ratio === '16:9';
  const b = (e && f?.[e.id]) || (wide ? [0.57, 0.18, 0.78, 0.54] : [0.32, 0.25, 0.68, 0.48]);
  // Until her face file is here (a moment) the clip is laid out but unseen: its poster is already on its way.
  return { className: wide ? ' clip-169' : ' clip-916', style: { '--fx': ((b[0] + b[2]) / 2).toFixed(3), '--fy': ((b[1] + b[3]) / 2).toFixed(3), '--face': b.join(' '), visibility: f ? undefined : 'hidden' } as CSSProperties };
}

/** Her face on screen now, [left, top, right, bottom] (her clip's box, its crop and its --face), or null. */
export function faceOnScreen(): number[] | null {
  const s = document.querySelector<HTMLElement>('.home-stage .scene.depth-enter'), i = s?.querySelector<HTMLElement>('.scene-poster');
  if (!s || !i) return null;
  const c = getComputedStyle(s), o = getComputedStyle(i).objectPosition.split(' ').map(parseFloat), r = i.getBoundingClientRect();
  const ar = parseFloat(c.getPropertyValue('--ar')), f = c.getPropertyValue('--face').trim().split(/\s+/).map(Number);
  const w = Math.max(r.width, r.height * ar), h = w / ar, x = r.left + o[0], y = r.top + o[1];
  return ar && f.length === 4 && o.length === 2 ? [x + f[0] * w, y + f[1] * h, x + f[2] * w, y + f[3] * h] : null;
}

/**
 * H2: a short landscape window (room.css draws the same line): her words keep to the side away from her face. And
 * (C-room, 740×675) every window from 17:20 on, where 目錄 keeps beside her face: its edge stays off her hair.
 */
const SHORT_LANDSCAPE = '(min-aspect-ratio: 17/20)';
type FaceSide = { side: 'left' | 'right'; l: number; r: number };
/** Which side of the screen her face is on, and where it starts and ends — measured where her clip is 16:9 (M, W). */
export function useFaceSide(): FaceSide | null {
  const [at, setAt] = useState<FaceSide | null>(null);
  useEffect(() => {
    const mq = window.matchMedia?.(SHORT_LANDSCAPE);
    if (!mq) return;
    let id: ReturnType<typeof setInterval> | undefined;
    const measure = () => {
      const f = mq.matches ? faceOnScreen() : null;
      if (!f) return;
      const next: FaceSide = { side: (f[0] + f[2]) / 2 < window.innerWidth / 2 ? 'left' : 'right', l: Math.round(f[0] / 4) * 4, r: Math.round(f[2] / 4) * 4 };
      setAt((cur) => (cur && cur.side === next.side && cur.l === next.l && cur.r === next.r ? cur : next));
    };
    // Her clip paints (and is cropped) a moment after the room: measured again while she is on screen.
    const arm = () => { clearInterval(id); if (mq.matches) { measure(); id = setInterval(measure, 1000); } };
    arm();
    mq.addEventListener?.('change', arm);
    window.addEventListener('resize', measure);
    return () => { clearInterval(id); mq.removeEventListener?.('change', arm); window.removeEventListener('resize', measure); };
  }, []);
  return at;
}

// ---------------------------------------------------------------- her words in pages (a romance ADV's ▼)

export { pageEnds, sentenceEnds } from '../lib/lines';
/** The pages of her line as her subtitle box sets it (measured; one page where nothing can be measured). */
function usePages(text: string, box: RefObject<HTMLElement | null>): number[] {
  const [ends, setEnds] = useState<number[]>([text.length]);
  const [w, setW] = useState(0);
  useEffect(() => {
    const bump = () => setW((x) => x + 1);
    void document.fonts?.ready.then(bump);
    window.addEventListener('resize', bump);
    return () => window.removeEventListener('resize', bump);
  }, []);
  // Measured again when her line, the box's width or the box itself (it comes once she starts) changes (a key, not deps).
  const last = useRef('');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- every render, guarded by the key above
  useLayoutEffect(() => {
    const m = box.current;
    const key = `${text}|${w}|${!!m}`;
    if (key === last.current) return;
    last.current = key;
    // H2: three lines, two in a short landscape window (room.css --sub-lines).
    const cs = m ? getComputedStyle(m) : null;
    const max = cs ? parseFloat(cs.lineHeight) * (parseInt(cs.getPropertyValue('--sub-lines'), 10) || 3) + 1 : 0;
    const next = m && max > 1 ? pageEnds(text, (s) => { m.textContent = `「${s}」▼`; return m.offsetHeight <= max; }) : [text.length];
    if (next.join() !== ends.join()) setEnds(next);
  });
  return ends[ends.length - 1] === text.length ? ends : [text.length];
}
/** The sentences she ends on, short enough for a line or two: they stay over his choices, which take her subtitle's place. */
export function lastWords(text: string, max = 36): string {
  const ends = sentenceEnds(text);
  let from = ends.length > 1 ? ends[ends.length - 2] : 0;
  for (let i = ends.length - 2; i >= 0; i--) {
    const at = i ? ends[i - 1] : 0;
    if (text.slice(at).trim().length > max) break;
    from = at;
  }
  return text.slice(from).trim();
}

/**
 * Her line typing out a character at a time (a streamed reply grows under it); all at once with reduced motion.
 * While her voice says it (#73): `hold` keeps it where it is (before her first sentence sounds, between sentences),
 * and `caption` types the sentence she is saying over that sentence's audio, so the words appear as she says them.
 * When her voice is off or stops, it goes on at its own pace from where it is.
 */
function useTyped(text: string, voice: { hold: boolean; caption: VoiceCaption | null } = { hold: false, caption: null }, limit = text.length): { shown: string; done: boolean; n: number; skip: () => void } {
  const reduce = useMemo(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, []);
  // At its own pace it types up to `limit` (the end of her page: ▼ turns it); her voice leads past it.
  const cap = Math.min(limit, text.length);
  const [n, setN] = useState(reduce && !voice.hold && !voice.caption ? cap : 0);
  const last = useRef(text);
  useEffect(() => {
    if (!text.startsWith(last.current.slice(0, Math.min(n, last.current.length)))) setN(0);
    last.current = text;
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const said = voice.caption;
  useEffect(() => {
    if (!said) return;
    const from = Math.min(said.from, text.length), to = Math.min(said.to, text.length);
    if (reduce) { setN(to); return; }
    setN((k) => Math.max(k, from));
    const t0 = Date.now();
    const id = setInterval(() => {
      const k = from + Math.floor(((Date.now() - t0) / said.ms) * (to - from));
      setN((cur) => Math.max(cur, Math.min(to, k)));
      if (k >= to) clearInterval(id);
    }, 30);
    return () => clearInterval(id);
  }, [said?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (voice.hold || said) return;
    if (reduce) { setN((k) => Math.max(k, cap)); return; }
    if (n >= cap) return;
    // About a second for a whole line (QA #8): 30 ms a character for a short one, faster for a long one.
    const id = setTimeout(() => setN((k) => Math.max(k, Math.min(cap, k + 1))), Math.max(12, Math.min(30, Math.round(1000 / Math.max(1, text.length)))));
    return () => clearTimeout(id);
  }, [n, text, reduce, voice.hold, said, cap]);
  return { shown: text.slice(0, n), done: n >= text.length, n, skip: () => setN((k) => Math.max(k, cap)) };
}
/** 「0:06」. */
const clockOf = (seconds: number) => { const s = Math.max(1, Math.round(seconds)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
/**
 * M4: the status line's date and clocks — her date and time in Japan, labelled, and his when his clock differs
 * (「10/5　日本 04:05 · 你 03:05」): never his device's time unlabelled beside her city.
 */
export function roomClock(now: Date, lang: string): string {
  const jst = new Date(now.getTime() + 9 * 3600_000);
  const hers = `${jst.getUTCMonth() + 1}/${jst.getUTCDate()}　${roomText('jst', lang, { t: hhmm(jst.getUTCHours(), jst.getUTCMinutes()) })}`;
  return now.getTimezoneOffset() === -540 ? hers : `${hers}${dotSep(lang)}${roomText('yours', lang, { t: hhmm(now.getHours(), now.getMinutes()) })}`;
}
/** Low 11: when her message came — the time today, the date and time before today. */
export function awayWhen(at: string, lang: string, now = new Date()): string {
  const d = new Date(at);
  const loc = lang === 'en' ? 'en-GB' : lang;
  const time = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()}　${time}`;
}
/** M5 / L1: her words in her language's quotes (lib/lines.ts). */
const quoted = (s: string, lang: string) => quoteLine(s, lang);
/**
 * H1: whether he came into her room from a page of the app (so back stays in it), not straight from a link or a push.
 * The router's own index in the session history: a star switch (a replace) keeps it at 0 — `location.key` does not,
 * and back from there left the site.
 */
export function cameFromApp(): boolean {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' && idx > 0;
}

// ---------------------------------------------------------------- the props

/** Her line before he talks, with the replies it asks for. */
export interface Lead {
  text: string;
  /** The test id on her line (greeting), and on the group of line + replies (scene-offer). */
  testId?: string;
  groupTestId?: string;
  groupLabel?: string;
  label?: 'room' | 'invitation';
  /**
   * #14: he answered her call for this invitation, so it leads, ahead of her ② messages ( 「還有 N 則留言」 brings
   * them). Any other invitation waits behind her messages: an invitation never hides them (U-29).
   */
  urgent?: boolean;
  /**
   * M2: his replies to this line in place of the opening set — her wake-up line after 接聽 (wakeReplies), her answer to
   * his naming answer or a message she called with (answerReplies on her last words).
   */
  replies?: string[];
  /** #15: his answers to her line when it asks him something (her #56 question): in place of the usual replies. */
  choices?: { label: string; onClick: () => void; testId?: string; disabled?: boolean }[];
  /** Her ✦ invitation (the rose block) and 下次吧. */
  invite?: { title: string; to?: string; onClick?: () => void; testId: string; laterTestId?: string; onLater?: () => void };
}
/** `hour`: his clock's hour as she calls; `wakeup`: her alarm call (else her invitation from a push). */
export interface Incoming {
  star: StarId; idx: number; name: string; first: string; romaji: string; line: string; hour: number; wakeup: boolean; onAnswer: () => void; onSnooze: () => void;
  /** #14: the other button — 再睡5分鐘 (her alarm), 下次吧 (her invitation), or none (her second call of the morning). */
  later?: 'snooze' | 'notNow' | null;
  /** #12: her ringtone (her voice); `blocked`: not sounding by itself, so the call offers a tap to hear her. */
  ring?: { blocked: boolean; unmute: () => void };
}
/**
 * QA #11: what her call says it is, by its kind and his hour — 深夜 0–4, 早安 5–10, 午後 11–17, 晚安 18–23; an alarm call
 * is MORNING CALL only in the morning, WAKE-UP CALL otherwise (an alarm at 03:27 is no morning call).
 */
export function callKind(hour: number, wakeup: boolean): { label: 'morningCall' | 'wakeCall' | 'call'; when: 'late' | 'morning' | 'daytime' | 'night' } {
  const when = hour < 5 ? 'late' : hour < 11 ? 'morning' : hour < 18 ? 'daytime' : 'night';
  return { label: wakeup ? (when === 'morning' ? 'morningCall' : 'wakeCall') : 'call', when };
}
export interface IndexData {
  /** tag: her presence under her name (#60, at home / out / asleep, her city's sky); dim while she is asleep. */
  stars: { id: string; label: string; badge?: number; aria?: string; tag?: ReactNode; dim?: boolean }[];
  /** What she is doing now, on her clock (#60). */
  now?: ReactNode;
  /** Her hint in her words and their anniversary (#54), under the bond. */
  bond?: ReactNode;
  onPick: (id: string) => void;
  stage: string;
  days: number;
  progress: number;
  closeness: number;
  giftHint: string | null;
  promise: PromiseItemT | null;
  promiseWhen: string | null;
  /** C-room R5: a promise whose time is over is kept or missed, never 「她在等你」. */
  promiseState?: 'open' | 'kept' | 'missed' | null;
  promiseLabel?: string | null;
  /** C-room R3: undefined while it is read (「…」). */
  alarm: string | null | undefined;
  /** null: not known yet (L8: the server's count is asked for as 目錄 opens). */
  linesTonight: number | null;
  /** C-room L9: what was said between them, oldest first (記錄 shows it in her room); null while it is read. */
  log?: { id: string; from: string; text: string; kind?: string }[] | null;
  /** 目錄 opened. */
  onOpen?: () => void;
  unread: number;
  /** Everything she has written him (read or not): 0 for a new member. */
  inboxTotal?: number;
  freePulls: number;
  /** The test site's demo menu, the alarm proposal, the chips (check-in, voice meter): under the grid. */
  extra: ReactNode;
}
export interface RoomV2Props {
  star: StarId;
  idx: number;
  name: string;
  first: string;
  romaji: string;
  /** 「10/1　23:50」, 「東京 · 晴」 (「東京・晴」 in Japanese), ♥ days. */
  date: string;
  place: string | null;
  /** Her sky (「多雲」): N10, the first to give way on the status line. */
  sky?: string | null;
  days: number | null;
  slot: Slot;
  lead: Lead | { wait: true; asleep?: string };
  /** R12: her line that comes in while he stays (a promise come due): her newest line, with ✦, until he answers. */
  interject?: (Lead & { id: string }) | null;
  messages: InboxItemT[];
  /** ② the photo with one of her messages: the one it carries, else one of her stills (none: no photo). */
  messageStill?: (m: InboxItemT) => string | undefined;
  /** All of ② seen: these ids (and only these) are read. */
  onMessagesRead: (ids: string[]) => void;
  incoming: Incoming | null;
  /** H1: another of the five is calling (her alarm, her invitation) while he is in this room: a small line, not her call over this face. */
  calling?: { first: string; onOpen: () => void } | null;
  index: IndexData;
  onTalking: (on: boolean) => void;
  onListening: (on: boolean) => void;
  /** Her talk loop on screen (its media id): what her runtime voice is lip-synced onto (#73, lib/lipsync.ts). */
  talkClip?: string;
  /** Her sentence lip-synced onto that loop, or null: the room shows it over her talk loop. */
  onLipsync?: (shot: LipsyncShot | null) => void;
  onToast: (msg: string) => void;
  onGift: (r: GiftSendResT) => void;
  /** A tap on her in pure view: her reaction line (and her reaction clip, which the room plays). */
  onTapHer: () => Promise<string | null>;
  onPure: (on: boolean) => void;
}

// ---------------------------------------------------------------- the room

export function RoomV2(p: RoomV2Props) {
  const { state, actions } = useStore();
  const t = useT();
  const nav = useNavigate();
  const lang = t.lang;
  const privateMode = !p.incoming;
  const [opened, setOpened] = useState(() => Date.now());
  // QA #22: the call's timer counts the call, not her ringing: it starts again once her call is answered (or let go).
  const ringingNow = !!p.incoming;
  useEffect(() => { if (!ringingNow) setOpened(Date.now()); }, [ringingNow]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const secs = Math.max(0, Math.floor((now - opened) / 1000));
  const timer = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  const [indexOpen, setIndexOpen] = useState(false);
  const [giftOpen, setGiftOpen] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);
  const [sheet, setSheet] = useState<'promise' | 'log' | null>(null);
  const [pure, setPureState] = useState(false);
  const setPure = (on: boolean) => { setPureState(on); p.onPure(on); };
  const [reaction, setReaction] = useState<string | null>(null);
  const face = useFaceSide();
  const [privateEntering, setPrivateEntering] = useState(true);
  const [privateReady, setPrivateReady] = useState(false);
  const [privateConnected, setPrivateConnected] = useState(false);
  const [privateUnavailable, setPrivateUnavailable] = useState(false);
  const [privateSceneOpen, setPrivateSceneOpen] = useState(false);
  const [privateTier, setPrivateTier] = useState<'SSR' | 'UR'>('SSR');
  const [privateCard, setPrivateCard] = useState<string | null>(() => {
    const requested = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('card');
    const card = requested ?? state.selectedCards[p.star] ?? null;
    return card && !!state.owned[card] && CARDS.some((item) => item.id === card && item.star === p.star && (item.rarity === 'SSR' || item.rarity === 'UR')) ? card : null;
  });
  const [privateBonusReaction, setPrivateBonusReaction] = useState<MediaEntry | null>(null);
  const privateBonusAt = useRef(0);
  const [privateLines, setPrivateLines] = useState<Array<{ id: string; from: 'me' | 'her'; text: string }>>([]);
  const privateStream = useRef<HTMLDivElement>(null);
  const privateConnection = useRef<LiveAvatarConnection | null>(null);
  const privateFallbackReplies = useRef(0);
  useEffect(() => {
    document.documentElement.classList.remove('private-live-route-leave');
    const enter = window.setTimeout(() => setPrivateEntering(false), 520);
    let alive = true;
    let poll = 0;
    let startTimer = 0;
    let retryTimer = 0;
    let retryCount = 0;
    let after = 0;
    const target = privateStream.current;
    setPrivateReady(false);
    setPrivateConnected(false);
    setPrivateUnavailable(false);
    privateConnection.current = null;

    const retry = () => {
      if (!alive) return;
      if (retryCount >= 3) {
        setPrivateUnavailable(true);
        return;
      }
      const delay = Math.min(15000, 1800 * (2 ** Math.min(retryCount, 3)));
      retryCount += 1;
      retryTimer = window.setTimeout(connect, delay);
    };
    const connect = () => {
      if (!target || !alive) return;
      target.replaceChildren();
      const layout = liveLayoutForViewport();
      void connectLiveAvatar(p.star, target, () => {
        if (alive) setPrivateReady(true);
      }, 'ja', layout).then((connection) => {
        if (!alive) { void connection?.close(); return; }
        if (!connection) { retry(); return; }
        retryCount = 0;
        privateConnection.current = connection;
        setPrivateConnected(true);
        poll = window.setInterval(async () => {
          try {
            const events = await connection.events(after, lang);
            for (const event of events) {
              after = Math.max(after, event.seq);
              setPrivateLines((lines) => [...lines.slice(-5), { id: `her-${event.seq}`, from: 'her', text: event.text }]);
            }
          } catch { /* a short polling failure leaves the call on screen */ }
        }, 700);
      }).catch(retry);
    };
    // React StrictMode mounts effects twice in development. Waiting one tick prevents the discarded mount from
    // opening a second paid provider session and tripping the per-IP session limit before the real room can join.
    startTimer = window.setTimeout(connect, 120);
    return () => {
      alive = false;
      window.clearTimeout(enter);
      window.clearTimeout(startTimer);
      window.clearTimeout(retryTimer);
      window.clearInterval(poll);
      const connection = privateConnection.current;
      privateConnection.current = null;
      setPrivateConnected(false);
      void connection?.close();
    };
  }, [p.star, lang]);

  // ---- the conversation (her chat page's own path)
  const [sentHere] = useState(() => new Set<string>());
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [made, setMade] = useState<PromiseItemT | null>(null);
  const [sceneAsk, setSceneAsk] = useState<NonNullable<ChatSendResT['scene']> | null>(null);
  // QA #4: his next words, written with her reply (for that reply only).
  const [suggested, setSuggested] = useState<{ id: string; list: string[] } | null>(null);
  // Her runtime voice (#73): her reply spoken in her cloned voice when the server offers it and his switch is on.
  const her = useHerVoice(p.star, lang, p.talkClip);
  // Her lip-sync (#73): a GPU is readied as her room opens with her voice on, long before her first reply.
  useEffect(() => { if (her.on && !(window as unknown as { __E2E__?: boolean }).__E2E__) warmLipsync(p.star); }, [p.star, her.on]);
  const { onLipsync } = p;
  useEffect(() => { onLipsync?.(her.lipsync); }, [her.lipsync, onLipsync]);
  useEffect(() => () => onLipsync?.(null), [onLipsync]);
  const talk = useChatSend(p.star, {
    sentHere, onToast: p.onToast,
    language: privateMode ? 'ja' : undefined,
    // He speaks again: she stops (N-32).
    onStart: () => { her.stop(); setSceneAsk(null); setMade(null); },
    onResult: (r, added) => {
      if (r.promise) setMade(r.promise);
      if (r.scene) setSceneAsk(r.scene);
      setSuggested(r.replies?.length && added[0] ? { id: added[0].id, list: r.replies } : null);
      if (privateMode && privateFallbackReplies.current > 0) {
        privateFallbackReplies.current -= 1;
        setPrivateLines((lines) => [...lines.slice(-5), { id: `her-api-${Date.now()}`, from: 'her', text: r.reply }]);
      }
      offerDue.current = true;
    },
    speak: her.speak,
    suggest: true,
    holdOffer: true
  });
  // N3: her notifications are offered once she has said it all and his choices are up (below), or as he leaves.
  const offerDue = useRef(false);
  const offerNow = () => { if (offerDue.current) { offerDue.current = false; window.dispatchEvent(new Event(REPLIED)); } };
  const { busy, live, failed, left, deliver } = talk;
  // QA #9: in her room a scene opens only by his ✦ — her yes (`start`) or her offer alike — never on its own after her
  // line: 「我回來了」 is something he says to her, and the call goes on until he chooses the scene.
  const field = useRef<HTMLInputElement>(null);
  const sendRef = useRef<(text: string) => boolean>(() => false);
  sendRef.current = talk.send;
  const voice = useVoice({ onStart: stopVoice, onFinal: (said) => { if (privateMode || !sendRef.current(said)) setDraft(said); }, onNotice: p.onToast, field });
  // Her idle loop while he types or speaks — and, with her voice on, whenever her audio is not sounding (before her
  // first sentence, between sentences, after she ends or is stopped).
  const voiceLed = her.willSpeak || her.phase !== 'off';
  const listening = (!busy && (voice.listening || focused || !!draft.trim())) || voiceLed;
  const { onTalking, onListening } = p;
  // Her talking loop: while her voice is on, exactly while her audio sounds (not while her reply is coming, nor in the
  // pauses between sentences); with it off, while her reply streams in, as before.
  const talking = voiceLed ? her.audible : busy;
  useEffect(() => { onTalking(privateMode ? false : talking); }, [privateMode, talking, onTalking]);
  useEffect(() => { onListening(privateMode ? false : listening); }, [privateMode, listening, onListening]);
  useEffect(() => () => { onTalking(false); onListening(false); }, [onTalking, onListening]);
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (voice.listening) { voice.ctl.toggle(); return; }
    const text = draft.trim();
    if (!text) return;
    const connection = privateConnection.current;
    if (!connection) {
      // The conversation stays playable while the visual RTC avatar is establishing. Its regular chat path supplies
      // the Japanese reply, which is mirrored into this room; once RTC is ready subsequent lines use Vidu directly.
      privateFallbackReplies.current += 1;
      if (!talk.send(text)) {
        privateFallbackReplies.current -= 1;
        return;
      }
      setPrivateLines((lines) => [...lines.slice(-5), { id: `me-api-${Date.now()}`, from: 'me', text }]);
      setDraft('');
      return;
    }
    setPrivateLines((lines) => [...lines.slice(-5), { id: `me-${Date.now()}`, from: 'me', text }]);
    setDraft('');
    if (privateCard === EIMI_BONUS_CARD_ID && p.star === 'eimi') {
      const key = EIMI_BONUS_REACTIONS[privateBonusAt.current % EIMI_BONUS_REACTIONS.length];
      privateBonusAt.current += 1;
      setPrivateBonusReaction(eimiBonusReaction(key));
    }
    void connection.send(text).catch(() => p.onToast(t('common.error')));
  }
  // Answering her message counts as reading it: the next one waits behind her answer (②).
  const say = (text: string) => { setReaction(null); if (message) markSeen(message); talk.send(text); };

  // What was said in this call: his last line, her last reply (earlier lines are in 記錄).
  const msgs = state.chats[p.star];
  const here = useMemo(() => msgs.filter((m) => sentHere.has(m.id) && m.kind !== 'memory'), [msgs, sentHere]);
  const mine = [...here].reverse().find((m) => m.from === 'me') ?? null;
  // QA #11: her last line stays her last line when his next one did not go (failed, blocked, the limit): never her
  // opening greeting and its replies again. `answered`: she has spoken since his last line.
  const lastHer = [...here].reverse().find((m) => m.from === 'her') ?? null;
  const answered = !!lastHer && (!mine || here.indexOf(lastHer) > here.indexOf(mine));

  // ② her messages while he was away, one at a time. NEXT or his answer moves on; answered, the next one waits
  // behind her answer (「還有 N 則留言」 brings it). Once all are seen they are read — those, and only those.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const queue = p.messages.filter((m) => !seen.has(m.id));
  const current = queue[0] ?? null;
  // here.length when her message last took the floor: a message shows while he has said nothing since.
  const [msgBase, setMsgBase] = useState(0);
  // Messages that arrive while he is here (her room reads his inbox again) take the floor when he is not mid-reply.
  const msgKey = p.messages.map((m) => m.id).join(',');
  const [lastKey, setLastKey] = useState(msgKey);
  if (msgKey !== lastKey) { setLastKey(msgKey); if (!busy) setMsgBase(here.length); }
  // U-29: her messages come first, then her invitation — except one he answered her call for (#14), which leads with
  // her messages a tap away.
  const [msgsAsked, setMsgsAsked] = useState(false);
  // F-30: her answered call's line is urgent too (no ✦ of its own).
  const leadFirst = !('wait' in p.lead) && !!p.lead.urgent && !msgsAsked;
  const message = current && !busy && here.length === msgBase && !leadFirst ? current : null;
  const moreWaiting = current && !busy && !message && (here.length !== msgBase || leadFirst) ? queue.length : 0;
  const msgAt = current ? p.messages.indexOf(current) : 0;
  function markSeen(m: InboxItemT) {
    const next = new Set(seen).add(m.id);
    setSeen(next);
    if (p.messages.every((x) => next.has(x.id))) p.onMessagesRead(p.messages.map((x) => x.id));
  }
  const nextMessage = () => { if (current) markSeen(current); };
  const photo = message ? p.messageStill?.(message) : undefined;
  const audio = message && typeof message.payload.audio === 'string' && message.payload.audio.startsWith('/') ? message.payload.audio : null;
  const recordedTime = useNoteTime(audio);
  // #13: her message without a recording is a voice note in her runtime voice when it is his to hear (her voice on,
  // sound on, minutes left): asked for and spoken only when he plays it, each second from his voice minutes.
  const sound = useSound();
  const spokenNote = !audio && message && her.on && sound && (state.voice?.leftSeconds ?? 0) > 0 && typeof message.payload.text === 'string' && message.payload.text.trim() ? message : null;
  // Low 6: a note in her runtime voice shows its length too — as long as her line takes to say (the voice is made
  // when he plays it, so it is reckoned from her words, as her voice queue does).
  const noteTime = recordedTime || (spokenNote ? clockOf(estimateSeconds(String(spokenNote.payload.text))) : '');

  // R12: her interjection holds the floor from when it comes until he says something.
  const [ijMark, setIjMark] = useState<{ id: string; n: number } | null>(null);
  if (p.interject && ijMark?.id !== p.interject.id) setIjMark({ id: p.interject.id, n: here.length });
  const ij = !busy && p.interject && ijMark?.id === p.interject.id && ijMark.n === here.length ? p.interject : null;

  // What her line says now.
  const lead = 'wait' in p.lead ? null : p.lead;
  // With her voice on, her reply is not shown as it streams: it appears as she says it.
  // N5: her message in his language (its `texts`), else as the server wrote it for his account — never another's.
  const herText = busy ? (her.willSpeak ? '' : live ?? '') : ij ? ij.text : message ? itemText(message.payload, lang) : lastHer ? lastHer.text : lead?.text ?? '';
  const spoken = !busy && !ij && !message && !reaction && !!lastHer && her.phase !== 'off';
  // B「電影字幕」: her line in pages of three lines (a romance ADV's ▼). While her voice says it, her voice turns them;
  // otherwise ▼ does (a tap on her words, Space). A new line, not the same one growing as it streams, starts on page 1.
  const lineText = reaction ?? herText;
  const measure = useRef<HTMLSpanElement>(null);
  const ends = usePages(lineText, measure);
  const [pg, setPg] = useState({ text: '', page: 0 });
  if (pg.text !== lineText) setPg({ text: lineText, page: pg.text && lineText.startsWith(pg.text) ? pg.page : 0 });
  const page = Math.min(pg.page, ends.length - 1);
  const typed = useTyped(lineText, spoken ? { hold: her.phase !== 'playing', caption: her.caption } : undefined, spoken ? undefined : ends[page]);
  // Her voice past the end of the page: the next page, as she says it.
  const at = typed.n > ends[page] ? ends.findIndex((e) => e >= typed.n) : page;
  if (at > page) setPg({ text: lineText, page: at });
  const pageEnd = ends[page], lastPage = page === ends.length - 1, pageDone = typed.n >= pageEnd;
  const quote = !/^[「『"]/.test(lineText.trim());
  const pageShown = lineText.slice(page ? ends[page - 1] : 0, Math.min(typed.n, pageEnd));
  const [qo, qc] = quoteMarks(lang);
  const subtitle = pageShown ? `${quote && !page ? qo : ''}${pageShown}${quote && lastPage && pageDone && !busy ? qc : ''}` : '';
  const waiting = (busy && (!live || her.willSpeak)) || (spoken && her.phase === 'waiting') || (!busy && !ij && !lastHer && !message && !lead && !reaction);
  const asleepLine = 'wait' in p.lead ? p.lead.asleep : undefined;
  const invite = ij ? ij.invite : !busy && !lastHer && !message ? lead?.invite : undefined;
  // His last words in this call are never offered back to him; her own suggestions first, else the fallback set.
  const said = here.filter((m) => m.from === 'me').slice(-2).map((m) => m.text.trim());
  const fromHer = lastHer && suggested?.id === lastHer.id ? suggested.list.filter((r) => !said.includes(r.trim())).slice(0, 3) : [];
  const leadChoices = !busy && !ij && !lastHer && !message && lead?.choices?.length ? lead.choices : null;
  const replies: string[] = busy || left === 0 || invite || sceneAsk || leadChoices ? []
    : message ? TO_MESSAGE[lang4(lang)]
    : lastHer ? (fromHer.length ? fromHer : answerReplies(lastWords(lastHer.text), lang, said))
      : lead?.replies?.length ? lead.replies.slice(0, 3) : openingReplies(p.star, p.slot, lang);
  // Her line with its own group (her invitation to a scene: scene-offer), when it is the one on screen.
  const group = ij?.groupTestId ? ij : !busy && !ij && !lastHer && !message && lead?.groupTestId ? lead : null;
  // QA #8: his choices come once her line has typed out, never ahead of her words — and B: they take her subtitle's
  // place, so they come on ▼, or once she has had time to be read (her voice was that time).
  const lineDone = !busy && !waiting && typed.done;
  const [chooseFor, setChooseFor] = useState<string | null>(null);
  // When her last words over the choices hold all of her last page, nothing is lost: they come at once.
  const lastPage0 = lineText.slice(page ? ends[page - 1] : 0, pageEnd).trim();
  const readMs = lastWords(lineText).length >= lastPage0.length ? 0 : voiceLed ? 500 : Math.max(600, Math.min(1600, lastPage0.length * 30));
  useEffect(() => {
    if (!lineDone || chooseFor === lineText) return;
    const id = setTimeout(() => setChooseFor(lineText), readMs);
    return () => clearTimeout(id);
  }, [lineDone, lineText, chooseFor]); // eslint-disable-line react-hooks/exhaustive-deps
  // M3: out of messages for today, the limit panel shows at once — never only after he pages through her last reply.
  // C-room R2: except her reply to the message that used the last one: she says it all (her voice, her pages) first,
  // and the panel comes in his choices' place after her last page.
  const lastReplyUnread = answered && !!lastHer && !reaction && !ij && !message && lineText === lastHer.text && chooseFor !== lineText;
  const limited = left === 0 && !busy && !lastReplyUnread;
  const choices = limited || (lineDone && chooseFor === lineText);
  /** ▼: the rest of the page at once, the next page, then his choices. Her voice turns her pages itself. */
  const advance = (): boolean => {
    if (spoken || waiting) return false;
    if (!pageDone) { typed.skip(); return true; }
    if (!lastPage) { setPg({ text: lineText, page: page + 1 }); return true; }
    if (lineDone && chooseFor !== lineText) { setChooseFor(lineText); return true; }
    return false;
  };
  const lineTestId = busy ? (live ? 'room-live' : undefined) : ij ? ij.testId : message ? 'room-message' : lastHer ? 'room-her' : lead?.testId;
  // B: his choices replace her subtitle (never stacked under it) once there is something to choose.
  // F-14: his last line did not go — it stays on screen with 「沒有送出 / 再送一次」 (her line above it), never hidden under
  // his choices or her ✦: he resends it, or says something else.
  const hisFailed = !!mine && failed.has(mine.id) && !answered && !busy;
  const choosing = choices && (!hisFailed || limited) && (replies.length > 0 || !!leadChoices || !!invite || !!sceneAsk || left === 0 || moreWaiting > 0 || !!message || !!made);
  useEffect(() => { if (choosing && !busy && her.phase === 'off') offerNow(); });

  // ⑤ pure view: a tap on the empty video or a swipe down; a tap on her there, her reaction; a tap elsewhere or up, back.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const surfaceDown = (e: React.PointerEvent) => { touch.current = { x: e.clientX, y: e.clientY }; };
  const surfaceUp = async (e: React.PointerEvent) => {
    const s = touch.current;
    touch.current = null;
    if (!s) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { // swipe left / right: another of the five
      const ids = p.index.stars.map((x) => x.id);
      const i = ids.indexOf(p.star);
      p.index.onPick(ids[(i + (dx < 0 ? 1 : -1) + ids.length) % ids.length]);
      return;
    }
    if (dy > 50 && Math.abs(dy) > Math.abs(dx)) { setPure(true); return; }
    if (dy < -50 && Math.abs(dy) > Math.abs(dx)) { setPure(false); return; }
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
    if (!pure) { setPure(true); return; }
    const onHer = e.clientX > box.left + box.width * 0.2 && e.clientX < box.left + box.width * 0.85 && e.clientY > box.top + box.height * 0.12 && e.clientY < box.top + box.height * 0.72;
    if (!onHer) { setPure(false); setReaction(null); return; }
    setTap({ ...rippleAt(e.clientX, e.clientY, faceOnScreen(), window.innerWidth), key: Date.now() });
    const line = await p.onTapHer();
    if (line) setReaction(line);
  };
  const [tap, setTap] = useState<{ x: number; y: number; key: number } | null>(null);
  // Desktop keys (A2, B): 1–3 replies, Space ▼ (her pure view once there is nothing left to turn), H pure view, M 目錄,
  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      // L6: Esc closes 目錄 from inside its own fields too (the alarm's time).
      if (e.key === 'Escape' && indexOpen && typing && !giftOpen) { setIndexOpen(false); return; }
      if (typing || p.incoming || giftOpen || extendOpen || sheet || leaving.current || e.metaKey || e.ctrlKey || e.altKey) return;
      // Space on a focused button or link presses it (keyboard users); elsewhere it is her pure view.
      if (e.key === ' ') { if (tag === 'BUTTON' || tag === 'A') return; e.preventDefault(); if (indexOpen || !advance()) setPure(!pure); }
      else if (e.key === 'h' || e.key === 'H') setPure(!pure);
      // Low 9: M opens 目錄 from her pure view too (the room comes back with it).
      else if (e.key === 'm' || e.key === 'M') { if (pure) { setPure(false); setIndexOpen(true); } else setIndexOpen((o) => !o); }
      // Esc closes 目錄, then the pure view — and stops there. Her room is his home: Esc never ends the call
      // (owner, 10/3: pressed again and again it walked him out of home); 目錄's 離開通話 does.
      else if (e.key === 'Escape') { if (indexOpen) setIndexOpen(false); else if (pure) setPure(false); }
      else if (/^[1-3]$/.test(e.key) && choosing && leadChoices?.[Number(e.key) - 1] && !indexOpen) leadChoices[Number(e.key) - 1].onClick();
      else if (/^[1-3]$/.test(e.key) && choosing && replies[Number(e.key) - 1] && !indexOpen) say(replies[Number(e.key) - 1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // One leave per call: a second Esc (or 離開通話) while the first is on its way out would step back past
  // where he came from — out of home, even out of the site.
  const leaving = useRef(false);
  const leave = () => {
    if (leaving.current) return;
    leaving.current = true;
    stopVoice();
    offerNow();
    p.onToast(roomText('ended', lang, { n: Math.max(1, Math.round(secs / 60)) }));
    // Back where he came from in the app; opened straight into her room (a link, a push), the menu — never out of the site.
    setTimeout(() => { if (cameFromApp()) nav(-1); else nav('/menu'); }, 900);
  };
  const v = state.voice;
  const mins = v ? minutesLeft(v.leftSeconds) : null;
  const label = message
    ? <><SpacedLabel>{roomText('awayLabel', lang)}</SpacedLabel><SpacedLabel meta>{String(msgAt + 1).padStart(2, '0')} / {String(p.messages.length).padStart(2, '0')}</SpacedLabel></>
    : <SpacedLabel>{lead?.label === 'invitation' && invite ? <><span className="js-spark" aria-hidden="true">✦</span> {roomText('invitation', lang)}</> : `${roomText('room', lang)}　${String(p.idx + 1).padStart(2, '0')} / 05`}</SpacedLabel>;
  // ▼ stays with her last character (never alone on a line of its own).
  const more = !busy && pageDone && !spoken && (!message || !lastPage);
  const line = (
    <>
      <span aria-hidden="true">{more ? subtitle.slice(0, -1) : subtitle}{more && <span className="room2-tail">{subtitle.slice(-1)}<span className="js-more">▼</span></span>}</span>
      {(busy || !pageDone) && <i className="js-cursor" aria-hidden="true" />}
    </>
  );

  const privateCards = CARDS.filter((card) => card.star === p.star && card.rarity === privateTier && !!state.owned[card.id]);
  const chosenPrivateCard = privateCard ? CARDS.find((card) => card.id === privateCard) ?? null : null;
  const privateBonus = p.star === 'eimi' && privateCard === EIMI_BONUS_CARD_ID;
  const privateCover = LIVE_COVERS[p.star];

  // The member conversation is a private 1-to-1 digital-human room. Text remains usable while RTC starts; once the
  // avatar is online the same composer sends directly through its live session.
  if (!p.incoming) return (
    <div className={`room2 private-live${privateEntering ? ' is-entering' : ''}${privateReady ? ' is-ready' : ''}${privateUnavailable ? ' is-unavailable' : ''}`} data-testid="room" data-star={p.star}>
      <div className="private-live-avatar" aria-label={`${p.name} 1v1 live`} style={{
        '--private-cover-mobile': `url("${privateCover.mobile}")`,
        '--private-cover-desktop': `url("${privateCover.desktop}")`
      } as CSSProperties}>
        <ResponsiveLiveCover cover={privateCover} className="private-live-cover" eager />
        <div ref={privateStream} className="private-live-stream" />
        <i className="private-live-glass" aria-hidden="true" />
        {privateBonus && <SceneVideo key={privateBonusReaction?.id ?? 'eimi-bonus-idle'} entry={privateBonusReaction ?? eimiBonusIdle()} active loop={!privateBonusReaction}
          className="private-live-bonus" onDone={privateBonusReaction ? () => setPrivateBonusReaction(null) : undefined} />}
        <i className="private-live-vignette" />
      </div>

      <header className="private-live-head">
        <button type="button" className="private-live-exit" onClick={leave} aria-label={roomText('leave', lang)}>
          <Icon name="back" size={20} /><span>{roomText('leave', lang)}</span>
        </button>
        <div className="private-live-identity">
          <span><i />1V1 · {privateReady ? 'DIGITAL HUMAN ONLINE' : privateUnavailable ? 'CHAT ONLINE' : privateConnected ? 'DIGITAL HUMAN STARTING' : 'DIGITAL HUMAN CONNECTING'}</span>
          <strong>{p.name}</strong><small>{timer}</small>
        </div>
      </header>

      <aside className="private-live-actions" aria-label={roomText('menu', lang)}>
        <button type="button" onClick={() => setGiftOpen(true)} aria-label={roomText('gift', lang)}><span aria-hidden="true">♢</span><b>{roomText('gift', lang)}</b></button>
        <button type="button" className={privateSceneOpen ? 'on' : ''} onClick={() => setPrivateSceneOpen((open) => !open)} aria-label="SSR / UR">
          <span aria-hidden="true">✦</span><b>SSR / UR</b>
        </button>
      </aside>

      {chosenPrivateCard && <div className={`private-live-current tier-${chosenPrivateCard.rarity}`}><span>{chosenPrivateCard.rarity}</span>{cardTitle(chosenPrivateCard, lang)}</div>}

      {privateSceneOpen && (
        <section className="private-live-scenes" aria-label="SSR / UR">
          <div className="private-live-scene-head"><strong>SCENE</strong><button type="button" onClick={() => setPrivateSceneOpen(false)} aria-label={roomText('close', lang)}><Icon name="close" size={17} /></button></div>
          <div className="private-live-tiers" role="tablist">
            {(['SSR', 'UR'] as const).map((tier) => <button key={tier} type="button" role="tab" aria-selected={privateTier === tier} onClick={() => setPrivateTier(tier)}>{tier}</button>)}
          </div>
          <div className="private-live-card-list">
            <button type="button" className={!privateCard ? 'selected private-live-default' : 'private-live-default'} onClick={() => { setPrivateCard(null); actions.setSelectedCard(p.star, null); setPrivateBonusReaction(null); setPrivateSceneOpen(false); }}>
              <span><b>DEFAULT</b>{lang === 'zh-Hant' ? '標準主視覺' : lang === 'ja' ? '通常ビジュアル' : 'Standard visual'}</span>
            </button>
            {privateCards.length ? privateCards.map((card) => {
              const art = cardArt(card, 'sm');
              return <button key={card.id} type="button" className={privateCard === card.id ? 'selected' : ''} onClick={() => { setPrivateCard(card.id); actions.setSelectedCard(p.star, card.id); setPrivateBonusReaction(null); setPrivateSceneOpen(false); }}>
                {art && <img src={art} alt="" />}<span><b>{card.rarity}</b>{cardTitle(card, lang)}</span>
              </button>;
            }) : <p>{lang === 'zh-Hant' ? `尚未擁有${privateTier}卡` : lang === 'ja' ? `${privateTier}カードはまだありません` : `No ${privateTier} cards yet`}</p>}
          </div>
        </section>
      )}

      <div className="private-live-chat" aria-live="polite">
        {privateLines.map((item) => <p key={item.id} className={item.from}><b>{item.from === 'me' ? roomText('you', lang) : p.first}</b>{item.text}</p>)}
      </div>

      <form className="private-live-composer" onSubmit={onSubmit} data-testid="room-composer">
        <label htmlFor="room-input" className="sr-only">{t('common.message')}</label>
        <input id="room-input" ref={field} value={draft} maxLength={300} autoComplete="off" enterKeyHint="send" disabled={left === 0}
          placeholder={left === 0 ? t('chat.limitTitle') : roomText('say', lang)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={(event) => setDraft(event.target.value)} />
        <button type="submit" aria-label={t('common.send')} disabled={busy || left === 0 || !draft.trim()}><Icon name="send" size={19} /></button>
      </form>
      {giftOpen && <GiftSheet call localSession={import.meta.env.DEV || !getToken()} onClose={() => setGiftOpen(false)} onSent={(r) => { setGiftOpen(false); p.onGift(r); }} />}
    </div>
  );

  return (
    <div className={`room2${pure ? ' pure' : ''}${indexOpen ? ' indexed' : ''}${p.incoming ? ' ringing' : ''}`} data-testid="room" data-star={p.star} data-pure={pure ? '' : undefined}
      data-voice={her.phase !== 'off' ? her.phase : undefined} data-talking={talking ? '' : undefined} data-choose={choosing && !pure && !indexOpen ? '' : undefined}
      data-face={face?.side} style={face ? { '--face-l': `${face.l}px`, '--face-r': `${face.r}px` } as CSSProperties : undefined}>
      <NightFade variant={pure ? 'pure' : indexOpen ? 'index' : 'room'} />
      <Sparkles points={SPARKS} />
      <div className="room2-surface" onPointerDown={surfaceDown} onPointerUp={(e) => void surfaceUp(e)} onPointerCancel={() => { touch.current = null; }} data-testid="room-surface" aria-hidden="true" />
      {tap && pure && <span key={tap.key} className="room2-tap" style={{ left: tap.x - 28, top: tap.y - 28 }} aria-hidden="true" />}

      {pure && <OfflineLine className="room2-offline" />}
      {pure ? (
        <p className="room2-sub js-line" data-testid="room-pure-line" aria-live="polite" onClick={() => advance()}>{line}<span className="room2-measure" ref={measure} aria-hidden="true" /></p>
      ) : indexOpen ? (
        <RoomIndex {...p} lang={lang} timer={timer} mins={mins} tts={!!v?.tts} her={her} onClose={() => setIndexOpen(false)} onGift={() => { setIndexOpen(false); setGiftOpen(true); }}
          onSheet={(s) => { setIndexOpen(false); setSheet(s); }} onLeave={leave} />
      ) : (
        <>
          {/* The top band: ✦ JSTAR, 目錄, the call, ┌ the label and the status line (B: the film's title-safe line). */}
          <header className="room2-head">
            <BrandMark />
            {!message && <SpacedLabel meta dot className="room2-calltime">{roomText('onCall', lang)} {timer}</SpacedLabel>}
            <button type="button" className="room2-idx" onClick={() => setIndexOpen(true)} aria-haspopup="dialog" data-testid="room-index-open">
              {roomText('index', lang)}<svg viewBox="0 0 18 12" width="18" height="12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M1 3h16M7 9h10" /></svg>
            </button>
            <div className="room2-lab"><CornerFrame />{label}</div>
            {p.calling ? (
              <button type="button" className="room2-exif room2-ringing" data-testid="call-elsewhere" onClick={p.calling.onOpen}>
                <SpacedLabel meta dot>{roomText('callingNow', lang, { first: p.calling.first })}</SpacedLabel><span aria-hidden="true">›</span>
              </button>
            ) : message ? (
              <div className="room2-exif room2-away" data-testid="room-away">
                <span>{roomText('away', lang, { first: p.first, n: p.messages.length }).split(String(p.messages.length)).map((s, i, a) => <span key={i}>{s}{i < a.length - 1 && <b>{p.messages.length}</b>}</span>)}</span>
                <RuleCounter n={p.messages.length} at={msgAt} />
              </div>
            ) : (
              <div className="room2-exif room2-status" data-testid="room-status"><span className="room2-clocks">{p.date}</span>
                {(p.place || p.sky) && <span className="room2-place">{p.place && <span>{p.place}</span>}{p.sky && <span className="room2-sky">{p.place ? dotSep(lang) : ''}{p.sky}</span>}</span>}{p.days ? <span className="room2-days"><span className="js-spark">♥</span> {roomText('day', lang, { n: p.days })}</span> : null}</div>
            )}
            {/* C-room N6: offline, the shared line docked under the room's top band (the shell's floating one steps aside). */}
            <OfflineLine className="room2-offline" />
          </header>
          {/* Her name: a small lane at the edge away from her face, clear of her words. */}
          <VerticalName name={p.name} romaji={p.romaji === p.name ? '' : p.romaji} className="room2-vname" />

          {/* The subtitle band: at most three lines of hers, paged with ▼; his choices take its place once she is done. */}
          <div className="room2-bottom">
            {/* A voice note when the message carries her recording, or (#13) her runtime voice can say it: never a waveform that cannot play. */}
            {message && (photo || audio || spokenNote) && (
              <div className="room2-attach">
                {photo && <PrintPhoto src={photo} alt="" />}
                {(audio || spokenNote) && <span data-testid="room-note"><Waveform bars={BARS} progress={0} time={noteTime} label={roomText('playNote', lang)}
                  onPlay={() => { if (audio) void playVoice(audio); else if (spokenNote) void noteVoice(spokenNote.id).then((r) => { if (r) her.speak(r.line, r.sig, spokenNote.id); }); }} /></span>}
              </div>
            )}
            <div className="room2-stage" data-testid={group?.groupTestId ?? 'room-cap'} role={group ? 'group' : undefined} aria-label={group?.groupLabel}>
              <div className="room2-cap">
                {message && <p className="room2-meta">{roomText('awayMeta', lang, { when: awayWhen(message.deliveredAt, lang) })}</p>}
                {/* His last line belongs to her answer: when her message takes the floor, it is hers alone. */}
                {mine && !message && (
                  <p className={`room2-him${failed.has(mine.id) ? ' failed' : ''}`} data-testid="room-mine-row">
                    {/* L13: no-break spaces keep 「你」 with the start of his line, never alone on a line of its own. */}
                    {roomText('you', lang)}{'\u00a0\u00a0'}<span data-testid="room-mine">{quoted(mine.text, lang)}</span>
                    {!failed.has(mine.id) && (live || answered) && <small>{roomText('read', lang)}</small>}
                    {failed.has(mine.id) && (
                      <span className="room2-failed" role="alert" data-testid="room-failed">
                        {SEND_FAILED[lang].msg}
                        <button type="button" className="js-btn-text" disabled={busy} onClick={() => void deliver(mine.text, mine.id)}>{SEND_FAILED[lang].resend}</button>
                      </span>
                    )}
                  </p>
                )}
                {waiting ? (
                  <p className="js-line" role="status" aria-label={t('common.typing', { first: p.first })} data-testid={busy ? 'room-typing' : 'greeting-wait'}>
                    {asleepLine && !busy ? quoted(asleepLine, lang) : <span className="typing"><i /><i /><i /></span>}
                  </p>
                ) : (
                  <p className="js-line room2-line" onClick={() => advance()}>
                    {line}
                    <span className="room2-measure" ref={measure} aria-hidden="true" />
                  </p>
                )}
                {ends.length > 1 && <span className="room2-pages"><RuleCounter n={ends.length} at={page} /></span>}
              </div>
              {/* Her whole line for screen readers (and tests), outside the page that is on screen. */}
              {!waiting && <span className="sr-only" data-testid={lineTestId}>{herText}</span>}
              {choosing && (
                <div className="room2-choose">
                  {/* M5: when her message came stays over her last words once his choices show. */}
                  {message && <p className="room2-meta" data-testid="room-message-when">{roomText('awayMeta', lang, { when: awayWhen(message.deliveredAt, lang) })}</p>}
                  {!reaction && lineText && <p className="room2-echo" aria-hidden="true">{quoted(lastWords(lineText), lang)}</p>}
                  {made && <PromiseMade promise={made} />}
                  {message && <button type="button" className="room2-next" onClick={nextMessage} data-testid="room-message-next">{roomText(queue.length > 1 ? 'next' : 'done', lang)}</button>}
                  {moreWaiting > 0 && <button type="button" className="room2-next" onClick={() => { setMsgsAsked(true); setMsgBase(here.length); }} data-testid="room-message-more">{roomText('more', lang, { n: moreWaiting })}</button>}
                  {invite && (
                    <div className="js-replies room2-replies room2-invite">
                      {/* N1: ✦ only for what can be done now (her scene, or 「今晚見」); until that is known, 下次吧 alone. */}
                      {(invite.to || invite.onClick) && <ReplyChoice hot to={invite.to} onClick={invite.onClick} testId={invite.testId}>✦ {invite.title}</ReplyChoice>}
                      {invite.onLater && <ReplyChoice plain onClick={invite.onLater} testId={invite.laterTestId}>{roomText('notNow', lang)}</ReplyChoice>}
                    </div>
                  )}
                  {sceneAsk && !busy && (
                    <div className="js-replies room2-replies room2-invite"><ReplyChoice hot to={sceneLink(sceneAsk.sceneId)} testId="room-scene">✦ {localText(sceneAsk.title, lang)}</ReplyChoice></div>
                  )}
                  {left === 0 && !busy && (
                    <Link to="/serial" className="room2-limit" data-testid="room-limit">
                      <b>{t('chat.limitTitle')}</b><span>{t('chat.limitBody', { first: p.first })}</span><u>{t('chat.limitCta')}</u>
                    </Link>
                  )}
                  {leadChoices && (
                    <div className="js-replies room2-replies" data-testid="room-replies">
                      {leadChoices.map((c, i) => <ReplyChoice key={c.label} index={i + 1} onClick={c.onClick} disabled={c.disabled} testId={c.testId}>{c.label}</ReplyChoice>)}
                    </div>
                  )}
                  {replies.length > 0 && (
                    <div className="js-replies room2-replies" data-testid="room-replies">
                      {replies.slice(0, 3).map((r, i) => <ReplyChoice key={r} index={i + 1} onClick={() => say(r)}>{r}</ReplyChoice>)}
                    </div>
                  )}
                </div>
              )}
            </div>
            <form onSubmit={onSubmit} data-testid="room-composer">
              <label htmlFor="room-input" className="sr-only">{t('common.message')}</label>
              <HairlineInput id="room-input" value={voice.listening ? voice.text : draft} maxLength={500} autoComplete="off" enterKeyHint="send" disabled={left === 0}
                placeholder={voice.listening ? t('voice.listening') : left === 0 ? t('chat.limitTitle') : roomText('say', lang)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
                onChange={(e) => { if (voice.listening) voice.ctl.cancel(); setDraft(e.target.value); }}
                inputRef={field}
                // B-L4: his voice minutes are a tap from more (the extension sheet, as everywhere else).
                meta={mins !== null && her.on ? <button type="button" className="room2-left" data-testid="voice-left" aria-haspopup="dialog" onClick={() => setExtendOpen(true)}>{roomText('voiceLeft', lang, { n: mins })}</button> : undefined}
                after={draft.trim()
                  ? <button type="submit" className="js-icon-btn" aria-label={t('common.send')} disabled={busy || left === 0}><svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M3 10l14-7-5 14-2-6z" /></svg></button>
                  // B-L7: out of messages for today, no mic either (the limit panel above says why).
                  : left === 0 ? undefined
                  : voice.available
                    ? <button type="button" className={`js-icon-btn${voice.listening ? ' on' : ''}`} data-testid="mic" data-phase={voice.phase} aria-pressed={voice.listening} aria-label={roomText('mic', lang)} disabled={left === 0} onClick={() => voice.ctl.toggle()}>
                        <svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><rect x="7" y="2.5" width="6" height="10" rx="3" /><path d="M4 9.5a6 6 0 0 0 12 0M10 15.5v2.5" /></svg>
                      </button>
                    : <button type="submit" className="js-icon-btn" aria-label={t('common.send')} disabled><svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M3 10l14-7-5 14-2-6z" /></svg></button>} />
            </form>
          </div>
        </>
      )}
      {!pure && !indexOpen && (
        <p className="room2-keys" aria-label={roomText('keys', lang)}>
          <span><kbd>1–3</kbd>{roomText('keyReply', lang)}</span><span><kbd>SPACE</kbd>{roomText('keyNext', lang)}</span><span><kbd>H</kbd>{roomText('keyPure', lang)}</span>
          <span><kbd>M</kbd>{roomText('index', lang)}</span><span><kbd>ESC</kbd>{roomText('close', lang)}</span>
        </p>
      )}
      {giftOpen && <GiftSheet call localSession={import.meta.env.DEV || !getToken()} onClose={() => setGiftOpen(false)} onSent={(r) => { setGiftOpen(false); p.onGift(r); }} />}
      {sheet && (
        <RoomSheet title={roomText(sheet === 'promise' ? 'promiseTitle' : 'logTitle', lang, { first: p.first })} testId={`room-${sheet}-sheet`} onClose={() => setSheet(null)}>
          {sheet === 'promise' ? <PromiseList x={p.index} lang={lang} /> : <LogList log={p.index.log ?? null} first={p.first} lang={lang} />}
        </RoomSheet>
      )}
      {extendOpen && <ExtendSheet onClose={() => setExtendOpen(false)} onDone={(r) => { if (r) p.onToast(t('voice.extended', { min: r.voice.extendMinutes })); }} />}
      {p.incoming && <IncomingCall call={p.incoming} lang={lang} />}
    </div>
  );
}
/**
 * QA #5, C-room P2: where his touch ripples — where he touched, except on her face or her neckline (the face box, and
 * a face's height under it): there it moves to the side of her face he touched, at the same height, inside the screen
 * (the other side when that one has no room).
 */
export function rippleAt(x: number, y: number, f: number[] | null, width: number): { x: number; y: number } {
  if (!f) return { x, y };
  const w = f[2] - f[0], pad = 34;
  const near = x > f[0] - pad && x < f[2] + pad && y > f[1] - pad && y < f[3] + (f[3] - f[1]) * 1.3;
  if (!near) return { x, y };
  // Beside her face (well clear of it where there is room), wholly off it and inside the screen.
  const left = Math.max(pad, f[0] - w * 0.45 - pad), right = Math.min(width - pad, f[2] + w * 0.45 + pad);
  const sides = [left <= f[0] - pad ? left : null, right >= f[2] + pad ? right : null];
  const [first, other] = x < (f[0] + f[2]) / 2 ? sides : [sides[1], sides[0]];
  const at = first ?? other;
  // Her face fills the width: above it, in her hair, where he touched across.
  return at === null ? { x, y: Math.max(pad, f[1] - pad) } : { x: at, y };
}
/** Her room's two sparkles: room.css places them in the night of each frame (window, city), never on her. */
const SPARKS = [{ x: 'var(--s1x)', y: 'var(--s1y)' }, { x: 'var(--s2x)', y: 'var(--s2y)', size: 7 }];

// ---------------------------------------------------------------- 約定 and 記錄 (C-room L9)

/** Her room's own sheet (A2: the night sheet, opaque, under her face on a phone and beside it on a wider screen). */
function RoomSheet({ title, testId, onClose, children }: { title: string; testId: string; onClose: () => void; children: ReactNode }) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={title} className="gift-backdrop call" data-testid={testId} onClick={onClose}>
      <div ref={panel} tabIndex={-1} className="panel gift-sheet call solid room2-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="gift-head">
          <h2 className="serif">{title}</h2>
          <button type="button" className="round" onClick={onClose} aria-label={t('common.close')} data-testid="room-sheet-close"><Icon name="close" size={18} /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

/** 約定: her promise with him — when (his clock; her wake-up by his alarm) and what, in her words. */
function PromiseList({ x, lang }: { x: IndexData; lang: string }) {
  if (!x.promise) return <p className="room2-sheet-none" data-testid="room-promise-none">{roomText('promiseNone', lang)}</p>;
  return (
    <div className="room2-promise" data-testid="room-promise-item">
      <SpacedLabel meta dot>{roomText(x.promiseState === 'kept' ? 'promiseKept' : x.promiseState === 'missed' ? 'promiseMissed' : 'promiseOpen', lang)}</SpacedLabel>
      <b>{x.promiseWhen}</b>
      <p>{quoted(timelessPromise(x.promise.text), lang)}</p>
    </div>
  );
}

/** 記錄: what was said between them, his lines and hers, the newest at the foot (where it opens). */
function LogList({ log, first, lang }: { log: IndexData['log']; first: string; lang: string }) {
  const end = useRef<HTMLDivElement>(null);
  const lines = (log ?? []).filter((m) => (m.from === 'me' || m.from === 'her') && m.kind !== 'memory');
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [lines.length]);
  if (log === null) return <p className="room2-sheet-none" role="status"><span className="typing"><i /><i /><i /></span></p>;
  if (!lines.length) return <p className="room2-sheet-none">{roomText('logNone', lang)}</p>;
  return (
    <div className="room2-log" data-testid="room-log">
      {lines.slice(-80).map((m) => (
        <p key={m.id} className={m.from === 'me' ? 'me' : undefined}><small>{m.from === 'me' ? roomText('you', lang) : first}</small>{quoted(m.text, lang)}</p>
      ))}
      <div ref={end} />
    </div>
  );
}

// ---------------------------------------------------------------- 目錄

function RoomIndex(p: RoomV2Props & { lang: string; timer: string; mins: number | null; tts: boolean; her: HerVoice; onClose: () => void; onGift: () => void; onSheet: (s: 'promise' | 'log') => void; onLeave: () => void }) {
  const { lang, index: x } = p;
  // L6: 目錄 takes the focus as it opens (M, a tap), so its keys and a screen reader start in it — never left on <body>.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus({ preventScroll: true }); x.onOpen?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // M8: a phone shows the grid's foot only as he scrolls: a cue at the foot while more is below.
  const scroller = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const on = () => setBelow(el.scrollHeight - el.clientHeight - el.scrollTop > 8);
    on();
    el.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(on);
    ro?.observe(el);
    return () => { el.removeEventListener('scroll', on); window.removeEventListener('resize', on); ro?.disconnect(); };
  }, []);
  const cell = (n: number, title: string, sub: string, el: { to?: string; onClick?: () => void; testId: string; label?: string }) => {
    const body = <><b><em>{String(n).padStart(2, '0')}</em>{title}</b><small>{sub}</small></>;
    return el.to ? <Link key={n} to={el.to} className="room2-cell" data-testid={el.testId} aria-label={el.label}>{body}</Link>
      : <button key={n} type="button" className="room2-cell" onClick={el.onClick} data-testid={el.testId} aria-label={el.label} aria-haspopup="dialog">{body}</button>;
  };
  return (
    <div className="room2-index" role="dialog" aria-modal="true" aria-label={roomText('index', lang)} data-testid="room-index" ref={box} tabIndex={-1}>
      <header className="room2-top">
        <span className="room2-ttl">{roomText('index', lang)}{lang !== 'en' && <small>INDEX</small>}</span>
        {/* Everything outside her room (settings, account, help) is one step away, never on her face. */}
        <Link to="/menu" className="room2-idx room2-menu" aria-label={roomText('menu', lang)} data-testid="room-menu">
          <svg viewBox="0 0 16 12" width="16" height="12" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true"><path d="M0 1h16M0 6h16M0 11h16" /></svg>
        </Link>
        <button type="button" className="room2-idx" onClick={p.onClose} data-testid="room-index-close">
          {roomText('close', lang)}
        </button>
      </header>
      <div className="room2-lab"><CornerFrame /><SpacedLabel>{roomText('room', lang)}　{String(p.idx + 1).padStart(2, '0')} / 05</SpacedLabel><SpacedLabel meta dot>{roomText('onCall', lang)} {p.timer}{dotSep(lang)}{roomText('listening', lang)}</SpacedLabel><OfflineLine className="room2-offline" /></div>
      <div className="room2-index-body">
        {/* Her face stays clear: the 目錄 keeps to the night below it, its middle scrolls, leaving stays in reach. */}
        <div className={`room2-index-scroll${below ? ' more' : ''}`} ref={scroller} data-testid="room-index-scroll">
        <div className="room2-sec"><SpacedLabel>{roomText('firstFive', lang)}　{String(p.idx + 1).padStart(2, '0')} / 05</SpacedLabel><SpacedLabel meta>{roomText('switchStar', lang)}</SpacedLabel></div>
        <div className="room2-stars">
          <StarRuleSwitcher items={x.stars.map((s) => ({ id: s.id, label: s.label, aria: s.aria, dim: s.dim, describedBy: s.tag ? `now-${s.id}` : undefined }))} active={p.star} onPick={x.onPick} label={roomText('switchStar', lang)} />
          {/* M8: her unread count sits at the end of her slot's rule, under the section's label — never over FIRST FIVE. */}
          {x.stars.map((s, i) => s.badge ? <span key={s.id} className="room2-badge" style={{ left: `calc(${(i + 1) * 20}% - 26px)` }} data-testid={`inbox-badge-${s.id}`} aria-hidden="true">{s.badge > 99 ? '99+' : s.badge}</span> : null)}
        </div>
        {x.stars.some((s) => s.tag) && <div className="room2-presence">{x.stars.map((s) => <span key={s.id}>{s.tag}</span>)}</div>}
        {x.now && <div className="room2-now">{x.now}</div>}
        <div className="room2-bond" data-testid="relationship">
          <span data-testid="stage">{x.stage}</span><small data-testid="rel-days">{roomText('chapter', lang, { n: x.days })}</small>
          <span className="room2-bar" aria-hidden="true"><i style={{ width: `${Math.round(x.progress * 100)}%` }} /></span>
          <small>{roomText('closeness', lang, { n: x.closeness })}</small>
        </div>
        {x.bond}
        <nav className="room2-grid" aria-label={roomText('index', lang)}>
          {cell(1, roomText('gift', lang), x.giftHint ?? '', { onClick: p.onGift, testId: 'gift-open' })}
          {/* C-room L9: 約定 and 記錄 are her room's own sheets (A2), never her chat page. */}
          {cell(2, roomText('promise', lang), x.promiseState === 'missed' ? roomText('promiseMissed', lang) : x.promiseWhen ?? roomText('noPromise', lang), { onClick: () => p.onSheet('promise'), testId: x.promise ? 'next-promise' : 'room-promise', label: x.promiseLabel ?? undefined })}
          {cell(3, roomText('alarm', lang), x.alarm === undefined ? '…' : x.alarm ?? roomText('noAlarm', lang), { to: '/me/alarm', testId: 'alarm-chip' })}
          {cell(4, roomText('log', lang), x.linesTonight === null ? '…' : roomText('lines', lang, { n: x.linesTonight }), { onClick: () => p.onSheet('log'), testId: 'room-history' })}
          {cell(5, roomText('memories', lang), x.unread ? roomText('unread', lang, { n: x.unread }) : roomText(x.inboxTotal === 0 ? 'noneYet' : 'allRead', lang), { to: '/me/cards?tab=memory', testId: 'room-memories' })}
          {cell(6, roomText('gacha', lang), roomText('freeToday', lang, { n: x.freePulls }), { to: '/gacha', testId: 'room-gacha' })}
        </nav>
        <div className="room2-extra">{x.extra}</div>
        </div>
        {below && <span className="room2-scrollcue" aria-hidden="true">▼</span>}
        <div className="room2-foot">
          {/* Her voice switch (#73) where the server offers her runtime voice; else the scenes' voice time. */}
          {p.her.available
            ? <button type="button" className="room2-voice" aria-pressed={p.her.on} aria-label={roomText('voiceSwitch', lang)} data-testid="room-voice-switch" onClick={() => p.her.setOn(!p.her.on)}>
                {roomText('voice', lang)}<b data-testid="voice-meter">{!p.her.on ? roomText('voiceOff', lang) : p.mins !== null ? roomText('voiceLeftShort', lang, { n: p.mins }) : '—'}</b>
              </button>
            : <span className="room2-voice">{roomText(p.tts ? 'voice' : 'voiceScene', lang)}<b data-testid="voice-meter">{p.mins !== null ? roomText('voiceLeftShort', lang, { n: p.mins }) : '—'}</b></span>}
          <BtnLine onClick={p.onLeave} testId="room-leave">{roomText('leave', lang)}</BtnLine>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- ⑥ her call

export function IncomingCall({ call, lang }: { call: Incoming; lang: string }) {
  const [clock] = useState(() => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
  const kind = callKind(call.hour, call.wakeup);
  const when = roomText(kind.when, lang);
  // N4: her line in pages of three lines (two on a phone on its side), ▼ turns them — as in her room, never cut.
  const measure = useRef<HTMLSpanElement>(null);
  const ends = usePages(call.line, measure);
  const [at, setAt] = useState(0);
  const page = Math.min(at, ends.length - 1), last = page === ends.length - 1;
  const [qo, qc] = quoteMarks(lang);
  const quote = !/^[「『"]/.test(call.line.trim());
  const shown = call.line.slice(page ? ends[page - 1] : 0, ends[page]);
  return (
    <div className="room2-call" role="alertdialog" aria-modal="true" aria-label={`${call.name} · ${roomText('videoCall', lang, { when })}`} data-testid="call-incoming">
      <NightFade variant="morning" />
      <Sparkles points={SPARKS} />
      {/* B: her call in the room's bands — what it is and the hour in the top band, her name in its lane, her line and
          the two answers in the subtitle band. */}
      <header className="room2-head">
        <BrandMark />
        <SpacedLabel meta className="room2-calltime">{roomText('incoming', lang)}</SpacedLabel>
        <div className="room2-lab"><CornerFrame /><SpacedLabel>{roomText(kind.label, lang)}　{String(call.idx + 1).padStart(2, '0')} / 05</SpacedLabel></div>
        <div className="room2-exif room2-clockrow"><span className="room2-clock" aria-hidden="true">{clock}</span><span>{roomText('videoCall', lang, { when })}</span></div>
        <OfflineLine className="room2-offline" />
      </header>
      <VerticalName name={call.name} romaji={call.romaji === call.name ? '' : call.romaji} className="room2-vname" />
      <div className="room2-bottom">
        <div className="room2-cap">
          {call.ring?.blocked
            ? <button type="button" className="room2-meta room2-ringtap" onClick={call.ring.unmute} data-testid="call-ringtone">{roomText('ringTap', lang)}</button>
            : <p className="room2-meta">{roomText('ringing', lang)}</p>}
          <p className={`js-line${last ? '' : ' room2-paged'}`} data-testid="call-incoming-line" aria-label={quoted(call.line, lang)} onClick={() => { if (!last) setAt(page + 1); }}>
            <span aria-hidden="true">{quote && !page ? qo : ''}{shown}{quote && last ? qc : ''}{!last && <span className="js-more">▼</span>}</span>
            <span className="room2-measure" ref={measure} aria-hidden="true" />
          </p>
          {ends.length > 1 && <span className="room2-pages"><RuleCounter n={ends.length} at={page} /></span>}
        </div>
        <div className="room2-acts">
          {call.later !== null && <BtnLine onClick={call.onSnooze} testId="call-incoming-later">{roomText(call.later === 'notNow' || (call.later === undefined && !call.wakeup) ? 'notNow' : 'snooze', lang)}</BtnLine>}
          <BtnRose large autoFocus onClick={call.onAnswer} testId="call-incoming-answer">
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M4.5 3h3l1.5 4-2 1.3a9 9 0 0 0 4.7 4.7L13 11l4 1.5v3a1.5 1.5 0 0 1-1.6 1.5A14 14 0 0 1 3 4.6 1.5 1.5 0 0 1 4.5 3z" /></svg>
            {roomText('answer', lang)}
          </BtnRose>
        </div>
        <p className="room2-ihint">{roomText('answerHint', lang)}</p>
      </div>
    </div>
  );
}

/** N-17: her yes is a tap away — the offered scene's clips and her loops start loading now. */
export function usePreloadOffer(offer: Offer | null) {
  useEffect(() => { if (offer) preloadClips(offerClips(offer.media, offer.star)); }, [offer?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}
