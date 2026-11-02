import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StoreProvider } from '../../src/lib/store';
import * as api from '../../src/services/api';
import DesignPage from '../../src/pages/design';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const cssFiles = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? cssFiles(p) : p.endsWith('.css') ? [p] : [];
});
const SRC = join(__dirname, '../../src');

/** #162: the visual system v1. */
describe('the visual system', () => {
  it('defines its tokens in one place: styles/tokens.css', () => {
    for (const f of cssFiles(SRC)) {
      const css = readFileSync(f, 'utf8');
      if (f.endsWith(join('styles', 'tokens.css'))) continue;
      expect(css.includes(':root'), f).toBe(false);
      expect(/--(navy|rose|ivory|mist|surface|serif|sans|ease)\s*:/.test(css), f).toBe(false);
    }
    const tokens = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');
    for (const t of ['--navy:', '--navy-deep:', '--night:', '--rose:', '--rose-text:', '--ivory:', '--mist:', '--surface:', '--hair:', '--soft:', '--ok:', '--err:', '--night-fade-room:', '--serif:', '--sans:', '--fs-line:', '--r-sharp:', '--hairline:', '--ease:', '--dur:']) {
      expect(tokens, t).toContain(t);
    }
    // zh-Hant: Chinese punctuation from a Traditional Chinese face.
    expect(tokens).toMatch(/JStar Punct TC Serif[\s\S]*unicode-range: U\+00B7, U\+2014-2026, U\+3000-303F/);
    expect(tokens).toMatch(/html:lang\(zh-Hant\) \{\s*--serif: 'JStar Punct TC Serif', 'Shippori Mincho'/);
  });

  it('names the punctuation faces as local() matches them: full or PostScript names, never a family name (R02)', () => {
    const tokens = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');
    const faces = Object.fromEntries([...tokens.matchAll(/@font-face \{ font-family: '([^']+)'; src: ([^;]+);/g)]
      .map(([, family, src]) => [family, [...src.matchAll(/local\('([^']+)'\)/g)].map((m) => m[1])]));
    // Chrome does not match these family names in local(): with only them the fallback never applied.
    const families = ['PingFang TC', 'Songti TC', 'Heiti TC', 'Noto Sans CJK TC', 'Noto Serif CJK TC', 'Noto Sans TC', 'Noto Serif TC'];
    for (const family of ['JStar Punct TC Serif', 'JStar Punct TC Sans']) {
      const names = faces[family];
      expect(names, family).toBeTruthy();
      for (const f of families) expect(names, `${family}: ${f}`).not.toContain(f);
      // macOS, Android and Windows, each by its full and its PostScript name.
      for (const n of ['PingFang TC Regular', 'PingFangTC-Regular', 'Microsoft JhengHei', 'MicrosoftJhengHei']) expect(names, `${family}: ${n}`).toContain(n);
    }
    expect(faces['JStar Punct TC Serif']).toEqual(expect.arrayContaining(['Songti TC Regular', 'STSongti-TC-Regular', 'NotoSerifCJKtc-Regular', 'PMingLiU']));
    expect(faces['JStar Punct TC Sans']).toEqual(expect.arrayContaining(['Noto Sans CJK TC Regular', 'NotoSansCJKtc-Regular']));
  });

  it('/#/design shows the tokens and components on the test site and in the prototype, nothing in production', () => {
    render(<StoreProvider><MemoryRouter><DesignPage /></MemoryRouter></StoreProvider>);
    expect(screen.getByTestId('design-page').textContent).toContain('--rose');
    cleanup();
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    vi.spyOn(api, 'isDemo').mockReturnValue(false);
    render(<StoreProvider><MemoryRouter><DesignPage /></MemoryRouter></StoreProvider>);
    expect(screen.queryByTestId('design-page')).toBeNull();
  });
});
