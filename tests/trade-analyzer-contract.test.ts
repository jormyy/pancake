import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const screen = readFileSync('app/(tabs)/trades.tsx', 'utf8')
const analyzer = readFileSync('components/trades/TradeAnalyzer.tsx', 'utf8')
const summary = readFileSync('components/trades/TradeAnalysisSummary.tsx', 'utf8')
const proposal = readFileSync('app/(modals)/propose-trade.tsx', 'utf8')

describe('trade analyzer product contract', () => {
    it('keeps the required trade tab order', () => {
        const labels = ['Picks', 'Offers', 'Analyzer', 'My Block', 'League', 'History']
        const positions = labels.map((label) => screen.indexOf(`label: '${label}'`))
        expect(positions.every((position) => position >= 0)).toBe(true)
        expect(positions).toEqual([...positions].sort((left, right) => left - right))
    })

    it('supports strategy, multi-team assets, offline safety, and an explicit handoff', () => {
        expect(analyzer).toContain("label: 'Overall'")
        expect(analyzer).toContain("label: 'Contend'")
        expect(analyzer).toContain("label: 'Rebuild'")
        expect(analyzer).toContain('Multi-Team')
        expect(analyzer).toContain('players, picks, or FAAB')
        expect(analyzer).toContain('Offer creation is disabled')
        expect(analyzer).toContain('Make Offer')
        expect(analyzer).toContain('analyzer-confirm-offer')
        expect(analyzer).toContain('disabled={!canMakeOffer}')
        expect(analyzer).toContain('!networkAvailable ? cachedSnapshot?.analysis')
        expect(analyzer).toContain('strategy, cacheRouteSignature')
        expect(screen).toContain('picksCacheKey(user.id, current.id, leagueId)')
    })

    it('shows current and long-term results without verdict labels', () => {
        expect(summary).toContain('Current points')
        expect(summary).toContain('Long-term value')
        expect(summary).toContain('Roster slots')
        expect(summary).toContain('Package effect')
        expect(summary).not.toMatch(/\b(won|lost|fair|unfair)\b/i)
    })

    it('requires review and confirmation for all proposal modes', () => {
        expect(proposal).toContain('onPress={() => setReviewing(true)}')
        expect(proposal).toContain('Confirm and send trade')
        expect(proposal).toContain('analyzerDraftId')
        expect(proposal).toContain('<TradeAnalysisSummary')
    })
})
