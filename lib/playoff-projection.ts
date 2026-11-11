import type { BracketMatchup, PlayoffBracket } from '@/lib/bracket'
import { compareStandingsRows, type StandingRow } from '@/lib/scoring'

type ActualRound = { number: number; label: string; matchups: BracketMatchup[] }
type ProjectedSeed = { seed: number; memberId: string; teamName: string; tied: boolean }
type ProjectedSlot = { kind: 'seed'; team: ProjectedSeed } | { kind: 'winner'; label: string } | { kind: 'bye' }
export type ProjectedMatchup = { id: string; home: ProjectedSlot; away: ProjectedSlot; bye: boolean }
type ProjectedRound = { number: number; label: string; matchups: ProjectedMatchup[] }
type UnresolvedTie = { seeds: number[]; teams: StandingRow[] }
export type PlayoffProjection =
    | { kind: 'actual'; rounds: ActualRound[]; champion: string | null }
    | { kind: 'projected'; seeds: ProjectedSeed[]; rounds: ProjectedRound[]; byes: ProjectedSeed[]; unresolvedTies: UnresolvedTie[] }
    | { kind: 'unavailable'; reason: string }

function tiedStandings(a: StandingRow, b: StandingRow) {
    return compareStandingsRows({ ...a, memberId: '', teamName: '' }, { ...b, memberId: '', teamName: '' }) === 0
}

export function projectPlayoffs(
    standings: readonly StandingRow[] | null | undefined,
    settings: { playoffEntrants: number | null } | null | undefined,
    actual?: PlayoffBracket | null,
): PlayoffProjection {
    const actualRounds = actual?.rounds?.length ? actual.rounds : actual ? [
        { number: 1, label: 'Quarterfinals', matchups: actual.quarterfinals },
        { number: 2, label: 'Semifinals', matchups: actual.semifinals },
        { number: 3, label: 'Championship', matchups: actual.final ? [actual.final] : [] },
    ].filter(round => round.matchups.length > 0) : []
    if (actualRounds.some(round => round.matchups.length > 0)) return { kind: 'actual', rounds: actualRounds, champion: actual?.champion ?? null }
    if (!standings?.length || !settings) return { kind: 'unavailable', reason: 'Current standings and playoff settings are needed to project the bracket.' }
    const entrants = settings.playoffEntrants ?? (standings.length >= 10 ? 6 : 4)
    if (!Number.isInteger(entrants) || entrants < 2) return { kind: 'unavailable', reason: 'The league playoff team count is unavailable.' }
    if (standings.length < entrants) return { kind: 'unavailable', reason: `The bracket needs ${entrants} teams. Current standings contain ${standings.length}.` }
    const ordered = [...standings].sort(compareStandingsRows)
    const unresolvedTies: UnresolvedTie[] = []
    for (let index = 0; index < ordered.length;) {
        let end = index + 1
        while (end < ordered.length && tiedStandings(ordered[index], ordered[end])) end += 1
        if (end - index > 1 && index < entrants) unresolvedTies.push({ seeds: Array.from({ length: end - index }, (_, offset) => index + offset + 1), teams: ordered.slice(index, end) })
        index = end
    }
    const seeds = ordered.slice(0, entrants).map((team, index) => ({ seed: index + 1, memberId: team.memberId, teamName: team.teamName, tied: unresolvedTies.some(group => group.seeds.includes(index + 1)) }))
    const roundCount = Math.ceil(Math.log2(entrants))
    const size = 2 ** roundCount
    let order = [1, 2]
    for (let fold = 4; fold <= size; fold *= 2) order = order.flatMap(seed => [seed, fold + 1 - seed])
    let slots: ProjectedSlot[] = order.map(seed => seeds[seed - 1] ? { kind: 'seed', team: seeds[seed - 1] } : { kind: 'bye' })
    const rounds: ProjectedRound[] = []
    const byes: ProjectedSeed[] = []
    for (let number = 1; number <= roundCount; number += 1) {
        const remainingRounds = roundCount - number
        const roundName = remainingRounds === 0 ? 'Championship' : remainingRounds === 1 ? 'Semifinal' : remainingRounds === 2 ? 'Quarterfinal' : `Round ${number}`
        const label = remainingRounds === 1 || remainingRounds === 2 ? `${roundName}s` : roundName
        const matchups: ProjectedMatchup[] = []
        const next: ProjectedSlot[] = []
        for (let index = 0; index < slots.length; index += 2) {
            const home = slots[index]
            const away = slots[index + 1]
            const bye = home.kind === 'bye' || away.kind === 'bye'
            const id = `projected-${number}-${index / 2 + 1}`
            matchups.push({ id, home, away, bye })
            if (bye) {
                const advancing = home.kind === 'bye' ? away : home
                if (advancing.kind === 'seed') byes.push(advancing.team)
                next.push(advancing)
            } else {
                next.push({ kind: 'winner', label: `Winner of ${number === 1 && home.kind === 'seed' && away.kind === 'seed' ? `${home.team.seed} vs ${away.team.seed}` : `${roundName} ${index / 2 + 1}`}` })
            }
        }
        rounds.push({ number, label, matchups })
        slots = next
    }
    return { kind: 'projected', seeds, rounds, byes, unresolvedTies }
}
