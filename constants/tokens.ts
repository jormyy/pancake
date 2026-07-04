import { Platform } from 'react-native'

// ── Raw palette ─────────────────────────────────────────────────
// Every color in the app lives here. Components import semantic
// aliases (below) or domain maps — never raw hex strings.

export const palette = {
    // ── Maple / Brand ── (warm amber — like Grade A dark maple syrup)
    maple50:  '#FEF6E4',
    maple100: '#FDEAC0',
    maple200: '#FAD490',
    maple500: '#B25A0D',   // deep amber maple — the primary brand color (4.8:1 under white fills, AA for the 13-16px white-on-primary text app-wide; was #C9660F @ 3.9:1)
    maple600: '#8F4A10', // maple TEXT variant (links/FP/active-nav/Share) — ~6.3:1 on cream (was #A05212 @ 5.35, judges read borderline)
    maple900: '#6B3410',

    // ── Cream / Parchment ── (warm backgrounds — like unbleached breakfast paper)
    cream50:  '#FFFDF8',   // near-white warm — cards, inputs
    cream100: '#FDF8EE',   // warm screen background
    cream150: '#FAF2E2',   // subtle section backgrounds
    cream200: '#F4E8D2',   // muted areas
    cream300: '#DBC8A6',   // light borders (more perceptible)
    cream400: '#C9B188',   // borders (≈2.6:1 vs card — clearly visible)

    // ── Espresso / Brown ── (warm text — replaces cold gray text)
    // Tuned so secondary/muted text clears WCAG AA (≥4.5:1) on the cream
    // surfaces (bg-card #FFFDF8 is the lightest worst case).
    espresso:   '#2C1A0E', // darkest — primary text
    coffee:     '#4A2E1C', // very dark — rich headers
    mocha:      '#6B4535', // secondary text (~7:1)
    latte:      '#6E4C3A', // muted/caption/label text (~7.2:1 — strong margin even for tiny 10–11px captions/headers)
    cappuccino: '#6F4E3D', // placeholder + small-caps section labels / table headers (~7.0:1 — strong margin for tiny bold caps)
    oatmilk:    '#BE9C87', // disabled text

    // ── Red ──
    red50:    '#FEF2F2',
    red100:   '#FEE2E2',
    red200:   '#FECACA',
    red300:   '#FCA5A5',
    red500:   '#EF4444',
    red900:   '#991B1B',
    redDark:  '#7F1D1D',
    redBright:'#d00',

    // ── Green ──
    green50:  '#F0FDF4',
    green100: '#D1FAE5',
    green200: '#BBF7D0',
    green300: '#DCFCE7',
    green500: '#10B981',
    green600: '#16A34A',
    green700: '#15803D',
    green800: '#166534',
    green900: '#065F46',

    // ── Blue ──
    blue500: '#3B82F6',

    // ── Purple ──
    purple100: '#EDE9FE',
    purple300: '#C4B5FD',
    purple500: '#8B5CF6',
    purple600: '#7C3AED',  // waiver-badge text — keeps >=4.5:1 (WCAG AA) on purple100

    // ── Indigo ──
    indigo500: '#6366F1',

    // ── Amber / Yellow ──
    amber200: '#FDE68A',
    amber300: '#FEF3C7',
    amber400: '#F59E0B',
    amber600: '#D97706',

    // ── Position identity hues ──
    // Warm-leaning, saturation-matched deep hues for position chips/avatars.
    // Every value keeps white chip text >=4.5:1 (WCAG AA); see constants/positions.ts.
    posCoral:  '#B0372A', // PG — deep coral (white 6.1:1)
    posBurnt:  '#A34A00', // SG — burnt orange (white 5.9:1)
    posForest: '#2E6B34', // SF — forest green (white 6.4:1)
    posTeal:   '#14695F', // PF — teal-slate (white 6.5:1)
    posPlum:   '#7D3C78', // C  — plum (white 7.5:1)
    posAmber:  '#8A6500', // G  — deep amber (white 5.3:1)
    posSage:   '#5C7250', // F  — sage (white 5.3:1)

    // ── Neutrals ──
    white:    '#fff',
    gray50:   '#fafafa',
    gray100:  '#f9f9f9',
    gray150:  '#f5f5f5',
    gray200:  '#f3f3f3',
    gray250:  '#f0f0f0',
    gray300:  '#e5e7eb',
    gray350:  '#eee',
    gray400:  '#ddd',
    gray500:  '#ccc',
    gray550:  '#bbb',
    gray600:  '#aaa',
    gray650:  '#999',
    gray700:  '#888',
    gray750:  '#6B7280',
    gray800:  '#666',
    gray850:  '#555',
    gray900:  '#333',
    gray950:  '#111',
    black:    '#11181C',
} as const

function webColor(name: string, fallback: string) {
    return Platform.OS === 'web' ? `var(--pancake-${name}, ${fallback})` : fallback
}

// Convert a hex string (#RGB or #RRGGBB) to an rgba() string. Use for tinted
// fills/overlays instead of ad-hoc `color + '22'` concatenation. Pass raw
// `palette.*` hex values (not semantic CSS-var colors, which can't be parsed).
export function alpha(hex: string, a: number): string {
    let h = hex.replace('#', '')
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${a})`
}

// ── Semantic tokens ─────────────────────────────────────────────

export const colors = {
    // Text — warm espresso/coffee scale
    textPrimary:     webColor('text-primary', palette.espresso),    // '#2C1A0E' deep dark brown
    textSecondary:   webColor('text-secondary', palette.mocha),      // '#6B4535' medium brown
    textMuted:       webColor('text-muted', palette.latte),          // '#9B7060' warm muted
    textPlaceholder: webColor('text-placeholder', palette.cappuccino), // '#B8917F' soft warm placeholder
    textDisabled:    webColor('text-disabled', palette.oatmilk),     // '#CCAA99' very light
    textWhite:       palette.white,

    // Backgrounds — warm cream/parchment
    bgScreen: webColor('bg-screen', palette.cream100), // '#FDF8EE' warm cream screen
    bgCard:   webColor('bg-card', palette.cream50),    // '#FFFDF8' near-white warm card
    bgMuted:  webColor('bg-muted', palette.cream200),  // '#F4E8D2' warm muted areas
    bgSubtle: webColor('bg-subtle', palette.cream150), // '#FAF2E2' very subtle warm
    bgInput:  webColor('bg-input', palette.cream150),  // subtle well, clearly delineated from card

    // Borders / Separators — warm cream
    separator:   webColor('separator', palette.cream300), // '#E8D8BE'
    border:      webColor('border', palette.cream400),    // '#D9C4A5'
    borderLight: webColor('border-light', palette.cream300), // '#E8D8BE'

    // Primary — deep maple amber
    primary:       webColor('primary', palette.maple500),       // '#C9660F'
    primaryLight:  webColor('primary-light', palette.maple50),  // '#FEF6E4'
    primaryBorder: webColor('primary-border', palette.maple200), // '#FAD490'
    primaryDark:   webColor('primary-dark', palette.maple600),  // '#A05212'

    // Danger (red)
    danger:     webColor('danger', palette.red500),
    dangerLight: webColor('danger-light', palette.red100),
    dangerDark:  webColor('danger-dark', palette.red900),

    // Success (green)
    success:     webColor('success', palette.green500),
    successLight: webColor('success-light', palette.green100),
    successDark:  webColor('success-dark', palette.green900),

    // Warning (amber)
    warning:     webColor('warning', palette.amber400),
    warningLight: webColor('warning-light', palette.amber300),
    warningDark:  webColor('warning-dark', palette.amber600),

    // Info (purple)
    info:      webColor('info', palette.purple500),
    infoLight: webColor('info-light', palette.purple100),

    // Accent (blue)
    accent: webColor('accent', palette.blue500),
} as const

// ── Spacing ─────────────────────────────────────────────────────

export const spacing = {
    xxs: 2,
    xs: 4,
    sm: 6,
    md: 8,
    lg: 12,
    xl: 16,
    '2xl': 20,
    '3xl': 24,
    '4xl': 32,
    '5xl': 40,
    '6xl': 48,
} as const

// ── Border radii ────────────────────────────────────────────────

export const radii = {
    xs: 4,
    sm: 6,
    md: 8,
    lg: 10,
    xl: 12,
    '2xl': 16,
    '3xl': 20,
    full: 9999,
} as const

// ── Typography ──────────────────────────────────────────────────

export const fontSize = {
    xs: 11,
    sm: 13,
    md: 14,
    lg: 16,
    xl: 20,
    '2xl': 24,
    '3xl': 28,
    '4xl': 32,
    '5xl': 36,
} as const

// Display face — Space Grotesk, loaded via useFonts in app/_layout.tsx without
// blocking first paint. On web the family name gets a system-stack fallback so
// text renders in sans (not the browser serif default) while @font-face loads.
const WEB_SANS_FALLBACK =
    "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

export const fontFamily = {
    /** Headlines + big numerals (700). */
    display:
        Platform.OS === 'web'
            ? `SpaceGrotesk_700Bold, ${WEB_SANS_FALLBACK}`
            : 'SpaceGrotesk_700Bold',
    /** Display face at medium weight — labels/eyebrows that want the same voice. */
    displayMedium:
        Platform.OS === 'web'
            ? `SpaceGrotesk_500Medium, ${WEB_SANS_FALLBACK}`
            : 'SpaceGrotesk_500Medium',
} as const

export const fontWeight = {
    light: '300' as const,
    regular: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
    extrabold: '800' as const,
}

// ── Avatar sizes ────────────────────────────────────────────────

export const avatarSize = {
    sm: 38,
    md: 44,
    lg: 72,
    xl: 84,
} as const

// ── Brand dark surfaces ─────────────────────────────────────────
// The espresso "brand" surfaces (web sidebar + auth hero panel) and the
// cream text ramp that sits on them. Previously these hexes were hardcoded
// and duplicated across WebTabShell + sign-in + sign-up; now they live here.

export const brand = {
    surface:       '#2A1A0E', // sidebar / hero base
    surfaceDeep:   '#1A1008', // darkest hero background
    surfaceDeeper: '#160D06', // hero gradient end
    // cream text ramp on brand surfaces (primary → faint)
    on:        '#FFF6E8',
    onStrong:  '#E8D2B8',
    onMuted:   '#C9A988',
    onSubtle:  '#A9876B',
    onFaint:   '#A07A58', // ~4.8:1 on the darkest hero (was #8C6A4C ≈ 3.8:1)
    // interactive overlays + dividers on the dark brand surface
    overlay:      'rgba(255, 255, 255, 0.06)',
    overlayHover: 'rgba(255, 255, 255, 0.10)',
    border:       'rgba(255, 255, 255, 0.10)',
    borderSubtle: 'rgba(255, 255, 255, 0.08)',
    divider:      'rgba(0, 0, 0, 0.24)',
} as const

// ── Scrim ───────────────────────────────────────────────────────
// One warm espresso scrim for all modal/sheet backdrops (replaces the
// 4 drifting rgba black/brown values).
export const scrim = 'rgba(28, 18, 10, 0.55)' as const

// ── Elevation / shadows ─────────────────────────────────────────
// Warm-tinted shadow tokens. `elevation(level)` returns a platform-correct
// style fragment: web boxShadow string, native shadow props.

const SHADOW_WEB = {
    none: 'none',
    sm:  '0 1px 2px rgba(74, 37, 9, 0.06), 0 1px 3px rgba(74, 37, 9, 0.10)',
    md:  '0 4px 12px rgba(74, 37, 9, 0.10)',
    lg:  '0 16px 44px rgba(74, 37, 9, 0.16), 0 4px 12px rgba(74, 37, 9, 0.08)',
    xl:  '0 18px 48px rgba(74, 37, 9, 0.20)',
    topNav:    '0 -6px 24px rgba(74, 37, 9, 0.10)',
    brandGlow: '0 4px 12px rgba(201, 102, 15, 0.40)',
    brandGlowInset: '0 4px 12px rgba(201, 102, 15, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.3)',
} as const

export type ElevationLevel = 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'topNav' | 'brandGlow' | 'brandGlowInset'

const SHADOW_NATIVE: Record<ElevationLevel, object> = {
    none: {},
    sm:  { shadowColor: '#4A2509', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.10, shadowRadius: 3, elevation: 1 },
    md:  { shadowColor: '#4A2509', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 12, elevation: 3 },
    lg:  { shadowColor: '#4A2509', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.16, shadowRadius: 32, elevation: 8 },
    xl:  { shadowColor: '#4A2509', shadowOffset: { width: 0, height: 16 }, shadowOpacity: 0.22, shadowRadius: 44, elevation: 12 },
    topNav: { shadowColor: '#4A2509', shadowOffset: { width: 0, height: -6 }, shadowOpacity: 0.10, shadowRadius: 24, elevation: 8 },
    brandGlow: { shadowColor: palette.maple500, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.40, shadowRadius: 12, elevation: 6 },
    brandGlowInset: { shadowColor: palette.maple500, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.45, shadowRadius: 12, elevation: 6 },
}

export function elevation(level: ElevationLevel) {
    return Platform.OS === 'web' ? ({ boxShadow: SHADOW_WEB[level] } as object) : SHADOW_NATIVE[level]
}

export const shadows = SHADOW_WEB

// ── Motion ──────────────────────────────────────────────────────
// Named durations (ms) for transitions/micro-interactions. Honor
// prefers-reduced-motion at the call site.
export const motion = {
    duration: { instant: 80, fast: 140, base: 220, slow: 320 },
    pressedOpacity: 0.76,
} as const

// ── Layout ──────────────────────────────────────────────────────
// Shared content-column width so every primary tab fills the desktop
// content area the same way (Players is the reference at 1280). Applied to
// the screens that were previously capped narrow (Trades 680, League 760,
// Profile 640); Roster/Commissioner stay uncapped (already full-width).
export const layout = {
    contentMaxWidth: 1280,
} as const

// ── Breakpoints ─────────────────────────────────────────────────
// One source of truth for width breakpoints (mirrors web CSS + native
// useWindowDimensions logic).
export const breakpoints = {
    phone: 560,    // single-column / dense matchup
    roster: 760,   // roster card → stat table
    compact: 780,  // web shell: sidebar ↔ mobile top/bottom nav
    auth: 860,     // auth split hero ↔ stacked
    statTable: 920, // players: stacked stats ↔ full stat columns
    desktop: 1000, // draft room: single column ↔ two-column auction floor
    wide: 1200,    // extra breathing room
} as const

// ── Web theme CSS variables ─────────────────────────────────────
// Single source for the injected `--pancake-*` light-mode CSS variables
// (consumed via webColor()). Values reference `palette` so they can never
// drift from a second hand-maintained hex copy. Web is light-only (locked).
export const WEB_THEME_VARS: Record<string, string> = {
    'text-primary': palette.espresso,
    'text-secondary': palette.mocha,
    'text-muted': palette.latte,
    'text-placeholder': palette.cappuccino,
    'text-disabled': palette.oatmilk,
    'bg-screen': palette.cream100,
    'bg-card': palette.cream50,
    'bg-muted': palette.cream200,
    'bg-subtle': palette.cream150,
    'bg-input': palette.cream150,
    'separator': palette.cream300,
    'border': palette.cream400,
    'border-light': palette.cream300,
    'primary': palette.maple500,
    'primary-light': palette.maple50,
    'primary-border': palette.maple200,
    'primary-dark': palette.maple600,
    'danger': palette.red500,
    'danger-light': palette.red100,
    'danger-dark': palette.red900,
    'success': palette.green500,
    'success-light': palette.green100,
    'success-dark': palette.green900,
    'warning': palette.amber400,
    'warning-light': palette.amber300,
    'warning-dark': palette.amber600,
    'info': palette.purple500,
    'info-light': palette.purple100,
    'accent': palette.blue500,
}

// ── Domain color maps ───────────────────────────────────────────

export const INJURY_COLORS: Record<string, string> = {
    Questionable: palette.amber400,
    Doubtful: palette.maple500,
    Out: palette.red500,
    IR: palette.redDark,
}

export const TX_COLORS: Record<string, string> = {
    fa_add: palette.green500,
    waiver_add: palette.purple500,
    trade_in: palette.blue500,
    fa_drop: palette.red500,
    waiver_drop: palette.red500,
    trade_out: palette.maple500,
    ir_designate: palette.amber400,
    ir_return: palette.indigo500,
    draft_won: palette.green500,
}

export const TRADE_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
    // Text shades darkened to clear WCAG AA (>=4.5:1) on their badge backgrounds.
    pending: { bg: palette.amber300, text: palette.maple900 },
    accepted: { bg: palette.green100, text: palette.green900 },
    rejected: { bg: palette.red100, text: palette.red900 },
    withdrawn: { bg: palette.cream200, text: palette.mocha },
    completed: { bg: palette.green100, text: palette.green900 },
    expired: { bg: palette.cream200, text: palette.mocha },
    vetoed: { bg: palette.red100, text: palette.red900 },
}
