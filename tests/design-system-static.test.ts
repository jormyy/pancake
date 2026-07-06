import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ROOT, read } from './source-guard'

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}))

const UI_ROOTS = ['app', 'components']
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])
const COLOR_LITERAL = /#[0-9A-Fa-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g
const DIRECT_PALETTE = /\bpalette\s*\.|\bpalette\b(?=[^}]*}\s*from\s*['"]@\/constants\/tokens['"])/g

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const fullPath = path.join(dir, entry)
        const stat = statSync(fullPath)
        if (stat.isDirectory()) return sourceFiles(fullPath)
        return SOURCE_EXTENSIONS.has(path.extname(entry)) ? [fullPath] : []
    })
}

const uiFiles = UI_ROOTS.flatMap((dir) => sourceFiles(path.join(ROOT, dir)))

describe('design system source guards', () => {
    it('keeps runtime UI colors behind semantic token exports', () => {
        const offenders = uiFiles.flatMap((file) => {
            const rel = path.relative(ROOT, file)
            const source = read(rel)
            const colorMatches = source.match(COLOR_LITERAL) ?? []
            const paletteMatches = source.match(DIRECT_PALETTE) ?? []
            return [...colorMatches, ...paletteMatches].map((match) => `${rel}: ${match}`)
        })

        expect(offenders).toEqual([])
    })

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
            expect(typeRamp[i]).toBeGreaterThan(typeRamp[i - 1])
        }

        const buttonHeights = Object.values(controlSize.button).map((size) => size.height)
        expect(buttonHeights).toEqual([...buttonHeights].sort((a, b) => a - b))
        for (const height of buttonHeights) {
            expect(height % foundation.grid).toBe(0)
        }
        expect(controlSize.field.md).toBe(controlSize.button.md.height)
    })

    it('routes shared primitives through the control-size token system', () => {
        expect(read('components/ui/Button.tsx')).toContain('controlSize.button')
        expect(read('components/ui/Input.tsx')).toContain('controlSize.field.md')
    })
})
