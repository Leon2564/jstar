import type { Browser, Page } from '@playwright/test';
import { test, expect } from './fixtures';

const VIEWPORTS = [
  { name: 'small-phone', width: 320, height: 568 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'phone-landscape', width: 844, height: 390 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'desktop', width: 1920, height: 1080 }
];
const VISITOR = ['/', '/menu', '/stars', '/features', '/gallery', '/events', '/pick', '/trial', '/signup', '/serial'];
const MEMBER = ['/me/home', '/me/chat', '/me/gacha', '/me/cards', '/me/cards/s1-mahiro-01', '/me/shop', '/me/mypage'];

for (const vp of VIEWPORTS) {
  for (const lang of ['ja', 'en']) {
    test(`${vp.name} ${lang}: every screen fits without horizontal scrolling`, async ({ browser }) => {
      test.setTimeout(90_000);
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: 'ja-JP' });
      await ctx.addInitScript((l) => {
        (window as unknown as { __E2E__: boolean }).__E2E__ = true;
        localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: l, owned: { 's1-mahiro-01': 1 }, lastPull: ['s1-mahiro-01'] }));
      }, lang);
      const page = await ctx.newPage();
      const problems: string[] = [];
      const check = async (path: string) => {
        await page.goto(`/#${path}`);
        await page.waitForTimeout(350);
        const r = await page.evaluate(() => {
          const over = document.documentElement.scrollWidth - window.innerWidth;
          const offenders = [...document.querySelectorAll('body *')].filter((el) => {
            const b = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return b.width > 0 && (b.right > window.innerWidth + 1 || b.left < -1) && cs.position !== 'fixed' && !el.closest('[style*="overflow"],.chips,.tabs,[role="group"]');
          }).slice(0, 3).map((el) => `${el.tagName}.${(el as HTMLElement).className}`);
          const tooSmall = [...document.querySelectorAll('a, button, input, select')].filter((el) => {
            const b = el.getBoundingClientRect();
            return b.width > 0 && b.height > 0 && b.height < 32 && !(el as HTMLElement).closest('.card, dl, .rowlist, p, .tiny, .small, summary');
          }).map((el) => (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 20));
          return { over, offenders, tooSmall };
        });
        if (r.over > 0) problems.push(`${path}: page scrolls sideways by ${r.over}px ${r.offenders.join(',')}`);
        if (r.tooSmall.length) problems.push(`${path}: small tap targets ${r.tooSmall.join(' | ')}`);
      };
      for (const p of VISITOR) await check(p);
      await page.evaluate((l) => localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: l, user: { via: 'email', nickname: 'k' }, owned: { 's1-mahiro-01': 1 }, lastPull: ['s1-mahiro-01'], points: 1000 })), lang);
      for (const p of MEMBER) await check(p);
      await check('/me/gacha/result');
      expect(problems).toEqual([]);
      await ctx.close();
    });
  }
}

test('desktop shows the full site navigation; the menu is there at every size', async ({ browser }) => {
  for (const [w, visible] of [[1440, true], [390, false]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, locale: 'ja-JP' });
    await ctx.addInitScript(() => localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'ja' })));
    const page = await ctx.newPage();
    await page.goto('/#/stars');
    const nav = page.getByRole('navigation', { name: 'サイト' });
    if (visible) await expect(nav).toBeVisible(); else await expect(nav).toBeHidden();
    // The menu (login, legal, social) is reachable at every size.
    await expect(page.getByRole('link', { name: 'メニュー' })).toBeVisible();
    await ctx.close();
  }
});

test('member tab bar sits at the bottom on phones and at the top on desktop', async ({ browser }) => {
  for (const [w, where] of [[390, 'bottom'], [1440, 'top']] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, locale: 'ja-JP' });
    await ctx.addInitScript(() => localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'ja', user: { via: 'email', nickname: 'k' } })));
    const page = await ctx.newPage();
    await page.goto('/#/me/cards');
    const box = await page.getByRole('navigation', { name: 'メイン' }).boundingBox();
    expect(box).not.toBeNull();
    if (where === 'top') expect(box!.y).toBeLessThan(10); else expect(box!.y + box!.height).toBeGreaterThan(900 - 10);
    await ctx.close();
  }
});

test('chat with a long history: the list scrolls; her name and the input with the mic stay on screen (N-03)', async ({ browser }) => {
  for (const [width, height] of [[375, 812], [1440, 900]] as const) {
    const ctx = await browser.newContext({ viewport: { width, height }, locale: 'ja-JP' });
    await ctx.addInitScript(() => {
      (window as unknown as { __E2E__: boolean }).__E2E__ = true;
      const mahiro = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, from: i % 2 ? 'me' : 'her', text: `メッセージ ${i}。今日はどんな一日だった？ 少し長めの行で、吹き出しを二行にします。` }));
      localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'ja', user: { via: 'email', nickname: 'k' }, star: 'mahiro', chats: { mahiro } }));
    });
    const page = await ctx.newPage();
    await page.goto('/#/me/chat');
    const input = page.locator('.composer input, .composer textarea').first();
    await expect(input).toBeVisible();
    const r = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('.chat-body')!;
      const hdr = document.querySelector<HTMLElement>('.chat-hdr')!.getBoundingClientRect();
      const composer = document.querySelector<HTMLElement>('.composer')!.getBoundingClientRect();
      return {
        pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
        listScrolls: body.scrollHeight > body.clientHeight,
        headerOn: hdr.top >= 0 && hdr.bottom <= window.innerHeight,
        composerOn: composer.top >= 0 && composer.bottom <= window.innerHeight + 1
      };
    });
    expect(r, `${width}×${height}`).toEqual({ pageScrolls: false, listScrolls: true, headerOn: true, composerOn: true });
    await ctx.close();
  }
});

test('chat header at 375 px: her badge and closeness are never cut (N-28)', async ({ browser }) => {
  for (const lang of ['ja', 'en', 'ko', 'zh-Hant']) {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'ja-JP' });
    await ctx.addInitScript((l) => {
      (window as unknown as { __E2E__: boolean }).__E2E__ = true;
      localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: l, user: { via: 'email', nickname: 'k' }, star: 'mahiro' }));
    }, lang);
    const page = await ctx.newPage();
    await page.goto('/#/me/chat');
    const sub = page.getByTestId('chat-sub');
    await expect(sub).toBeVisible();
    const r = await sub.evaluate((el) => {
      const hdr = el.closest('header')!.getBoundingClientRect();
      const parts = [...el.children].map((c) => c.getBoundingClientRect());
      return {
        cut: [...el.children].filter((c) => (c as HTMLElement).scrollWidth > (c as HTMLElement).clientWidth + 1).length,
        outside: parts.filter((b) => b.right > el.getBoundingClientRect().right + 1 || b.bottom > hdr.bottom).length
      };
    });
    expect(r, lang).toEqual({ cut: 0, outside: 0 });
    await ctx.close();
  }
});

test('memory cards at 375 px: a long title ends in an ellipsis within the card, never cut mid-word at its edge (N-31)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'ja-JP' });
  await ctx.addInitScript(() => {
    (window as unknown as { __E2E__: boolean }).__E2E__ = true;
    const long = 'Reading aloud for you — and praise that means it, every single evening together';
    localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'en', user: { via: 'email', nickname: 'k' }, memories: [
      { id: 'm1', star: 'nana', title: long.slice(0, 40), date: '2026-09-28' },
      { id: 'm2', star: 'mahiro', title: 'Extraordinarilylongwordthatcannotfit', date: '2026-09-28' },
      { id: 'm3', star: 'eimi', title: '読み聞かせと、本気のほめ言葉を、毎晩ふたりで', date: '2026-09-28' }
    ] }));
  });
  const page = await ctx.newPage();
  await page.goto('/#/me/cards?tab=memory');
  await expect(page.locator('.card .cap span').first()).toBeVisible();
  const r = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.card .cap span')].map((el) => {
    const card = el.closest('.card')!.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    return {
      inside: el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= card.right + 1,
      lines: Math.round(el.clientHeight / lh) <= 3,
      clampedWithEllipsis: el.scrollHeight <= el.clientHeight + 1 || getComputedStyle(el).webkitLineClamp === '3'
    };
  }));
  expect(r).toHaveLength(3);
  for (const x of r) expect(x).toEqual({ inside: true, lines: true, clampedWithEllipsis: true });
  await ctx.close();
});

/** Her room (A2 room v2, #163) at a size, signed in, in a language, with a star. */
async function openRoom(browser: Browser, width: number, height: number, lang = 'ja', star = 'mahiro') {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: lang === 'en' ? 'en-US' : 'ja-JP' });
  await ctx.addInitScript(([l, s]) => {
    (window as unknown as { __E2E__: boolean }).__E2E__ = true;
    localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: l, user: { via: 'email', nickname: 'k' }, star: s }));
  }, [lang, star] as const);
  // Her face's lower edge on screen: her clip's box, its crop and its face box (data/faces.gen.json, --face).
  await ctx.addInitScript(() => {
    (window as unknown as { faceBottom: () => number }).faceBottom = () => {
      const s = document.querySelector<HTMLElement>('.home-stage .scene.depth-enter')!, i = s.querySelector<HTMLElement>('.scene-poster')!;
      const c = getComputedStyle(s), r = i.getBoundingClientRect(), ar = parseFloat(c.getPropertyValue('--ar'));
      const oy = parseFloat(getComputedStyle(i).objectPosition.split(' ')[1]), f = c.getPropertyValue('--face').trim().split(/\s+/).map(Number);
      return r.top + oy + f[3] * (Math.max(r.width, r.height * ar) / ar);
    };
  });
  const page = await ctx.newPage();
  await page.goto('/#/me/home');
  await expect(page.getByTestId('room-composer')).toBeVisible();
  return { ctx, page };
}
declare function faceBottom(): number;

test('her room 目錄: the five names, ☰ and 關閉 fit from 320 to 390 px (N-01)', async ({ browser }) => {
  for (const width of [320, 375, 390]) {
    const { ctx, page } = await openRoom(browser, width, 812);
    await page.getByTestId('room-index-open').click();
    await expect(page.getByRole('link', { name: 'メニュー' })).toBeVisible();
    await expect(page.getByTestId('room-index-close')).toBeVisible();
    const row = page.getByRole('group', { name: '交代' });
    const r = await row.evaluate((el) => ({
      over: el.scrollWidth - el.clientWidth,
      out: [...el.children].map((c) => c.getBoundingClientRect()).filter((b) => b.left < 0 || b.right > window.innerWidth).length,
      pageOver: document.documentElement.scrollWidth - window.innerWidth
    }));
    expect(r, `${width}px`).toEqual({ over: 0, out: 0, pageOver: 0 });
    // Her face is never covered: the 目錄 starts in the night below it, and leaving stays on screen.
    const top = await page.locator('.room2-index-scroll').evaluate((el) => el.getBoundingClientRect().top / window.innerHeight);
    expect(top, `${width}px`).toBeGreaterThanOrEqual(0.45);
    await expect(page.getByTestId('room-leave')).toBeInViewport();
    await ctx.close();
  }
});

test('her room on a phone: her replies wrap, never scroll sideways, with the longest en and ko replies (QA #3)', async ({ browser }) => {
  for (const [width, lang, words] of [
    [390, 'en', ['I want to hear your voice', 'Tell me more about your day', 'I\'ll come again tomorrow too']],
    [390, 'ko', ['네 목소리가 듣고 싶어서 왔어', '오늘 하루 어땠는지 더 말해 줘', '내일도 또 올게, 기다려 줘']],
    [320, 'ja', ['あなたの声が聞きたくて来たよ', 'もっと聞かせて、今日のこと', '明日もまた来るね、待っててね']]
  ] as const) {
    const { ctx, page } = await openRoom(browser, width, 844, lang);
    // B: his choices come in her subtitle's place once her line is done.
    await expect(page.getByTestId('room-replies')).toBeVisible();
    const r = await page.getByTestId('room-replies').evaluate((row, w) => {
      [...row.querySelectorAll<HTMLElement>('.js-reply')].forEach((b, i) => { b.lastChild!.textContent = w[i]; });
      const box = row.getBoundingClientRect();
      const kids = [...row.querySelectorAll<HTMLElement>('.js-reply')].map((b) => b.getBoundingClientRect());
      return {
        sideways: row.scrollWidth > row.clientWidth + 1 || getComputedStyle(row).overflowX === 'auto' || getComputedStyle(row).overflowX === 'scroll',
        out: kids.filter((b) => b.left < -1 || b.right > window.innerWidth + 1).length,
        rows: new Set(kids.map((b) => Math.round(b.top))).size,
        inside: kids.every((b) => b.right <= box.right + 1),
        pageOver: document.documentElement.scrollWidth - window.innerWidth
      };
    }, words);
    expect(r.sideways, `${width} ${lang}`).toBe(false);
    expect(r.out, `${width} ${lang}`).toBe(0);
    expect(r.inside, `${width} ${lang}`).toBe(true);
    expect(r.rows, `${width} ${lang}`).toBeLessThanOrEqual(3);
    expect(r.pageOver, `${width} ${lang}`).toBe(0);
    await ctx.close();
  }
});

test('her room 目錄: the presence words under the names are never cut, with her city\'s sky beside them (N-12)', async ({ browser }) => {
  for (const [width, lang] of [[375, 'ja'], [375, 'en'], [1440, 'ja']] as const) {
    const { ctx, page } = await openRoom(browser, width, 900, lang);
    await page.getByTestId('room-index-open').click();
    await expect(page.getByTestId('presence-mahiro')).toBeVisible();
    // The test site's weather puts a sky symbol before each word; the longest words are 「おやすみ」「おでかけ」.
    const cut = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.presence')].map((el) => {
      el.insertAdjacentHTML('afterbegin', '<i class="presence-sky">☂︎</i>');
      const label = el.querySelector<HTMLElement>('.presence-label');
      if (label && document.documentElement.lang !== 'en') label.textContent = 'おでかけ';
      const slot = el.parentElement!.getBoundingClientRect();
      const b = (label ?? el).getBoundingClientRect();
      return el.scrollWidth > el.clientWidth || b.left < slot.left - 1 || b.right > slot.right + 1 ? el.dataset.testid : null;
    }).filter(Boolean));
    expect(cut, `${width} ${lang}`).toEqual([]);
    await ctx.close();
  }
});

test('her room on a desktop: its text is 12 px or more and her words keep under her face; the phone keeps 20 px gutters (N-15)', async ({ browser }) => {
  for (const width of [1440, 1024, 390]) {
    const { ctx, page } = await openRoom(browser, width, 900);
    await expect(page.getByTestId('room-replies')).toBeVisible();
    const room = await page.evaluate(() => {
      const px = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].filter((el) => el.textContent?.trim()).map((el) => parseFloat(getComputedStyle(el).fontSize));
      const col = document.querySelector<HTMLElement>('.room2-bottom')!.getBoundingClientRect();
      return { smallest: Math.min(...px('.room2-exif span'), ...px('.room2-bottom .js-line'), ...px('.room2-bottom .js-reply')), top: col.top, face: faceBottom(), left: col.left };
    });
    await page.getByTestId('room-index-open').click();
    await expect(page.getByTestId('now-line')).toBeVisible();
    const index = await page.evaluate(() => {
      const px = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].filter((el) => el.textContent?.trim()).map((el) => parseFloat(getComputedStyle(el).fontSize));
      return Math.min(...px('[data-testid="now-line"]'), ...px('.room2-rel'), ...px('[data-testid="rewards"] .reward'), ...px('.room2-cell small'));
    });
    if (width >= 1024) {
      expect(Math.min(room.smallest, index), `${width}px`).toBeGreaterThanOrEqual(12);
      // B: her words are a subtitle band under her face (data/faces.gen.json), never beside or over it.
      expect(room.top, `${width}px`).toBeGreaterThan(room.face);
    } else {
      expect(room.left).toBe(20);
    }
    await ctx.close();
  }
});

test('desktop her room: her words, the replies and his input are one group at the bottom of the column (N-23, N-26)', async ({ browser }) => {
  for (const [width, height] of [[1440, 900], [1280, 800], [1920, 1080]] as const) {
    const { ctx, page } = await openRoom(browser, width, height);
    await expect(page.getByTestId('room-replies')).toBeVisible();
    const gap = await page.evaluate(() => {
      const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const echo = box('.room2-echo'), replies = box('[data-testid="room-replies"]'), form = box('[data-testid="room-composer"]');
      return { toReplies: replies.top - echo.bottom, toForm: form.top - replies.bottom, bottom: window.innerHeight - form.bottom };
    });
    // B: her last words, his choices (in her subtitle's place) and his input, one group on the band's foot.
    expect(gap.toReplies, `${width}px`).toBeGreaterThanOrEqual(0);
    expect(gap.toReplies, `${width}px`).toBeLessThan(40);
    expect(gap.toForm, `${width}px`).toBeGreaterThanOrEqual(0);
    expect(gap.toForm, `${width}px`).toBeLessThan(40);
    // No empty band under it either: the group sits on the column's foot.
    expect(gap.bottom, `${width}px`).toBeLessThan(140);
    await ctx.close();
  }
});

test('desktop her room: 目錄, ☰ and 關閉 stay in the top bar, off her face (N-30)', async ({ browser }) => {
  for (const [width, height] of [[1024, 768], [1440, 900], [1920, 1080]] as const) {
    const { ctx, page } = await openRoom(browser, width, height);
    const open = (await page.getByTestId('room-index-open').boundingBox())!;
    expect(open.y + open.height, `${width}px`).toBeLessThan(80);
    await page.getByTestId('room-index-open').click();
    const menu = (await page.getByRole('link', { name: 'メニュー' }).boundingBox())!;
    const close = (await page.getByTestId('room-index-close').boundingBox())!;
    for (const b of [menu, close]) expect(b.y + b.height, `${width}px`).toBeLessThan(80);
    expect(Math.abs(menu.y + menu.height / 2 - (close.y + close.height / 2)), `${width}px`).toBeLessThan(12);
    // The 目錄 itself floats on the night at the left: her face (66–74 % of the width) stays clear.
    const body = await page.locator('.room2-index-body').evaluate((el) => el.getBoundingClientRect().right / window.innerWidth);
    expect(body, `${width}px`).toBeLessThan(0.5);
    await ctx.close();
  }
});

/**
 * WCAG contrast of each text in her room over what is really behind it (her clip, the night fade): the text is made
 * transparent (its own backing stays), the page is captured, and the brightest pixel behind each line is compared with its colour.
 */
async function worstContrast(page: Page, selector: string): Promise<{ min: number; at: string }> {
  // What is on screen (B: her subtitle is hidden while his choices stand in its place, her last words over them).
  const boxes = await page.evaluate((sel) => [...document.querySelectorAll<HTMLElement>(sel)].filter((el) => el.textContent?.trim() && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden').map((el) => {
    const b = el.getBoundingClientRect();
    return { x: Math.max(0, b.left), y: Math.max(0, b.top), w: Math.min(b.width, window.innerWidth - b.left), h: b.height, color: getComputedStyle(el).color, text: el.textContent!.trim().slice(0, 16) };
  }), selector);
  const tag = await page.addStyleTag({ content: `${selector}, ${selector} * { color: transparent !important; text-shadow: none !important; border-color: transparent !important; } .js-cursor, .js-more, .js-dot, ${selector} kbd { visibility: hidden !important; } ${selector}::before, ${selector}::after, ${selector} *::before, ${selector} *::after { opacity: 0 !important; }` });
  await page.waitForTimeout(100);
  const shot = (await page.screenshot()).toString('base64');
  // The text comes back: the page can be measured again (another frame of her clip).
  await tag.evaluate((el) => el.remove());
  return page.evaluate(async ({ png, boxes: list }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const k = img.width / window.innerWidth;
    const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const lum = (r: number, gg: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b);
    let min = 99, at = '';
    for (const b of list) {
      const d = g.getImageData(Math.round(b.x * k), Math.round(b.y * k), Math.max(1, Math.round(b.w * k)), Math.max(1, Math.round(b.h * k))).data;
      let back = 0;
      for (let i = 0; i < d.length; i += 4) back = Math.max(back, lum(d[i], d[i + 1], d[i + 2]));
      const [r, gg, bb, a = 1] = (b.color.match(/[\d.]+/g) ?? []).map(Number);
      // The text's own alpha over that brightest pixel.
      const bgc = Math.round(Math.min(1, back) * 255);
      const t = lum(r * a + bgc * (1 - a), gg * a + bgc * (1 - a), bb * a + bgc * (1 - a));
      const [hi, lo] = [t, back].sort((m, n) => n - m);
      const ratio = (hi + 0.05) / (lo + 0.05);
      if (ratio < min) { min = ratio; at = b.text; }
    }
    return { min, at };
  }, { png: shot, boxes });
}

test('desktop her room: her words and status read over her brightest morning frame — WCAG AA (N-60)', async ({ browser }) => {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const ctx = await browser.newContext({ viewport: { width, height }, locale: 'ja-JP' });
    await ctx.addInitScript(() => {
      (window as unknown as { __E2E__: boolean }).__E2E__ = true;
      localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'ja', user: { via: 'email', nickname: 'k' }, star: 'eimi' }));
    });
    const page = await ctx.newPage();
    // 08:30: her morning room, the brightest frames she has.
    await page.clock.setFixedTime(new Date('2026-10-14T08:30:00+09:00'));
    await page.goto('/#/me/home');
    await expect(page.getByTestId('room-composer')).toBeVisible();
    await page.waitForTimeout(800);
    const r = await worstContrast(page, '.room2-bottom .js-line, .room2-echo, .room2-bottom .js-reply, .room2-exif span, .room2-lab .js-label');
    expect(r.min, `${width}px: ${r.at}`).toBeGreaterThanOrEqual(4.5);
    await ctx.close();
  }
});

test('desktop her room: a ✦ or ♥ that means something is 12 px or more and AA over her frame (QA #10)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ja-JP' });
  await ctx.addInitScript(() => {
    (window as unknown as { __E2E__: boolean }).__E2E__ = true;
    localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: 'zh-Hant', user: { via: 'email', nickname: 'k' }, star: 'mahiro', rel: { mahiro: { stage: 'new', stageSince: '2026-10-13T00:00:00.000Z', stageDay: 2, daysTogether: 2, lastDay: '2026-10-13', confessedAt: null, anniversary: null, loverXp: null, rewardRank: 0 } } }));
  });
  const page = await ctx.newPage();
  // By day her confession day offers it: ✦ INVITATION over her clip.
  await page.clock.setFixedTime(new Date('2026-10-14T13:00:00+08:00'));
  await page.goto('/#/me/home');
  await page.getByTestId('room-index-open').click();
  await page.getByTestId('demo-menu-open').click();
  await page.getByTestId('confession-demo').click();
  await page.getByTestId('room-index-close').click();
  await expect(page.getByTestId('confession-entry')).toBeVisible();
  await page.waitForTimeout(800);
  const sizes = await page.locator('.room2 .js-spark').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => parseFloat(getComputedStyle(e).fontSize)));
  expect(sizes.length).toBeGreaterThanOrEqual(2);
  for (const px of sizes) expect(px).toBeGreaterThanOrEqual(12);
  const r = await worstContrast(page, '.room2-lab .js-spark, .room2-exif .js-spark');
  expect(r.min, r.at).toBeGreaterThanOrEqual(4.5);
  await ctx.close();
});

/** The lowest contrast over a few frames of her clip (it moves: the brightest frame decides). */
async function worstOver(page: Page, selector: string, frames = 3): Promise<{ min: number; at: string }> {
  let worst = { min: 99, at: '' };
  for (let i = 0; i < frames; i++) {
    const r = await worstContrast(page, selector);
    if (r.min < worst.min) worst = r;
    await page.waitForTimeout(700);
  }
  return worst;
}
const STARS5 = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as const;
async function roomAt(browser: Browser, star: string, at: string, width: number, height: number, lang = 'ja') {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', ...(width < 1000 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}) });
  await ctx.addInitScript(([s, l]) => {
    (window as unknown as { __E2E__: boolean }).__E2E__ = true;
    localStorage.setItem('jstar.v1', JSON.stringify({ v: 1, ageOk: true, lang: l, user: { via: 'email', nickname: 'k' }, star: s }));
  }, [star, lang] as const);
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(at));
  await page.goto('/#/me/home');
  await expect(page.getByTestId('room-composer')).toBeAttached();
  // Her clip and its poster are in (the morning looks come from the lazy catalogue).
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.home-stage img')].every((i) => i.complete), null, { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1200);
  return { ctx, page };
}
const overlaps = (page: Page, text: string) => page.evaluate((sel) => {
  const boxes = [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0);
  return [...document.querySelectorAll('.room2 > .js-sparkles span')].map((e) => e.getBoundingClientRect())
    .filter((s) => boxes.some((b) => s.left < b.right && s.right > b.left && s.top < b.bottom && s.bottom > b.top)).length;
}, text);

// One test per star (they run in parallel), each well inside its time: five rooms in one test were slow on a busy runner.
test.describe('her name and the key line, star by star (R05)', () => {
test.describe.configure({ mode: 'parallel' });
for (const star of STARS5) test(`her name and its romaji read AA over her brightest frames, mornings included; no sparkle on them (R05) — ${star}`, async ({ browser }) => {
  test.setTimeout(90_000);
  // Her name as each language writes it (zh-Hant: 唯井真尋… and 「Unpai」), her morning room and her night.
  for (const [at, lang] of [['2026-10-14T08:30:00+09:00', 'ja'], ['2026-10-14T08:30:00+09:00', 'zh-Hant'], ['2026-10-14T21:00:00+09:00', 'ja']] as const) {
    const { ctx, page } = await roomAt(browser, star, at, 390, 844, lang);
    const r = await worstOver(page, '.room2-vname .js-vname-jp, .room2-vname .js-vname-ro');
    expect(r.min, `${star} ${lang} ${at}: ${r.at}`).toBeGreaterThanOrEqual(4.5);
    expect(await overlaps(page, '.room2-vname, .room2-lab, .room2-exif, .room2-bottom'), `${star} ${at}`).toBe(0);
    await ctx.close();
  }
});

for (const star of STARS5) test(`desktop: the key line reads AA in her room; no sparkle on it (R05) — ${star}`, async ({ browser }) => {
  test.setTimeout(90_000);
  {
    const { ctx, page } = await roomAt(browser, star, '2026-10-14T08:30:00+09:00', 1440, 900);
    await expect(page.locator('.room2-keys')).toContainText('ESC');
    await expect(page.locator('.room2-keys')).toBeVisible();
    const r = await worstOver(page, '.room2-keys');
    expect(r.min, `${star}: ${r.at}`).toBeGreaterThanOrEqual(4.5);
    const name = await worstOver(page, '.room2-vname .js-vname-jp, .room2-vname .js-vname-ro', 2);
    expect(name.min, `${star} name: ${name.at}`).toBeGreaterThanOrEqual(4.5);
    expect(await overlaps(page, '.room2-keys, .room2-vname, .room2-bottom'), star).toBe(0);
    await ctx.close();
  }
});
});

test('desktop her room: her words never cover her face, however long its lines (round 10, B)', async ({ browser }) => {
  for (const [width, height] of [[1024, 768], [1280, 720], [1440, 900], [1920, 1080]] as const) {
    const { ctx, page } = await openRoom(browser, width, height, 'en', 'unpai');
    await expect(page.getByTestId('room-replies')).toBeVisible();
    const r = await page.evaluate(() => {
      // The longest it gets: a long line of hers, long replies.
      const line = document.querySelector<HTMLElement>('.room2-bottom .js-line span[aria-hidden]');
      if (line) line.textContent = '「I was thinking about the promise you two made for tonight, right here with you, and about the rain over the city」';
      for (const b of document.querySelectorAll<HTMLElement>('[data-testid="room-replies"] .js-reply')) b.append(' — and then, tell me everything about your day');
      const col = document.querySelector<HTMLElement>('.room2-bottom')!.getBoundingClientRect();
      const fade = parseFloat(getComputedStyle(document.querySelector('.home.room-v2')!).getPropertyValue('--fade'));
      return { top: col.top - fade, face: faceBottom(), overflow: [...document.querySelectorAll<HTMLElement>('.room2-bottom .js-line, .room2-bottom .js-reply, .room2-bottom input')].some((e) => e.getBoundingClientRect().right > col.right + 1) };
    });
    // B: the band (its night included) stays under her face (data/faces.gen.json through her clip's own crop).
    expect(r.top, `${width}px`).toBeGreaterThan(r.face);
    expect(r.overflow, `${width}px`).toBe(false);
    await ctx.close();
  }
});

