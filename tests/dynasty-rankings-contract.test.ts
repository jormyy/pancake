import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const screen = readFileSync(path.join(root, 'app/(tabs)/dynasty.tsx'), 'utf8')
const hook = readFileSync(path.join(root, 'hooks/use-dynasty-rankings.ts'), 'utf8')

describe('Dynasty Rankings product contract', () => {
    it('keeps the required outer tab order', () => {
        const rankings = screen.indexOf("{ label: 'Rankings', value: 'rankings'")
        const news = screen.indexOf("{ label: 'News', value: 'news'")
        const myNews = screen.indexOf("{ label: 'My News', value: 'my-news'")

        expect(rankings).toBeGreaterThan(-1)
        expect(news).toBeGreaterThan(rankings)
        expect(myNews).toBeGreaterThan(news)
    })

    it('shows the four required ranking views in order', () => {
        const overall = screen.indexOf("{ label: 'Overall', value: 'overall' }")
        const contend = screen.indexOf("{ label: 'Contend', value: 'contend' }")
        const rebuild = screen.indexOf("{ label: 'Rebuild', value: 'rebuild' }")
        const rookies = screen.indexOf("{ label: 'Rookies & Picks', value: 'rookies-picks' }")

        expect(overall).toBeGreaterThan(-1)
        expect(contend).toBeGreaterThan(overall)
        expect(rebuild).toBeGreaterThan(contend)
        expect(rookies).toBeGreaterThan(rebuild)
    })

    it('shows value explanations and unknown pick ranges', () => {
        expect(screen).toContain('Production {formatPoints(player.shortTermPoints ?? 0)}')
        expect(screen).toContain('Projection {formatPoints(player.projectionPoints ?? 0)}')
        expect(screen).toContain('Confidence {confidenceText}')
        expect(screen).toContain('valueRange.low')
        expect(screen).toContain('Missing {player.missingInputs.join')
    })

    it('remounts the recycled ranking list when the view changes', () => {
        expect(screen).toContain('key={rankings.view}')
    })

    it('hydrates the scoped cache and rejects older responses', () => {
        expect(hook).toContain('readPersistentCache<DynastyRankingsCache>')
        expect(hook).toContain('requestSeqRef.current !== requestId')
        expect(hook).toContain('activeKeyRef.current !== cacheKey')
        expect(hook).toContain('writePersistentCache<DynastyRankingsCache>')
    })
})
