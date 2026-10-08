import { Platform, type TextStyle, type ViewStyle } from 'react-native'

// ── Raw palette ─────────────────────────────────────────────────
// Every color in the app lives here. Components import semantic
// aliases (below) or domain maps — never raw hex strings.

export const palette = {
    // ── Maple / Brand ──
    maple50:  '#FAEADC',
    maple100: '#F2D3B6',
    maple200: '#E2A36A',
    maple500: '#A65317',
    maple600: '#854314',
    maple900: '#4F2812',

    // ── Parchment / Neutral ──
    cream50:  '#FFFDF7',
    cream100: '#F7F1E8',
    cream150: '#F0E7D9',
    cream200: '#E8DAC7',
    cream300: '#D3C1AB',
    cream400: '#BFA88F',

    // ── Ink / Olive Neutrals ──
    espresso:   '#1F2421',
    coffee:     '#29332E',
    mocha:      '#4D5A54',
    latte:      '#627068',
    cappuccino: '#6D6155',
    oatmilk:    '#A99379',
    // Input hint text: lighter than typed values so a hint never reads as an answer.
    hint:       '#9A8B78',

    // ── Red ──
    red50:    '#FEF2F2',
    red100:   '#FEE2E2',
    red200:   '#FECACA',
    red300:   '#FCA5A5',
    red500:   '#EF4444',
    red600:   '#DC2626',
    red900:   '#991B1B',
    redDark:  '#7F1D1D',
    redBright:'#d00',

    // ── Green ──
    green50:  '#EDF7F1',
    green100: '#CFEADB',
    green200: '#B7DDC9',
    green300: '#DCFCE7',
    green500: '#2F7A5B',
    green600: '#276A4F',
    green700: '#205A43',
    green800: '#1D4939',
    green900: '#15372B',

    // ── Blue ──
    blue500: '#386C8F',

    // ── Purple ──
    purple100: '#EFE8F2',
    purple300: '#CBB8D6',
    purple500: '#7B558E',
    purple600: '#654275',

    // ── Indigo ──
    indigo500: '#6366F1',

    // ── Amber / Yellow ──
    amber200: '#FDE68A',
    amber300: '#F7E0AD',
    amber400: '#C7862B',
    amber600: '#9E671F',
    amber700: '#805017',

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

// ── Night palette ───────────────────────────────────────────────
// Warm near-black surfaces and a cream text ramp for dark mode. Accent hues
// are lifted so text and icons keep their contrast on dark surfaces.
const night = {
    bgScreen: '#121614',
    bgSubtle: '#171C19',
    bgCard:   '#1C221F',
    bgInput:  '#1F2622',
    bgMuted:  '#262E2A',
    separator: '#2D3530',
    border:    '#3D4641',
    textPrimary:     '#F3EEE4',
    textSecondary:   '#CFC8BC',
    textMuted:       '#A3ABA4',
    textPlaceholder: '#8C948D',
    textDisabled:    '#6A726C',
    maple:       '#F0A868',
    mapleStrong: '#F7C99A',
    mapleAccent: '#D9823F',
    mapleTint:   '#3A2618',
    mapleTintSoft: '#2A1D14',
    mapleBorder: '#7A4A26',
    mapleBorderSoft: '#5A3820',
    red:       '#F87171',
    redText:   '#FCA5A5',
    redTint:   '#3B1D1D',
    redTintSoft: '#2E1919',
    redBorder: '#6B2B2B',
    green:       '#4FB286',
    greenText:   '#9EE0BF',
    greenLive:   '#5FD39C',
    greenStrong: '#7FD9AE',
    greenTint:   '#173328',
    greenTintSoft: '#14261E',
    greenTintStrong: '#1D3A2C',
    greenBorder: '#2F5E48',
    amber:     '#E2A84B',
    amberText: '#F3C97C',
    amberTint: '#3A2C14',
    amberBorder: '#6B5320',
    purple:     '#B48FC7',
    purpleText: '#C9A6DA',
    purpleTint: '#2C2335',
    blue:   '#7FB0D3',
    indigo: '#8B8DF8',
    posCoral:  '#E07B6E',
    posBurnt:  '#E8924A',
    posForest: '#6DB878',
    posTeal:   '#4DB5A6',
    posPlum:   '#C98AC4',
    posAmber:  '#D4AE45',
    posSage:   '#9DB88E',
} as const

// Every themed color registers its light value here as it is declared, so the
// light CSS variables can never drift from the tokens that use them.
const LIGHT_THEME: Record<string, string> = {}

function webColor(name: string, fallback: string) {
    LIGHT_THEME[name] = fallback
    return Platform.OS === 'web' ? `var(--pancake-${name}, ${fallback})` : fallback
}

// Tint a color: rgba() for a hex value. A themed CSS-variable color can't be
// parsed, so on web it mixes with transparent and follows the active theme.
export function alpha(color: string, a: number): string {
    if (!color.startsWith('#')) return `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`
    let h = color.replace('#', '')
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${a})`
}

const GRID = 4
const unit = (steps: number) => steps * GRID
const halfUnit = (steps: number) => steps * (GRID / 2)

export const foundation = {
    grid: GRID,
    halfGrid: GRID / 2,
    minTouch: unit(11),
} as const

// ── Semantic tokens ─────────────────────────────────────────────

export const colors = {
    // Text
    textPrimary:     webColor('text-primary', palette.espresso),
    textSecondary:   webColor('text-secondary', palette.mocha),
    textMuted:       webColor('text-muted', palette.latte),
    textPlaceholder: webColor('text-placeholder', palette.cappuccino),
    textDisabled:    webColor('text-disabled', palette.oatmilk),
    inputPlaceholder: webColor('input-placeholder', palette.hint),
    textWhite:       palette.white,
    // Text on a solid status fill (danger, info, taxi). Those fills lighten in
    // dark mode, so the text flips to near-black there to stay readable.
    onAccent:        webColor('on-accent', palette.white),

    // Backgrounds
    bgScreen: webColor('bg-screen', palette.cream100),
    bgCard:   webColor('bg-card', palette.cream50),
    bgMuted:  webColor('bg-muted', palette.cream200),
    bgSubtle: webColor('bg-subtle', palette.cream150),
    bgInput:  webColor('bg-input', palette.cream150),

    // Borders / separators
    separator:   webColor('separator', palette.cream300),
    border:      webColor('border', palette.cream400),
    borderLight: webColor('border-light', palette.cream300),

    // Primary
    primary:       webColor('primary', palette.maple500),
    primaryLight:  webColor('primary-light', palette.maple50),
    primaryBorder: webColor('primary-border', palette.maple200),
    primaryDark:   webColor('primary-dark', palette.maple600),
    // Hover fill behind white text. Dark mode lightens primaryDark for text, so
    // fills keep this deeper maple in both themes.
    primaryHover:  palette.maple600,

    // Danger (red)
    danger:     webColor('danger', palette.red600),
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
    xxs: halfUnit(1),
    xs: unit(1),
    sm: halfUnit(3),
    md: unit(2),
    lg: unit(3),
    xl: unit(4),
    '2xl': unit(5),
    '3xl': unit(6),
    '4xl': unit(8),
    '5xl': unit(10),
    '6xl': unit(12),
} as const

// ── Border radii ────────────────────────────────────────────────

export const radii = {
    xs: unit(1),
    sm: halfUnit(3),
    md: unit(2),
    lg: halfUnit(5),
    xl: unit(3),
    '2xl': unit(4),
    '3xl': unit(5),
    full: 9999,
} as const

// ── Typography ──────────────────────────────────────────────────

const TYPE_SCALE = [10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36] as const

export const fontSize = {
    '2xs': TYPE_SCALE[0],
    xs: TYPE_SCALE[1],
    '2sm': TYPE_SCALE[2],
    sm: TYPE_SCALE[3],
    md: TYPE_SCALE[4],
    lg: TYPE_SCALE[5],
    '2lg': TYPE_SCALE[6],
    xl: TYPE_SCALE[7],
    '2xl': TYPE_SCALE[8],
    '3xl': TYPE_SCALE[9],
    '4xl': TYPE_SCALE[10],
    '5xl': TYPE_SCALE[11],
} as const

// Display face — Outfit, loaded via useFonts in app/_layout.tsx without
// blocking first paint. On web the family name gets a system-stack fallback so
// text renders in sans (not the browser serif default) while @font-face loads.
const WEB_SANS_FALLBACK =
    "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

export const fontFamily = {
    /** Headlines + big numerals (700). */
    display:
        Platform.OS === 'web'
            ? `Outfit_700Bold, ${WEB_SANS_FALLBACK}`
            : 'Outfit_700Bold',
    /** Display face at medium weight — labels/eyebrows that want the same voice. */
    displayMedium:
        Platform.OS === 'web'
            ? `Outfit_600SemiBold, ${WEB_SANS_FALLBACK}`
            : 'Outfit_600SemiBold',
    control:
        Platform.OS === 'web'
            ? `Outfit_500Medium, ${WEB_SANS_FALLBACK}`
            : 'Outfit_500Medium',
} as const

export const fontWeight = {
    light: '300' as const,
    regular: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
    extrabold: '800' as const,
    black: '900' as const,
}

const tabularNums: TextStyle['fontVariant'] = ['tabular-nums']

// Text roles. Screens pick a role instead of a raw size so the hierarchy reads
// the same everywhere: hero number > page title > row title > body > meta > label.
export const textStyles = {
    hero: { fontFamily: fontFamily.display, fontSize: fontSize['5xl'], lineHeight: 40, fontWeight: fontWeight.black, fontVariant: tabularNums },
    pageTitle: { fontFamily: fontFamily.display, fontSize: fontSize.xl, lineHeight: 26, fontWeight: fontWeight.bold, color: colors.textPrimary },
    rowTitle: { fontSize: fontSize.md, lineHeight: 18, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    body: { fontSize: fontSize.md, lineHeight: 20, color: colors.textSecondary },
    meta: { fontSize: fontSize['2sm'], lineHeight: 16, color: colors.textMuted },
    sectionLabel: { fontSize: fontSize.xs, lineHeight: 14, fontWeight: fontWeight.extrabold, letterSpacing: 0.8, textTransform: 'uppercase' as const, color: colors.textMuted },
    stat: { fontSize: fontSize['2sm'], fontVariant: tabularNums, color: colors.textSecondary },
    tableHeader: { fontSize: fontSize['2xs'], lineHeight: 12, fontWeight: fontWeight.extrabold, letterSpacing: 0.6, textTransform: 'uppercase' as const, color: colors.textMuted },
    tableCell: { fontSize: fontSize.sm, fontVariant: tabularNums, color: colors.textSecondary },
} satisfies Record<string, TextStyle>

// Data tables (roster, players, standings, rankings, trades). One spec so
// every table has the same header, row height, and column rhythm.
export const table = {
    headerHeight: 32,
    rowHeight: 52,
    rowHeightCompact: 44,
    statColWidth: 44,
    cellPadX: spacing.sm,
} as const

export const controlSize = {
    minTouch: foundation.minTouch,
    button: {
        sm: { height: unit(11), padX: spacing.lg, font: fontSize.sm, icon: unit(4), gap: spacing.sm },
        md: { height: unit(12), padX: spacing.xl, font: fontSize.md, icon: halfUnit(9), gap: spacing.md },
        lg: { height: unit(13), padX: spacing['3xl'], font: fontSize.lg, icon: unit(5), gap: spacing.md },
    },
    field: {
        md: unit(12),
    },
} as const

// ── Brand dark surfaces ─────────────────────────────────────────
// The espresso "brand" surfaces (web sidebar + auth hero panel) and the
// cream text ramp that sits on them. Previously these hexes were hardcoded
// and duplicated across WebTabShell + sign-in + sign-up; now they live here.

export const brand = {
    surface:       '#18211D',
    surfaceDeep:   '#101713',
    surfaceDeeper: '#0B110E',
    on:        '#FFF8EA',
    onStrong:  '#DDE5D7',
    onMuted:   '#BFC6B4',
    onSubtle:  '#9FA690',
    onFaint:   '#8E937F',
    overlay:      'rgba(255, 248, 234, 0.07)',
    overlayHover: 'rgba(255, 248, 234, 0.12)',
    border:       'rgba(255, 248, 234, 0.12)',
    borderSubtle: 'rgba(255, 248, 234, 0.08)',
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
    sm:  '0 1px 2px rgba(34, 41, 36, 0.06), 0 1px 3px rgba(34, 41, 36, 0.08)',
    md:  '0 8px 22px rgba(34, 41, 36, 0.10)',
    lg:  '0 18px 48px rgba(34, 41, 36, 0.14), 0 4px 14px rgba(34, 41, 36, 0.08)',
    xl:  '0 24px 70px rgba(34, 41, 36, 0.18)',
    topNav:    '0 -8px 28px rgba(34, 41, 36, 0.12)',
    brandGlow: '0 10px 24px rgba(166, 83, 23, 0.26)',
    brandGlowInset: '0 10px 24px rgba(166, 83, 23, 0.30), inset 0 1px 0 rgba(255, 255, 255, 0.28)',
} as const

export type ElevationLevel = 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'topNav' | 'brandGlow' | 'brandGlowInset'

const SHADOW_NATIVE: Record<ElevationLevel, object> = {
    none: {},
    sm:  { shadowColor: palette.coffee, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 3, elevation: 1 },
    md:  { shadowColor: palette.coffee, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.10, shadowRadius: 16, elevation: 3 },
    lg:  { shadowColor: palette.coffee, shadowOffset: { width: 0, height: 14 }, shadowOpacity: 0.14, shadowRadius: 34, elevation: 8 },
    xl:  { shadowColor: palette.coffee, shadowOffset: { width: 0, height: 18 }, shadowOpacity: 0.18, shadowRadius: 46, elevation: 12 },
    topNav: { shadowColor: palette.coffee, shadowOffset: { width: 0, height: -6 }, shadowOpacity: 0.10, shadowRadius: 24, elevation: 8 },
    brandGlow: { shadowColor: palette.maple500, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.40, shadowRadius: 12, elevation: 6 },
    brandGlowInset: { shadowColor: palette.maple500, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.45, shadowRadius: 12, elevation: 6 },
}

export function elevation(level: ElevationLevel) {
    return Platform.OS === 'web' ? ({ boxShadow: SHADOW_WEB[level] } as object) : SHADOW_NATIVE[level]
}

export const shadows = SHADOW_WEB

export type WebOnlyViewStyle = ViewStyle & {
    backdropFilter?: string
    WebkitBackdropFilter?: string
    backgroundImage?: string
    boxShadow?: string
}

export const webBackgrounds = {
    appRoot: webColor('image-app-root', 'radial-gradient(circle at 22% 0%, rgba(166, 83, 23, 0.10), transparent 32%), radial-gradient(circle at 78% 10%, rgba(47, 122, 91, 0.12), transparent 30%), linear-gradient(180deg, #FFFDF7 0%, #F7F1E8 42%, #EFE5D6 100%)'),
    appContent: webColor('image-app-content', 'radial-gradient(circle at 74% -10%, rgba(47, 122, 91, 0.12), transparent 30%), linear-gradient(180deg, rgba(255, 253, 247, 0.92), rgba(247, 241, 232, 0.98))'),
    authScreen: webColor('image-auth-screen', 'radial-gradient(circle at 84% 8%, rgba(47, 122, 91, 0.12), transparent 32%), linear-gradient(135deg, #FFFDF7 0%, #F7F1E8 54%, #EDE0CE 100%)'),
    authHero: `radial-gradient(circle at 24% 12%, rgba(166, 83, 23, 0.30), transparent 30%), radial-gradient(circle at 80% 30%, rgba(47, 122, 91, 0.22), transparent 34%), linear-gradient(155deg, ${brand.surface} 0%, ${brand.surfaceDeeper} 100%)`,
    noLeague: webColor('image-no-league', 'radial-gradient(circle at 78% 8%, rgba(47, 122, 91, 0.12), transparent 34%), linear-gradient(145deg, #FFFDF7, #F7F1E8)'),
    sidebar: `radial-gradient(circle at 18% 0%, rgba(166, 83, 23, 0.26), transparent 34%), linear-gradient(180deg, ${brand.surface} 0%, ${brand.surfaceDeeper} 100%)`,
} as const

export const webOverlays = {
    brandPreview: 'rgba(255, 248, 234, 0.08)',
    mobileTopbar: webColor('overlay-mobile-topbar', 'rgba(255, 253, 247, 0.90)'),
    mobileBottomNav: webColor('overlay-mobile-bottom-nav', 'rgba(255, 253, 247, 0.94)'),
    navBadgeActive: 'rgba(255, 255, 255, 0.28)',
    sheetScrim: 'rgba(16, 23, 19, 0.48)',
    scoreboardBorder: 'rgba(255,255,255,0.07)',
    scoreboardHidden: 'rgba(255,255,255,0.18)',
    scoreboardMuted: 'rgba(255,255,255,0.30)',
    scoreboardFaint: 'rgba(255,255,255,0.20)',
    liveGlow: '0 0 14px rgba(166, 83, 23, 0.35)',
} as const

// Fades the right edge of a scroll strip so more items read as "swipe for more".
export const webMasks = {
    fadeRight: 'linear-gradient(to right, black calc(100% - 40px), transparent)',
    fadeLeft: 'linear-gradient(to right, transparent, black 40px)',
    fadeBoth: 'linear-gradient(to right, transparent, black 40px, black calc(100% - 40px), transparent)',
} as const

export const webChrome = {
    themeColor: palette.cream100,
    themeColorDark: night.bgScreen,
    rootBackgroundCss: `html,body,#root{background-color:${palette.cream100};}`
        + `@media (prefers-color-scheme: dark){html,body,#root{background-color:${night.bgScreen};}}`,
} as const

export const tints = {
    selectedIndicatorStrong: alpha(palette.white, 0.7),
    selectedIndicatorMuted: alpha(palette.white, 0.5),
    dangerAction: alpha(palette.red500, 0.13),
    dangerActionStrong: alpha(palette.red900, 0.13),
    dangerFocusRing: alpha(palette.red500, 0.14),
    neutralAction: alpha(palette.latte, 0.13),
    selectBackdrop: alpha(palette.espresso, 0.36),
} as const

export const uiColors = {
    accentDanger: webColor('ui-accent-danger', palette.red500),
    accentPick: webColor('ui-accent-pick', palette.indigo500),
    accentSuccess: webColor('ui-accent-success', palette.green500),
    brandAccent: webColor('ui-brand-accent', palette.maple500),
    brandBorder: webColor('ui-brand-border', palette.maple200),
    brandBorderSoft: webColor('ui-brand-border-soft', palette.maple100),
    brandSurface: webColor('ui-brand-surface', palette.maple100),
    brandSurfaceSoft: webColor('ui-brand-surface-soft', palette.maple50),
    brandText: webColor('ui-brand-text', palette.maple600),
    brandTextStrong: webColor('ui-brand-text-strong', palette.maple900),
    borderNeutral: webColor('ui-border-neutral', palette.gray300),
    dangerBorder: webColor('ui-danger-border', palette.red200),
    dangerSurface: webColor('ui-danger-surface', palette.red50),
    dangerText: webColor('ui-danger-text', palette.red900),
    neutralSolid: webColor('ui-neutral-solid', palette.mocha),
    neutralTint: webColor('ui-neutral-tint', palette.latte),
    successBorder: webColor('ui-success-border', palette.green200),
    successSurface: webColor('ui-success-surface', palette.green50),
    successSurfaceStrong: webColor('ui-success-surface-strong', palette.green300),
    successText: webColor('ui-success-text', palette.green800),
    successTextLive: webColor('ui-success-text-live', palette.green600),
    successTextStrong: webColor('ui-success-text-strong', palette.green700),
    surfaceAlt: webColor('ui-surface-alt', palette.gray50),
    tableText: webColor('ui-table-text', palette.gray900),
    taxi: webColor('ui-taxi', palette.purple500),
    textFaint: webColor('ui-text-faint', palette.gray500),
    textLost: webColor('ui-text-lost', palette.gray650),
    warningBorder: webColor('ui-warning-border', palette.amber200),
    warningSurface: webColor('ui-warning-surface', palette.amber300),
    warningText: webColor('ui-warning-text', palette.amber600),
    waiverText: webColor('ui-waiver-text', palette.purple600),
} as const

export const scoreboardColors = {
    background: brand.surface,
    card: brand.surfaceDeep,
    textMuted: brand.onFaint,
    accent: palette.maple200,
    accentSoft: palette.maple100,
    hidden: webOverlays.scoreboardHidden,
    border: webOverlays.scoreboardBorder,
    statusMuted: webOverlays.scoreboardMuted,
    statusFinal: webOverlays.scoreboardFaint,
    liveGlow: webOverlays.liveGlow,
} as const

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
    // Readable form/settings column on wide screens (was inlined as 640/720/760).
    formMaxWidth: 720,
    // Head-to-head lineup column. Wider than this, a player's name drifts away
    // from the points at the row's outer edge.
    lineupMaxWidth: 680,
    // Box-score lineup: grows to this when there's room for names and games.
    statLineupMaxWidth: 1120,
    // Side column on two-pane screens (other matchups, scoreboard, details).
    railWidth: 320,
    // Web app shell sidebar shown at breakpoints.compact and wider.
    sidebarWidth: 264,
    pagePadX: { compact: spacing.lg, regular: spacing['3xl'] },
} as const

// Visually-hidden but screen-reader-available. Use for headings/labels that
// exist for AT structure but are shown visually by another element. Single
// source instead of re-inlining the absolute/1px clip in every screen.
export const srOnly = {
    position: 'absolute' as const,
    width: 1,
    height: 1,
    margin: -1,
    overflow: 'hidden' as const,
    opacity: 0,
}

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

// ── Domain color maps ───────────────────────────────────────────

// Solid-badge backgrounds darkened so the white 11px label clears WCAG AA (>=4.5:1).
export const INJURY_COLORS: Record<string, string> = {
    Questionable: palette.amber700,
    Doubtful: palette.maple600,
    Out: palette.red900,
    IR: palette.redDark,
}

// Transaction colors follow the theme so soft badges stay readable in dark mode.
export const TX_COLORS: Record<string, string> = {
    fa_add: webColor('tx-add', palette.green500),
    waiver_add: webColor('tx-waiver', palette.purple500),
    trade_in: webColor('tx-trade-in', palette.blue500),
    fa_drop: webColor('tx-drop', palette.red500),
    waiver_drop: webColor('tx-drop', palette.red500),
    trade_out: webColor('tx-trade-out', palette.maple500),
    ir_designate: webColor('tx-ir', palette.amber400),
    ir_return: webColor('tx-ir-return', palette.indigo500),
    draft_won: webColor('tx-add', palette.green500),
}

export const TRADE_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
    // Text shades darkened to clear WCAG AA (>=4.5:1) on their badge backgrounds.
    pending: { bg: webColor('status-pending-bg', palette.amber300), text: webColor('status-pending-text', palette.maple900) },
    accepted: { bg: webColor('status-good-bg', palette.green100), text: webColor('status-good-text', palette.green900) },
    rejected: { bg: webColor('status-bad-bg', palette.red100), text: webColor('status-bad-text', palette.red900) },
    withdrawn: { bg: webColor('status-neutral-bg', palette.cream200), text: webColor('status-neutral-text', palette.mocha) },
    completed: { bg: webColor('status-good-bg', palette.green100), text: webColor('status-good-text', palette.green900) },
    expired: { bg: webColor('status-neutral-bg', palette.cream200), text: webColor('status-neutral-text', palette.mocha) },
    vetoed: { bg: webColor('status-bad-bg', palette.red100), text: webColor('status-bad-text', palette.red900) },
}

// Position identity hues. Light values keep white chip text >=4.5:1 (WCAG AA);
// dark values are lifted so tinted chips and labels stay readable on dark.
export const positionColors: Record<string, string> = {
    PG: webColor('pos-pg', palette.posCoral),
    SG: webColor('pos-sg', palette.posBurnt),
    SF: webColor('pos-sf', palette.posForest),
    PF: webColor('pos-pf', palette.posTeal),
    C:  webColor('pos-c', palette.posPlum),
    G:  webColor('pos-g', palette.posAmber),
    F:  webColor('pos-f', palette.posSage),
}

// ── Web theme CSS variables ─────────────────────────────────────
// Light values come from the tokens themselves (LIGHT_THEME). Dark values are
// listed here, one per light value; a test keeps the two sets of names equal.
// Web follows the system setting; native stays light.
export const WEB_THEME_VARS: Record<string, string> = LIGHT_THEME

const darkImage = (glow: string) =>
    `radial-gradient(circle at 22% 0%, rgba(240, 168, 104, 0.07), transparent 32%), ${glow}linear-gradient(180deg, ${night.bgSubtle} 0%, ${night.bgScreen} 100%)`

export const WEB_THEME_VARS_DARK: Record<string, string> = {
    'text-primary': night.textPrimary,
    'text-secondary': night.textSecondary,
    'text-muted': night.textMuted,
    'text-placeholder': night.textPlaceholder,
    'text-disabled': night.textDisabled,
    'input-placeholder': '#7A827B',
    'on-accent': night.bgScreen,
    'bg-screen': night.bgScreen,
    'bg-card': night.bgCard,
    'bg-muted': night.bgMuted,
    'bg-subtle': night.bgSubtle,
    'bg-input': night.bgInput,
    'separator': night.separator,
    'border': night.border,
    'border-light': night.separator,
    'primary': palette.maple500,
    'primary-light': night.mapleTint,
    'primary-border': night.mapleBorder,
    'primary-dark': night.maple,
    'danger': night.red,
    'danger-light': night.redTint,
    'danger-dark': night.redText,
    'success': night.green,
    'success-light': night.greenTint,
    'success-dark': night.greenText,
    'warning': night.amber,
    'warning-light': night.amberTint,
    'warning-dark': night.amberText,
    'info': night.purple,
    'info-light': night.purpleTint,
    'accent': night.blue,
    'image-app-root': darkImage('radial-gradient(circle at 78% 10%, rgba(79, 178, 134, 0.06), transparent 30%), '),
    'image-app-content': darkImage(''),
    'image-auth-screen': darkImage('radial-gradient(circle at 84% 8%, rgba(79, 178, 134, 0.06), transparent 32%), '),
    'image-no-league': darkImage(''),
    'overlay-mobile-topbar': 'rgba(18, 22, 20, 0.90)',
    'overlay-mobile-bottom-nav': 'rgba(18, 22, 20, 0.94)',
    'ui-accent-danger': night.red,
    'ui-accent-pick': night.indigo,
    'ui-accent-success': night.green,
    'ui-brand-accent': night.mapleAccent,
    'ui-brand-border': night.mapleBorder,
    'ui-brand-border-soft': night.mapleBorderSoft,
    'ui-brand-surface': night.mapleTint,
    'ui-brand-surface-soft': night.mapleTintSoft,
    'ui-brand-text': night.maple,
    'ui-brand-text-strong': night.mapleStrong,
    'ui-border-neutral': night.border,
    'ui-danger-border': night.redBorder,
    'ui-danger-surface': night.redTintSoft,
    'ui-danger-text': night.redText,
    'ui-neutral-solid': night.textSecondary,
    'ui-neutral-tint': night.textMuted,
    'ui-success-border': night.greenBorder,
    'ui-success-surface': night.greenTintSoft,
    'ui-success-surface-strong': night.greenTintStrong,
    'ui-success-text': night.greenText,
    'ui-success-text-live': night.greenLive,
    'ui-success-text-strong': night.greenStrong,
    'ui-surface-alt': night.bgCard,
    'ui-table-text': night.textPrimary,
    'ui-taxi': night.purple,
    'ui-text-faint': night.textDisabled,
    'ui-text-lost': night.textPlaceholder,
    'ui-warning-border': night.amberBorder,
    'ui-warning-surface': night.amberTint,
    'ui-warning-text': night.amberText,
    'ui-waiver-text': night.purpleText,
    'status-pending-bg': night.amberTint,
    'status-pending-text': night.amberText,
    'status-good-bg': night.greenTint,
    'status-good-text': night.greenText,
    'status-bad-bg': night.redTint,
    'status-bad-text': night.redText,
    'status-neutral-bg': night.bgMuted,
    'status-neutral-text': night.textSecondary,
    'tx-add': night.greenLive,
    'tx-waiver': night.purpleText,
    'tx-trade-in': night.blue,
    'tx-drop': night.redText,
    'tx-trade-out': night.maple,
    'tx-ir': night.amberText,
    'tx-ir-return': night.indigo,
    'pos-pg': night.posCoral,
    'pos-sg': night.posBurnt,
    'pos-sf': night.posForest,
    'pos-pf': night.posTeal,
    'pos-c': night.posPlum,
    'pos-g': night.posAmber,
    'pos-f': night.posSage,
}

/** CSS that declares both themes: light by default, dark when the system asks. */
export function themeVariablesCss(): string {
    const declarations = (vars: Record<string, string>) =>
        Object.entries(vars).map(([name, value]) => `--pancake-${name}:${value};`).join('')
    return `:root{${declarations(WEB_THEME_VARS)}}`
        + `@media (prefers-color-scheme: dark){:root{${declarations(WEB_THEME_VARS_DARK)}color-scheme:dark;}}`
}
