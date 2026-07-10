import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('screen error fallback', () => {
    it('keeps the recovery action at least 44px tall', () => {
        const source = readFileSync(
            path.join(process.cwd(), 'components/ScreenErrorFallback.tsx'),
            'utf8',
        )

        expect(source).toMatch(/button:\s*\{[^}]*minHeight:\s*44/s)
    })
})
