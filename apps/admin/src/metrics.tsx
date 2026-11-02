import { useEffect, useState } from 'react';
import { LAUNCH_LANGS, TRIGGER_SOURCES, TRIGGER_SOURCE_TARGET, addDays, type AdminMetricsResT, type MetricsCountsT, type MetricsGrainT, type TriggerSource } from '@jstar/shared';
import { api } from './api';

/**
 * 指標 (#52): the v1.1 success metrics (#47). The rest of the admin is English-only; this page is read by the
 * product owner and the agency too, so it carries its own strings in the three launch languages. Japanese is the
 * source; the other two must have the same keys (the type below enforces it).
 */
const ja = {
  title: '指標',
  hint: 'v1.1 の成功指標（#47）。サーバーが記録したイベントだけで集計します。会話の本文は含まず、180 日で削除されます。',
  byDay: '日別', byWeek: '週別', range: '期間', days: '{n} 日', lang: '表示言語',
  loading: '読み込み中…', error: '読み込めませんでした：', whole: '期間全体',
  empty: 'この期間にはまだイベントがありません。告白・目覚まし・約束・シーン・変体カードの各機能が記録を始めると、ここに数字が出ます。',
  confession: '告白到達率', confessionDef: 'この期間に初めて来たユーザーのうち、告白まで進んだ割合',
  alarm: '目覚まし設定率', alarmDef: 'この期間のアクティブユーザー（何か操作した人）のうち、目覚ましを設定している割合',
  promise: '約束の再訪率', promiseDef: '期限が来た約束のうち、戻ってきて果たされた割合',
  scenes: '入室あたりのシーン', scenesDef: 'シーンが始まった回数 ÷ 彼女の部屋に入った回数',
  variant: '変体カード転化', variantDef: '勧められた → 引いた → 引いた日に着替えシーンを開いた',
  prompted: '勧誘', drew: '抽選', opened: 'シーン',
  sources: 'シーンの発生元', sourcesDef: '目標はリクエスト 40%・彼女から 30%・時間イベント 30%',
  request: 'リクエスト', proposed: '彼女から', time: '時間イベント', actual: '実績', target: '目標',
  retention: '7 日後の定着', retentionDef: '最初の 7 日間にシーンを起こしたユーザーと会話だけのユーザーで、8〜14 日目に戻ってきた割合',
  sceneUsers: 'シーンあり', chatOnly: '会話のみ', gap: '差',
  period: '期間', colNew: '新規', colScenes: 'シーン/入室', colSources: '依頼/彼女/時間',
  maturing: '集計中', maturingHint: '「集計中」の行は初回から 14 日たっておらず、定着と告白の数字はまだ伸びます。'
};
type Strings = typeof ja;
const STRINGS: Record<(typeof LAUNCH_LANGS)[number], Strings> = {
  ja,
  'zh-Hant': {
    title: '指標',
    hint: 'v1.1 的成功指標（#47）。只用伺服器記錄的事件統計，不含聊天內容，180 天後刪除。',
    byDay: '按天', byWeek: '按週', range: '期間', days: '{n} 天', lang: '顯示語言',
    loading: '載入中…', error: '無法載入：', whole: '整個期間',
    empty: '這段期間還沒有事件。告白、鬧鐘、約定、場景、變體卡等功能開始記錄後，數字會出現在這裡。',
    confession: '告白到達率', confessionDef: '這段期間首次出現的使用者中，走到告白的比例',
    alarm: '鬧鐘設定率', alarmDef: '這段期間的活躍使用者（有任何操作的人）中，設定過叫醒鬧鐘的比例',
    promise: '約定兌現回訪率', promiseDef: '到期的約定中，他回來兌現的比例',
    scenes: '每次進房的場景', scenesDef: '場景觸發次數 ÷ 進入她房間的次數',
    variant: '變體卡轉化', variantDef: '被引導 → 抽卡 → 抽到當天進入換裝場景',
    prompted: '引導', drew: '抽卡', opened: '場景',
    sources: '場景觸發來源', sourcesDef: '目標：請求 40%、她主動 30%、時間事件 30%',
    request: '請求', proposed: '她主動', time: '時間事件', actual: '實際', target: '目標',
    retention: '7 日留存', retentionDef: '前 7 天觸發過場景的使用者與只聊天的使用者，第 8–14 天回來的比例',
    sceneUsers: '有場景', chatOnly: '只聊天', gap: '差距',
    period: '期間', colNew: '新使用者', colScenes: '場景/進房', colSources: '請求/她/時間',
    maturing: '統計中', maturingHint: '標示「統計中」的列距首次出現不到 14 天，留存與告白的數字還會增加。'
  },
  en: {
    title: 'Metrics',
    hint: 'The v1.1 success metrics (#47), counted only from events the server records. No chat text; deleted after 180 days.',
    byDay: 'By day', byWeek: 'By week', range: 'Range', days: '{n} days', lang: 'Language',
    loading: 'Loading…', error: 'Could not load: ', whole: 'Whole range',
    empty: 'No events in this range yet. Numbers appear here once the confession, alarm, promise, scene and variant-card features start recording.',
    confession: 'Confession reach', confessionDef: 'Of users first seen in the period, the share who reached her confession',
    alarm: 'Alarm set rate', alarmDef: 'Of the users active in the period (any event), the share who have set a wake-up alarm',
    promise: 'Promise-kept revisits', promiseDef: 'Of promises that came due, the share he came back to keep',
    scenes: 'Scenes per room entry', scenesDef: 'Scenes started ÷ times her room was opened',
    variant: 'Variant conversion', variantDef: 'Prompted → drew → opened its scene the day he drew it',
    prompted: 'prompted', drew: 'drew', opened: 'scene',
    sources: 'Scene trigger sources', sourcesDef: 'Target: request 40%, she proposed 30%, time event 30%',
    request: 'Request', proposed: 'She proposed', time: 'Time event', actual: 'Actual', target: 'Target',
    retention: '7-day retention', retentionDef: 'Users who triggered a scene in their first 7 days vs chat-only users: share who came back on days 8–14',
    sceneUsers: 'Scene users', chatOnly: 'Chat only', gap: 'Gap',
    period: 'Period', colNew: 'New', colScenes: 'Scenes/entry', colSources: 'Req/She/Time',
    maturing: 'filling in', maturingHint: 'Rows marked “filling in” are less than 14 days old: retention and confession will still rise.'
  }
};
const LANG_NAMES: Record<keyof typeof STRINGS, string> = { ja: '日本語', 'zh-Hant': '繁體中文', en: 'English' };
const LANG_KEY = 'jstar.admin.lang';
const RANGES = [14, 28, 56, 84, 180];
const SOURCE_COLORS: Record<TriggerSource, string> = { request: 'var(--rose)', proposed: 'var(--ok)', time: 'var(--sky)' };

function initialLang(): keyof typeof STRINGS {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved && saved in STRINGS) return saved as keyof typeof STRINGS;
  } catch { /* storage blocked: fall back to the browser language */ }
  const nav = navigator.language.toLowerCase();
  return nav.startsWith('ja') ? 'ja' : nav.startsWith('zh') ? 'zh-Hant' : 'en';
}

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');
const ratio = (n: number, d: number) => (d > 0 ? (n / d).toFixed(2) : '—');
const gapPt = (c: MetricsCountsT) =>
  c.sceneUsers > 0 && c.chatOnlyUsers > 0 ? `${Math.round((c.sceneRetained / c.sceneUsers - c.chatOnlyRetained / c.chatOnlyUsers) * 100)} pt` : '—';
const isEmpty = (c: MetricsCountsT) =>
  !c.newUsers && !c.activeUsers && !c.roomEntries && !c.sceneTriggers && !c.promisesDue && !c.variantPrompted;
const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

export function Metrics() {
  const [lang, setLang] = useState(initialLang);
  const [grain, setGrain] = useState<MetricsGrainT>('day');
  const [days, setDays] = useState(28);
  const [data, setData] = useState<AdminMetricsResT | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const t = STRINGS[lang];

  useEffect(() => {
    let live = true;
    setErr(null);
    api<AdminMetricsResT>(`/v1/admin/metrics?grain=${grain}&days=${days}`)
      .then((r) => { if (live) setData(r); })
      .catch((e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [grain, days]);

  const chooseLang = (l: keyof typeof STRINGS) => {
    setLang(l);
    try { localStorage.setItem(LANG_KEY, l); } catch { /* the choice just is not remembered */ }
  };
  // Cohort numbers of the last 14 days are still growing (retention looks at day 7–13 after the first visit).
  const maturingFrom = data ? addDays(data.asOf, -13) : '';
  const total = data?.total;

  return (
    <section lang={lang} className="metrics">
      <h2>{t.title}</h2>
      <p className="hint">{t.hint}</p>
      <div className="controls">
        <div className="seg" role="group" aria-label={t.period}>
          <button aria-pressed={grain === 'day'} onClick={() => setGrain('day')}>{t.byDay}</button>
          <button aria-pressed={grain === 'week'} onClick={() => setGrain('week')}>{t.byWeek}</button>
        </div>
        <label>{t.range}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {RANGES.map((n) => <option key={n} value={n}>{t.days.replace('{n}', String(n))}</option>)}
          </select>
        </label>
        <label>{t.lang}
          <select value={lang} onChange={(e) => chooseLang(e.target.value as keyof typeof STRINGS)}>
            {LAUNCH_LANGS.map((l) => <option key={l} value={l}>{LANG_NAMES[l]}</option>)}
          </select>
        </label>
      </div>

      {err && <p className="err">{t.error}{err}</p>}
      {!data && !err && <p className="hint">{t.loading}</p>}
      {data && total && (
        <>
          <p className="hint">{t.whole}: {data.from} – {data.to}</p>
          {isEmpty(total) && <p className="card">{t.empty}</p>}
          <div className="tiles">
            <Tile label={t.confession} def={t.confessionDef} value={pct(total.confessed, total.newUsers)} sub={`${total.confessed} / ${total.newUsers}`} />
            <Tile label={t.alarm} def={t.alarmDef} value={pct(total.alarmSet, total.activeUsers)} sub={`${total.alarmSet} / ${total.activeUsers}`} />
            <Tile label={t.promise} def={t.promiseDef} value={pct(total.promisesKept, total.promisesDue)} sub={`${total.promisesKept} / ${total.promisesDue}`} />
            <Tile label={t.scenes} def={t.scenesDef} value={ratio(total.sceneTriggers, total.roomEntries)} sub={`${total.sceneTriggers} / ${total.roomEntries}`} />
            <Tile label={t.variant} def={t.variantDef} value={pct(total.variantSceneOpened, total.variantPrompted)}
              sub={`${t.prompted} ${total.variantPrompted} → ${t.drew} ${total.variantDrawn} → ${t.opened} ${total.variantSceneOpened}`} />
          </div>

          <div className="panels">
            <div className="card">
              <h3>{t.sources}</h3>
              <p className="hint">{t.sourcesDef}</p>
              <SourceBar label={t.actual} counts={total.triggerSources} />
              <SourceBar label={t.target} counts={TRIGGER_SOURCE_TARGET} />
              <p className="legend">
                {TRIGGER_SOURCES.map((s) => <span key={s}><i style={{ background: SOURCE_COLORS[s] }} />{t[s]} {pct(total.triggerSources[s], total.sceneTriggers)}</span>)}
              </p>
            </div>
            <div className="card">
              <h3>{t.retention}</h3>
              <p className="hint">{t.retentionDef}</p>
              <Meter label={t.sceneUsers} n={total.sceneRetained} d={total.sceneUsers} color="var(--rose)" />
              <Meter label={t.chatOnly} n={total.chatOnlyRetained} d={total.chatOnlyUsers} color="var(--muted)" />
              <p><strong>{t.gap}: {gapPt(total)}</strong></p>
            </div>
          </div>

          <p className="hint">{t.maturingHint}</p>
          <div className="scroll">
            <table className="metrics-table">
              <thead>
                <tr>
                  <th>{t.period}</th><th>{t.colNew}</th><th>{t.confession}</th><th>{t.alarm}</th><th>{t.promise}</th>
                  <th>{t.colScenes}</th><th>{t.variant}</th><th>{t.colSources}</th><th>{t.retention} ({t.gap})</th>
                </tr>
              </thead>
              <tbody>
                {data.periods.slice().reverse().map((p) => {
                  const maturing = (data.grain === 'week' ? addDays(p.period, 6) : p.period) >= maturingFrom;
                  return (
                  <tr key={p.period}>
                    <td>
                      {shortDay(p.period)}{data.grain === 'week' ? '〜' : ''}
                      {maturing && <small className="tag">{t.maturing}</small>}
                    </td>
                    <td>{p.newUsers}</td>
                    <td>{pct(p.confessed, p.newUsers)}</td>
                    <td>{pct(p.alarmSet, p.activeUsers)}</td>
                    <td>{pct(p.promisesKept, p.promisesDue)}</td>
                    <td>{ratio(p.sceneTriggers, p.roomEntries)}</td>
                    <td>{pct(p.variantSceneOpened, p.variantPrompted)}</td>
                    <td>{p.sceneTriggers ? TRIGGER_SOURCES.map((s) => pct(p.triggerSources[s], p.sceneTriggers)).join(' / ') : '—'}</td>
                    {/* Nobody in a young cohort can have come back on day 7–13 yet: a gap there would read as a real 0. */}
                    <td>{maturing ? '—' : gapPt(p)}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Tile({ label, def, value, sub }: { label: string; def: string; value: string; sub: string }) {
  return (
    <div className="tile" title={def}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <div className="tile-sub">{sub}</div>
      <div className="tile-def">{def}</div>
    </div>
  );
}

/** One stacked bar of the three sources; widths are shares of the row's total, so actual and target line up. */
function SourceBar({ label, counts }: { label: string; counts: Record<TriggerSource, number> }) {
  const sum = TRIGGER_SOURCES.reduce((n, s) => n + counts[s], 0);
  return (
    <div className="bar-row">
      <span>{label}</span>
      <div className="bar">
        {sum > 0 ? TRIGGER_SOURCES.map((s) => <i key={s} style={{ width: `${(counts[s] / sum) * 100}%`, background: SOURCE_COLORS[s] }} />) : <em>—</em>}
      </div>
    </div>
  );
}

function Meter({ label, n, d, color }: { label: string; n: number; d: number; color: string }) {
  return (
    <div className="bar-row">
      <span>{label}</span>
      <div className="bar">{d > 0 ? <i style={{ width: `${(n / d) * 100}%`, background: color }} /> : <em>—</em>}</div>
      <b>{pct(n, d)} <small>({n}/{d})</small></b>
    </div>
  );
}
