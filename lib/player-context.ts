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
    return [
        player.avgFantasyPoints != null ? `${formatPoints(player.avgFantasyPoints)} FP` : null,
        player.avgMinutesPlayed != null ? `${formatPoints(player.avgMinutesPlayed)} MIN` : null,
    ].filter(Boolean).join(' · ') || 'No season stats'
}
