import { formatPoints } from '@/lib/format'

type PlayerContextInput = {
    position?: string | null
    eligiblePositions?: string[] | null
    yearsExp?: number | null
    avgFantasyPoints?: number | null
    avgMinutesPlayed?: number | null
}

export function playerEligiblePositions(player: PlayerContextInput): string[] {
    if (player.eligiblePositions?.length) return player.eligiblePositions
    return player.position ? [player.position] : []
}

export function playerSeasonContextText(player: PlayerContextInput): string {
    return `${formatPoints(player.avgFantasyPoints ?? 0)} FP · ${formatPoints(player.avgMinutesPlayed ?? 0)} mins`
}
