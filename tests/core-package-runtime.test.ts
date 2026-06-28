import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('@pancake/core package runtime', () => {
    it('is consumable from CommonJS backend builds', () => {
        const core = require('@pancake/core') as typeof import('@pancake/core')

        expect(core.currentSeasonYear(new Date('2026-10-01T12:00:00Z'))).toBe(2027)
        expect(core.calculateFantasyPoints(
            {
                points: 10,
                rebounds: 2,
                assists: 1,
                steals: 0,
                blocks: 0,
                turnovers: 0,
                threePointersMade: 0,
                fieldGoalsMade: 0,
                fieldGoalsAttempted: 0,
                freeThrowsMade: 0,
                freeThrowsAttempted: 0,
                doubleDouble: false,
                tripleDouble: false,
                didNotPlay: false,
            },
            { points: 1, rebounds: 1.2, assists: 1.5 },
        )).toBe(13.9)
    })

    it('keeps committed CommonJS output in sync with core source', () => {
        const result = spawnSync('npm', ['run', 'check:core-cjs'], {
            cwd: process.cwd(),
            encoding: 'utf8',
        })

        expect(result.status, result.stderr || result.stdout).toBe(0)
    })
})
