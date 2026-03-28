// ── Raw palette ─────────────────────────────────────────────────
// Every color in the app lives here. Components import semantic
// aliases (below) or domain maps — never raw hex strings.

export const palette = {
    // Brand
    orange50: '#FFF7ED',
    orange100: '#FFE4CC',
    orange200: '#FED7AA',
    orange500: '#F97316',
    orange600: '#C2410C',
    orange900: '#9A3412',

    // Red
    red50: '#FEF2F2',
    red100: '#FEE2E2',
    red500: '#EF4444',
    red900: '#991B1B',
    redDark: '#7F1D1D',
    redBright: '#d00',

    // Green
    green50: '#F0FDF4',
    green100: '#D1FAE5',
    green200: '#BBF7D0',
    green300: '#DCFCE7',
    green500: '#10B981',
    green600: '#16A34A',
    green700: '#15803D',
    green800: '#166534',
    green900: '#065F46',

    // Blue
    blue500: '#3B82F6',

    // Purple
    purple100: '#EDE9FE',
    purple300: '#C4B5FD',
    purple500: '#8B5CF6',

    // Indigo
    indigo500: '#6366F1',

    // Amber / Yellow
    amber200: '#FDE68A',
    amber300: '#FEF3C7',
    amber400: '#F59E0B',
    amber600: '#D97706',

    // Orange helpers (position)
    orangeLight: '#FB923C',

    // Green helpers (position)
    greenLight: '#34D399',

    // Neutrals
    white: '#fff',
    gray50: '#fafafa',
    gray100: '#f9f9f9',
    gray150: '#f5f5f5',
    gray200: '#f3f3f3',
    gray250: '#f0f0f0',
    gray300: '#e5e7eb',
    gray350: '#eee',
    gray400: '#ddd',
    gray500: '#ccc',
    gray550: '#bbb',
    gray600: '#aaa',
    gray650: '#999',
    gray700: '#888',
    gray750: '#6B7280',
    gray800: '#666',
    gray850: '#555',
    gray900: '#333',
    gray950: '#111',
    black: '#11181C',
} as const

// ── Semantic tokens ─────────────────────────────────────────────

export const colors = {
    // Text
    textPrimary: palette.gray950,
    textSecondary: palette.gray850,
    textMuted: palette.gray700,
    textPlaceholder: palette.gray600,
    textDisabled: palette.gray550,
    textWhite: palette.white,

    // Backgrounds
    bgScreen: palette.white,
    bgCard: palette.white,
    bgMuted: palette.gray200,
    bgSubtle: palette.gray150,
    bgInput: palette.gray50,

    // Borders / Separators
    separator: palette.gray200,
    border: palette.gray400,
    borderLight: palette.gray350,

    // Primary (orange)
    primary: palette.orange500,
    primaryLight: palette.orange50,
    primaryBorder: palette.orange200,
    primaryDark: palette.orange600,

    // Danger (red)
    danger: palette.red500,
    dangerLight: palette.red100,
    dangerDark: palette.red900,

    // Success (green)
    success: palette.green500,
    successLight: palette.green100,
    successDark: palette.green900,

    // Warning (amber)
    warning: palette.amber400,
    warningLight: palette.amber300,
    warningDark: palette.amber600,

    // Info (purple)
    info: palette.purple500,
    infoLight: palette.purple100,

    // Accent (blue)
    accent: palette.blue500,
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
    Doubtful: palette.orange500,
    Out: palette.red500,
    IR: palette.redDark,
}

export const TX_COLORS: Record<string, string> = {
    fa_add: palette.green500,
    waiver_add: palette.purple500,
    trade_in: palette.blue500,
    fa_drop: palette.red500,
    waiver_drop: palette.red500,
    trade_out: palette.orange500,
    ir_designate: palette.amber400,
    ir_return: palette.indigo500,
    draft_won: palette.green500,
}

export const TRADE_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
    pending: { bg: palette.amber300, text: palette.amber600 },
    accepted: { bg: palette.green100, text: palette.green900 },
    rejected: { bg: palette.red100, text: palette.red900 },
    withdrawn: { bg: '#F3F4F6', text: palette.gray750 },
    completed: { bg: palette.green100, text: palette.green900 },
    expired: { bg: '#F3F4F6', text: palette.gray750 },
    vetoed: { bg: palette.red100, text: palette.red900 },
}
