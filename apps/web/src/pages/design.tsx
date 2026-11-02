/**
 * /#/design — the JSTAR visual system v1 reference (#162): every token and component, on light and on the night,
 * as the baseline of the visual regression (tests/e2e/design.spec.ts). Test and demo sites and the prototype only;
 * production shows its 404. Lazy: never in the entry bundle. Documented in docs/design-system.md.
 */
import { useState, type ReactNode } from 'react';
import { isDemo, serverMode } from '../services/api';
import {
  BrandMark, BtnLine, BtnRose, CornerFrame, HairlineInput, Hint, NightFade, Panel, PrintPhoto, ReplyChoice, RuleCounter, Sparkles,
  SpacedLabel, StarRuleSwitcher, VerticalName, Waveform
} from '../system';
import './design.css';

const COLOURS = ['navy', 'navy-deep', 'night', 'rose', 'rose-text', 'ivory', 'mist', 'mist-deep', 'surface', 'bubble', 'hair', 'soft', 'ok', 'err', 'iv-meta', 'iv-line', 'iv-hair'] as const;
const TYPE = [
  ['--fs-label', '11 · HER ROOM 01 / 05', 'label'], ['--fs-meta', '12 · 10/1 23:50 · 東京・晴', 'meta'], ['--fs-small', '13 · 小字', 'sans'],
  ['--fs-body', '15 · 本文、回覆、輸入（≥14px）', 'sans'], ['--fs-ui', '17 · ✦ JSTAR、主要按鈕', 'serif'], ['--fs-line', '18.5 · 「呵呵，你來了呀……」', 'serif'],
  ['--fs-name', '27 · 唯井真尋', 'serif']
] as const;
const SPACE = ['--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5', '--sp-6', '--sp-8', '--sp-10'] as const;
const BARS = [8, 14, 20, 12, 24, 16, 10, 22, 18, 12, 24, 14, 8, 18, 22, 10, 16, 6];
const FIVE = [{ id: 'mahiro', label: '真尋' }, { id: 'nana', label: '奈奈' }, { id: 'unpai', label: 'Unpai' }, { id: 'alice', label: '愛麗絲' }, { id: 'eimi', label: '詠美' }];
const STILL = '/media/mahiro-hero-16x9/poster.jpg';

function Section({ id, title, en, children }: { id: string; title: string; en: string; children: ReactNode }) {
  return (
    <section className="ds-sec" aria-labelledby={`ds-${id}`}>
      <h2 id={`ds-${id}`}><SpacedLabel light>{en}</SpacedLabel><span>{title}</span></h2>
      {children}
    </section>
  );
}

/** A piece of the night: her still, the night fade, and what sits on it. */
function Night({ children, variant, h = 220 }: { children: ReactNode; variant?: 'room' | 'pure' | 'morning' | 'index' | 'desk'; h?: number }) {
  return (
    <div className="ds-night" style={{ minHeight: h }}>
      <img className="ds-still" src={STILL} alt="" decoding="async" />
      <NightFade variant={variant} />
      <div className="ds-night-body">{children}</div>
    </div>
  );
}

export default function DesignPage() {
  const [star, setStar] = useState('mahiro');
  const [text, setText] = useState('');
  const [playing, setPlaying] = useState(false);
  if (serverMode() && !isDemo()) {
    return <main className="page"><p className="pad" style={{ padding: 40 }}>404</p></main>;
  }
  return (
    <main className="ds" data-testid="design-page">
      <header className="ds-head">
        <BrandMark />
        <h1>視覺系統 v1<small>JSTAR VISUAL SYSTEM</small></h1>
        <p>她的房間 A2「夜畫廊」與首頁共用的 tokens 與元件。內容優先，她的臉永不被遮，玫瑰色只給主要動作與 ✦。文件：docs/design-system.md。</p>
      </header>

      <Section id="colour" title="顏色" en="COLOUR">
        <ul className="ds-swatches">
          {COLOURS.map((c) => (
            // The night's ivories on navy-deep, as they are used.
            <li key={c}><i style={{ background: c.startsWith('iv-') ? `linear-gradient(var(--${c}), var(--${c})), var(--navy-deep)` : `var(--${c})` }} /><b>--{c}</b></li>
          ))}
        </ul>
        <div className="ds-fades">
          {(['room', 'pure', 'morning', 'index'] as const).map((v) => (
            <figure key={v}><Night variant={v} h={180}><span /></Night><figcaption>night-fade · {v}</figcaption></figure>
          ))}
        </div>
      </Section>

      <Section id="type" title="字體與字級" en="TYPE">
        <ul className="ds-type">
          {TYPE.map(([token, sample, face]) => (
            <li key={token}><code>{token}</code><span className={`ds-type-${face}`} style={{ fontSize: `var(${token})` }}>{sample}</span></li>
          ))}
        </ul>
        <p className="ds-note">--serif Shippori Mincho（她的話、名字、標籤）· --sans Zen Kaku Gothic New（介面）· 繁中標點用繁中字型：「，。……」</p>
      </Section>

      <Section id="space" title="間距、圓角、細線、動效" en="SPACE · SHAPE · MOTION">
        <ul className="ds-space">{SPACE.map((s) => <li key={s}><i style={{ width: `var(${s})` }} /><code>{s}</code></li>)}</ul>
        <div className="ds-shapes">
          <span className="ds-shape" style={{ borderRadius: 'var(--r-sharp)' }}>--r-sharp 2px</span>
          <span className="ds-shape" style={{ borderRadius: 'var(--r-chip)' }}>--r-chip 18px</span>
          <span className="ds-shape hair">--hairline 1px</span>
          <span className="ds-shape">--ease · --dur 280ms</span>
        </div>
      </Section>

      <Section id="brand" title="品牌與名字" en="BRAND · NAME">
        <Night h={260}>
          <CornerFrame style={{ left: 14, top: 14 }} />
          <div className="ds-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div className="ds-stack">
              <BrandMark />
              <SpacedLabel>HER ROOM　01 / 05</SpacedLabel>
              <SpacedLabel meta dot>通話中 00:12</SpacedLabel>
              <SpacedLabel meta>10/1　23:50　東京・晴　<span className="js-spark">♥</span> 第1天</SpacedLabel>
            </div>
            <VerticalName name="唯井真尋" romaji="Mahiro Tadai" />
          </div>
          <Sparkles />
        </Night>
      </Section>

      <Section id="buttons" title="按鈕與回覆" en="BUTTONS · REPLIES">
        <Night h={250}>
          <p className="js-line">「呵呵，你來了呀……今天也是夜貓子呢。」<span className="js-more">▼</span></p>
          <div className="js-replies"><ReplyChoice>我回來了</ReplyChoice><ReplyChoice>有點累</ReplyChoice><ReplyChoice>想聽你的聲音</ReplyChoice></div>
          <div className="js-replies"><ReplyChoice hot>✦ 來猜拳</ReplyChoice><ReplyChoice plain>下次吧</ReplyChoice></div>
          <div className="js-replies column" style={{ maxWidth: 360 }}><ReplyChoice index={1}>我回來了</ReplyChoice><ReplyChoice index={2}>有點累</ReplyChoice></div>
        </Night>
        <div className="ds-row ds-light">
          <BtnRose large>接聽</BtnRose>
          <BtnLine light>再睡5分鐘</BtnLine>
          <button type="button" className="btn btn-rose" style={{ padding: '0 24px' }}>.btn-rose（首頁）</button>
          <button type="button" className="btn btn-line" style={{ padding: '0 24px' }}>.btn-line（首頁）</button>
        </div>
      </Section>

      <Section id="input" title="髮絲線輸入" en="INPUT">
        <Night h={120}>
          <HairlineInput placeholder="用自己的話說…" aria-label="訊息" value={text} onChange={(e) => setText(e.target.value)} meta="聲音 剩10分"
            after={<button type="button" className="js-icon-btn" aria-label="語音輸入"><svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><rect x="7" y="2.5" width="6" height="10" rx="3" /><path d="M4 9.5a6 6 0 0 0 12 0M10 15.5v2.5" /></svg></button>} />
        </Night>
      </Section>

      <Section id="switcher" title="五人切換與計數" en="SWITCHER">
        <Night variant="index" h={200}>
          <div className="ds-row" style={{ justifyContent: 'space-between' }}><SpacedLabel>FIRST FIVE　01 / 05</SpacedLabel><SpacedLabel meta>換人</SpacedLabel></div>
          <StarRuleSwitcher items={FIVE} active={star} onPick={setStar} label="切換角色" />
          <SpacedLabel>WHILE YOU WERE AWAY　01 / 03</SpacedLabel>
          <RuleCounter n={3} at={0} />
        </Night>
      </Section>

      <Section id="media" title="照片與語音" en="PRINT · VOICE">
        <Night h={200}>
          <div className="ds-row" style={{ alignItems: 'center', gap: 18 }}>
            <PrintPhoto src={STILL} alt="她的照片" />
            <div style={{ flex: 1, minWidth: 200 }}>
              <Waveform bars={BARS} progress={playing ? 0.4 : 0.33} time="0:02 / 0:06" playing={playing} onPlay={() => setPlaying((p) => !p)} label="播放她的語音" />
            </div>
          </div>
        </Night>
      </Section>

      <Section id="panels" title="面板與提示" en="PANEL · HINT">
        <Night h={200}>
          <Panel><SpacedLabel>NEXT PROMISE</SpacedLabel><p className="ds-p">10/2 23:00　晚上9點，在這裡見</p></Panel>
          <Hint>她喜歡熱可可 · 送禮物</Hint>
        </Night>
        <div className="ds-light ds-stack" style={{ padding: 16 }}>
          <Panel light><SpacedLabel light>LIGHT PANEL</SpacedLabel><p className="ds-p">淺色地上的雙細線面板。</p></Panel>
          <Hint light>淺色提示條</Hint>
        </div>
      </Section>

      <Section id="rules" title="可讀性與反例" en="RULES">
        <ul className="ds-rules">
          <li><b>她的臉永不被遮。</b>畫面中段完全透明，字只浮在下半的夜色上。</li>
          <li><b>對比 AA，正文 ≥14px。</b>文字放在夜色漸層上，不靠毛玻璃卡片。</li>
          <li><b>玫瑰色只給主要動作與 ✦。</b>一個畫面一個玫瑰色實心塊。</li>
          <li><b>近直角與細線。</b>不用大圓角膠囊、不用表情符號圖示、不用紫色漸層、不用霓虹。</li>
        </ul>
      </Section>
    </main>
  );
}
