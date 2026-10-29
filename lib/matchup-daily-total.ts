import type { LiveStatLine } from '@/lib/games'
import type { LineupSlot } from '@/lib/lineup'
import { computeLiveFantasyPoints } from '@/lib/scoring'

export function matchupDailyTotal(
    starters: readonly LineupSlot[],
    stats: ReadonlyMap<string, LiveStatLine>,
    scoringSettings: Record<string, number>,
): number | null {
    let total: number | null = null
    for (const { player } of starters) {
        const line = player ? stats.get(player.playerId) : undefined
        if (line && !line.didNotPlay) total = (total ?? 0) + computeLiveFantasyPoints(line, scoringSettings)
    }
    return total
}
