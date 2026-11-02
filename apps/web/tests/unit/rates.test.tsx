import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { VARIANT_CARDS } from '@jstar/shared/rules';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState } from '../../src/lib/state';
import { CARD_BY_ID } from '../../src/data/cards';
import { ja } from '../../src/i18n/ja';
import { zhHant } from '../../src/i18n/zhHant';
import { en } from '../../src/i18n/en';
import { ko } from '../../src/i18n/ko';

afterEach(cleanup);
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

/** Wording of a complete-the-set prize (カード合わせ, docs/compliance-jp.md §2), in the launch languages. */
const SET_PRIZE = /集齐|集齊|全部集|コンプ|揃え|揃う|集めると|complete (the|a) set|collect (them )?all|full set|세트/i;

describe('提供割合 and variant cards (#75)', () => {
  it('lists the variant cards with a note, and nothing on the page reads as a set-completion prize', async () => {
    render(
      <StoreProvider initial={{ ...initialState(), ageOk: true }}>
        <MemoryRouter initialEntries={['/legal/rates']}><AppRoutes /></MemoryRouter>
      </StoreProvider>
    );
    const section = await screen.findByTestId('rates-variants');
    expect(section.textContent).toContain('もうひとりの彼女');
    for (const id of VARIANT_CARDS) expect(section.textContent).toContain(CARD_BY_ID[id].title.ja);
    expect(document.body.textContent).not.toMatch(SET_PRIZE);
  });

  it('no rates string in any language offers a set-completion prize', () => {
    for (const dict of [ja, zhHant, en, ko]) {
      for (const [k, v] of Object.entries(dict)) if (k.startsWith('rates.')) expect(v, k).not.toMatch(SET_PRIZE);
    }
  });
});
