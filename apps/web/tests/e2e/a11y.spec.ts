import AxeBuilder from '@axe-core/playwright';
import { test, expect, passAgeGate, signUpByEmail } from './fixtures';

const VISITOR = ['/age', '/', '/menu', '/stars', '/features', '/gallery', '/events', '/pick', '/trial', '/signup', '/serial'];
const MEMBER = ['/me/home', '/me/chat', '/me/gacha', '/me/cards', '/me/shop', '/me/mypage'];

test('no serious or critical axe violations', async ({ page }) => {
  test.setTimeout(180_000);
  const report: Record<string, string[]> = {};
  await page.goto('/#/age');
  const scan = async (path: string) => {
    await page.goto(`/#${path}`);
    await page.waitForTimeout(700);
    // Let finite entrance fades settle: axe blends colours of half-transparent text.
    await page.evaluate(() => Promise.race([
      Promise.all(document.getAnimations()
        .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
        .map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 3000))
    ]));
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    if (bad.length) report[path] = bad.map((v) => `${v.id} (${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
  };
  await scan('/age');
  await passAgeGate(page);
  for (const p of VISITOR.slice(1)) await scan(p);
  await signUpByEmail(page);
  for (const p of MEMBER) await scan(p);
  console.log('AXE', JSON.stringify(report, null, 1));
  expect(report).toEqual({});
});
