import {
    brand,
    breakpoints,
    fontSize,
    palette,
    radii,
    spacing,
    webBackgrounds,
    webOverlays,
    WEB_THEME_VARS,
} from './tokens'

// The instant boot shell.
//
// The web build is a client-rendered SPA: its exported HTML has an empty #root,
// so nothing at all is on screen until ~550KB of compressed JavaScript has
// downloaded, parsed, and mounted React. On an installed PWA over a mobile link
// that is seconds of blank screen on every cold launch.
//
// This module emits static markup + CSS for the persistent app chrome (sidebar
// on desktop, top/bottom bars on mobile) so first paint shows the real app.
// It is built from the same design tokens as WebTabShell, so the two cannot
// drift apart in color, size, or spacing.
//
// The shell is inert HTML with real <a href> links: it paints and navigates
// even if the bundle never arrives. WebAppShell removes it before its own first
// paint, so the handoff has no flicker and no duplicated chrome.

export const BOOT_SHELL_ID = 'pancake-boot-shell'
/** Marks the shell as painted; the paint probe and E2E gates assert on this. */
export const BOOT_SHELL_READY_ATTR = 'data-pancake-shell'
/** Performance marks for the two moments the launch gate measures. */
export const BOOT_SHELL_MARK = 'pancake-boot-shell'
export const APP_MOUNTED_MARK = 'pancake-app-mounted'

const SIDEBAR_WIDTH = 264
const MOBILE_TOPBAR_HEIGHT = 56
const MOBILE_BOTTOMBAR_HEIGHT = 64
const SANS = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

type BootNavItem = { label: string; mobileLabel: string; href: string; icon: string }

// Material Design 24x24 outlines, inlined so the chrome never waits on the icon
// font. Mirrors the MaterialIcons glyphs WebTabShell uses for the same routes.
const ICONS: Record<string, string> = {
    home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
    assignment:
        'M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z',
    groups:
        'M12 12.75c1.63 0 3.07.39 4.24.9 1.08.48 1.76 1.56 1.76 2.73V18H6v-1.61c0-1.18.68-2.26 1.76-2.73 1.17-.52 2.61-.91 4.24-.91zM4 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm1.13 1.1c-.37-.06-.74-.1-1.13-.1-.99 0-1.93.21-2.78.58C.48 14.9 0 15.62 0 16.43V18h4.5v-1.61c0-.83.23-1.61.63-2.29zM20 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm4 3.43c0-.81-.48-1.53-1.22-1.85-.85-.37-1.79-.58-2.78-.58-.39 0-.76.04-1.13.1.4.68.63 1.46.63 2.29V18H24v-1.57zM12 6c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z',
    'swap-horiz': 'M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z',
    'auto-awesome':
        'M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z',
    'flash-on': 'M7 2v11h3v9l7-12h-4l4-8z',
    'account-tree':
        'M22 11V3h-7v3H9V3H2v8h7V8h2v10h4v3h7v-8h-7v3h-2V8h2v3z',
    'admin-panel-settings':
        'M17 12c.14 0 .27.01.4.03V6.28l-7-3.12-7 3.12v4.7c0 4.28 2.99 8.29 7 9.27.42-.1.83-.24 1.23-.4A4.98 4.98 0 0 1 12 17c0-2.76 2.24-5 5-5zm0 2c-1.65 0-3 1.35-3 3s1.35 3 3 3 3-1.35 3-3-1.35-3-3-3zm0 7.5c-1.83 0-3.5.92-4.5 2.3V24h9v-.2c-1-1.38-2.67-2.3-4.5-2.3z',
    'emoji-events':
        'M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V19H7v2h10v-2h-4v-3.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z',
}

// Mirrors MOBILE_NAV / MOBILE_LABELS in WebTabShell.
const NAV: BootNavItem[] = [
    { label: 'Matchup', mobileLabel: 'Match', href: '/', icon: 'home' },
    { label: 'Roster', mobileLabel: 'Roster', href: '/roster', icon: 'assignment' },
    { label: 'Players', mobileLabel: 'Players', href: '/players', icon: 'groups' },
    { label: 'Trades', mobileLabel: 'Trades', href: '/trades', icon: 'swap-horiz' },
    { label: 'Dynasty', mobileLabel: 'Dyn', href: '/dynasty', icon: 'auto-awesome' },
    { label: 'League', mobileLabel: 'League', href: '/league', icon: 'emoji-events' },
]

const themeVars = Object.entries(WEB_THEME_VARS)
    .map(([name, value]) => `--pancake-${name}:${value};`)
    .join('')

export const BOOT_SHELL_CSS = `
:root{${themeVars}}
html,body{background-color:${palette.cream100};}
#${BOOT_SHELL_ID}{position:fixed;inset:0;z-index:1;display:none;font-family:${SANS};
  background-color:${palette.cream100};background-image:${webBackgrounds.appRoot};}
#${BOOT_SHELL_ID}[data-visible="1"]{display:block;}
#${BOOT_SHELL_ID} *{box-sizing:border-box;}
#${BOOT_SHELL_ID} a{text-decoration:none;-webkit-tap-highlight-color:transparent;}
.pbs-side{position:fixed;left:0;top:0;bottom:0;width:${SIDEBAR_WIDTH}px;
  display:flex;flex-direction:column;
  background-color:${brand.surface};background-image:${webBackgrounds.sidebar};
  border-right:1px solid ${brand.divider};padding-bottom:14px;}
.pbs-side-scroll{flex:1;min-height:0;overflow-y:auto;padding:20px 16px 0;
  display:flex;flex-direction:column;gap:${spacing.md}px;}
.pbs-brand{display:flex;align-items:center;gap:11px;padding:6px 10px 16px;}
.pbs-brand img{width:42px;height:42px;object-fit:contain;}
.pbs-brand-title{font-size:21px;font-weight:800;color:${brand.on};line-height:1.15;}
.pbs-brand-sub{margin-top:-2px;font-size:${fontSize['2xs']}px;font-weight:700;letter-spacing:1.1px;
  text-transform:uppercase;color:${brand.onSubtle};}
.pbs-league{min-height:58px;display:flex;align-items:center;gap:${spacing.lg}px;
  padding:${spacing.md}px ${spacing.lg}px;border-radius:${radii.lg}px;
  background:${brand.overlay};border:1px solid ${brand.borderSubtle};margin-bottom:${spacing.md}px;}
.pbs-crest{width:34px;height:34px;border-radius:${radii.lg}px;background:${palette.maple500};
  display:flex;align-items:center;justify-content:center;flex-shrink:0;
  color:${palette.white};font-weight:800;font-size:${fontSize.sm}px;}
.pbs-league-text{min-width:0;flex:1;}
.pbs-league-name{color:${brand.onStrong};font-weight:700;font-size:${fontSize.md}px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pbs-league-meta{color:${brand.onSubtle};font-size:${fontSize.xs}px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pbs-navgroup{display:flex;flex-direction:column;gap:${spacing.xs}px;}
.pbs-navitem{display:flex;align-items:center;gap:${spacing.lg}px;height:44px;flex-shrink:0;
  padding:0 ${spacing.lg}px;border-radius:${radii.lg}px;color:${brand.onStrong};
  font-size:${fontSize.md}px;font-weight:600;}
.pbs-navitem svg{width:19px;height:19px;flex-shrink:0;fill:${brand.onStrong};}
.pbs-navitem[aria-current="page"]{background:${palette.maple500};color:${brand.on};}
.pbs-navitem[aria-current="page"] svg{fill:${palette.white};}
.pbs-section{padding:14px ${spacing.lg}px ${spacing.sm}px;color:${brand.onSubtle};
  font-size:${fontSize['2xs']}px;font-weight:800;letter-spacing:1px;text-transform:uppercase;}
.pbs-side-foot{flex-shrink:0;padding:${spacing.md}px 14px 0;border-top:1px solid ${brand.borderSubtle};}
.pbs-userchip{min-height:50px;display:flex;align-items:center;gap:${spacing.lg}px;
  padding:0 ${spacing.md}px;border-radius:${radii.md}px;}
.pbs-avatar{width:34px;height:34px;border-radius:9999px;background:${palette.maple500};
  display:flex;align-items:center;justify-content:center;color:${palette.white};font-weight:800;flex-shrink:0;}
.pbs-username{color:${brand.onStrong};font-size:${fontSize.sm}px;font-weight:700;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pbs-usermeta{color:${brand.onSubtle};font-size:${fontSize.xs}px;}
.pbs-content{position:absolute;left:${SIDEBAR_WIDTH}px;right:0;top:0;bottom:0;
  background-image:${webBackgrounds.appContent};}
.pbs-topbar,.pbs-bottomnav{display:none;}
@media (max-width:${breakpoints.compact - 1}px){
  .pbs-side{display:none;}
  .pbs-content{left:0;top:calc(${MOBILE_TOPBAR_HEIGHT}px + env(safe-area-inset-top,0px));
    bottom:calc(${MOBILE_BOTTOMBAR_HEIGHT}px + env(safe-area-inset-bottom,0px));}
  .pbs-topbar{position:fixed;top:0;left:0;right:0;z-index:50;display:flex;align-items:center;
    gap:${spacing.lg}px;padding:0 ${spacing.xl}px;
    height:calc(${MOBILE_TOPBAR_HEIGHT}px + env(safe-area-inset-top,0px));
    padding-top:env(safe-area-inset-top,0px);background:${webOverlays.mobileTopbar};
    -webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);
    border-bottom:1px solid ${palette.cream300};}
  .pbs-topbar img{width:34px;height:44px;object-fit:contain;}
  .pbs-topbar-league{flex:1;min-width:0;height:44px;display:flex;align-items:center;
    gap:${spacing.md}px;padding:0 ${spacing.md}px;border-radius:${radii.lg}px;
    background:${palette.cream200};border:1px solid ${palette.cream300};}
  .pbs-topbar-league .pbs-league-name{color:${palette.espresso};font-size:${fontSize.sm}px;}
  .pbs-menu{width:44px;height:44px;border-radius:${radii.lg}px;background:${palette.cream200};
    display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .pbs-menu svg{width:22px;height:22px;fill:${palette.espresso};}
  .pbs-bottomnav{position:fixed;left:0;right:0;bottom:0;z-index:50;display:flex;
    align-items:center;justify-content:space-around;
    height:calc(${MOBILE_BOTTOMBAR_HEIGHT}px + env(safe-area-inset-bottom,0px));
    padding-bottom:calc(${spacing.xs}px + env(safe-area-inset-bottom,0px));
    background:${webOverlays.mobileBottomNav};border-top:1px solid ${palette.cream300};}
  .pbs-bottomitem{flex:1;min-height:44px;height:54px;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:${spacing.xs}px;color:${palette.latte};}
  .pbs-bottomitem svg{width:22px;height:22px;fill:${palette.latte};}
  .pbs-bottomitem[aria-current="page"]{color:${palette.maple600};}
  .pbs-bottomitem[aria-current="page"] svg{fill:${palette.maple600};}
  .pbs-bottomlabel{width:100%;text-align:center;font-size:${fontSize['2xs']}px;font-weight:700;}
}
`.trim()

const icon = (name: string) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICONS[name]}"/></svg>`

const sideItem = (item: BootNavItem) =>
    `<a class="pbs-navitem" data-href="${item.href}" href="${item.href}">${icon(item.icon)}<span>${item.label}</span></a>`

const bottomItem = (item: BootNavItem) =>
    `<a class="pbs-bottomitem" data-href="${item.href}" href="${item.href}">${icon(item.icon)}<span class="pbs-bottomlabel">${item.mobileLabel}</span></a>`

const MENU_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>'

export const BOOT_SHELL_HTML = `
<div id="${BOOT_SHELL_ID}" aria-hidden="true">
  <nav class="pbs-side">
    <div class="pbs-side-scroll">
      <div class="pbs-brand">
        <img src="/pwa-192.png" alt="" />
        <div><div class="pbs-brand-title">Pancake</div><div class="pbs-brand-sub">Manager Console</div></div>
      </div>
      <div class="pbs-league">
        <div class="pbs-crest" data-pbs="crest">P</div>
        <div class="pbs-league-text">
          <div class="pbs-league-name" data-pbs="league">Pancake League</div>
          <div class="pbs-league-meta" data-pbs="team">Team</div>
        </div>
      </div>
      <div class="pbs-navgroup">${NAV.slice(0, 5).map(sideItem).join('')}</div>
      <div class="pbs-navgroup">${sideItem(NAV[5])}</div>
      <div class="pbs-section">Season tools</div>
      <div class="pbs-navgroup">
        <div class="pbs-navitem">${icon('flash-on')}<span>Draft Room</span></div>
        <div class="pbs-navitem">${icon('account-tree')}<span>Playoffs</span></div>
        <div class="pbs-navitem" data-pbs="commissioner" hidden>${icon('admin-panel-settings')}<span>Commissioner</span></div>
      </div>
    </div>
    <div class="pbs-side-foot">
      <div class="pbs-userchip">
        <div class="pbs-avatar" data-pbs="initials">P</div>
        <div class="pbs-league-text">
          <div class="pbs-username" data-pbs="team">Profile</div>
          <div class="pbs-usermeta">Profile &amp; settings</div>
        </div>
      </div>
    </div>
  </nav>
  <div class="pbs-topbar">
    <img src="/pwa-192.png" alt="" />
    <div class="pbs-topbar-league"><div class="pbs-crest" data-pbs="crest">P</div>
      <div class="pbs-league-text"><div class="pbs-league-name" data-pbs="league">Pancake League</div></div></div>
    <div class="pbs-menu">${MENU_ICON}</div>
  </div>
  <div class="pbs-content"></div>
  <nav class="pbs-bottomnav">${NAV.map(bottomItem).join('')}</nav>
</div>
`.trim()

// Runs before the bundle. Shows the shell only for a signed-in launch, fills it
// from the persistent cache, and marks the active route.
export const BOOT_SHELL_SCRIPT = `
(function () {
  var el = document.getElementById(${JSON.stringify(BOOT_SHELL_ID)});
  if (!el) return;
  var store;
  try { store = window.localStorage } catch (e) { return }
  if (!store) return;

  var read = function (test) {
    try {
      for (var i = 0; i < store.length; i++) {
        var key = store.key(i);
        if (key && test(key)) return { key: key, raw: store.getItem(key) };
      }
    } catch (e) {}
    return null;
  };

  // Auth routes render their own screen, never the app chrome.
  var path = location.pathname;
  if (path.indexOf('/sign-in') === 0 || path.indexOf('/sign-up') === 0) return;

  // Only a stored Supabase session means "this launch will land in the app".
  var session = read(function (k) { return k.indexOf('sb-') === 0 && k.lastIndexOf('-auth-token') === k.length - 11 });
  if (!session) return;
  var userId = null;
  try { userId = JSON.parse(session.raw).user.id } catch (e) { return }
  if (!userId) return;

  // The chrome is cosmetic and React corrects it within a frame or two, so a
  // day-old league name is fine to paint. A long-abandoned install is not:
  // past this bound the shell renders without claiming a specific league.
  var MAX_IDENTITY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  var envelope = function (hit) {
    if (!hit) return null;
    try {
      var parsed = JSON.parse(hit.raw);
      if (!parsed || parsed.version !== 1) return null;
      if (!(typeof parsed.savedAt === 'number') || Date.now() - parsed.savedAt > MAX_IDENTITY_AGE_MS) return null;
      return parsed.value;
    } catch (e) { return null }
  };
  var memberships = envelope(read(function (k) { return k === 'pancake:league-memberships:v1:' + userId })) || [];
  var selectedId = envelope(read(function (k) { return k === 'pancake:selected-league:v1:' + userId }));
  var current = null;
  for (var i = 0; i < memberships.length; i++) {
    if (!current || memberships[i].id === selectedId) current = memberships[i];
    if (memberships[i].id === selectedId) break;
  }

  var setText = function (name, value) {
    var nodes = el.querySelectorAll('[data-pbs="' + name + '"]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = value;
  };
  // Mirrors getInitials in lib/format.ts, so the chip does not change on mount.
  var initials = function (name) {
    var safe = (name || '').trim();
    var words = safe.split(/\\s+/).filter(function (w) { return /[a-zA-Z0-9]/.test(w) });
    var letters = words.filter(function (w) { return /^[a-zA-Z]/.test(w) });
    var pick = letters.length ? letters : words;
    if (pick.length >= 2) return (pick[0][0] + pick[pick.length - 1][0]).toUpperCase();
    if (pick.length === 1) return pick[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase();
    return (safe.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2) || '?').toUpperCase();
  };
  if (current) {
    var leagueName = (current.leagues && current.leagues.name) || 'Pancake League';
    var teamName = current.team_name || 'Team';
    setText('league', leagueName);
    setText('team', teamName);
    setText('crest', (leagueName.trim()[0] || 'P').toUpperCase());
    setText('initials', initials(teamName));
    if (current.role === 'commissioner') {
      var commissioner = el.querySelector('[data-pbs="commissioner"]');
      if (commissioner) commissioner.removeAttribute('hidden');
    }
  }

  // Mark the active route the same way WebTabShell's isRouteActive does.
  var active = function (href) {
    if (href === '/') return path === '/' || path === '' || path === '/index';
    return path.indexOf(href) === 0;
  };
  var links = el.querySelectorAll('[data-href]');
  for (var j = 0; j < links.length; j++) {
    if (active(links[j].getAttribute('data-href'))) links[j].setAttribute('aria-current', 'page');
  }

  el.setAttribute('data-visible', '1');
  el.setAttribute(${JSON.stringify(BOOT_SHELL_READY_ATTR)}, '1');
  document.documentElement.setAttribute('data-pancake-boot', 'shell');
  try { performance.mark(${JSON.stringify(BOOT_SHELL_MARK)}) } catch (e) {}
  // What the shell actually painted, kept after the element is removed so the
  // launch gate can assert on it without racing the handoff.
  window.__PANCAKE_BOOT__ = {
    league: (el.querySelector('[data-pbs="league"]') || {}).textContent || null,
    team: (el.querySelector('[data-pbs="team"]') || {}).textContent || null,
    initials: (el.querySelector('[data-pbs="initials"]') || {}).textContent || null,
    active: (function () { var a = el.querySelector('[aria-current="page"]'); return a ? a.getAttribute('data-href') : null })(),
  };
})();
`.trim()
