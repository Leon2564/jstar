import { http, serverMode, type LiveEventT, type LiveLayoutT, type LiveSessionT, type LiveStarT } from '../services/http';

interface AliRtcEngineT {
  on(event: string, listener: (...args: unknown[]) => void): void;
  setChannelProfile(profile: string): void;
  setClientRole(role: string): void;
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

async function prepare(star: LiveStarT, language: string, layout: LiveLayoutT): Promise<LiveSessionT | null> {
  if (!serverMode()) return null;
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
  if (!serverMode()) return;
  void loadSdk().catch(() => undefined);
  for (const star of stars) void prepare(star, language, layout);
}

/** Reuses a prepared provider session and joins its RTC channel only when the audience opens that room. */
export async function connectLiveAvatar(star: LiveStarT, container: HTMLElement, onVideo: () => void, language = 'ja', layout: LiveLayoutT = 'mobile'): Promise<LiveAvatarConnection | null> {
  const session = await prepare(star, language, layout);
  if (!session) return null;
  const factory = await loadSdk();
  if (!(await factory.isSupported()).support) throw new Error('rtc_unsupported');
  const engine = factory.getInstance();
  engine.setChannelProfile('interactive_live');
  engine.setClientRole('live');
  engine.on('videoSubscribeStateChanged', (...args: unknown[]) => {
    const [userId, , next] = args as [string, number, number];
    // Vidu's publisher id is provider-controlled and is not guaranteed to use a fixed prefix.
    // The subscribed remote camera stream is the digital human we need to render.
    if (next !== 3 || !userId) return;
    container.replaceChildren();
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.className = 'live-avatar-video';
    video.addEventListener('playing', onVideo, { once: true });
    container.appendChild(video);
    engine.setRemoteViewConfig(video, userId, 1);
  });
  try {
    await engine.joinChannel(session.rtc.token, session.rtc.user_id);
  } catch (error) {
    prepared.delete(`${star}:${layout}`);
    engine.destroy();
    throw error;
  }
  return {
    session,
    engine,
    send: (text) => http.liveMessage(session.liveId, text).then(() => undefined),
    events: (after, lang) => http.liveEvents(session.liveId, after, lang).then((r) => r.events),
    close: async () => {
      await Promise.allSettled([engine.leaveChannel()]);
      engine.destroy();
    },
    end: async () => {
      await Promise.allSettled([engine.leaveChannel(), http.liveEnd(session.liveId)]);
      prepared.delete(`${star}:${layout}`);
      engine.destroy();
    }
  };
}
