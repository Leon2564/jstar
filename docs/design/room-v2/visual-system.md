# MUST FOLLOW · the JSTAR home page visual system (owner request: "需要参考首页的视觉系统")

The room must feel like the same product as the home page. Screenshots of the live home page are in this folder: `home-mobile.png`, `home-desktop.png` (and `-2` for the scrolled view). Study them first.

## Tokens (apps/web/src/global.css)
- **Navy**
  - `--navy: #24284D`
  - `--navy-deep: #1B1E3D`
  - `--night: #2E3260`
- **Rose**
  - `--rose: #D38A97`
  - `--rose-text: #86465A` (rose text on light backgrounds)
- **Light neutrals**
  - `--ivory: #EFE8ED`
  - `--mist: #E6E0EA`
  - `--mist-deep: #DCD4E2`
  - `--surface: #F2EEF4`
  - `--bubble: #F7F4F8`
- **Lines and text**
  - `--hair: rgba(36,40,77,.18)`
  - `--soft: rgba(36,40,77,.74)`
- **Status**
  - `--ok: #2F6B4F`
  - `--err: #9E3346`
- **Fonts**
  - `--serif: 'Shippori Mincho','Hiragino Mincho ProN','Yu Mincho','Noto Serif CJK JP',serif` for display and her voice; load Shippori Mincho from Google Fonts.
  - `--sans: 'Zen Kaku Gothic New','Hiragino Sans','Noto Sans JP',system-ui,sans-serif`
- **Ease:** `cubic-bezier(0.2,0.7,0.2,1)`

## Signature elements on the home page (reuse them)
- **Brand mark:** a rose four-point sparkle ✦ followed by letter-spaced serif caps 「JSTAR」.
- **Video treatment:** a navy night overlay/vignette on the video, with tiny white four-point sparkles drifting.
- **Her name:** set vertically (直排) in large Shippori Mincho, with the romanized name in letter-spaced serif small caps running alongside, e.g. "Mahiro Tadai" in rose.
- **Small labels:** letter-spaced uppercase serif, e.g. 「FIRST FIVE 01 / 05」, 「NEWS」, 「SCROLL」, in rose or ivory at low opacity.
- **Primary button:** `.btn-rose`, a solid rose block with navy-deep serif text 17px, letter-spacing .1em, min-height 56, radius 2px. Corners are nearly square; no pill buttons for primary actions.
- **Secondary button:** `.btn-line`, transparent with a 1px line and an inner second line (double-rule frame: `box-shadow: inset 0 0 0 3px <bg>, inset 0 0 0 4px <hair>`).
- **Panels:** `.panel`, also with the inset double rule, radius 2px.
- **Chips:** 1px line, radius 18px, 12px text; pressed = navy fill.
- **Five-star switcher:** thin horizontal rules with names under them; the active one has a rose segment.
- **Small pills:** a translucent pill 「點點她」 (tap her) over the video, a rose vertical side tab 「序號」, and a hairline corner-bracket frame (top-left ┌).
- **Overall:** restrained, editorial, Japanese magazine feel; navy plus rose plus ivory; square corners and hairlines, not glassy rounded cards.

## How to apply to the room
- Keep the approved v5 structure: status, her line, choices, input, invitation, pure view, incoming call. Restyle and refine it in this visual system.
- Square or near-square corners and hairline double-rule frames, not generic rounded glass.
- Her name and labels in letter-spaced serif. Her lines in Shippori Mincho.
- Use rose sparingly: the main choice and ✦ invitations. The rest is navy, ivory and hairlines.
- Reuse the sparkle ✦, the vertical name, the 01/05 style counters and the rule-line star switcher.
- In zh-Hant use the zh names (唯井真尋 / Mahiro Tadai).
