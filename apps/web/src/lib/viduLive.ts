import { http, type LiveEventT, type LiveLayoutT, type LiveSessionT, type LiveStarT } from '../services/http';

interface AliRtcEngineT {
  on(event: string, listener: (...args: unknown[]) => void): void;
  setChannelProfile(profile: string): void;
  setClientRole(role: string): void;
  setDefaultSubscribeAllRemoteAudioStreams(enabled: boolean): Promise<void> | void;
  setDefaultSubscribeAllRemoteVideoStreams(enabled: boolean): Promise<void> | void;
  joinChannel(token: string, userName: string): Promise<void>;
  setRemoteViewConfig(view: HTMLVideoElement | null, userId: string, streamType: number): void;
  leaveChannel(): Promise<void>;
  destroy(): void;
}

interface AliRtcFactoryT {
  isSupported(): Promise<{ support: boolean }>;
  getInstance(): AliRtcEngineT;
}

declare global { interface Window { AliRtcEngine?: AliRtcFactoryT } }

let sdk: Promise<AliRtcFactoryT> | null = null;
function loadSdk(): Promise<AliRtcFactoryT> {
  if (window.AliRtcEngine) return Promise.resolve(window.AliRtcEngine);
  sdk ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://g.alicdn.com/apsara-media-box/imp-web-rtc/7.3.4/aliyun-rtc-sdk.js';
    script.async = true;
    script.onload = () => window.AliRtcEngine ? resolve(window.AliRtcEngine) : reject(new Error('rtc_sdk_missing'));
    script.onerror = () => reject(new Error('rtc_sdk_failed'));
    document.head.appendChild(script);
  });
  return sdk;
}

export interface LiveAvatarConnection {
  session: LiveSessionT;
  engine: AliRtcEngineT;
  send(text: string): Promise<void>;
  events(after: number, lang: string): Promise<LiveEventT[]>;
  close(): Promise<void>;
  end(): Promise<void>;
}

const prepared = new Map<`${LiveStarT}:${LiveLayoutT}`, Promise<LiveSessionT | null>>();

interface LiveControl {
  send(text: string): Promise<void>;
  events(after: number): LiveEventT[];
  close(): void;
}

async function openControl(session: LiveSessionT): Promise<LiveControl | null> {
  if (!session.controlUrl || !session.controlId) return null;
  const url = new URL(session.controlUrl, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  let seq = 0;
  let eventSeq = 0;
  let ready = false;
  const received: LiveEventT[] = [];
  const packet = (type: number, payload: Record<string, unknown>) => JSON.stringify({
    type,
    live_id: session.liveId,
    conn_id: session.controlId,
    seq_id: ++seq,
    payload
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('vidu_control_timeout')), 15_000);
    const fail = (error: Error) => { window.clearTimeout(timeout); reject(error); };
    socket.addEventListener('open', () => socket.send(packet(1, { conn_init: { version: 1 } })));
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message: { type?: number; payload?: Record<string, unknown> };
      try { message = JSON.parse(event.data) as typeof message; } catch { return; }
      if (message.type === 2) {
        const ack = message.payload?.conn_init_ack as { success?: boolean; error_msg?: string } | undefined;
        if (ack?.success) {
          ready = true;
          window.clearTimeout(timeout);
          resolve();
        } else fail(new Error(ack?.error_msg || 'vidu_control_rejected'));
      }
      if (message.type === 10) {
        const text = (message.payload?.text_msg as { content?: string } | undefined)?.content;
        if (text) received.push({ seq: ++eventSeq, text, spoken: text });
      }
      if (message.type === 6 && !ready) fail(new Error('vidu_control_closed'));
    });
    socket.addEventListener('error', () => fail(new Error('vidu_control_failed')), { once: true });
    socket.addEventListener('close', () => { if (!ready) fail(new Error('vidu_control_closed')); }, { once: true });
  }).catch((error) => {
    socket.close();
    throw error;
  });

  return {
    send: async (text) => {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('vidu_control_closed');
      socket.send(packet(99, { text_msg: { msg_id: crypto.randomUUID(), content: text, timestamp: Date.now() } }));
    },
    events: (after) => received.filter((event) => event.seq > after),
    close: () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(packet(5, { hangup: { hangup_reason: 'user_end' } }));
      socket.close();
    }
  };
}

async function prepare(star: LiveStarT, language: string, layout: LiveLayoutT): Promise<LiveSessionT | null> {
  const key = `${star}:${layout}` as const;
  let pending = prepared.get(key);
  if (!pending) {
    pending = http.liveStart(star, language, layout).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[live-avatar] session preparation failed (${star}/${layout}): ${detail}`);
      return null;
    });
    prepared.set(key, pending);
  }
  const session = await pending;
  if (!session) prepared.delete(key);
  return session;
}

/**
 * Warms every room while the audience is still in the lobby. Provider sessions and the RTC SDK are prepared,
 * but the browser does not join a channel or create a playing media element until a room is opened.
 */
export function prewarmLiveAvatars(stars: readonly LiveStarT[], language = 'ja', layout: LiveLayoutT = 'mobile'): void {
  void loadSdk().catch(() => undefined);
  // A provider session is created only after a room is opened. The lobby warms the shared RTC SDK without opening
  // five billable digital-human sessions in parallel.
  void stars; void language; void layout;
}

/** Reuses a prepared provider session and joins its RTC channel only when the audience opens that room. */
export async function connectLiveAvatar(star: LiveStarT, container: HTMLElement, onVideo: () => void, language = 'ja', layout: LiveLayoutT = 'mobile'): Promise<LiveAvatarConnection | null> {
  const session = await prepare(star, language, layout);
  if (!session) return null;
  const control = await openControl(session);
  if (!control) {
    prepared.delete(`${star}:${layout}`);
    return null;
  }
  const factory = await loadSdk();
  if (!(await factory.isSupported()).support) throw new Error('rtc_unsupported');
  const engine = factory.getInstance();
  engine.setChannelProfile('interactive_live');
  engine.setClientRole('live');
  engine.on('videoSubscribeStateChanged', (...args: unknown[]) => {
    const [userId, , next] = args as [string, number | string, number | string];
    // AliRTC 7.x emits the documented string state, while older builds emitted
    // the numeric enum. Accept both so a successful subscription is never left
    // behind the local fallback clip.
    const subscribed = next === 3 || next === '3' || next === 'subscribed';
    // Vidu's publisher id is provider-controlled and is not guaranteed to use a fixed prefix.
    // The subscribed remote camera stream is the digital human we need to render.
    if (!subscribed || !userId) return;
    container.replaceChildren();
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.className = 'live-avatar-video';
    video.addEventListener('playing', onVideo, { once: true });
    video.addEventListener('loadedmetadata', () => { void video.play().catch(() => undefined); }, { once: true });
    container.appendChild(video);
    engine.setRemoteViewConfig(video, userId, 1);
  });
  try {
    await Promise.all([
      Promise.resolve(engine.setDefaultSubscribeAllRemoteAudioStreams(true)),
      Promise.resolve(engine.setDefaultSubscribeAllRemoteVideoStreams(true))
    ]);
    await engine.joinChannel(session.rtc.token, session.rtc.user_id);
  } catch (error) {
    prepared.delete(`${star}:${layout}`);
    control.close();
    engine.destroy();
    throw error;
  }
  return {
    session,
    engine,
    send: (text) => control.send(text),
    events: async (after) => control.events(after),
    close: async () => {
      await Promise.allSettled([engine.leaveChannel()]);
      control.close();
      prepared.delete(`${star}:${layout}`);
      engine.destroy();
    },
    end: async () => {
      await Promise.allSettled([engine.leaveChannel()]);
      control.close();
      prepared.delete(`${star}:${layout}`);
      engine.destroy();
    }
  };
}
