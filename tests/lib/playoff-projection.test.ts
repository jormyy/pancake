import { expect, it } from 'vitest'
import { projectPlayoffs } from '@/lib/playoff-projection'
import type { StandingRow } from '@/lib/scoring'
import type { BracketMatchup } from '@/lib/bracket'

function standings(count: number): StandingRow[] {
    return Array.from({ length: count }, (_, index) => ({ memberId: `team-${index + 1}`, teamName: `Team ${index + 1}`, wins: count - index, losses: index, ties: 0, pointsFor: 1000, pointsAgainst: 900, maxPointsFor: 1200 }))
}

it('folds six entrants into the server bracket order with byes for seeds one and two', () => {
    const result = projectPlayoffs(standings(10).reverse(), { playoffEntrants: 6 })
    expect(result.kind).toBe('projected')
    if (result.kind !== 'projected') throw new Error('Expected a projection')
    expect(result.seeds.map(team => team.memberId)).toEqual(standings(6).map(team => team.memberId))
    expect(result.byes.map(team => team.seed)).toEqual([1, 2])
    expect(result.rounds.map(round => round.matchups.length)).toEqual([4, 2, 1])
    expect(result.rounds[0].matchups.map(matchup => [matchup.home.kind === 'seed' ? matchup.home.team.seed : null, matchup.away.kind === 'seed' ? matchup.away.team.seed : null])).toEqual([[1, null], [4, 5], [2, null], [3, 6]])
    expect(result.rounds[1].matchups[0].home).toMatchObject({ kind: 'seed', team: { seed: 1 } })
})

it('uses four entrants without byes and preserves folded semifinal pairings', () => {
    const result = projectPlayoffs(standings(10), { playoffEntrants: 4 })
    if (result.kind !== 'projected') throw new Error('Expected a projection')
    expect(result.byes).toEqual([])
    expect(result.rounds.map(round => round.matchups.length)).toEqual([2, 1])
    expect(result.rounds[0].matchups[0]).toMatchObject({ home: { team: { seed: 1 } }, away: { team: { seed: 4 } } })
})

it.each([[10, 6], [8, 4]])('uses the legacy entrant rule for %s teams', (teams, entrants) => {
    const result = projectPlayoffs(standings(teams), { playoffEntrants: null })
    expect(result.kind === 'projected' && result.seeds.length).toBe(entrants)
})

it('seeds tied records by points per game and counts record ties as half wins', () => {
    const rows = standings(4)
    rows[0] = { ...rows[0], wins: 2, losses: 0, ties: 2, pointsFor: 400 }
    rows[1] = { ...rows[1], wins: 3, losses: 1, ties: 0, pointsFor: 440 }
    rows[2] = { ...rows[2], wins: 1, losses: 1, ties: 0, pointsFor: 2000 }
    rows[3] = { ...rows[3], wins: 0, losses: 4, ties: 0 }
    const result = projectPlayoffs(rows, { playoffEntrants: 4 })
    expect(result.kind === 'projected' && result.seeds.map(team => team.memberId)).toEqual(['team-2', 'team-1', 'team-3', 'team-4'])
    expect(result.kind === 'projected' && result.unresolvedTies).toEqual([])
})

it('flags exact ties including a tie that crosses the playoff cut', () => {
    const rows = standings(6)
    rows[4] = { ...rows[3], memberId: 'tied-team', teamName: 'Another team' }
    const result = projectPlayoffs(rows, { playoffEntrants: 4 })
    if (result.kind !== 'projected') throw new Error('Expected a projection')
    expect(result.unresolvedTies).toEqual([{ seeds: [4, 5], teams: [rows[4], rows[3]] }])
    expect(result.seeds[3].tied).toBe(true)
})

it('replaces the projection with actual playoff matchups even without standings or settings', () => {
    const matchup: BracketMatchup = { id: 'actual', round: 'final', weekNumber: 20, homeId: 'a', homeName: 'A', homePoints: 0, awayId: 'b', awayName: 'B', awayPoints: 0, winnerId: null, isFinalized: false }
    const actual = { quarterfinals: [], semifinals: [], final: matchup, champion: null }
    expect(projectPlayoffs(standings(4), { playoffEntrants: 4 }).kind).toBe('projected')
    expect(projectPlayoffs(null, null, actual)).toEqual({ kind: 'actual', rounds: [{ number: 3, label: 'Championship', matchups: [matchup] }], champion: null })
})

it('returns an unavailable reason for missing standings, settings, or too few teams', () => {
    expect(projectPlayoffs([], { playoffEntrants: 4 })).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('standings') })
    expect(projectPlayoffs(standings(4), null)).toMatchObject({ kind: 'unavailable' })
    expect(projectPlayoffs(standings(4), { playoffEntrants: 6 })).toMatchObject({ kind: 'unavailable', reason: 'The bracket needs 6 teams. Current standings contain 4.' })
})
