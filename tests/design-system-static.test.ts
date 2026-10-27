import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}))

describe('design system source guards', () => {

    it('keeps the spacing and radius ramps on the half-grid', async () => {
        const { foundation, radii, spacing } = await import('../constants/tokens')

        for (const value of Object.values(spacing)) {
            expect(value % foundation.halfGrid).toBe(0)
        }

        for (const [name, value] of Object.entries(radii)) {
            if (name === 'full') continue
            expect(value % foundation.halfGrid).toBe(0)
        }
    })

    it('keeps type and control sizes on a single monotonic scale', async () => {
        const { controlSize, fontSize, foundation } = await import('../constants/tokens')

        const typeRamp = Object.values(fontSize)
        for (let i = 1; i < typeRamp.length; i += 1) {
            expect(typeRamp[i]).toBeGreaterThanOrEqual(typeRamp[i - 1])
        }

        const buttonHeights = Object.values(controlSize.button).map((size) => size.height)
        expect(buttonHeights).toEqual([...buttonHeights].sort((a, b) => a - b))
        for (const height of buttonHeights) {
            expect(height % foundation.grid).toBe(0)
        }
        expect(controlSize.field.md).toBe(controlSize.button.md.height)
    })
})

describe('theme variables', () => {
    it('gives every themed light color a dark value, and nothing extra', async () => {
        const { WEB_THEME_VARS, WEB_THEME_VARS_DARK } = await import('../constants/tokens')

        expect(Object.keys(WEB_THEME_VARS_DARK).sort()).toEqual(Object.keys(WEB_THEME_VARS).sort())
    })

    it('stays light unless the Appearance choice asks for dark', async () => {
        const { themeVariablesCss } = await import('../constants/tokens')
        const css = themeVariablesCss()
        const darkStart = css.indexOf(':root[data-theme="dark"]{')
        const systemStart = css.indexOf('@media (prefers-color-scheme: dark){:root[data-theme="system"]{')

        expect(darkStart).toBeGreaterThan(0)
        expect(systemStart).toBeGreaterThan(darkStart)
        expect(css.slice(0, darkStart)).toContain('--pancake-bg-screen:#F7F1E8;')
        expect(css.slice(0, darkStart)).not.toContain('--pancake-bg-screen:#121614;')
        expect(css.slice(darkStart, systemStart)).toContain('--pancake-bg-screen:#121614;')
        expect(css.slice(systemStart)).toContain('--pancake-bg-screen:#121614;')
    })
})
