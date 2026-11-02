// M9 (C-room): a cold link into her room boots on her night, never a light page first. Set before the first paint
// (a file, not inline: the CSP allows no inline script); index.html's boot style reads it, her room keeps it.
// B-N1: 'room' is her room only (/me, /me/home): it paints the whole document navy for good, so a member page that
// matched it by mistake (/me/mypage…) drew its navy text on navy. The member pages are on the night too (B-N2):
// they boot 'night' like the guest night screens, which paints only the empty #root until the page renders.
// M11 (guest paths): the home and the other night screens (age gate, loader, JSTARS, menu, pick, trial, sign-up, the
// code form and its cards, events, the gallery and the legal pages) boot on the night too ('night'); the light pages
// (features…) boot light ('site').
var h = location.hash;
document.documentElement.dataset.boot = /^#\/me(\/home)?\/?(\?|$)/.test(h) ? 'room'
  : /^(#\/?)?(\?|$)|^#\/(me|age|loading|stars|menu|trial|signup|login|serial|pick|events|gallery|live|legal)([?/]|$)/.test(h) ? 'night' : 'site';
