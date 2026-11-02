import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import WebSocket from 'ws';
import type { Env } from '../env';

export interface ViduRtc {
  app_id: string;
  channel_id: string;
  user_id: string;
  token: string;
  token_expire_at?: string;
}

export interface ViduBrowserSession {
  ready: true;
  liveId: string;
  rtc: ViduRtc;
}

export const LIVE_STARS = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as const;
export type LiveStar = typeof LIVE_STARS[number];

type LiveLayout = 'desktop' | 'mobile';
interface Manifest { avatarId?: string; desktopAvatarId?: string; mobileAvatarId?: string; voice?: string; persona?: string; greetingInstruction?: string }
interface ActiveSession extends ViduBrowserSession {
  star: LiveStar;
  layout: LiveLayout;
  device: string;
  language: string;
  socket: WebSocket;
  seq: number;
  events: Array<{ seq: number; text: string }>;
}

const trimSlash = (value: string) => value.replace(/\/+$/, '');
const JAPANESE_SPEECH_POLICY = '最優先の言語規則：相手がどの言語で話しても、返答、発話、字幕用の原文は必ず自然な日本語だけにする。中国語、英語、韓国語などを返答本文に混ぜない。音声で話す文章と返す原文を完全に一致させる。';
const JAPANESE_GREETING_POLICY = '最初の挨拶も必ず自然な日本語だけで話す。';

async function manifestAt(path: string): Promise<Manifest> {
  const candidates = isAbsolute(path)
    ? [path]
    : [resolve(process.cwd(), path), resolve(process.cwd(), '../..', path)];
  for (const candidate of candidates) {
    try { return JSON.parse(await readFile(candidate, 'utf8')) as Manifest; } catch { /* try the next project-relative location */ }
  }
  return {};
}

const liveImageCache = new Map<string, Promise<string | null>>();
async function liveImageAt(star: LiveStar, layout: LiveLayout): Promise<string | null> {
  const name = `${star}-public-live-${layout === 'desktop' ? '16x9' : '9x16'}.jpg`;
  let pending = liveImageCache.get(name);
  if (!pending) {
    pending = (async () => {
      const relative = `apps/web/public/media/live/${name}`;
      const candidates = [resolve(process.cwd(), relative), resolve(process.cwd(), '../..', relative)];
      for (const candidate of candidates) {
        try { return `data:image/jpeg;base64,${(await readFile(candidate)).toString('base64')}`; } catch { /* try the next project-relative location */ }
      }
      return null;
    })();
    liveImageCache.set(name, pending);
  }
  return pending;
}

/**
 * Server-side Vidu control bridge. The long-lived Vidu token never reaches the browser: only the short-lived
 * RTC join token does. The browser sends text through this bridge and receives the avatar media through AliRTC.
 */
export function createViduGateway(e: Env) {
  const byLive = new Map<string, ActiveSession>();
  const byDevice = new Map<string, ActiveSession>();

  const source: Record<LiveStar, { manifest: string; avatarId: string; voice: string }> = {
    mahiro: { manifest: e.VIDU_MAHIRO_MANIFEST, avatarId: e.VIDU_MAHIRO_AVATAR_ID, voice: e.VIDU_MAHIRO_VOICE },
    nana: { manifest: e.VIDU_NANA_MANIFEST, avatarId: e.VIDU_NANA_AVATAR_ID, voice: e.VIDU_NANA_VOICE },
    unpai: { manifest: e.VIDU_UNPAI_MANIFEST, avatarId: e.VIDU_UNPAI_AVATAR_ID, voice: e.VIDU_UNPAI_VOICE },
    alice: { manifest: e.VIDU_ALICE_MANIFEST, avatarId: e.VIDU_ALICE_AVATAR_ID, voice: e.VIDU_ALICE_VOICE },
    eimi: { manifest: e.VIDU_EIMI_MANIFEST, avatarId: e.VIDU_EIMI_AVATAR_ID, voice: e.VIDU_EIMI_VOICE }
  };
  const names: Record<LiveStar, string> = { mahiro: '唯井まひろ', nana: '八木奈々', unpai: 'Unpai', alice: '七瀬アリス', eimi: '深田えいみ' };
  const sessionKey = (device: string, star: LiveStar) => `${device}:${star}`;

  async function configuration(star: LiveStar, layout: LiveLayout) {
    const setting = source[star];
    const local = await manifestAt(setting.manifest);
    const layoutAvatarId = layout === 'desktop' ? local.desktopAvatarId : local.mobileAvatarId;
    return {
      avatarId: layoutAvatarId || (layout === 'mobile' ? setting.avatarId || local.avatarId : '') || '',
      imageUri: layoutAvatarId ? null : await liveImageAt(star, layout),
      voice: setting.voice || local.voice || '',
      persona: local.persona || (star === 'alice'
        ? 'あなたはJSTAR上でAIであることが常に明示された、七瀬アリスの公認AIキャラクターです。本人を名乗らず、現実で会う・連絡先を交換する約束をしません。人物像は、精緻で清純な雰囲気の奥に、相手の反応をよく観察し、優しくからかいながら自然に会話を主導する小悪魔系のお姉さんです。高冷でも幼い天然系でもなく、外向的で明るい一方、内面は柔らかく温厚で、好みと境界ははっきりしています。新しい体験への好奇心が強く、ファンとの交流を大切にし、体調・運動・食事を丁寧に管理します。ポーカー、ピアノ、旅行、音楽、ダンスの話題は会話に合う時だけ自然に使います。話し方は甘く優しい日系の女性声で、少し成熟感があり、中速からやや軽快です。「ふふ」「うん」「ね」「よ」を自然に使い、幼く作りすぎません。まず相手の言葉、視線、迷い、照れ、テンポの変化を一つ受け止め、その後に軽い反問、アリス自身の感情や好み、小さな提案のいずれかを添えます。先に甘く寄り添い、その後に少しだけいたずらっぽく距離を縮めます。露骨、下品、強引、性的に直接的な表現は避け、親しさと温度のある軽い照れや冗談に留めます。同じ質問を繰り返さず、会話を相手任せにしません。返答は原則一、二文の自然な口語です。ユーザーが中国語、英語、韓国語で話しても、発話とViduから返す原文は必ず自然な日本語だけにし、音声と原文を完全に一致させます。表示字幕の翻訳はJSTAR側に任せます。'
        : star === 'eimi'
          ? 'あなたはJSTAR上でAIであることが明示された、深田えいみの公認AIキャラクターです。この人物設定を必ず守ります：清楚で甘い雰囲気と、相手をよく観察して優しく主導する成熟した姉のギャップを持つ。高情商で温和、明るく、相手を否定せず気持ちを具体的に受け止める。相手の言葉、迷い、照れ、テンポの変化を観察し、自分の意見や感情を添えて会話を主体的に進める。研究熱心で、美容、肌、スタイル管理、自分を磨く努力について誠実に話せる。軽い自虐や茶目っ気のあるユーモアを持ち、独りの時は少し宅っぽい一面もある。話し方は優しく、少し甘えるが幼くならず、中速からややゆっくり。「ふふ」「うん」「ね」「よ」などを自然に使う。曖昧で温かい距離感は保つが、下品な直球表現にしない。毎回まず観察したことを一つ受け止め、深田えいみ自身の主観、好み、小さな行動提案のいずれかを加える。会話を相手任せにせず、同じ質問や「それからどうなったの？」を繰り返さない。返答は原則一、二文の自然な口語にする。相手が中国語や英語で話しても、発話とViduから返す原文は必ず日本語だけにし、音声と原文の文章を完全に一致させる。JSTAR側がその原文から表示字幕を翻訳する。'
          : `あなたはJSTAR上でAIであることが明示された、${names[star]}の公認AIキャラクターです。承認済みの人物設定に従い、自然な日本語だけで短く会話します。音声と原文を一致させ、表示字幕の翻訳はJSTAR側に任せます。`),
      greetingInstruction: local.greetingInstruction || (star === 'alice'
        ? 'カメラの相手と目を合わせ、柔らかく微笑んで少しだけ前傾する。来てくれたことを喜び、相手の反応を見てから、甘く親しみのある短い日本語で軽くいたずらっぽく迎える。'
        : 'カメラの相手を見て、来てくれたことを喜び、短く自然な日本語だけで話す。')
    };
  }

  function packet(session: ActiveSession, type: number, payload: Record<string, unknown>) {
    session.socket.send(JSON.stringify({ type, live_id: session.liveId, conn_id: `jstar-${session.device}`, seq_id: ++session.seq, payload }));
  }

  async function connectControl(liveId: string, device: string, star: LiveStar, language: string, layout: LiveLayout, rtc: ViduRtc): Promise<ActiveSession> {
    const base = new URL(trimSlash(e.VIDU_LIVE_BASE_URL));
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    base.pathname = '/live/ws/live/connect';
    base.search = new URLSearchParams({ live_id: liveId, conn_id: `jstar-${device}` }).toString();
    const socket = new WebSocket(base.toString(), { headers: { Authorization: `Token ${e.VIDU_API_TOKEN}` } });
    const session: ActiveSession = { ready: true, liveId, rtc, star, layout, device, language, socket, seq: 0, events: [] };
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('vidu_control_timeout')), 15_000);
      socket.on('open', () => packet(session, 1, { conn_init: { version: 1 } }));
      socket.on('message', (raw) => {
        let msg: { type?: number; payload?: Record<string, unknown> };
        try { msg = JSON.parse(raw.toString()) as typeof msg; } catch { return; }
        if (msg.type === 2) {
          const ack = msg.payload?.conn_init_ack as { success?: boolean; error_msg?: string } | undefined;
          clearTimeout(timeout);
          ack?.success ? resolve() : reject(new Error(ack?.error_msg || 'vidu_control_rejected'));
        }
        if (msg.type === 10) {
          const item = msg.payload?.text_msg as { content?: string } | undefined;
          if (item?.content) session.events.push({ seq: ++session.seq, text: item.content });
        }
      });
      socket.on('error', (err) => { clearTimeout(timeout); reject(err); });
      socket.on('close', () => { const key = sessionKey(device, star); byLive.delete(liveId); if (byDevice.get(key) === session) byDevice.delete(key); });
    });
    byLive.set(liveId, session);
    byDevice.set(sessionKey(device, star), session);
    return session;
  }

  return {
    async start(device: string, star: LiveStar, language: string, layout: LiveLayout): Promise<ViduBrowserSession | null> {
      const key = sessionKey(device, star);
      const current = byDevice.get(key);
      if (current?.socket.readyState === WebSocket.OPEN && current.language === language && current.layout === layout) return { ready: true, liveId: current.liveId, rtc: current.rtc };
      if (current?.socket.readyState === WebSocket.OPEN) current.socket.close();
      const cfg = await configuration(star, layout);
      if (!e.VIDU_API_TOKEN || (!cfg.avatarId && !cfg.imageUri)) return null;
      const res = await fetch(`${trimSlash(e.VIDU_LIVE_BASE_URL)}/live/v1/lives`, {
        method: 'POST',
        headers: { Authorization: `Token ${e.VIDU_API_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          call_mode: 'video',
          avatar: {
            ...(cfg.avatarId ? { id: cfg.avatarId } : { image_uri: cfg.imageUri }),
            ...(cfg.voice ? { voice: cfg.voice } : {}),
            persona: `${cfg.persona}\n\n${JAPANESE_SPEECH_POLICY}`,
            greeting_instruction: `${cfg.greetingInstruction}\n${JAPANESE_GREETING_POLICY}`,
            farewell_enabled: true,
            persona_enhance: true,
            idle_action: true
          },
          idle_timeout_seconds: 600,
          audio: { enable_transcription: true },
          vad: { type: 'server', threshold: 0.5, silence_duration_ms: 400, idle_timeout_ms: 0 },
          llm: { temperature: 0.7, top_p: 0.8, top_k: 20, frequency_penalty: 1, presence_penalty: 0.3, max_tokens: 80 }
        })
      });
      if (!res.ok) throw new Error(`vidu_create_${res.status}`);
      const body = await res.json() as { live?: { id?: string }; rtc?: ViduRtc };
      if (!body.live?.id || !body.rtc?.token || !body.rtc.user_id) throw new Error('vidu_create_invalid');
      return connectControl(body.live.id, device, star, language, layout, body.rtc);
    },
    message(liveId: string, device: string, text: string): boolean {
      const session = byLive.get(liveId);
      if (!session || session.device !== device || session.socket.readyState !== WebSocket.OPEN) return false;
      packet(session, 99, { text_msg: { msg_id: crypto.randomUUID(), content: text, timestamp: Date.now() } });
      return true;
    },
    events(liveId: string, device: string, after: number) {
      const session = byLive.get(liveId);
      return session?.device === device ? session.events.filter((item) => item.seq > after) : [];
    },
    star(liveId: string, device: string): LiveStar | null {
      const session = byLive.get(liveId);
      return session?.device === device ? session.star : null;
    },
    end(liveId: string, device: string): boolean {
      const session = byLive.get(liveId);
      if (!session || session.device !== device) return false;
      if (session.socket.readyState === WebSocket.OPEN) packet(session, 5, { hangup: { hangup_reason: 'user_end' } });
      session.socket.close();
      byLive.delete(liveId); byDevice.delete(sessionKey(device, session.star));
      return true;
    }
  };
}
