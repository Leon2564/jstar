/**
 * L15: a guest on a phone is told, once, that JSTAR can live on the home screen (A2 sheet, dismissible). Android and
 * Chrome get the browser's own install prompt (captured in main.tsx); iOS, which has none, gets the Safari steps.
 * Shown once per device, never in the installed app. Its own lazy chunk; its few words are kept here, in the four
 * languages, so they never weigh on the entry bundle's dictionary (tests/unit/guestUx.test.tsx checks them).
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Lang } from '../i18n';
import { isIos } from '../lib/push';
import { useT } from '../lib/store';
import { Icon } from './ui';
import './gift.css';

type Words = { title: string; body: string; ios: string; cta: string };
export const INSTALL_WORDS: Record<Lang, Words> = {
  ja: { title: 'ホーム画面に追加', body: 'アプリのようにワンタップで開けて、彼女からの通知も受け取れます。', ios: 'Safariの共有ボタンをタップして、「ホーム画面に追加」を選んでください。', cta: '追加する' },
  'zh-Hant': { title: '加到主畫面', body: '像 App 一樣一鍵打開，也能收到她傳來的通知。', ios: '點 Safari 下方的分享按鈕，再選「加入主畫面」。', cta: '加入主畫面' },
  en: { title: 'Add JSTAR to your home screen', body: 'Open it like an app in one tap, and get her messages as notifications.', ios: 'Tap the Share button in Safari, then choose "Add to Home Screen".', cta: 'Install' },
  ko: { title: '홈 화면에 추가', body: '앱처럼 한 번에 열 수 있고, 그녀의 알림도 받을 수 있어요.', ios: 'Safari의 공유 버튼을 누른 뒤 "홈 화면에 추가"를 선택하세요.', cta: '추가하기' }
};

type InstallEvent = Event & { prompt: () => Promise<void> };
const stashed = () => (window as unknown as { __jstarInstall?: InstallEvent }).__jstarInstall;

export default function InstallHint() {
  const t = useT();
  const w = INSTALL_WORDS[t.lang] ?? INSTALL_WORDS.en;
  const ios = isIos();
  const [open, setOpen] = useState(() => ios || !!stashed());
  // Android / Chrome may announce installability a little later than the page: the sheet waits for it.
  useEffect(() => {
    if (open) return;
    const on = () => setOpen(true);
    window.addEventListener('jstar-installable', on);
    return () => window.removeEventListener('jstar-installable', on);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    try { localStorage.setItem('jstar.installHint', String(Date.now())); } catch { /* storage blocked: it may show again */ }
  }, [open]);
  // A-L15: Esc closes it, like the other sheets.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  const close = () => setOpen(false);
  const install = async () => {
    const e = stashed();
    close();
    try { await e?.prompt(); } catch { /* dismissed or no longer allowed */ }
  };
  // The same A2 night sheet as her notification offer (components/pushOffer.tsx, gift.css's `call` sheet).
  return createPortal(
    <div role="dialog" aria-modal="true" aria-labelledby="install-h" className="gift-backdrop call" data-testid="install-hint" onClick={close}>
      <div className="panel gift-sheet call" onClick={(e) => e.stopPropagation()}>
        <div className="gift-head">
          <h2 id="install-h">{w.title}</h2>
          <button type="button" className="round" onClick={close} aria-label={t('common.close')}><Icon name="close" size={18} /></button>
        </div>
        <p className="small" style={{ margin: 0 }}>{w.body}</p>
        {ios
          ? <p className="small" style={{ margin: 0, color: 'var(--iv-meta)' }}>{w.ios}</p>
          : <button type="button" className="btn btn-rose" onClick={() => void install()}>{w.cta}</button>}
        <button type="button" className="btn-text" onClick={close}>{t('push.later')}</button>
      </div>
    </div>,
    document.body
  );
}
