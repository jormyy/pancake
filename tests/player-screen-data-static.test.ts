import { describe, expect, it } from 'vitest'
import { read } from './source-guard'

describe('player screen season cache guards', () => {
    it('invalidates in-flight season requests when the player route changes', () => {
        const source = read('hooks/use-player-screen-data.ts')
        const playerLoadEffect = source.slice(
            source.indexOf('useEffect(() => {'),
            source.indexOf('async function load()'),
        )

        expect(playerLoadEffect).toContain('seasonRequestRef.current += 1')
        expect(source).toContain('if (!player || player.id !== playerId) return')
    })

    it('clears season-bound state on uncached season changes before loading new data', () => {
        const source = read('hooks/use-player-screen-data.ts')
        const requestIndex = source.indexOf('const requestId = ++seasonRequestRef.current')
        const cacheHitIndex = source.indexOf('const cached = seasonCacheRef.current.get(key)')
        const cacheMissBlock = source.slice(
            requestIndex,
            source.indexOf('async function loadSeasonData()'),
        )

        expect(requestIndex).toBeGreaterThan(-1)
        expect(cacheHitIndex).toBeGreaterThan(-1)
        expect(requestIndex).toBeLessThan(cacheHitIndex)
        expect(cacheMissBlock).toContain('setSeasonAverages(null)')
        expect(cacheMissBlock).toContain('setGameLog([])')
        expect(cacheMissBlock).toContain('setGameLogOffset(0)')
        expect(cacheMissBlock).toContain('setHasMoreGames(false)')
        expect(cacheMissBlock).toContain('setFantasyPointsMap(null)')
        expect(cacheMissBlock).toContain('setAvgFantasyPoints(0)')
    })
})
