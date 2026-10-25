import { isTaxiEligible } from '@pancake/core'
import { describe, expect, it } from 'vitest'
import { getRosterProblems } from '@/lib/roster-problems'
import { rosterPlayer } from '../helpers/fixtures'

describe('existing taxi roster eligibility', () => {
    it.each([null, undefined])('keeps a veteran with an unknown count (%s) legal but refuses taxi entry', careerGames => {
        const player = rosterPlayer({ is_on_taxi: true })
        player.players.career_regular_season_games = careerGames

        expect(getRosterProblems([player], 1)).toEqual([])
        expect(isTaxiEligible(player.players.years_exp, careerGames ?? null)).toBe(false)
    })

    it.each([
        { years: 2, games: 64, illegal: false },
        { years: 2, games: 65, illegal: true },
        { years: 2, games: 82, illegal: true },
        { years: 0, games: 82, illegal: false },
        { years: 0, games: null, illegal: false },
        { years: null, games: 65, illegal: true },
    ])('checks known games and rookie status: $years years, $games games', ({ years, games, illegal }) => {
        const player = rosterPlayer({ is_on_taxi: true })
        player.players = { ...player.players, years_exp: years, career_regular_season_games: games }

        expect(getRosterProblems([player], 0)).toEqual(illegal
            ? [{ kind: 'taxi', player, message: 'Player A no longer qualifies for taxi.' }]
            : [])
    })

    it('still reports IR and active roster problems when a taxi count is unknown', () => {
        const taxi = rosterPlayer({ is_on_taxi: true })
        const ir = rosterPlayer({ id: 'ir', is_on_ir: true })
        const active = rosterPlayer({ id: 'active' })

        expect(getRosterProblems([taxi, ir, active], 0)).toEqual([
            { kind: 'ir', player: ir, message: 'Player A no longer qualifies for IR.' },
            { kind: 'over_limit', player: null, message: 'Active roster is 1 over the limit.' },
        ])
    })
})
