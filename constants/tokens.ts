import { Platform } from 'react-native'

// ── Raw palette ─────────────────────────────────────────────────
// Every color in the app lives here. Components import semantic
// aliases (below) or domain maps — never raw hex strings.

export const palette = {
    // ── Maple / Brand ── (warm amber — like Grade A dark maple syrup)
    maple50:  '#FEF6E4',
    maple100: '#FDEAC0',
    maple200: '#FAD490',
    maple500: '#C9660F',   // deep amber maple — the primary brand color
    maple600: '#A05212',
    maple900: '#6B3410',

    // ── Cream / Parchment ── (warm backgrounds — like unbleached breakfast paper)
    cream50:  '#FFFDF8',   // near-white warm — cards, inputs
    cream100: '#FDF8EE',   // warm screen background
    cream150: '#FAF2E2',   // subtle section backgrounds
    cream200: '#F4E8D2',   // muted areas
    cream300: '#E8D8BE',   // light borders
    cream400: '#D9C4A5',   // borders

    // ── Espresso / Brown ── (warm text — replaces cold gray text)
    espresso:   '#2C1A0E', // darkest — primary text
    coffee:     '#4A2E1C', // very dark — rich headers
    mocha:      '#6B4535', // secondary text
    latte:      '#9B7060', // muted text
    cappuccino: '#B8917F', // placeholder text
    oatmilk:    '#CCAA99', // disabled text

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

    // ── Position helpers ──
    orangeLight: '#E8832A', // warm maple-orange for SG/G flex
    greenLight:  '#34D399',

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
    bgInput:  webColor('bg-input', palette.cream50),   // '#FFFDF8' warm input bg

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
