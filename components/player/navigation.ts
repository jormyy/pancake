import type { ComponentProps } from 'react'
import type { PlayerHeader } from './PlayerHeader'
import type { PlayerRow } from '@/lib/players'

type HeaderPlayer = ComponentProps<typeof PlayerHeader>['player'] & { id: string }

export function readPlayerHeader(playerId: string, encoded: string | undefined): HeaderPlayer | null {
    if (!encoded || encoded.length > 2048) return null
    try {
        const value: Record<string, unknown> = JSON.parse(encoded)
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || value.id !== playerId || typeof value.display_name !== 'string' || !value.display_name.trim()) return null
        if (value.eligible_positions != null && (!Array.isArray(value.eligible_positions)
            || !value.eligible_positions.every(position => typeof position === 'string'))) return null
        const text = (field: string) => typeof value[field] === 'string' ? value[field] : null
        const integer = (field: string) => typeof value[field] === 'number' && Number.isSafeInteger(value[field]) && value[field] >= 0 ? value[field] : null
        return {
            id: playerId, display_name: value.display_name, nba_team: text('nba_team'),
            position: text('position'), eligible_positions: value.eligible_positions ?? [],
            jersey_number: text('jersey_number'), injury_status: text('injury_status'),
            dynasty_rank: integer('dynasty_rank'), headshot_url: text('headshot_url'),
            nba_id: text('nba_id'), years_exp: integer('years_exp'),
        }
    } catch {
        return null
    }
}

export function playerDetailRoute(player: PlayerRow, pickupPossible = false) {
    return {
        pathname: '/player/[id]' as const,
        params: {
            id: player.id,
            ...(pickupPossible ? { pickupHint: '1' } : {}),
            playerHeader: JSON.stringify({
                id: player.id, display_name: player.display_name, nba_team: player.nba_team,
                position: player.position, eligible_positions: player.eligible_positions,
                injury_status: player.injury_status, nba_id: player.nba_id, years_exp: player.years_exp,
            }),
        },
    }
}
