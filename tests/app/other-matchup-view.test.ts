import { expect, it, vi } from 'vitest'
import { otherMatchupView } from '../../supabase/functions/api/views/other-matchup'

const home = { context: { memberId: 'actor', seasonId: 'season', seasonYear: 2026, weekNumber: 3 }, selectedDate: '2026-10-27', leagueMatchups: [{ id: 'other', homeMemberId: 'a', awayMemberId: 'b', homeTeamName: 'Owls', awayTeamName: 'Foxes', homePoints: 123, awayPoints: 98, isFinalized: true }], matchup: { id: 'own' }, liveStats: { own: {} } }
function reader() {
    return vi.fn(async (name: string, params: Record<string, unknown>) => {
        if (name === 'matchup') return { week_number: 2, end_week_number: 3, winner_member_id: 'a' }
        if (name === 'standings') return { standings: [{ memberId: 'a', wins: 2, losses: 0 }, { memberId: 'b', wins: 1, losses: 1 }] }
        if (name === 'forecast') return { matchupId: 'other', teams: [{ memberId: 'a', projectedFinal: 123, winProbability: 1 }] }
        return { starters: [{ player: { playerId: params.targetMemberId } }], bench: [params.targetMemberId], weekDays: ['Tue'], games: ['game'], liveStats: { [String(params.targetMemberId)]: { points: 10 } }, startedTeams: ['BOS'], teamMatchups: { BOS: { opponent: 'NYK' } } }
    })
}
it('returns the selected matchup with both records, scores, forecast, lineups, and merged points', async () => {
    const read = reader()
    const result = await otherMatchupView(home, 'other', read)
    expect(result?.context).toEqual(home.context)
    expect(result?.matchup).toMatchObject({ id: 'other', weekNumber: 3, roundStartWeek: 2, roundEndWeek: 3, myMemberId: 'a', opponentMemberId: 'b', myPoints: 123, opponentPoints: 98, myWins: 2, myLosses: 0, opponentWins: 1, opponentLosses: 1, iWon: true })
    expect(result?.myLineup.starters).toEqual([{ player: { playerId: 'a' } }])
    expect(result?.oppLineup.bench).toEqual(['b'])
    expect(result?.liveStats).toEqual({ a: { points: 10 }, b: { points: 10 } })
    expect(result?.forecast).toMatchObject({ matchupId: 'other' })
    expect(read).toHaveBeenCalledWith('lineup', { date: '2026-10-27', targetMemberId: 'a' })
    expect(read).toHaveBeenCalledWith('lineup', { date: '2026-10-27', targetMemberId: 'b' })
})
it.each(['foreign-league', 'voided', 'past-week'])('rejects %s before reading another lineup', async id => {
    const read = reader()
    expect(await otherMatchupView(home, id, read)).toBeNull()
    expect(read).not.toHaveBeenCalled()
})
it('fails the complete view when either lineup read fails', async () => {
    const read = reader().mockRejectedValueOnce(new Error('Lineup unavailable'))
    await expect(otherMatchupView(home, 'other', read)).rejects.toThrow('Lineup unavailable')
})
