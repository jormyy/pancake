import { expect, it } from 'vitest'
import { adjacentMatchupId, orderedMatchups } from '@/lib/matchup-navigation'
import type { LeagueWeekMatchup } from '@/lib/scoring'

const matchup = (id: string, isMine = false): LeagueWeekMatchup => ({
    id, isMine, homeMemberId: `${id}-home`, awayMemberId: `${id}-away`, homeTeamName: id,
    awayTeamName: id, homePoints: 0, awayPoints: 0, isFinalized: false,
})
const matchups = [matchup('second'), matchup('own', true), matchup('last')]

it('puts the viewer first without changing the supplied list or other order', () => {
    expect(orderedMatchups(matchups).map(matchup => matchup.id)).toEqual(['own', 'second', 'last'])
    expect(matchups.map(matchup => matchup.id)).toEqual(['second', 'own', 'last'])
})

it.each([
    ['own', 1, 'second'], ['second', 1, 'last'], ['last', 1, 'own'],
    ['own', -1, 'last'], ['last', -1, 'second'], ['second', -1, 'own'],
] as const)('moves from %s by %s to %s', (current, direction, expected) => {
    expect(adjacentMatchupId(matchups, current, direction)).toBe(expected)
})

it('handles an empty list, an unknown current matchup, and a one-matchup week', () => {
    expect(adjacentMatchupId([], 'own', 1)).toBeNull()
    expect(adjacentMatchupId(matchups, 'unknown', -1)).toBeNull()
    expect(adjacentMatchupId([matchup('own', true)], 'own', 1)).toBe('own')
    expect(adjacentMatchupId([matchup('own', true)], 'own', -1)).toBe('own')
})
