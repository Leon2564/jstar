import { test, expect, passAgeGate, signUpByEmail } from './fixtures';

test('top: rotation controls, sound toggle, menu', async ({ page }) => {
  await passAgeGate(page);
  await page.getByRole('button', { name: '深田えいみ', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('深田えいみ');
  await expect(page.getByRole('button', { name: '深田えいみ', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Sound is on by default (it starts on the first tap); the switch turns it off and remembers.
  await page.getByRole('button', { name: '音声をオフにする' }).click();
  await expect(page.getByRole('button', { name: '音声をオンにする' })).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('jstar.sound'))).toBe('off');
  await page.getByRole('link', { name: 'メニュー' }).click();
  for (const [name, re] of [['JSTARS', /#\/stars$/], ['遊び方', /#\/features$/], ['カード図鑑', /#\/gallery$/], ['イベント', /#\/events$/]] as const) {
    await page.getByRole('link', { name: new RegExp(`^${name}`) }).click();
    await expect(page).toHaveURL(re);
    await page.goto('/#/menu');
  }
});

test('top rotates automatically', async ({ page }) => {
  await passAgeGate(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('唯井まひろ');
  // Her 5 s entrance clip plays first; the 7 s rotation starts once she has settled into her loop.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('八木奈々', { timeout: 16_000 });
});

test('stars pager, features tabs, gallery filter, events', async ({ page }) => {
  await passAgeGate(page, '/stars');
  await page.getByRole('button', { name: '次のひと' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('八木奈々');
  await page.getByRole('button', { name: '前のひと' }).click();
  await page.getByRole('button', { name: '前のひと' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('深田えいみ');
  await page.getByRole('link', { name: 'えいみと話す' }).click();
  await expect(page).toHaveURL(/#\/trial$/);
  await expect(page.getByText('深田えいみ').first()).toBeVisible();

  await page.goto('/#/features');
  await page.getByRole('tab', { name: 'シリアル' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('手元のカードが、声になる');

  await page.goto('/#/gallery');
  await expect(page.getByRole('img', { name: /「未入手」/ })).toHaveCount(150);
  await page.getByRole('button', { name: 'うんぱい', exact: true }).click();
  await expect(page.getByRole('img', { name: /「未入手」/ })).toHaveCount(30);

  await page.goto('/#/events');
  // #61: from the calendar — her five birthdays and the four seasons, at their next dates (no hand-written list).
  await expect(page.getByRole('listitem')).toHaveCount(9);
  await expect(page.getByRole('heading', { name: 'クリスマス' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '八木奈々 誕生日' })).toBeVisible();
});

test('tab bar moves between logged-in sections', async ({ page }) => {
  await passAgeGate(page);
  await signUpByEmail(page);
  const tabs = page.getByRole('navigation', { name: 'メイン' });
  // Her room (A2 room v2) is the call itself: no tab bar over her. Its 目錄 leads out; the other sections have the bar.
  await expect(tabs).toBeHidden();
  await page.getByTestId('room-index-open').click();
  await page.getByTestId('room-gacha').click();
  await expect(page).toHaveURL(/gacha$/);
  for (const [label, re] of [['カード', /cards$/], ['マイ', /mypage$/], ['ガチャ', /gacha$/]] as const) {
    await tabs.getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(re);
    await expect(tabs.getByRole('link', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
  }
  await tabs.getByRole('link', { name: '彼女', exact: true }).click();
  await expect(page).toHaveURL(/home$/);
  await expect(tabs).toBeHidden();
  // Back in her room: 目錄's 記錄 is her log, in her room (C-room L9).
  await page.getByTestId('room-index-open').click();
  await page.getByTestId('room-history').click();
  await expect(page.getByTestId('room-log-sheet')).toBeVisible();
  await expect(page).toHaveURL(/home$/);
  await page.getByTestId('room-sheet-close').click();
  await page.goto('/#/me/chat');
  // full-screen chat on phones hides the tab bar; the back button returns home
  await page.getByRole('link', { name: 'ホームへ戻る' }).click();
  await expect(page).toHaveURL(/home$/);
  await page.getByTestId('room-index-open').click();
  await page.getByTestId('star-rule-unpai').click();
  await expect(page.getByTestId('room')).toContainText('うんぱい');
  await expect(page.getByTestId('greeting')).not.toBeEmpty();
});

test('logout and local data reset', async ({ page }) => {
  await passAgeGate(page);
  await signUpByEmail(page, '/me/mypage');
  // M4 (v1.1.1): the e-mail stand-in is never shown as his name; he is asked to choose one.
  await expect(page.getByTestId('nickname-set')).toBeVisible();
  await expect(page.getByText('kenta', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'この端末のデータを消去' }).click();
  await page.getByRole('button', { name: '消去する' }).click();
  await expect(page.getByRole('heading', { name: '18歳以上の方ですか？' })).toBeVisible();
});

test('unknown route shows a 404 page', async ({ page }) => {
  await passAgeGate(page, '/no-such-page');
  await expect(page.getByRole('heading', { name: 'ページが見つかりません' })).toBeVisible();
});
