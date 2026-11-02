import { test, expect, passAgeGate, signUpByEmail } from './fixtures';
import fs from 'node:fs';

const PAYLOADS = [
  '<img src=x onerror="window.__xss=1">',
  '<script>window.__xss=1</script>',
  '"><svg onload="window.__xss=1">',
  'javascript:window.__xss=1'
];

test('chat renders hostile input as plain text', async ({ page }) => {
  let dialog = false;
  page.on('dialog', async (d) => { dialog = true; await d.dismiss(); });
  await passAgeGate(page);
  await signUpByEmail(page, '/me/chat');
  for (const p of PAYLOADS) {
    await page.getByLabel('メッセージ').fill(p);
    await page.getByRole('button', { name: '送信' }).click();
    await expect(page.getByText(p, { exact: true })).toBeVisible();
    await expect(page.getByRole('status', { name: /入力中/ })).toHaveCount(0);
  }
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator('.chat-body img, .chat-body svg[onload], .chat-body script').count()).toBe(0);
  expect(dialog).toBe(false);
});

for (const next of ['https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
  test(`open redirect blocked: next=${next}`, async ({ page }) => {
    await passAgeGate(page);
    await signUpByEmail(page, next);
    await expect(page).toHaveURL(/localhost:\d+\/#\/me\/home$/);
  });
}

test('hostile ?code= in QR link is not auto-filled', async ({ page }) => {
  await passAgeGate(page);
  await page.goto('/#/serial?code=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
  await expect(page.getByRole('textbox', { name: 'シリアルコード' })).toHaveValue('');
});

test('hostile payload smuggled through the age-gate redirect is dropped', async ({ page }) => {
  await passAgeGate(page, '/serial?code=%3Cscript%3E');
  await expect(page).toHaveURL(/#\/$/);
});

test('tampered local storage cannot grant items or break the app', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('jstar.v1', JSON.stringify({
      v: 1, ageOk: true, points: -99999, freePulls: 'lots',
      owned: { '<img src=x onerror=alert(1)>': 5, 'mahiro-1': 2 },
      user: { via: 'email', email: 'x@example.com', nickname: '<b>boss</b>', named: true }, star: 'constructor',
      chats: { mahiro: [{ from: 'her', text: '<img src=x onerror="window.__xss=1">' }] }
    }));
  });
  await page.goto('/#/me/mypage');
  await expect(page.getByTestId('nickname')).toHaveText('<b>boss</b>');
  await page.goto('/#/me/gacha');
  await expect(page.getByTestId('points')).toHaveText('0 pt');
  await page.goto('/#/me/chat');
  await expect(page.getByText('<img src=x onerror="window.__xss=1">')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test('corrupt local storage falls back to a fresh session', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('jstar.v1', '{broken'));
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: '18歳以上の方ですか？' })).toBeVisible();
});

test('production build ships a Content-Security-Policy and no unsafe sinks', async ({ page }) => {
  await page.goto('/');
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).not.toContain('unsafe-eval');
  const js = fs.readdirSync('dist/assets').filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(`dist/assets/${f}`, 'utf8')).join('\n');
  const src = ['src/pages/site.tsx', 'src/pages/flows.tsx', 'src/pages/me.tsx', 'src/components/ui.tsx'].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  expect(src).not.toContain('dangerouslySetInnerHTML');
  expect(src).not.toMatch(/\beval\(|new Function\(/);
  expect(js).not.toMatch(/sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/);
});
