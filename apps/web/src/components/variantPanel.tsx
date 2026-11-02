/**
 * Her variant card on its card page (#76): "another her" and how close he is with her — a bar over the ten levels,
 * her four scenes (1 / 3 / 6 / 10) open or still locked, and a line for what comes next in her words, never the XP
 * behind it. From level 10 he may keep her in this look on her home (the pin; server mode only).
 *
 * Laid out for a 375px phone in all four languages: every row wraps rather than overflows (min-width 0, the status
 * never shrinks, labels break anywhere), and the pin button's label may take two lines.
 */
import { useState } from 'react';
import type { StarId } from '@jstar/shared/domain';
import { VARIANT_RULES } from '@jstar/shared/rules';
import { VARIANT_MAX_LEVEL, canPinHome, variantState } from '@jstar/shared/variants';
import { getStar } from '../data/cast';
import { starFirst, type Key } from '../i18n';
import { useStore, useT } from '../lib/store';
import { pinVariantHome, serverMode } from '../services/api';
import { Icon, Toast, useToast } from './ui';

export function VariantPanel({ cardId, star }: { cardId: string; star: StarId }) {
  const { state, actions } = useStore();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useToast();
  const v = state.variants[cardId] ?? variantState(null);
  const first = starFirst(getStar(star), t.lang);
  // Level 1 of 10 shows a tenth; the way to the next level fills the rest of its tenth.
  const fill = Math.min(1, (v.level + (v.level >= VARIANT_MAX_LEVEL ? 0 : v.progress)) / VARIANT_MAX_LEVEL);
  const canPin = serverMode() && canPinHome(v.level);

  async function togglePin() {
    if (busy) return;
    setBusy(true);
    try {
      actions.setVariant(await pinVariantHome(cardId, !v.pinned));
    } catch {
      setToast(t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel stack" style={{ margin: '18px 24px 0', gap: 10 }} data-testid="variant-panel" aria-label={t('cd.variant.title', { first })}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '2px 12px', fontSize: 13 }}>
        <span className="serif" style={{ minWidth: 0, overflowWrap: 'anywhere', fontWeight: 600 }}>{t('cd.variant.title', { first })}</span>
        <span data-testid="variant-level">{t('cd.variant.level', { n: v.level, max: VARIANT_MAX_LEVEL })}</span>
      </div>
      <span className="track" role="progressbar" aria-label={t('cd.variant.bar')} aria-valuemin={1} aria-valuemax={VARIANT_MAX_LEVEL} aria-valuenow={v.level}>
        <i style={{ width: `${Math.round(fill * 100)}%` }} />
      </span>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="variant-layers">
        {VARIANT_RULES.layerLevels.map((layer) => {
          const open = v.layers.includes(layer);
          return (
            <li key={layer} data-layer={layer} data-open={open} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 13, minWidth: 0 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {!open && <Icon name="lock" size={16} />}
                <span style={{ overflowWrap: 'anywhere' }}>{t(`cd.variant.layer${layer}` as Key)}</span>
              </span>
              <span className="small muted" style={{ flexShrink: 0 }}>{open ? t('cd.unlocked') : t('cd.variant.locked')}</span>
            </li>
          );
        })}
      </ul>
      <p className="tiny muted" style={{ margin: 0 }} data-testid="variant-hint">{v.nextLayer === null ? t('cd.variant.all', { first }) : t('cd.variant.next', { first })}</p>
      {canPin && (
        <>
          {v.pinned && <p className="tiny" style={{ margin: 0 }} data-testid="variant-pinned">{t('cd.variant.pinned', { first })}</p>}
          <button type="button" className="btn btn-ghost" aria-pressed={v.pinned} disabled={busy} onClick={() => void togglePin()} data-testid="variant-pin"
            style={{ minHeight: 44, fontSize: 13, alignSelf: 'flex-start', maxWidth: '100%', whiteSpace: 'normal', lineHeight: 1.4, padding: '6px 16px' }}>
            {v.pinned ? t('cd.variant.unpin') : t('cd.variant.pin')}
          </button>
        </>
      )}
      <Toast msg={toast} />
    </section>
  );
}
