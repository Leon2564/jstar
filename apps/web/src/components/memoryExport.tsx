/**
 * 思い出 → export (#51): his memories are his. One button saves everything he has with them as a JSON file — the
 * memory cards, his answer to her confession with a link to his voice, his promises and his chats (the server's
 * MemoryExport). Once a JST day; the server says so (429 `export_limit`) and so does this.
 */
import { useState } from 'react';
import { MEMORY_RULES, exportFileName } from '@jstar/shared/memories';
import { jstDay } from '@jstar/shared/rules';
import { useStore, useT } from '../lib/store';
import { ApiError, exportMemories } from '../services/api';

/** Hands the file to the browser's own download. */
function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function MemoryExportButton({ onNotice }: { onNotice: (msg: string) => void }) {
  const t = useT();
  const { state } = useStore();
  const [busy, setBusy] = useState(false);
  const empty = state.memories.length === 0;

  const run = async () => {
    setBusy(true);
    try {
      save(await exportMemories(state), exportFileName(jstDay()));
      onNotice(t('memories.exported'));
    } catch (e) {
      onNotice(t(e instanceof ApiError && e.code === 'export_limit' ? 'memories.exportLimit' : 'common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pad" aria-labelledby="memory-export" style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p id="memory-export" className="tiny muted" style={{ margin: 0 }}>{t('memories.exportHint', { hours: Math.round(MEMORY_RULES.linkTtlMs / 3_600_000) })}</p>
      {/* L8: nothing to save yet — the button says so instead of handing him an empty file. */}
      <button type="button" className="btn btn-line" data-testid="memory-export" style={{ minHeight: 44 }} disabled={busy || empty} aria-busy={busy} onClick={() => void run()}>
        {t(busy ? 'memories.exporting' : 'memories.export')}
      </button>
      {empty && <p className="tiny muted" style={{ margin: 0 }} data-testid="memory-export-empty">{t('memories.exportEmpty')}</p>}
    </section>
  );
}
