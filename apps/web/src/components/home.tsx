/**
 * The home page below the first screen (its own chunk): one idea per screen, as in the reference.
 * 02 the five talents → 03 how it works → 04 the card series → 05 news and the PV → footer.
 * Each section's children enter in layers (.rise with a stagger index --d) when the section scrolls in (.in).
 */
import { localText } from '@jstar/shared/domain';
import { useEffect, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CAST } from '../data/cast';
import { CARD_BY_ID } from '../data/cards';
import { EVENT_BADGE, eventStatus, useEvents } from '../data/events';
import { THEME } from '../data/theme';
import { fmtDate, starFirst, starName, verticalName, type Key } from '../i18n';
import { getStar, type StarId } from '../data/cast';
import { playVoice } from '../lib/sound';
import { useStore, useT } from '../lib/store';
import { CardTile } from './cardTile';
import { Footer } from './footer';
import { SceneVideo, media, mediaFor, stillOf, usePortrait } from './stage';
import { Icon } from './ui';
import '../styles/home.css';

/**
 * Her world behind every section, deep and out of focus, moving with the tilt: the page reads as one space.
 * Decorative only; the section's own colours stay as they were.
 */
function World({ star }: { star: string }) {
  const portrait = usePortrait();
  const w = mediaFor(`${star}-night`, portrait);
  return w ? <img key={w.id} className="sec-world" src={stillOf(w)} alt="" aria-hidden="true" loading="lazy" decoding="async" draggable={false} /> : null;
}

const d = (k: number, extra?: Record<string, string | number>) => ({ '--d': k, ...extra }) as CSSProperties;

/** Keep every approved 16:9 idle loop framed consistently inside the narrow home-page slats. */
const STAR_SLAT_FACE_X: Partial<Record<StarId, string>> = {
  mahiro: '63%',
  nana: '54%',
  unpai: '64%',
  alice: '57%',
  eimi: '70.5%'
};

function StarsSection({ on, star }: { on: boolean; star: string }) {
  const t = useT();
  const { actions } = useStore();
  const [hover, setHover] = useState<number | null>(null);
  const vertical = verticalName(t.lang);
  return (
    <section id="fp-stars" data-fp="1" className="fp-sec sec-stars" aria-labelledby="h-stars">
      <World star={star} />
      <span className="outline-word" aria-hidden="true">STARS</span>
      <header className="sec-head rise" style={d(0)}>
        <span className="eyebrow">02 — FIRST FIVE</span>
        <h2 id="h-stars" className="sec-title">{t('home.starsTitle')}</h2>
      </header>
      <ul className="slats">
        {CAST.map((c, k) => {
          // The poster and hover motion deliberately share the current approved idle entry. This keeps all five
          // talents on the same visual generation and avoids a still-to-video framing jump.
          const clip = media(`${c.id}-idle-16x9`);
          const still = stillOf(clip);
          const name = starName(c, t.lang);
          return (
            <li key={c.id} className="rise" style={d(k + 1, {
              '--accent': THEME[c.id].accent,
              '--slat-face-x': STAR_SLAT_FACE_X[c.id] ?? '50%'
            })}>
              <Link to={`/stars?star=${c.id}`} className="slat" aria-label={name} onClick={() => actions.setTrialStar(c.id)}
                onPointerEnter={() => setHover(k)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(k)} onBlur={() => setHover(null)}>
                {still && <img className="slat-img" src={still} alt="" loading="lazy" decoding="async" draggable={false} />}
                {on && hover === k && clip && <SceneVideo entry={clip} active className="slat-video" />}
                <span className="slat-no" aria-hidden="true">{String(k + 1).padStart(2, '0')}</span>
                <span className={`slat-name${vertical ? '' : ' h'}`} aria-hidden="true">{name}</span>
                <span className="slat-romaji" aria-hidden="true">{c.romaji}</span>
                <span className="slat-line" aria-hidden="true">{t(`star.${c.id}.line` as Key)}</span>
              </Link>
              <button type="button" className="slat-voice" aria-label={t('stars.voice', { name })} onClick={() => void playVoice(`/voice/greet/${c.id}-welcome.mp3`, true)}>
                <Icon name="speaker" size={16} />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="sec-ctas rise" style={d(6)}><Link to="/stars" className="btn btn-line magnetic">{t('home.starsAll')}</Link></div>
    </section>
  );
}

const STEPS: [string, 'chat' | 'cards' | 'spark' | 'speaker'][] = [['f1', 'chat'], ['f2', 'cards'], ['f3', 'spark'], ['f4', 'speaker']];

const REPLIES = ['trial.q1', 'trial.q2', 'trial.q3'] as const;

function HowSection({ star }: { star: string }) {
  const t = useT();
  const { state, actions } = useStore();
  const member = !!state.user;
  const nav = useNavigate();
  const s = getStar(star);
  const face = stillOf(media(`${star}-hero-9x16`) ?? media(`${star}-breath-9x16`));
  /** A reply opens the conversation with that message already sent (visitors: the trial; members: her chat). */
  const say = (text: string) => {
    if (member) { actions.setStar(star as StarId); nav(`/me/chat?say=${encodeURIComponent(text)}`); }
    else { actions.setTrialStar(star as StarId); nav(`/trial?say=${encodeURIComponent(text)}`); }
  };
  return (
    <section id="fp-how" data-fp="2" className="fp-sec sec-how light" aria-labelledby="h-how">
      <World star={star} />
      <span className="outline-word" aria-hidden="true">HOW TO</span>
      <header className="sec-head rise" style={d(0)}>
        <span className="eyebrow">03 — HOW IT WORKS</span>
        <h2 id="h-how" className="sec-title">{t('home.howTitle')}</h2>
      </header>
      <ol className="steps">
        {STEPS.map(([f, icon], k) => (
          <li key={f} className="step rise" style={d(k + 1)}>
            <span className="step-no" aria-hidden="true">{String(k + 1).padStart(2, '0')}</span>
            <span className="step-icon" aria-hidden="true"><Icon name={icon} size={22} /></span>
            <h3>{t(`${f}.title` as Key)}</h3>
            <p>{t(`${f}.body` as Key)}</p>
          </li>
        ))}
      </ol>
      <div className="sec-ctas rise" style={d(5)}>
        <Link to={member ? '/me/home' : '/pick'} className="btn btn-navy magnetic">{t(member ? 'top.room' : 'features.cta')}</Link>
        <Link to="/features" className="btn btn-ghost">{t('nav.features')}</Link>
      </div>
      <div className="talk rise" style={d(6)} data-testid="talk">
        {face && <img className="talk-face" src={face} alt="" loading="lazy" decoding="async" draggable={false} />}
        <div className="talk-body">
          <span className="tiny talk-who">{t('home.talkTitle', { first: starFirst(s, t.lang) })}</span>
          <p className="msg her talk-line">{t(`star.${star}.line` as Key)}</p>
          <div className="talk-chips" role="group" aria-label={t('trial.suggest')}>
            {REPLIES.map((q) => <button key={q} type="button" className="chip" onClick={() => say(t(q))}>{t(q)}</button>)}
          </div>
        </div>
      </div>
    </section>
  );
}

const TIERS = ['N', 'R', 'SR', 'SSR', 'UR'] as const;
/** One real catalog card per talent, with the rarer tiers in the middle of the fan. */
const FAN_CARD_IDS = ['s1-mahiro-19', 's1-nana-26', 's1-unpai-30', 's1-alice-26', 's1-eimi-19'] as const;

function CardsSection({ star }: { star: string }) {
  const t = useT();
  return (
    <section id="fp-cards" data-fp="3" className="fp-sec sec-cards" aria-labelledby="h-cards">
      <World star={star} />
      <span className="outline-word" aria-hidden="true">GENESIS</span>
      <div className="cards-copy">
        <span className="eyebrow rise" style={d(0)}>04 — STAR GENESIS · FIRST FIVE</span>
        <h2 id="h-cards" className="sec-title rise" style={d(1)}>{t('f2.title')}</h2>
        <p className="sec-body rise" style={d(2)}>{t('f2.body')}</p>
        <ul className="tier-ladder rise" style={d(3)} aria-label={t('home.tiers')}>
          {TIERS.map((tr) => <li key={tr} className={`tier-chip tier-${tr}`}>{tr}</li>)}
        </ul>
        <div className="sec-ctas rise" style={d(4)}>
          <Link to="/gallery" className="btn btn-rose magnetic">{t('nav.cards')}</Link>
          <Link to="/serial" className="btn btn-line">{t('top.serial')}</Link>
        </div>
      </div>
      <div className="fan-wrap">
      <ul className="fan" aria-hidden="true">
        {CAST.map((c, k) => {
          const card = CARD_BY_ID[FAN_CARD_IDS[k]];
          if (!card) return null;
          return (
            <li key={c.id} className="fan-slot rise" style={d(k + 2, { '--k': k - 2 })}>
              <div className="cover-card tilt">
                <CardTile card={card} small />
                <i className="cardx-glare" />
              </div>
            </li>
          );
        })}
      </ul>
      </div>
    </section>
  );
}

function NewsSection({ onPv, star }: { onPv: () => void; star: string }) {
  const t = useT();
  // #61: from the shared calendar, loaded after the first paint (it stays out of the entry bundle).
  const events = useEvents();
  const pvStill = stillOf(media('mahiro-hero-16x9') ?? media('mahiro-hero-9x16'), true);
  return (
    <section id="fp-news" data-fp="4" className="fp-sec sec-news light" aria-labelledby="h-news">
      <World star={star} />
      <span className="outline-word" aria-hidden="true">News</span>
      <button type="button" className="pv-tile rise tilt" style={d(1)} onClick={onPv} aria-label={t('home.pv')}>
        {pvStill && <img src={pvStill} alt="" loading="lazy" decoding="async" draggable={false} />}
        <span className="pv-tile-play" aria-hidden="true"><Icon name="play" size={22} /></span>
        <span className="pv-tile-cap" aria-hidden="true"><b>PROMOTION VIDEO</b>First Five</span>
      </button>
      <div className="news-list">
        <span className="eyebrow rise" style={d(0)}>05 — NEWS</span>
        <h2 id="h-news" className="sec-title rise" style={d(1)}>{t('nav.events')}</h2>
        <ul className="rise" style={d(2)}>
          {events.slice(0, 4).map((e) => (
            <li key={e.id}>
              <Link to="/events">
                <span className={`badge ${EVENT_BADGE[eventStatus(e)].cls}`}>{t(EVENT_BADGE[eventStatus(e)].key)}</span>
                <span className="news-t">{localText(e.title, t.lang)}</span>
                <time className="tiny" dateTime={e.startsAt}>{fmtDate(e.startsAt, t.lang)}</time>
              </Link>
            </li>
          ))}
        </ul>
        <Link to="/events" className="btn-text rise" style={d(3)}>{t('home.newsAll')}</Link>
      </div>
    </section>
  );
}

export default function HomeSections({ active, star, onReady, onPv }: { active: number; star: string; onReady: () => void; onPv: () => void }) {
  useEffect(() => { onReady(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <StarsSection on={active === 1} star={star} />
      <HowSection star={star} />
      <CardsSection star={star} />
      <NewsSection onPv={onPv} star={star} />
      <Footer />
    </>
  );
}
