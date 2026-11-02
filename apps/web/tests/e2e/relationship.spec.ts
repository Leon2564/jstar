import { test, expect } from './fixtures';

// The relationship panel (#54) in her room's 目錄 (A2 room v2, #163), at the acceptance viewport (390×844), in the three launch
// languages: nothing may push the page sideways or leave the screen, with the longest content each state can hold.
const LOVER = {
  stage: 'lover', stageSince: '2026-10-09T12:00:00.000Z', stageDay: 7, daysTogether: 128, lastDay: '2026-11-01',
  confessedAt: '2026-10-09T12:00:00.000Z', anniversary: '2026-10-09', loverXp: 0, rewardRank: 12
};
const READY = { ...LOVER, stage: 'confession_ready', confessedAt: null, anniversary: null, loverXp: null, rewardRank: 2 };
const LABEL = { ja: ['恋人 Lv.10', '気になるふたり'], 'zh-Hant': ['戀人 Lv.10', '曖昧'], en: ['Lovers Lv.10', 'Something more'] } as const;

for (const [lang, [loverLabel, readyLabel]] of Object.entries(LABEL)) {
  for (const [state, rel, label] of [['lover', LOVER, loverLabel], ['confession_ready', READY, readyLabel]] as const) {
    test(`${lang}: the ${state} panel fits a 390×844 phone`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript(([l, r]) => {
        localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: l, user: { via: 'email', nickname: 'kenta' }, star: 'mahiro', affinity: { mahiro: 3000 }, rel: { mahiro: r } }));
      }, [lang, rel] as const);
      // Midday JST: from 17:00 her room opens on the confession itself (#55) and the panel is not on screen.
      await page.clock.setFixedTime(new Date('2026-11-01T03:00:00.000Z'));
      await page.goto('/#/me/home');
      await page.getByTestId('room-index-open').click();
      await expect(page.getByTestId('stage')).toHaveText(label);
      await expect(page.getByTestId('rel-hint')).toBeVisible();
      if (state === 'lover') await expect(page.getByTestId('rel-anniv')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      for (const id of ['relationship', 'stage', 'rel-days', 'rel-hint', ...(state === 'lover' ? ['rel-anniv'] : [])]) {
        const box = (await page.getByTestId(id).boundingBox())!;
        expect(box.x, id).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, id).toBeLessThanOrEqual(390);
      }
      // The 目錄 keeps her face clear: the bond sits in the night below it, and leaving stays on screen.
      const panel = (await page.getByTestId('relationship').boundingBox())!;
      expect(panel.y).toBeGreaterThan(844 * 0.45);
      const leave = (await page.getByTestId('room-leave').boundingBox())!;
      expect(leave.y + leave.height).toBeLessThanOrEqual(844);
    });
  }
}
