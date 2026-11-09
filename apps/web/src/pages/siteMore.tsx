/**
 * Secondary site pages. A separate chunk so the first visit only downloads the age gate,
 * the loading screen and the home stage (bundle budget: tests/e2e/perf.spec.ts).
 */
import { localText } from '@jstar/shared/domain';
import { SCENE_GROUPS } from '@jstar/shared/catalog';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { CAST, getStar } from '../data/cast';
import { heroEntry } from '../data/heroMedia';
import { CARDS, CARD_BY_ID, type CardDef } from '../data/cards';
import { EVENT_BADGE, eventStatus } from '../data/events';
import { upcomingEvents } from '../data/eventsCalendar';
import { SIGNATURE, THEME } from '../data/theme';
import { monthDayLabel, profileOf } from '../data/profile';
import { starFirst, starName, type Key, fmtDate } from '../i18n';
import { audioExists, playVoice, stopVoice } from '../lib/sound';
import { useStore, useT } from '../lib/store';
import { isDemo } from '../services/api';
import { Icon, LangSelect, MediaSlot, SiteHeader, siteNav } from '../components/ui';
import { SceneVideo, media, sceneFor, stillOf } from '../components/stage';
import { CardArt } from '../components/cardArt';
import { CardShowcase } from '../components/cardShowcase';
import { Footer, LEGAL, SNS } from '../components/footer';
import { LIVE_COVERS, ResponsiveLiveCover } from '../components/liveCover';
import '../components/gift.css';
import '../styles/site.css';
// The gallery, the legal pages and the 404 are on the A2 night too (the member pages' night scope).
import '../system/system.css';

export function Menu() {
  const { state } = useStore();
  const t = useT();
  return (
    <div className="page dark" style={{ background: 'var(--navy)', color: 'var(--ivory)', padding: '0 24px', minHeight: '100dvh' }}>
      <div className="menu-panel" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        <header className="hdr" style={{ padding: 0, marginRight: -12 }}>
          <span className="brand" style={{ padding: 0 }}>JSTAR</span>
          <Link to={state.user ? '/me/home' : '/'} className="icon-btn" aria-label={t('common.close')}><Icon name="close" /></Link>
        </header>
        <nav aria-label={t('nav.site')} className="menu-nav" style={{ marginTop: 16 }}>
          {siteNav(!!state.user).map(([to, key, en]) => (
            <Link key={to} to={to}>
              <span className="serif" style={{ fontSize: 23 }}>{t(key)}</span>
              {t.lang !== 'en' && <span className="serif" aria-hidden="true" style={{ fontSize: 12, letterSpacing: '0.3em', color: '#E3A8B2' }}>{en}</span>}
            </Link>
          ))}
        </nav>
        <div className="grid2" style={{ marginTop: 26, maxWidth: 520 }}>
          {state.user
            ? <Link to="/me/mypage" className="btn btn-ivory" style={{ minHeight: 48 }}>{t('menu.mypage')}</Link>
            : <Link to="/signup?mode=login" className="btn btn-ivory" style={{ minHeight: 48 }}>{t('menu.login')}</Link>}
          <Link to="/serial" className="btn btn-ghost" style={{ minHeight: 48 }}>{t('menu.serial')}</Link>
        </div>
        <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="small">{t('menu.lang')}</span>
          <LangSelect />
        </div>
        <div className="menu-foot" style={{ marginTop: 'auto', padding: '24px 0 22px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {SNS.length > 0 && <div style={{ display: 'flex', gap: 18, fontSize: 12 }}>{SNS.map((x) => <a key={x.name} href={x.href} target="_blank" rel="noopener noreferrer">{x.name}</a>)}</div>}
          <nav aria-label={t('foot.legal')} style={{ display: 'flex', flexWrap: 'wrap', gap: '0 16px', fontSize: 12, color: 'rgba(239,232,237,0.82)' }}>
            {LEGAL.map(([to, k]) => <Link key={to} to={to} style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>{t(k)}</Link>)}
          </nav>
          <p className="tiny" style={{ margin: 0, color: 'rgba(239,232,237,0.72)' }}>{t('foot.adult')}　© 2026 JSTAR</p>
        </div>
      </div>
    </div>
  );
}

/**
 * JSTARS: one talent at a time, in her own colour. Her clip enters like a curtain opening; the name, line and
 * profile sit beside her on desktop and below her face on phones, never over it. Only confirmed data is shown.
 */
export function Stars() {
  const t = useT();
  const { state, actions } = useStore();
  const loc = useLocation();
  const nav = useNavigate();
  const [i, setI] = useState(() => Math.max(0, CAST.findIndex((c) => c.id === new URLSearchParams(loc.search).get('star'))));
  // A `?star=` link followed while this page is open (menu, back/forward) switches to her too.
  useEffect(() => {
    const n = CAST.findIndex((c) => c.id === new URLSearchParams(loc.search).get('star'));
    if (n >= 0) setI((cur) => (cur === n ? cur : n));
  }, [loc.search]);
  const [voice, setVoice] = useState(false);
  const c = CAST[i];
  const theme = THEME[c.id];
  const name = starName(c, t.lang);
  const first = starFirst(c, t.lang);
  const profile = profileOf(c.id);
  // Korean where written (her city), else English.
  const pick = (v?: Partial<Record<string, string>>) => v && (v[t.lang] || (t.lang === 'ko' ? v.en : undefined));
  const rows = ([
    ['stars.birthday', profile.birthday && monthDayLabel(profile.birthday, t.lang)], ['stars.height', profile.height],
    ['stars.from', pick(profile.from)], ['stars.likes', pick(profile.likes)]
  ] as [Key, string | undefined][]).filter((r): r is [Key, string] => !!r[1]);
  const copy = PROFILE_HUB_COPY[t.lang];
  const featureVideo = heroEntry(c.id, false);
  const featureSource = featureVideo?.sources.find((source) => source.type.includes('avc1') && source.width <= 1280)
    ?? featureVideo?.sources.find((source) => source.type.includes('avc1'))
    ?? featureVideo?.sources[0];
  const photo = PROFILE_SPACE_PHOTOS[c.id];
  const videoTo = state.user ? `/me/home?star=${c.id}` : '/trial';
  const textTo = state.user ? `/me/chat?star=${c.id}` : '/trial?mode=text';
  const voiceUrl = `/voice/greet/${c.id}-welcome.mp3`;
  const go = (k: number) => {
    const n = (k + CAST.length) % CAST.length;
    stopVoice();
    setI(n);
    nav(`/stars?star=${CAST[n].id}`, { replace: true });
  };
  useEffect(() => {
    let live = true;
    setVoice(false);
    void audioExists(voiceUrl).then((ok) => { if (live) setVoice(ok); });
    return () => { live = false; };
  }, [voiceUrl]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input, textarea, select, [role="slider"]') || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === 'ArrowRight') go(i + 1);
      else if (e.key === 'ArrowLeft') go(i - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <main className="page stars stars-hub" data-star={c.id} style={{ '--accent': theme.accent } as React.CSSProperties}>
      <SiteHeader />
      <div key={`v${c.id}`} className="stars-media stars-enter" aria-hidden="true">
        <ResponsiveLiveCover cover={LIVE_COVERS[c.id]} className="stars-profile-cover" eager />
        <span className="stars-outline">{c.romajiFirst}</span>
      </div>
      <div className="scrim" />
      <section key={c.id} className="stars-info" aria-live="polite">
        <div className="stars-name rise-seq" style={{ '--d': 0 } as React.CSSProperties}>
          <span className="stars-romaji">{String(i + 1).padStart(2, '0')} — {c.romaji}</span>
          <h1 className="stars-h1">{name}</h1>
        </div>
        <p className="serif pre stars-line rise-seq" style={{ '--d': 1 } as React.CSSProperties}>{t(`star.${c.id}.line` as Key)}</p>
        <p className="stars-intro rise-seq" style={{ '--d': 2 } as React.CSSProperties}>{t(`star.${c.id}.intro` as Key)}</p>
        <div className="stars-actions stars-hub-actions rise-seq" style={{ '--d': 3 } as React.CSSProperties}>
          {voice && (
            <button type="button" className="btn btn-ghost voice-btn" aria-label={t('stars.voice', { name })} onClick={() => void playVoice(voiceUrl, true)}>
              <Icon name="speaker" size={18} />
            </button>
          )}
          <Link to={videoTo} className="btn btn-rose magnetic stars-video-cta" onClick={() => { actions.setStar(c.id); actions.setTrialStar(c.id); }}>
            <Icon name="play" size={18} /><span><b>{copy.video}</b><small>{copy.videoSub}</small></span>
          </Link>
          <Link to={textTo} className="btn stars-text-cta" onClick={() => { actions.setStar(c.id); actions.setTrialStar(c.id); }}>
            <span><b>{copy.text}</b><small>{copy.textSub}</small></span>
          </Link>
        </div>
        {rows.length > 0 && (
          <dl className="stars-profile rise-seq" style={{ '--d': 4 } as React.CSSProperties} aria-label={t('stars.profile')}>
            {rows.map(([k, v]) => <div key={k}><dt>{t(k)}</dt><dd>{v}</dd></div>)}
          </dl>
        )}
        <section className="stars-space rise-seq" style={{ '--d': 5 } as React.CSSProperties} aria-labelledby="stars-space-title">
          <div className="stars-section-head"><div><span className="eyebrow">HER SPACE · 01</span><h2 id="stars-space-title">{copy.space}</h2></div><span className="stars-space-mark">✦ JSTAR</span></div>
          <p className="stars-space-lead">{copy.spaceLead}</p>
          <div className="stars-editorial-grid">
            <figure className="stars-editorial-photo"><img src={photo} alt={copy.photoAlt.replace('{name}', name)} loading="lazy" /><figcaption><span>01 / {copy.photo}</span><b>{name}</b></figcaption></figure>
            <figure className="stars-editorial-portrait"><ResponsiveLiveCover cover={LIVE_COVERS[c.id]} className="stars-editorial-portrait-img" /><figcaption>{copy.portrait}</figcaption></figure>
          </div>
          <div className="stars-feature-film">
            <div className="stars-feature-film-head"><span className="eyebrow">FILM · 01</span><span>{copy.filmHint}</span></div>
            {featureVideo && featureSource ? <video key={c.id} controls playsInline preload="none" poster={featureVideo.poster} aria-label={copy.filmAlt.replace('{name}', name)}><source src={featureSource.src} type={featureSource.type} /></video> : <img src={photo} alt={copy.photoAlt.replace('{name}', name)} loading="lazy" />}
            <div className="stars-feature-film-copy"><div><h3>{copy.film}</h3><p>{copy.filmBody}</p></div><span aria-hidden="true">↗</span></div>
          </div>
        </section>
        <section className="stars-moments rise-seq" style={{ '--d': 6 } as React.CSSProperties} aria-labelledby="stars-moments-title">
          <div className="stars-section-head"><div><span className="eyebrow">PUBLIC NOTES · 02</span><h2 id="stars-moments-title">{copy.moments}</h2></div></div>
          <div className="stars-moment-list">
            {c.id === 'nana' ? NANA_PUBLIC_MOMENTS.map((post, index) => <article key={post.id} className="stars-moment-media-post">
              <div className="stars-moment-avatar"><ResponsiveLiveCover cover={LIVE_COVERS[c.id]} className="stars-moment-face" /></div>
              <div className="stars-moment-content"><header><b>{name}</b><span>JSTAR · {String(index + 1).padStart(2, '0')}</span></header>
                <p>{post.caption[t.lang]}</p>
                {post.kind === 'photos'
                  ? <div className="stars-moment-gallery">{post.images.map((src, photoIndex) => <img key={src} src={src} alt={`${post.caption[t.lang]} · ${photoIndex + 1}`} loading="lazy" />)}</div>
                  : <video controls playsInline preload="none" poster={post.poster} aria-label={post.caption[t.lang]}><source src={post.video} type="video/mp4" /></video>}
                <span className="stars-moment-tag">{post.tag}</span>
              </div>
            </article>) : copy.posts.map((post, index) => <article key={post.title}>
              <div className="stars-moment-avatar"><ResponsiveLiveCover cover={LIVE_COVERS[c.id]} className="stars-moment-face" /></div>
              <div className="stars-moment-content"><header><b>{name}</b><span>JSTAR · {String(index + 1).padStart(2, '0')}</span></header><p>{post.body.replace('{name}', first)}</p>{index === 0 && <img className="stars-moment-image" src={photo} alt={copy.photoAlt.replace('{name}', name)} loading="lazy" />}<span className="stars-moment-tag">{post.tag}</span></div>
            </article>)}
          </div>
        </section>
        {SIGNATURE[c.id] && <img className="stars-autograph" src={SIGNATURE[c.id]} alt={t('stars.sign')} />}
        <div className="stars-pager">
          <button type="button" className="icon-btn" aria-label={t('stars.prev')} onClick={() => go(i - 1)}><Icon name="back" /></button>
          <div className="stars-dots">
            {CAST.map((m, k) => (
              <button key={m.id} type="button" className={`stars-dot${k === i ? ' on' : ''}`} aria-label={starName(m, t.lang)} aria-current={k === i ? 'true' : undefined}
                style={{ '--accent': THEME[m.id].accent } as React.CSSProperties} onClick={() => go(k)} />
            ))}
          </div>
          <button type="button" className="icon-btn" aria-label={t('stars.next')} onClick={() => go(i + 1)}><Icon name="chev" /></button>
        </div>
      </section>
    </main>
  );
}

const PROFILE_HUB_COPY = {
  ja: {
    video: 'ビデオ通話', videoSub: '彼女と顔を見ながら話す', text: 'メッセージ', textSub: '文字でゆっくり話す',
    space: '彼女のスペース', spaceLead: '写真と言葉、そして少しの映像。彼女らしい空気を、ここでゆっくり。', photo: 'PHOTO DIARY', portrait: 'A MOMENT WITH HER', photoAlt: '{name}の写真', film: '彼女の時間', filmBody: '再生して、彼女の表情や空気を感じて。', filmHint: 'タップして再生', filmAlt: '{name}のプロフィール映像',
    moments: '公開モーメント', posts: [
      { title: 'scene', body: 'この一枚が、{name}らしい時間の入り口になりますように。', tag: '#JSTAR #PHOTO' },
      { title: 'pv', body: '短い映像を置いておくね。少しだけ一緒に過ごせたらうれしいな。', tag: '#FILM' },
      { title: 'hello', body: '今日もここで待ってるね。話したくなったら、いつでも。', tag: '#MESSAGE' }
    ]
  },
  'zh-Hant': {
    video: '視訊通話', videoSub: '和她面對面聊天', text: '文字聊天', textSub: '用訊息慢慢聊',
    space: '她的個人空間', spaceLead: '一些照片、一些心情，還有屬於她的影像片段。慢慢認識她。', photo: '影像日記', portrait: '她的片刻', photoAlt: '{name}的照片', film: '和她相處的片刻', filmBody: '點開影片，看看她此刻的神情與氛圍。', filmHint: '點擊播放', filmAlt: '{name}的個人影片',
    moments: '公開動態', posts: [
      { title: 'scene', body: '留下一張照片，記錄屬於{name}的一個片刻。', tag: '#JSTAR #PHOTO' },
      { title: 'pv', body: '這段影像裡有她安靜的表情，也有一點想對你說的話。', tag: '#FILM' },
      { title: 'hello', body: '想聊聊的時候，可以從這裡來找我。', tag: '#MESSAGE' }
    ]
  },
  en: {
    video: 'Video call', videoSub: 'Talk face to face', text: 'Text chat', textSub: 'Take it slow in messages',
    space: 'Her space', spaceLead: 'A few photos, a few thoughts, and a film that feels like her. Take your time.', photo: 'PHOTO DIARY', portrait: 'A MOMENT WITH HER', photoAlt: 'A portrait of {name}', film: 'A moment with her', filmBody: 'Press play and spend a quiet moment in her world.', filmHint: 'PRESS PLAY', filmAlt: 'Profile video of {name}',
    moments: 'Public moments', posts: [
      { title: 'scene', body: 'A photograph to hold one small moment with {name}.', tag: '#JSTAR #PHOTO' },
      { title: 'pv', body: 'A short film, a quiet expression, and a few seconds in her world.', tag: '#FILM' },
      { title: 'hello', body: 'Whenever you feel like talking, you can find me here.', tag: '#MESSAGE' }
    ]
  },
  ko: {
    video: '영상 통화', videoSub: '얼굴을 보며 대화하기', text: '문자 채팅', textSub: '메시지로 천천히 대화하기',
    space: '그녀의 공간', spaceLead: '사진과 짧은 생각, 그리고 그녀다운 영상. 천천히 알아가 보세요.', photo: 'PHOTO DIARY', portrait: '그녀의 순간', photoAlt: '{name}의 사진', film: '그녀와의 순간', filmBody: '재생해서 그녀의 표정과 분위기를 느껴보세요.', filmHint: '눌러서 재생', filmAlt: '{name}의 프로필 영상',
    moments: '공개 모먼트', posts: [
      { title: 'scene', body: '{name}와 함께한 작은 순간을 사진으로 남겼어요.', tag: '#JSTAR #PHOTO' },
      { title: 'pv', body: '짧은 영상 속 그녀의 표정과 분위기를 느껴보세요.', tag: '#FILM' },
      { title: 'hello', body: '이야기하고 싶을 때 언제든 여기로 와요.', tag: '#MESSAGE' }
    ]
  }
} as const;

const PROFILE_SPACE_PHOTOS = {
  mahiro: '/media/mahiro-feedback/poster.jpg',
  nana: '/media/nana-feedback/posters-4k/nana-react-a-16x9.jpg',
  unpai: '/media/unpai-feedback/posters-4k/unpai-react-a-16x9.jpg',
  alice: '/media/alice-feedback/posters/alice-react-a-16x9.jpg',
  eimi: '/media/eimi-feedback/enter-poster.png'
} as const;

const NANA_PUBLIC_MOMENTS = [
  {
    id: 'stairs', kind: 'photos', images: ['/media/profile/nana/stairs-01.jpg', '/media/profile/nana/stairs-02.jpg'], tag: '#PHOTO · 01',
    caption: { ja: '階段の途中で、ふと見上げた二つの瞬間。', 'zh-Hant': '樓梯轉角，抬頭看鏡頭的兩個瞬間。', en: 'Two little moments, looking up from the stairs.', ko: '계단에서 올려다본 두 순간.' }
  },
  {
    id: 'garden', kind: 'video', video: '/media/profile/nana/garden.mp4', poster: '/media/profile/nana/garden-poster.png', tag: '#VIDEO · 01',
    caption: { ja: '庭の揺れる椅子で、ブルーベリーと小さな休憩。', 'zh-Hant': '坐在庭院吊椅上，帶著一籃藍莓偷個閒。', en: 'A little garden break with a basket of blueberries.', ko: '정원의 흔들의자에서 블루베리와 함께 잠깐 쉬어가기.' }
  },
  {
    id: 'sofa', kind: 'photos', images: ['/media/profile/nana/sofa-01.jpg', '/media/profile/nana/sofa-02.jpg'], tag: '#PHOTO · 02',
    caption: { ja: '白いソファで、少しだけのんびり。', 'zh-Hant': '在白色沙發上，讓午後慢一點。', en: 'A slower afternoon on the white sofa.', ko: '하얀 소파에서 조금 느리게 보내는 오후.' }
  },
  {
    id: 'morning', kind: 'video', video: '/media/profile/nana/morning.mp4', poster: '/media/profile/nana/morning-poster.png', tag: '#VIDEO · 02',
    caption: { ja: '窓から光が入る朝、ベッドの上でひと息。', 'zh-Hant': '晨光從窗邊進來，抱著枕頭慢慢醒來。', en: 'Morning light, a pillow, and a moment to wake up slowly.', ko: '창가의 아침 햇살, 베개를 안고 천천히 눈뜨는 시간.' }
  },
  {
    id: 'spa', kind: 'photos', images: ['/media/profile/nana/spa-01.jpg', '/media/profile/nana/spa-02.jpg'], tag: '#PHOTO · 03',
    caption: { ja: '星のような灯りと、あたたかな湯のそばで。', 'zh-Hant': '星點燈光與暖暖的水邊，留一點放鬆的時間。', en: 'A little time to unwind beneath starry lights by the warm water.', ko: '별빛 같은 조명과 따뜻한 물가에서 쉬어가는 시간.' }
  }
] as const;

// f5 / f6: v1.1 (Nest), life together and the scenes. Their lines are reviewed (#84), but the scenes play in
// production only once their clips exist (the publish rule), so production shows these two once the clips land.
const FEATURES_V10 = ['f1', 'f2', 'f3', 'f4'] as const;
const FEATURES_V11 = [...FEATURES_V10, 'f5', 'f6'] as const;

export function Features() {
  const t = useT();
  const [i, setI] = useState(0);
  const FEATURES: readonly (typeof FEATURES_V11)[number][] = isDemo() ? FEATURES_V11 : FEATURES_V10;
  const f = FEATURES[i];
  const featureStar = CAST[i % CAST.length];
  // Until screen recordings of the app exist, each feature is shown with one of the five in her scene.
  const clip = media(`${featureStar.id}-breath-9x16`) ?? media(`${featureStar.id}-hero-9x16`);
  return (
    <main className="page features-page">
      <SiteHeader />
      <div className="features">
        <div role="tablist" aria-label={t('nav.features')} className="underline-tabs" style={{ gridTemplateColumns: `repeat(${FEATURES.length}, minmax(0,1fr))` }}>
          {FEATURES.map((x, k) => (
            <button key={x} type="button" role="tab" id={`ft-${k}`} aria-controls="ft-panel" aria-selected={k === i} onClick={() => setI(k)}>{t(`${x}.short` as Key)}</button>
          ))}
        </div>
        {clip
          ? <div key={`m${f}`} className="features-media media on-dark fade-in" style={{ '--feature-face-x': featureStar.id === 'eimi' ? '82%' : '50%' } as React.CSSProperties}><SceneVideo entry={clip} active /></div>
          : <MediaSlot key={`m${f}`} className="features-media fade-in" tint="var(--mist-deep)" label={t('features.video', { v: t(`${f}.video` as Key) })} spec={t('features.slotSpec')} />}
        <section key={`s${f}`} id="ft-panel" role="tabpanel" aria-labelledby={`ft-${i}`} className="features-text stack fade-in">
          <h1 className="h1 features-title">
            {t(`${f}.title` as Key).split('\n').map((line, lineIndex) => <span key={`${lineIndex}-${line}`}>{line}</span>)}
          </h1>
          <p className="features-subtitle">
            {t(`${f}.subtitle` as Key).split('\n').map((line, lineIndex) => <span key={`${lineIndex}-${line}`}>{line}</span>)}
          </p>
          <p className="muted features-body">{t(`${f}.body` as Key)}</p>
        </section>
      </div>
      <div className="bottom features-cta"><Link to="/pick" className="btn btn-navy magnetic">{t('features.cta')}</Link></div>
      <Footer />
    </main>
  );
}

/**
 * Five scene groups for each talent, each with a card at every tier. A locked card opens a preview with the way to
 * collect it (a guest: sign up, free; a member: the draw). The heading is the page's name in his language.
 */
export function Gallery() {
  const { state } = useStore();
  const t = useT();
  const [f, setF] = useState<string>('all');
  const [peek, setPeek] = useState<CardDef | null>(null);
  const [showcase, setShowcase] = useState<CardDef | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const groups = SCENE_GROUPS.filter((group) => f === 'all' || group.star === f);
  const ownedCount = CARDS.filter((card) => !!state.owned[card.id]).length;
  const close = () => { setPeek(null); opener.current?.focus(); };
  return (
    <main className="page night-page js-nightpage">
      <SiteHeader />
      <div className="gallery-wrap" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div className="pad" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <div><span className="eyebrow" aria-hidden="true">FIRST FIVE</span><h1 className="h1" style={{ fontSize: 22 }}>{t('nav.cards')}</h1></div>
          <span className="small muted">{t('gallery.count', { owned: ownedCount, total: CARDS.length })}</span>
        </div>
        <div role="group" aria-label={t('gallery.filter')} style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '14px 24px 2px', scrollbarWidth: 'none' }}>
          {[{ id: 'all', label: t('gallery.all') }, ...CAST.map((c) => ({ id: c.id, label: starName(c, t.lang) }))].map((o) => (
            <button key={o.id} type="button" className="chip" aria-pressed={f === o.id} onClick={() => setF(o.id)}>{o.label}</button>
          ))}
        </div>
        <div className="pad" style={{ marginTop: 16, display: 'grid', gap: 30 }}>
          {groups.map((group) => <section key={group.id} aria-label={`${starName(getStar(group.star), t.lang)} · ${t('gallery.scene', { n: group.index })}`}>
            <h2 className="serif" style={{ fontSize: 17, margin: '0 0 12px' }}>{starName(getStar(group.star), t.lang)} · {t('gallery.scene', { n: group.index })}</h2>
            <div className="cards-grid wide gallery-grid">
          {Object.values(group.cards).map((id, k) => {
            const c = CARD_BY_ID[id];
            const own = !!state.owned[c.id];
            const art = <CardArt key={`${f}-${c.id}`} card={c} locked={!own} tilt={own} className="deal" style={{ animationDelay: `${Math.min(k, 12) * 25}ms` }} />;
            return own ? (
              <button key={`${f}-${c.id}`} type="button" className="gallery-tile is-owned" aria-haspopup="dialog"
                aria-label={`${starName(getStar(c.star), t.lang)} ${c.rarity}「${t('gallery.showcase')}」`}
                onClick={() => setShowcase(c)}>{art}</button>
            ) : (
              <button key={`${f}-${c.id}`} type="button" className="gallery-tile" aria-haspopup="dialog"
                aria-label={`${starName(getStar(c.star), t.lang)} ${c.rarity}「${t('common.locked')}」`}
                onClick={(e) => { opener.current = e.currentTarget; setPeek(c); }}>{art}</button>
            );
          })}
            </div>
          </section>)}
        </div>
        <div className="bottom stack" style={{ gap: 8, maxWidth: 420, width: '100%', alignSelf: 'center' }}>
          <Link to="/gacha" className="btn btn-rose">{t('gallery.cta')}</Link>
          <p className="tiny muted" style={{ textAlign: 'center', margin: 0 }}>{t('gallery.note')}</p>
        </div>
        <div className="gallery-back-top-row">
          <button
            type="button"
            className="gallery-back-top"
            aria-label={t('home.backTop')}
            onClick={() => window.scrollTo({
              top: 0,
              behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
            })}
          >
            <Icon name="back" size={17} />
            <span aria-hidden="true">TOP</span>
          </button>
        </div>
      </div>
      <Footer />
      {peek && <CardPeek card={peek} member={!!state.user} onClose={close} />}
      {showcase && <CardShowcase card={showcase} onClose={() => setShowcase(null)} />}
    </main>
  );
}

function CardPeek({ card, member, onClose }: { card: CardDef; member: boolean; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The A2 night sheet of her notification offer and gifts (gift.css), with the card beside the way to it; A-N4: a modal
  // centred over the dimmed gallery at every size (site.css .peek-wrap), never pinned over the heading.
  return (
    <div className="gift-backdrop peek-wrap" role="presentation" onClick={onClose}>
      <div ref={ref} className="panel gift-sheet peek-sheet" role="dialog" aria-modal="true" aria-labelledby="peek-h" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="gift-head">
          <h2 id="peek-h"><span className={`badge r-${card.rarity}`}>{card.rarity}</span> {starName(getStar(card.star), t.lang)}</h2>
          <button type="button" className="round" onClick={onClose} aria-label={t('common.close')}><Icon name="close" size={18} /></button>
        </div>
        <div className="peek">
          <div className="peek-card"><CardArt card={card} locked /></div>
          <div className="stack">
            <p className="small" style={{ margin: 0, color: 'var(--iv-meta)' }}>{t(member ? 'gallery.note' : 'gallery.preview')}</p>
            <Link to="/gacha" className="btn btn-rose">{t(member ? 'gallery.cta' : 'gallery.join')}</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Events() {
  const t = useT();
  const { state } = useStore();
  // #61: from the shared calendar — her birthdays, the seasons, and their anniversaries he has — never fixed dates.
  const events = upcomingEvents(new Date(), { anniversaries: Object.fromEntries(Object.entries(state.relView).map(([id, v]) => [id, v?.anniversary ?? null])) });
  return (
    <main className="page night-page events-page">
      <SiteHeader />
      <ul className="events-list">
        {events.map((e, k) => {
          const st = eventStatus(e);
          const previewStar = e.star ?? CAST[k % CAST.length].id;
          const preview = sceneFor(previewStar, false) ?? media(`${previewStar}-hero-16x9`);
          return (
            <li key={e.id}>
              <article style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <MediaSlot tint={e.tint} label={t('events.banner')} spec="1029×390" src={stillOf(preview, true)} style={{ aspectRatio: '1029 / 390', borderRadius: 2 }}>
                  <span className={`badge ${EVENT_BADGE[st].cls}`} data-testid={`event-status-${e.id}`} data-status={st} style={{ position: 'absolute', left: 0, top: 10, fontSize: 11, padding: '3px 10px' }}>{t(EVENT_BADGE[st].key)}</span>
                </MediaSlot>
                <h2 className="serif" style={{ margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.5 }}>{localText(e.title, t.lang)}</h2>
                <span className="small muted">{st === 'soon' ? t('ev.soonDate', { date: fmtDate(e.startsAt, t.lang) }) : t('gacha.period', { from: fmtDate(e.startsAt, t.lang), to: fmtDate(e.endsAt, t.lang) })}</span>
              </article>
            </li>
          );
        })}
      </ul>
      <Footer />
    </main>
  );
}

export function NotFound() {
  const t = useT();
  return (
    <main className="page night-page js-nightpage" style={{ minHeight: '100dvh' }}>
      <SiteHeader />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, textAlign: 'center' }}>
        <span className="eyebrow" aria-hidden="true">404</span>
        <h1 className="h1">{t('nf.title')}</h1>
        <p className="small muted" style={{ margin: 0 }}>{t('nf.body')}</p>
        <Link to="/" className="btn btn-rose" style={{ width: '100%', maxWidth: 360 }}>{t('nf.cta')}</Link>
      </div>
      <Footer />
    </main>
  );
}
