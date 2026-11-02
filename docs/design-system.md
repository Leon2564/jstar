# JSTAR visual system v1

The home page, her room and every screen after them are one product, so they share one visual system. Her room's
approved design is A2「夜畫廊」 ([`docs/design/room-v2/A2-gallery-night.html`](design/room-v2/A2-gallery-night.html),
[`.png`](design/room-v2/A2-gallery-night.png); owner, 2026-10-02). Its inputs are in the same folder:
[`spec.md`](design/room-v2/spec.md) and [`visual-system.md`](design/room-v2/visual-system.md).

The system is defined in three places:
- **Tokens:** `apps/web/src/styles/tokens.css`. This is the only place they are defined.
- **Components:** CSS classes in `apps/web/src/system/system.css` and React primitives in
  `apps/web/src/system/index.tsx`.
- **Reference page:** `/#/design`, on the test and demo sites and in the prototype only. It shows every token and
  component, and it is the visual-regression baseline (`apps/web/tests/e2e/design.spec.ts`).

Tracking: epic #161, this system #162.

## Principles

1. **Content first.** She and her words are the screen. Everything else recedes: small, hairline, letter-spaced, or
   one step away in 目錄.
2. **Her face is never covered.** The middle of her video stays fully transparent. Text sits only on the night (the
   top wash, and the lower half sinking into navy-deep), never on her face.
3. **Rose only for the main action and ✦.** One solid rose block per screen (「✦ 來猜拳」, 「接聽」). Everything else is
   navy, ivory and hairlines.
4. **Editorial, not app chrome.** Near-square corners (2px), hairlines and double rules, letter-spaced serif labels,
   vertical names. It should feel like a Japanese magazine, not a glassy rounded card.

## Tokens

### Colour

| Token | Value | Use |
| --- | --- | --- |
| `--navy` | `#24284D` | text on light grounds, pressed chips |
| `--navy-deep` | `#1B1E3D` | the night; text on rose |
| `--night` | `#2E3260` | the vignette |
| `--rose` | `#D38A97` | the main action, ✦, labels on the night |
| `--rose-text` | `#86465A` | rose text on light grounds (AA on `--surface`) |
| `--ivory` | `#EFE8ED` | text on the night |
| `--mist` / `--mist-deep` | `#E6E0EA` / `#DCD4E2` | light grounds |
| `--surface` / `--bubble` | `#F2EEF4` / `#F7F4F8` | panels, bubbles on light |
| `--hair` / `--soft` | `rgba(36,40,77,.18)` / `.74` | hairline / secondary text on light |
| `--iv-meta` / `--iv-line` / `--iv-hair` | ivory at `.72` / `.44` / `.18` | meta, lines and inner rules on the night |
| `--ok` / `--err` | `#2F6B4F` / `#9E3346` | status |
| `--nd` / `--nt` | `27,30,61` / `46,50,96` | navy-deep / night as `r,g,b` for `rgba()` |

**The night fade** (`--night-fade-*`, the `NightFade` component) has these variants:
- `room`: a top wash, her face clear, and the lower half sinking into navy-deep, with a right-edge wash for her
  vertical name and a vignette;
- `pure`: lighter, for pure view;
- `morning`: a stronger top, for a bright morning frame;
- `index`: 目錄, where the night rises higher;
- `desk`: the desktop, where the left half carries the column.

### Type

- **`--serif`:** Shippori Mincho. Use it for her lines, her name, labels and the brand.
- **`--sans`:** Zen Kaku Gothic New. Use it for the interface.
- **zh-Hant** keeps both faces. Chinese punctuation (`，。「」……`) comes from a Traditional Chinese face on the
  device (`JStar Punct TC Serif / Sans`, `unicode-range` on `U+3000–303F`, `U+FF00–FF65`, `…`, `—`, `·`), so it sits
  centred, as Taiwan writes it. Hanzi that Shippori Mincho lacks fall back to Noto Serif / Sans TC.
- **ko** uses Noto Serif / Sans KR.

| Token | Size | Use |
| --- | --- | --- |
| `--fs-label` | 11 | spaced capitals 「HER ROOM　01 / 05」 (`--ls-label` .34em) |
| `--fs-meta` | 12 | meta on the night 「10/1　23:50　東京・晴」 (`--ls-meta` .16em) |
| `--fs-small` | 13 | small UI text |
| `--fs-body` | 15 | body, replies, input (**body ≥ 14px**) |
| `--fs-ui` | 17 | the brand, primary buttons (`--ls-ui` .1em) |
| `--fs-line` | 18.5 | her line (`--lh-line` 1.75, `--ls-line` .04em) |
| `--fs-name` / `--fs-name-desk` | 27 / 46 | her vertical name |

### Space, shape, line, motion

- **Space:** `--sp-1…--sp-10` (4, 8, 12, 16, 20, 24, 32, 40). The minimum touch target is `--tap` (44px).
- **Shape:** `--r-sharp` 2px for buttons, panels and frames. `--r-chip` 18px is for chips only.
- **Line:** `--hairline` 1px.
- **Motion:** `--ease` `cubic-bezier(.2,.7,.2,1)`, with `--dur-fast` 160ms, `--dur` 280ms and `--dur-slow` 600ms. Under
  `prefers-reduced-motion` the durations are 0.

## Components

| Primitive | Class | Use |
| --- | --- | --- |
| `BrandMark` | `.js-brand` | ✦ JSTAR, top-left of her room |
| `VerticalName` | `.js-vname` | her name set vertically, with the romaji in rose small caps (`large` on desktop) |
| `SpacedLabel` | `.js-label` | 「HER ROOM　01 / 05」, 「✦ INVITATION」; `meta` for ivory meta, `dot` for the rose live dot, `light` on light grounds |
| `BtnRose` | `.js-btn-rose` | the one main action (`large` 56px: 接聽) |
| `BtnLine` | `.js-btn-line` | secondary: double rule on the night (`light` on light grounds) |
| `ReplyChoice` | `.js-reply` | her choices for him: double rule; `hot` = the rose ✦ invitation; `plain` = text only (下次吧); `index` = the 1–3 key on desktop |
| `HairlineInput` | `.js-input` | 「用自己的話說…」 on a bottom hairline, with her voice minutes as a meta and the mic after it |
| `StarRuleSwitcher` | `.js-stars` | the five as thin rules, the active one with a rose segment |
| `RuleCounter` | `.js-rules` | 1 / 3 of her messages |
| `CornerFrame` | `.js-corner` | the ┌ hairline corner: the one frame that says "a picture" |
| `NightFade` | `.js-night` | the fade over her video (variants above) |
| `Sparkles` | `.js-sparkles` | a few small white ✦ drifting |
| `Waveform` | `.js-voice` | her voice note: play, waveform (rose where played), time |
| `PrintPhoto` | `.js-print` | her photo as a small print: ivory border, a slight tilt |
| `Panel` | `.js-panel` | a double-rule panel, on the night or `light` |
| `Hint` | `.js-hint` | a hint strip with a rose rule at its left |
| — | `.js-line`, `.js-cursor`, `.js-more` | her line in Shippori Mincho, the typing cursor, ▼ |

The home page's own `.btn-rose`, `.btn-line`, `.panel` and `.chip` (`global.css`) use the same tokens.
A v1 page moves onto the night with the `.js-nightpage` scope (`system.css`): it remaps the light tokens the shared
classes read (`--soft`, `--hair`, `--rose-text`) and the few hard-coded light colours, so its buttons, chips, tabs,
inputs, panels and lists read on navy-deep (`--err` turns to `--rose-glow` there). Every member page uses it — the
gacha and its history, the cards, a card, memories, the alarm, My page, the shop / points page, the code history and
the account deletion — and so do the gift sheet, the gallery, the legal pages and the 404. Only her room (`/me`,
`/me/home`) boots as `room` in `public/boot.js`; the other member pages boot as `night`.

**The offline line** (`OfflineLine` in `components/ui.tsx`, `.offline-line` in `global.css`) is one quiet A2 line,
docked in the page's flow right under its header band and sticky while the page scrolls, so it never covers a header.
The shared `Header` docks it; a page with its own header (her chat, the trial, My page, the gacha, the cards, her room)
renders `<OfflineLine />` right after it. A screen without one gets the shell's `float` line, fixed under the site
header.

## Screens beyond her room

- **The scene player** (`apps/web/src/scene/scene.css`) is laid out as her room's B「電影字幕」, so a scene feels like
  the same film:
  - the top band: hairline ✕ and CC in 44px targets, ✦ before the title (the scene's accent, never her colour), her
    voice time as a meta, the countdown as a meta over a shortening hairline;
  - the subtitle band at the foot, with its own night: his line, her words in ivory Shippori Mincho in 「」, her
    numbered `ReplyChoice` lines (a column on a phone, a row from 600px), and the hairline input;
  - the memory card as a double-rule print.
- **うんぱい's stream:** LIVE is a rose dot and spaced capitals. His comments run in three lanes under her face box
  (`.scn-live --fb`, from her stream clips' face boxes), never across her face.
- **Sign-up and log-in** (`apps/web/src/styles/flows.css`): her hero poster on the night with her vertical name, her
  line, and the form. 傳送驗證碼 is its one rose block, and legal text is 12px or larger.

## Readability rules

- **WCAG AA for all text.** On the night, text sits on the fade (at least navy-deep at .66 behind it), never on a
  frosted card. Meta text uses `--iv-meta` (.72) at 12px or larger.
- **Body ≥ 14px.** Her line is 18.5px; replies and the input are 15px.
- **Touch targets ≥ 44px.**
- **Her words in her language's quotes** (`apps/web/src/lib/lines.ts`): 「」 in ja and zh-Hant, “ ” in en and ko; a
  quote inside her words takes the inner pair (『』, ‘ ’).
- **Subtitles are three lines at most**, in her room and in scenes: a longer line is paged at whole sentences with ▼,
  turned by her voice or a tap. ja and zh-Hant break between phrases and words, never inside one.
- **Weather stays outside**: rain, snow and petals keep clear of her face (masked to the sides of the frame).
- **Respect the safe areas.**

## Anti-patterns

- Anything over her face: chips, cards, pills or badges in the middle of the frame.
- Glassy rounded cards and pills for primary actions (corners are 2px), or big round icon buttons.
- More than one solid rose block per screen, or rose for anything other than the main action and ✦.
- Emoji as icons, purple gradients, neon or GitHub-dark styling.
- Japanese corner punctuation in zh-Hant (the punctuation fallback prevents it), or kana names in zh-Hant (#171).
- Defining a colour, face, size or timing outside `tokens.css`.
