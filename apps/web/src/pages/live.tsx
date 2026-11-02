import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { CAST, getStar, isStarId, type StarId } from '../data/cast';
import { THEME } from '../data/theme';
import { starName, type Key, type Lang } from '../i18n';
import { useT } from '../lib/store';
import { Icon, SiteHeader } from '../components/ui';
import { GiftSheet, giftName } from '../components/gift';
import { connectLiveAvatar, prewarmLiveAvatars, type LiveAvatarConnection } from '../lib/viduLive';
import { speechEngine, type Engine } from '../lib/voice';
import type { GiftSendResT } from '@jstar/shared/contracts';
import type { LiveEventT } from '../services/http';
import { getToken } from '../services/http';
import '../styles/live.css';

type LiveCover = { desktop: string; mobile: string };

const LIVE_COVERS: Record<StarId, LiveCover> = {
  mahiro: { desktop: '/media/live/mahiro-public-live-16x9.jpg', mobile: '/media/live/mahiro-public-live-9x16.jpg' },
  nana: { desktop: '/media/live/nana-public-live-16x9.jpg', mobile: '/media/live/nana-public-live-9x16.jpg' },
  unpai: { desktop: '/media/live/unpai-public-live-16x9.jpg', mobile: '/media/live/unpai-public-live-9x16.jpg' },
  alice: { desktop: '/media/live/alice-public-live-16x9.jpg', mobile: '/media/live/alice-public-live-9x16.jpg' },
  eimi: { desktop: '/media/live/eimi-public-live-16x9.jpg', mobile: '/media/live/eimi-public-live-9x16.jpg' }
};

function ResponsiveLiveCover({ cover, className, eager = false }: { cover: LiveCover; className: string; eager?: boolean }) {
  return (
    <picture>
      <source media="(min-width: 1024px)" srcSet={cover.desktop} />
      <img className={className} src={cover.mobile} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" />
    </picture>
  );
}

/** Public 1-to-many live lobby. Every configured avatar session is warmed here, without joining or playing it. */
export function LiveLobby() {
  const t = useT();
  useEffect(() => {
    const desktop = window.matchMedia?.('(min-width: 1024px)').matches ?? window.innerWidth >= 1024;
    prewarmLiveAvatars(CAST.map((star) => star.id), 'ja', desktop ? 'desktop' : 'mobile');
    for (const cover of Object.values(LIVE_COVERS)) {
      const image = new Image();
      image.decoding = 'async';
      image.src = desktop ? cover.desktop : cover.mobile;
    }
  }, []);
  return (
    <main className="page live-lobby night-page js-nightpage">
      <SiteHeader />
      <section className="live-intro">
        <div>
          <span className="live-kicker">JSTAR LIVE · 1 → MANY</span>
          <h1>{t('live.title')}</h1>
        </div>
        <p>{t('live.body')}</p>
      </section>
      <div className="live-roster" aria-label={t('live.choose')}>
        {CAST.map((star, index) => (
          <Link
            key={star.id}
            to={`/live/${star.id}`}
            className="live-card"
            style={{ '--live-accent': THEME[star.id].accent, '--live-delay': `${index * 70}ms` } as CSSProperties}
            aria-label={t('live.enter', { name: starName(star, t.lang) })}
          >
            <ResponsiveLiveCover cover={LIVE_COVERS[star.id]} className="live-card-cover" eager={index < 2} />
            <span className="live-card-status"><i />{t('live.preview')}</span>
            <span className="live-card-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="live-card-copy">
              <strong>{starName(star, t.lang)}</strong>
              <small>{star.romaji}</small>
              <em>{t('live.public')}<Icon name="chev" size={17} /></em>
            </span>
          </Link>
        ))}
      </div>
      <p className="live-note">{t('live.note')}</p>
    </main>
  );
}

/** Full-screen public room shell. It is kept independent of member-only 1-to-1 rooms. */
export function LiveRoom() {
  const { star: id } = useParams();
  const t = useT();
  const [clean, setClean] = useState(false);
  const [avatarReady, setAvatarReady] = useState(false);
  const [messages, setMessages] = useState<LiveBubble[]>([]);
  const [giftOpen, setGiftOpen] = useState(false);
  const starId = isStarId(id) ? id : 'eimi';
  const star = getStar(starId);
  const addMessage = useCallback((message: Omit<LiveBubble, 'id'>) => {
    setMessages((current) => [...current.slice(-5), { ...message, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }]);
  }, []);
  useEffect(() => {
    let timer = 0;
    let alive = true;
    const next = () => {
      timer = window.setTimeout(() => {
        if (!alive) return;
        const pool = LIVE_AUDIENCE[t.lang];
        const question = pool[Math.floor(Math.random() * pool.length)];
        const viewer = LIVE_VIEWERS[Math.floor(Math.random() * LIVE_VIEWERS.length)];
        addMessage({ from: 'viewer', label: viewer, text: question });
        if (activeAvatar && Math.random() < .48) {
          window.setTimeout(() => { if (alive) void sendToAvatar(question); }, 900 + Math.random() * 900);
        }
        next();
      }, 11_000 + Math.random() * 8_000);
    };
    timer = window.setTimeout(() => {
      if (!alive) return;
      const question = LIVE_AUDIENCE[t.lang][0];
      addMessage({ from: 'viewer', label: LIVE_VIEWERS[0], text: question });
      next();
    }, 3_800);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [addMessage, starId, t.lang]);
  const onAvatarReply = useCallback((event: LiveEventT) => {
    setMessages((current) => {
      const id = `host-${event.seq}`;
      const found = current.findIndex((message) => message.id === id);
      if (found >= 0) return current.map((message, index) => index === found ? { ...message, text: event.text } : message);
      return [...current.slice(-5), { id, from: 'host', label: '', text: event.text }];
    });
  }, []);
  const onGiftSent = useCallback((result: GiftSendResT) => {
    const name = giftName(result.giftId, t.lang);
    setGiftOpen(false);
    addMessage({ from: 'viewer', label: LIVE_COPY[t.lang].you, text: `🎁 ${name}` });
    addMessage({ from: 'host', label: '', text: result.reaction });
  }, [addMessage, t.lang]);
  if (!isStarId(id)) return <Navigate to="/live" replace />;
  return (
    <main className="live-room-page">
    <section className={`live-room${clean ? ' is-clean' : ''}`} style={{ '--live-accent': THEME[starId].accent } as CSSProperties}>
      <AvatarLiveStage starId={starId} cover={LIVE_COVERS[starId]} label={t('live.avatarStage', { name: starName(star, t.lang) })} language={t.lang} onReady={setAvatarReady} onReply={onAvatarReply} />
      <header className="live-room-head">
        <Link to="/live" className="live-round" aria-label={t('common.back')}><Icon name="back" /></Link>
        <div className="live-room-identity">
          <span><i />LIVE · PUBLIC</span>
          <strong>{starName(star, t.lang)}</strong>
        </div>
        <button type="button" className="live-clean-toggle" aria-pressed={clean} onClick={() => setClean((v) => !v)}>{t(clean ? 'live.showUi' : 'live.hideUi')}</button>
      </header>

      <aside className="live-social" aria-label={t('live.interaction')}>
        <div className="live-desktop-panel-head" aria-hidden="true">
          <span>JSTAR LIVE · PUBLIC</span>
          <strong>{LIVE_DESKTOP_COPY[t.lang].audience}</strong>
          <div><i>{LIVE_DESKTOP_COPY[t.lang].all}</i><i>{LIVE_DESKTOP_COPY[t.lang].comments}</i></div>
        </div>
        <div className="live-bubble-list" aria-live="polite" aria-label={t('live.chat')}>
          {messages.map((message) => (
            <div key={message.id} className={`live-bubble is-${message.from}`}>
              <b>{message.from === 'host' ? starName(star, t.lang) : message.label}</b><span>{message.text}</span>
            </div>
          ))}
        </div>
        <LiveComposer ready={avatarReady} onMessage={(text) => addMessage({ from: 'viewer', label: LIVE_COPY[t.lang].you, text })} />
      </aside>
      <div className="live-gift-rail" aria-label={LIVE_DESKTOP_COPY[t.lang].gifts}>
        <span className="live-gift-title"><small>JSTAR</small><b>{LIVE_DESKTOP_COPY[t.lang].gifts}</b></span>
        {LIVE_DESKTOP_GIFTS[t.lang].map((gift, index) => (
          <button type="button" className="live-gift-item" key={gift} aria-haspopup="dialog" onClick={() => setGiftOpen(true)}>
            <i aria-hidden="true">{LIVE_GIFT_MARKS[index]}</i><b>{gift}</b><small>{LIVE_GIFT_PRICES[index]}</small>
          </button>
        ))}
      </div>
      {giftOpen && <GiftSheet star={starId} call localSession={import.meta.env.DEV || !getToken()} onClose={() => setGiftOpen(false)} onSent={onGiftSent} />}
    </section>
    </main>
  );
}

let activeAvatar: LiveAvatarConnection | null = null;
let avatarQueue: Promise<void> = Promise.resolve();
const pendingAvatarMessages: string[] = [];

type LiveBubble = { id: string; from: 'viewer' | 'host'; label: string; text: string };

const LIVE_VIEWERS = ['mika', 'sora', 'yui', 'haru', 'ren', 'aoi'];
const LIVE_AUDIENCE: Record<Lang, string[]> = {
  ja: ['今日はどんな一日だった？', '最近いちばん嬉しかったことは？', '今夜は何をして過ごしたい？', 'その笑顔、すごく好き。', '最近のお気に入りを教えて。'],
  'zh-Hant': ['今天過得怎麼樣？', '最近最開心的是什麼？', '今晚想怎麼度過？', '很喜歡妳現在的笑容。', '最近有什麼新的喜歡嗎？'],
  en: ['How was your day?', 'What made you happiest lately?', 'How would you spend tonight?', 'I love that smile.', 'What is your newest favorite thing?'],
  ko: ['오늘 하루는 어땠어요?', '요즘 가장 기뻤던 일은 뭐예요?', '오늘 밤은 어떻게 보내고 싶어요?', '지금 그 미소가 정말 좋아요.', '요즘 새로 좋아하게 된 게 있나요?']
};
const LIVE_COPY: Record<Lang, { you: string; type: string; hold: string; listening: string; unavailable: string; voice: string; keyboard: string }> = {
  ja: { you: 'あなた', type: 'コメントを入力…', hold: '長押しして話す', listening: '聞いています… 離して送信', unavailable: '音声を認識できませんでした', voice: '音声入力', keyboard: '文字入力' },
  'zh-Hant': { you: '你', type: '輸入留言…', hold: '長按說話', listening: '正在聆聽… 鬆開發送', unavailable: '未能識別語音', voice: '語音輸入', keyboard: '文字輸入' },
  en: { you: 'You', type: 'Write a comment…', hold: 'Hold to talk', listening: 'Listening… release to send', unavailable: 'Speech was not recognized', voice: 'Voice input', keyboard: 'Text input' },
  ko: { you: '나', type: '댓글 입력…', hold: '길게 눌러 말하기', listening: '듣고 있어요… 놓으면 전송', unavailable: '음성을 인식하지 못했어요', voice: '음성 입력', keyboard: '텍스트 입력' }
};
const LIVE_DESKTOP_COPY: Record<Lang, { audience: string; all: string; comments: string; gifts: string }> = {
  ja: { audience: 'オンライン', all: 'すべて', comments: 'コメント', gifts: 'ギフト' },
  'zh-Hant': { audience: '線上觀眾', all: '全部', comments: '留言', gifts: '禮物' },
  en: { audience: 'Online audience', all: 'All', comments: 'Comments', gifts: 'Gifts' },
  ko: { audience: '온라인 시청자', all: '전체', comments: '댓글', gifts: '선물' }
};
const LIVE_DESKTOP_GIFTS: Record<Lang, string[]> = {
  ja: ['きらめき', 'リボン', '花束', '香水', '星の冠', '月の鍵', 'バラ'],
  'zh-Hant': ['心動星光', '粉色緞帶', '玫瑰花束', '限定香水', '星辰王冠', '月光鑰匙', '永恆玫瑰'],
  en: ['Starlight', 'Pink ribbon', 'Rose bouquet', 'Perfume', 'Star crown', 'Moon key', 'Forever rose'],
  ko: ['설렘 별빛', '핑크 리본', '장미 꽃다발', '향수', '별의 왕관', '달빛 열쇠', '영원의 장미']
};
const LIVE_GIFT_MARKS = ['✦', '୨୧', '❀', '♢', '♕', '☾', '❦'];
const LIVE_GIFT_PRICES = ['10', '30', '90', '180', '360', '520', '999'];

function sendToAvatar(message: string): Promise<void> {
  if (!activeAvatar) {
    pendingAvatarMessages.push(message);
    if (pendingAvatarMessages.length > 12) pendingAvatarMessages.shift();
    return Promise.resolve();
  }
  avatarQueue = avatarQueue.catch(() => undefined).then(async () => {
    if (!activeAvatar) return;
    await activeAvatar.send(message);
  });
  return avatarQueue;
}

function activateAvatar(connection: LiveAvatarConnection): void {
  activeAvatar = connection;
  const waiting = pendingAvatarMessages.splice(0);
  for (const message of waiting) void sendToAvatar(message);
}

function AvatarLiveStage({ starId, cover, label, language, onReady, onReply }: { starId: StarId; cover: LiveCover; label: string; language: Lang; onReady: (ready: boolean) => void; onReply: (event: LiveEventT) => void }) {
  const t = useT();
  const stream = useRef<HTMLDivElement>(null);
  const languageRef = useRef<Lang>(language);
  const [status, setStatus] = useState<'connecting' | 'preview' | 'live'>('connecting');
  const [viewers, setViewers] = useState(() => 1180 + Math.floor(Math.random() * 180));
  const [caption, setCaption] = useState('');
  useEffect(() => { languageRef.current = language; }, [language]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setViewers((current) => Math.max(680, Math.min(2980, current + Math.floor(Math.random() * 25) - 9)));
    }, 4200);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!activeAvatar || activeAvatar.session.liveId === '') return;
    void activeAvatar.events(0, language).then((events) => {
      for (const event of events) onReply(event);
    }).catch(() => undefined);
  }, [language, onReply]);
  useEffect(() => {
    let alive = true;
    let poll = 0;
    let startTimer = 0;
    let retryTimer = 0;
    let retryAttempt = 0;
    let after = 0;
    let connection: LiveAvatarConnection | null = null;
    if (!stream.current) return;
    const container = stream.current;
    const retry = (): void => {
      if (!alive) return;
      setStatus('preview');
      const delay = Math.min(15_000, 2_400 * (2 ** retryAttempt));
      retryAttempt += 1;
      retryTimer = window.setTimeout(start, delay);
    };
    const start = (): void => {
      if (!alive) return;
      setStatus('connecting');
      const layout = window.matchMedia?.('(min-width: 1024px)').matches ?? window.innerWidth >= 1024 ? 'desktop' : 'mobile';
      connectLiveAvatar(starId, container, () => alive && setStatus('live'), 'ja', layout).then((next) => {
        if (!alive) { void next?.close(); return; }
        if (!next) { retry(); return; }
        retryAttempt = 0;
        connection = next;
        activateAvatar(next);
        onReady(true);
        poll = window.setInterval(async () => {
          try {
            const events = await next.events(after, languageRef.current);
            for (const event of events) { after = Math.max(after, event.seq); setCaption(event.text); onReply(event); }
          } catch { /* a brief polling failure does not stop the stream */ }
        }, 700);
      }).catch(retry);
    };
    // React development mode mounts effects twice. Delaying the paid session start lets the
    // discarded first mount cancel cleanly instead of opening a duplicate avatar session.
    startTimer = window.setTimeout(start, 100);
    return () => {
      alive = false;
      window.clearTimeout(startTimer);
      window.clearTimeout(retryTimer);
      window.clearInterval(poll);
      if (activeAvatar === connection) activeAvatar = null;
      onReady(false);
      void connection?.close();
    };
  }, [onReady, onReply, starId]);
  return (
    <div className={`live-avatar-stage is-${status}`} aria-label={label}>
      <ResponsiveLiveCover cover={cover} className="live-avatar-cover" eager />
      <div ref={stream} className="live-avatar-stream" />
      <span className="live-avatar-state"><i />{t('live.avatarLive', { n: viewers.toLocaleString(language === 'zh-Hant' ? 'zh-TW' : language) })}</span>
      <span className="sr-only" aria-live="polite">{caption}</span>
    </div>
  );
}

function LiveComposer({ ready, onMessage }: { ready: boolean; onMessage: (text: string) => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceText, setVoiceText] = useState('');
  const engine = useRef<Engine | null>(null);
  const voiceTextRef = useRef('');
  const copy = LIVE_COPY[t.lang];
  const send = useCallback(async (message: string) => {
    const value = message.trim();
    if (!value || sending) return;
    setSending(true);
    onMessage(value);
    setText('');
    try { await sendToAvatar(value); } finally { setSending(false); }
  }, [onMessage, sending]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await send(text);
  };
  const stopVoice = useCallback(() => { engine.current?.stop(); }, []);
  const startVoice = useCallback(() => {
    if (!ready || sending || engine.current) return;
    voiceTextRef.current = '';
    setVoiceText('');
    engine.current = speechEngine(t.lang, {
      onStart: () => setListening(true),
      onText: (value) => { voiceTextRef.current = value; setVoiceText(value); },
      onSound: () => undefined,
      onEnd: () => {
        const value = voiceTextRef.current.trim();
        engine.current = null;
        setListening(false);
        if (value) void send(value);
        else setVoiceText(copy.unavailable);
      },
      onError: () => { engine.current = null; setListening(false); setVoiceText(copy.unavailable); }
    });
  }, [copy.unavailable, ready, send, sending, t.lang]);
  useEffect(() => () => engine.current?.abort(), []);
  const onVoiceDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    startVoice();
  };
  const onVoiceKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); startVoice(); }
  };
  const onVoiceKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); stopVoice(); }
  };
  return (
    <form className="live-composer" onSubmit={submit}>
      {voiceMode
        ? <button type="button" className={`live-hold${listening ? ' is-listening' : ''}`} disabled={!ready || sending}
            onPointerDown={onVoiceDown} onPointerUp={stopVoice} onPointerCancel={stopVoice} onLostPointerCapture={stopVoice}
            onKeyDown={onVoiceKeyDown} onKeyUp={onVoiceKeyUp} aria-label={listening ? copy.listening : copy.hold}>
            {voiceText || (listening ? copy.listening : copy.hold)}
          </button>
        : <input value={text} onChange={(event) => setText(event.target.value)} maxLength={300} placeholder={copy.type} aria-label={copy.type} />}
      {!voiceMode && <button type="submit" className="live-send" aria-label={t('common.send')} disabled={sending || !text.trim()}><Icon name="send" size={18} /></button>}
      <button type="button" className="live-mode" aria-label={voiceMode ? copy.keyboard : copy.voice} onClick={() => { engine.current?.abort(); engine.current = null; setListening(false); setVoiceText(''); setVoiceMode((value) => !value); }}>
        <Icon name={voiceMode ? 'chat' : 'mic'} size={18} />
      </button>
    </form>
  );
}

/** Shared CSS-only stage, deliberately free of media URLs and third-party requests. */
export function LiveStagePlaceholder({ compact, label }: { compact?: boolean; label: string }) {
  return (
    <div className={`live-stage${compact ? ' compact' : ''}`} aria-label={label}>
      <div className="live-stage-grid" />
      <div className="live-orbit one" />
      <div className="live-orbit two" />
      <div className="live-silhouette" aria-hidden="true"><i /><span /></div>
      <div className="live-stage-label"><span>VIDU DIGITAL HUMAN</span><b>{label}</b></div>
    </div>
  );
}

export function LiveFeaturePreview() {
  const t = useT();
  const steps: Key[] = ['live.stepChoose', 'live.stepPublic', 'live.stepGift', 'live.stepPrivate'];
  return (
    <div className="features-media live-feature-preview">
      <div className="live-feature-stage"><LiveStagePlaceholder compact label={t('live.stagePending')} /></div>
      <ol>{steps.map((key, index) => <li key={key}><span>{String(index + 1).padStart(2, '0')}</span><b>{t(key)}</b></li>)}</ol>
    </div>
  );
}
