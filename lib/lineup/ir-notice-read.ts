import { supabase } from '@/lib/supabase'
import type { IrNotice } from '@/lib/lineup/ir-notices'

export type AutoIrNotices = {
    enabled: boolean
    notices: IrNotice[]
}

type NoticesRpc = {
    rpc: (name: 'get_auto_ir_notices', args: {
        p_league_id: string
        p_league_season_id: string
    }) => PromiseLike<{ data: unknown; error: { message: string } | null }>
}

export async function readAutoIrNotices(leagueId: string, seasonId: string): Promise<AutoIrNotices> {
    const { data, error } = await (supabase as unknown as NoticesRpc).rpc('get_auto_ir_notices', {
        p_league_id: leagueId,
        p_league_season_id: seasonId,
    })
    if (error) throw error
    return parseAutoIrNotices(data)
}

export function parseAutoIrNotices(value: unknown): AutoIrNotices {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const enabled = record.enabled === true
    const notices = enabled && Array.isArray(record.notices)
        ? record.notices.flatMap((row) => {
            if (!row || typeof row !== 'object') return []
            const notice = row as Record<string, unknown>
            return typeof notice.playerId === 'string' && typeof notice.playerName === 'string' &&
                typeof notice.reason === 'string' && typeof notice.action === 'string'
                ? [{ playerId: notice.playerId, playerName: notice.playerName, reason: notice.reason, action: notice.action }]
                : []
        })
        : []
    return { enabled, notices }
}
