import { describe, expect, it } from 'vitest'
import { getPositionColors, POSITION_COLOR_TOKENS } from '../../constants/positionColors'

function luminance(hex: string): number {
  const rgb = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}

describe('position color tokens', () => {
  it('keeps text readable in both themes', () => {
    for (const tokens of Object.values(POSITION_COLOR_TOKENS)) {
      for (const token of [tokens.light, tokens.dark]) {
        const values = [luminance(token.text), luminance(token.background)].sort((a, b) => a - b)
        expect((values[1] + 0.05) / (values[0] + 0.05)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
  it('covers every slot and uses a stable fallback', () => {
    for (const position of ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE', 'IR', 'TAXI']) {
      expect(getPositionColors(position, 'dark')).toBe(POSITION_COLOR_TOKENS[position].dark)
    }
    expect(getPositionColors('unknown')).toBe(POSITION_COLOR_TOKENS.UTIL.light)
  })
})
