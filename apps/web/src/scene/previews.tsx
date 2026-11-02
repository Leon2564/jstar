/**
 * Scene previews: `/me/preview`, for the owner on the test site. The five scenes (#66–#70) and her variant scenes
 * (#76) are reviewed and published (#84), but by the publish rule production plays a scene only once all its clips
 * exist (#80, #81); until then they are demo-only. Here each one plays as written, judged by the server, with her
 * existing clips standing in for the pending ones — and says so on screen.
 *
 * The list comes from the API (demo mode only; 404 in production). Prototype mode has no server to judge the games,
 * so it says the page needs the test site.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { localText } from '@jstar/shared/domain';
import type { ScenePreviewItemT } from '@jstar/shared/contracts';
import { getStar } from '../data/cast';
import { starName, type Key } from '../i18n';
import { useT } from '../lib/store';
import { http, serverMode } from '../services/http';
import { isDemo } from '../services/api';
import { Header, Icon, TabBar } from '../components/ui';
import '../system/system.css';

/** N-27: the mini-games by their names, never their ids. */
const GAMES = new Set(['rps', 'praise', 'danmaku', 'bargain', 'ogiri']);

export default function ScenePreviews() {
  const t = useT();
  const usable = serverMode() && isDemo();
  /** undefined while loading; null when it could not be loaded. */
  const [list, setList] = useState<ScenePreviewItemT[] | null | undefined>(usable ? undefined : null);
  useEffect(() => {
    if (!usable) return;
    let live = true;
    http.scenePreviews().then((r) => { if (live) setList(r.scenes); }, () => { if (live) setList(null); });
    return () => { live = false; };
  }, [usable]);

  const waiting = list === undefined || list === null || list.some((s) => s.pending.length > 0);
  return (
    <div className="page member js-nightpage">
      {/* N-18: 「撮影待ち」 only while some scene still waits for a clip; live scenes are previews, nothing more. */}
      <Header back="/me/home" title={t(waiting ? 'scene.previewList' : 'scene.previewListLive')} />
      <div className="col pad stack" data-testid="scene-previews">
        <p className="small" style={{ margin: 0 }} data-testid="scene-previews-note">{t(waiting ? 'scene.previewNote' : 'scene.previewNoteLive')}</p>
        {list === undefined && <p role="status" className="small muted">{t('scene.loading')}</p>}
        {list === null && <p role="status" className="small muted" data-testid="scene-previews-off">{t('scene.previewNone')}</p>}
        {list && (
          <ul className="rowlist">
            {list.map((s) => (
              <li key={s.id}>
                <Link to={`/me/scene/${s.id}?preview=1`} data-testid={`preview-${s.id}`}>
                  <span className="serif"><span className="small muted" style={{ display: 'block' }}>{starName(getStar(s.star), t.lang)}</span>{localText(s.title, t.lang)}
                    {s.pending.length > 0 && <span className="tiny muted" style={{ display: 'block' }} data-testid={`preview-pending-${s.id}`}>{t('scene.previewPending', { n: s.pending.length })}</span>}</span>
                  <span className="small muted" style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>{s.games.map((g) => (GAMES.has(g) ? t(`scene.game.${g}` as Key) : g)).join(' · ')}<Icon name="chev" size={14} /></span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <TabBar />
    </div>
  );
}
