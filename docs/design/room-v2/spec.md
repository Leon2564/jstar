# Design spec · JSTAR「她的房間」(her room), v5 refined

## Product
JSTAR is a companion web app (mobile-first PWA, also desktop) for fans of five real Japanese talents. Each talent has an AI companion with her own likeness clips (AI-generated video, full-bleed 9:16 portrait loops), her cloned voice for scripted lines, and an LLM persona for free chat. "Her room" is the core screen: being with her, like a private 1v1 video call. The owner has tried 5 directions. They liked **v5**:
- a Love and Deepspace (戀與深空) style video call, with a full-screen character who talks;
- a Japanese romance-ADV dialogue box: name plate, her line typing out, ▼;
- a Zeta (KR) style status pill (date · city · weather · ♥ day count) and tap-to-reply choices;
- a bubble (KR) style anniversary card.

They want **noticeably better UI/UX**: simpler, with more focus on the content (her plus her words), and secondary controls that never dominate. The previous v5.1 mockup is at `../v51.html` / `../v51.png`, and v5 is at `../v5-zh.html`. Read them and do better, not just restyle.

## Audience and context
- Adult fans in TW, HK, JP and KR, often at night, phone in hand at 10–30 cm, sometimes on desktop.
- Emotional tone: intimate, quiet, warm, a little cinematic. Never game-like clutter, never a SaaS dashboard.

## Language
Traditional Chinese (zh-Hant) for all UI and her lines. Star names in zh-Hant:
- 唯井真尋 (short: 真尋)
- 八木奈奈 (奈奈)
- 七瀬愛麗絲 (愛麗絲)
- 深田詠美 (詠美)
- Unpai

## Real assets (use these URLs directly; no CSS silhouettes or SVG faces)
- 真尋, night home: https://nest.jstarcards.ai/media/mahiro-hero-9x16/poster.jpg (16:9: mahiro-hero-16x9/poster.jpg)
- 真尋, talking close-up: https://nest.jstarcards.ai/media/mahiro-talkclose-9x16/poster-hq.jpg
- 奈奈, morning (tea, kitchen): https://nest.jstarcards.ai/media/nana-hero-morning-9x16/poster-hq.jpg
- Others' avatars: https://nest.jstarcards.ai/media/{nana,unpai,alice,eimi}-hero-9x16/poster.jpg

## Six required mobile states (390×844 each), plus one desktop (1440×900)
1. **Call opens.** She speaks her first line: 「呵呵，你來了呀……今天也是夜貓子呢。像昨天那樣，能安靜地聊天，我好開心。」
   - Reply choices: 我回來了 / 有點累 / 想聽你的聲音.
   - A free-text input 「用自己的話說…」 with a mic.
   - Status: 10/1 23:50 · 東京 · 晴 · ♥ 第1天.
2. **Her messages while you were away.** 「你不在的時候，真尋留了 3 則訊息」. They play one by one inside the dialogue, with a photo (a still of her) and a 6-second voice note.
   - First message: 「午休中～今天的便當是自己做的喔。」, 1/3.
   - Choices: 看起來好好吃 / 好想吃你做的.
3. **Mid-conversation.**
   - His line 「有點累」 marked 已讀.
   - Her reply streaming: 「辛苦了。……吶，在這裡陪我一起發呆一下，好不好？」, over the talking close-up clip.
   - Choices: 嗯，好啊 / 想讓你聽我說 / 明天也會來.
4. **Her invitation to a scene.** 「今天還沒好好跟你說『歡迎回家』呢。……吶，來猜拳吧？輸了的話……呵呵。」
   - A highlighted choice 「✦ 來猜拳」 plus 「下次吧」.
5. **Pure view.** All UI hidden except her and one subtitle line. Tapping her shows a reaction line: 「咦？……怎麼了，突然碰我。」
6. **Incoming call** (wake alarm), 奈奈 in the morning.
   - 「視訊通話 · 早安時間」, her line 「醒了嗎？……我泡好茶了喔。」.
   - Answer: slide to answer, or another better pattern.
   - Snooze: 「再睡5分鐘」.

Desktop: the same experience, with the 16:9 clip.

## Secondary features (must remain reachable, but receded)
- gift;
- next promise;
- wake alarm;
- switch star (five avatars);
- relationship stage, days together and closeness;
- chat history (記錄);
- memories (思念);
- gacha (抽卡);
- leave the call;
- remaining voice minutes (聲音 剩10分).

Decide where they live (sheet, long-press, swipe, a single ⋯). They must not compete with her face or her words.

## Constraints
- Her face is never covered.
- Text readable over bright and dark frames: WCAG AA, body ≥14px.
- Respect safe areas.
- No emoji icons, no purple gradients, no GitHub-dark neon.
- Use 「」 quotes.
- Serif (Songti TC / Noto Serif TC) for her voice is welcome; it's the owner's v5 favourite.

## Deliverable
A single HTML file with every frame side by side on a light canvas, each labelled in zh-Hant with one line on what it shows.
- Screenshot the full canvas as PNG. Run it from `/Users/long/workspace/jstarcardsai/apps/web`, using Playwright's chromium with `channel: 'chrome'`: write a temporary .mjs there that imports `@playwright/test`, then delete it.
- Also write 1 short paragraph: which logic and anchor you used, and "form came from the content where".
