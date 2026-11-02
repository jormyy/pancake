import { describe, expect, it } from 'vitest'
import { homeHintAffects, homeVersionAffects } from '../src/live/changes'

const selected = { seasonId: 'season', memberIds: ['mine', 'opponent'], date: '2026-11-01', week: 1 }
describe('saved home changes', () => {
    it('ignores another matchup roster and future lineups while keeping current league scores', () => {
        expect(homeHintAffects({ topic: 'roster', scopes: [{ season_id: 'season', member_id: 'other' }] }, selected)).toBe(false)
        expect(homeHintAffects({ topic: 'roster', scopes: [{ season_id: 'season', member_id: 'opponent' }] }, selected)).toBe(true)
        expect(homeHintAffects({ topic: 'lineup', scopes: [{ season_id: 'season', date: '2026-11-02' }] }, selected)).toBe(false)
        expect(homeHintAffects({ topic: 'lineup', scopes: [{ season_id: 'season', member_id: 'other', date: '2026-11-01' }] }, selected)).toBe(true)
        expect(homeHintAffects({ topic: 'score', scopes: [{ season_id: 'season', week: 1 }] }, selected)).toBe(true)
        expect(homeHintAffects({ topic: 'inventory', details: [{ resource: 'claims' }, { resource: 'waivers' }] }, selected)).toBe(false)
        expect(homeHintAffects({ topic: 'inventory', details: [{ resource: 'season' }] }, selected)).toBe(true)
        expect(homeHintAffects({ topic: 'score', details: [{ resource: 'averages' }] }, selected)).toBe(false)
        expect(homeHintAffects({ topic: 'score', details: [{ resource: 'scoring' }] }, selected)).toBe(true)
    })
    it('uses scoped version hints and keeps unknown or missed changes conservative', () => {
        expect(homeVersionAffects({ topic: 'roster', scope: { topics: ['roster'], hints: [{ topic: 'roster', scopes: [{ season_id: 'season', member_id: 'other' }] }] } }, selected)).toBe(false)
        expect(homeVersionAffects({ topic: 'trade', scope: {} }, selected)).toBe(false)
        expect(homeVersionAffects({ topic: 'claims', scope: {} }, selected)).toBe(false)
        expect(homeVersionAffects({ topic: 'score', scope: { homeChanged: false } }, selected)).toBe(false)
        expect(homeVersionAffects({ topic: 'score', scope: { homeChanged: true } }, selected)).toBe(true)
        expect(homeVersionAffects({ topic: 'catchup', scope: {} }, selected)).toBe(true)
        expect(homeVersionAffects({ topic: 'unknown', scope: {} }, selected)).toBe(true)
        expect(homeVersionAffects({ topic: 'roster', scope: {} }, selected)).toBe(true)
    })
})

it('forecast updates invalidate only the displayed matchup',()=>{
  const change={topic:'forecast',scope:{topics:['forecast'],forecastMatchupIds:['other']}}
  expect(homeVersionAffects(change,{...selected,matchupId:'selected'})).toBe(false)
  expect(homeVersionAffects(change,{...selected,matchupId:'other'})).toBe(true)
  expect(homeVersionAffects(change,selected)).toBe(true)
})

it('refreshes total scores across every week of a multi-week matchup', () => {
    const secondWeek = { ...selected, week: 2, roundStartWeek: 1, roundEndWeek: 2 }
    expect(homeHintAffects({ topic: 'score', scopes: [{ season_id: 'season', week: 1 }] }, secondWeek)).toBe(true)
    expect(homeHintAffects({ topic: 'stat', scopes: [{ season_id: 'season', week: 1 }] }, secondWeek)).toBe(true)
    expect(homeHintAffects({ topic: 'score', scopes: [{ season_id: 'season', week: 3 }] }, secondWeek)).toBe(false)
    expect(homeHintAffects({ topic: 'score', scopes: [{ season_id: 'other', week: 1 }] }, secondWeek)).toBe(false)
    expect(homeHintAffects({ topic: 'lineup', scopes: [{ season_id: 'season', week: 1 }] }, secondWeek)).toBe(false)
})
