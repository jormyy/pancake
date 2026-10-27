export type PositionColorToken = { background: string; text: string; border: string }
type PositionThemeTokens = { light: PositionColorToken; dark: PositionColorToken }

function tokens(background: string, text: string, darkBackground: string, darkText: string): PositionThemeTokens {
  return { light: { background, text, border: text }, dark: { background: darkBackground, text: darkText, border: darkText } }
}

const neutral = tokens('#F1F5F9', '#334155', '#1E293B', '#E2E8F0')

export const POSITION_COLOR_TOKENS: Record<string, PositionThemeTokens> = {
  PG: tokens('#FEE2E2', '#991B1B', '#450A0A', '#FECACA'),
  SG: tokens('#FFEDD5', '#9A3412', '#431407', '#FED7AA'),
  SF: tokens('#DCFCE7', '#166534', '#052E16', '#BBF7D0'),
  PF: tokens('#CCFBF1', '#115E59', '#042F2E', '#99F6E4'),
  C: tokens('#F3E8FF', '#6B21A8', '#3B0764', '#E9D5FF'),
  G: tokens('#FEF3C7', '#92400E', '#451A03', '#FDE68A'),
  F: tokens('#ECFCCB', '#3F6212', '#1A2E05', '#D9F99D'),
  UTIL: neutral,
  BE: neutral,
  IR: tokens('#FFE4E6', '#9F1239', '#4C0519', '#FECDD3'),
  TAXI: tokens('#DBEAFE', '#1E40AF', '#172554', '#BFDBFE'),
}

export function getPositionColors(position: string | null | undefined, theme: 'light' | 'dark' = 'light'): PositionColorToken {
  return (POSITION_COLOR_TOKENS[position ?? ''] ?? POSITION_COLOR_TOKENS.UTIL)[theme]
}
