import { useEffect, useRef } from 'react'
import type { PlayerSupportResource } from '@/lib/player-availability'
import { usePanelActivity } from '@/contexts/panel-activity'
import { deferLeagueRefresh, leagueResourceAffects, listenForLeagueChanges } from '@/lib/league-changes'
import { invalidateSeasonCache } from '@/lib/shared/season'
import { reportRealtimeCleanup, subscribeToTableChanges, unsubscribeFromTableChanges } from '@/lib/realtime'

type Read = () => void | boolean | Promise<void | boolean>
type SupportRead = (resources: readonly PlayerSupportResource[]) => ReturnType<Read>
const ALL_SUPPORT: PlayerSupportResource[] = ['ownership', 'waivers', 'claims', 'transactions']

export function usePlayerSupportRealtime(memberId: string | undefined, leagueId: string | null, refreshSupport: SupportRead, recover: Read, enabled = true, seasonId?: string | null) {
    const season = useRef(seasonId)
    season.current = seasonId
    const active = usePanelActivity() && enabled
    useEffect(() => {
        if (!active || !leagueId || !memberId) return
        const pending = new Set<PlayerSupportResource>()
        let fullRecovery = false
        const refresh = deferLeagueRefresh(async () => {
            const resources = [...pending]
            const full = fullRecovery
            pending.clear()
            fullRecovery = false
            try {
                const result = full ? await recover() : await refreshSupport(resources)
                if (result === false) {
                    for (const resource of resources) pending.add(resource)
                    fullRecovery ||= full
                }
                return result
            } catch (error) {
                for (const resource of resources) pending.add(resource)
                fullRecovery ||= full
                throw error
            }
        })
        const changed = (...resources: PlayerSupportResource[]) => {
            for (const resource of resources) pending.add(resource)
            refresh.trigger()
        }
        let registering = true
        const stop = listenForLeagueChanges(leagueId, change => {
            if (registering && change.topic === 'catchup') return
            if (change.topic === 'catchup' || leagueResourceAffects(change, ['season'])) {
                invalidateSeasonCache(leagueId)
                fullRecovery = true
                refresh.trigger()
            } else if (change.topic === 'inventory') {
                const selection = { seasonId: season.current, memberId }
                const resources: PlayerSupportResource[] = []
                if (leagueResourceAffects(change, ['waivers'], selection)) resources.push('waivers')
                if (leagueResourceAffects(change, ['claims'], selection)) resources.push('claims')
                if (leagueResourceAffects(change, ['faab'], selection)) resources.push('transactions')
                if (resources.length) changed(...resources)
            } else if (change.topic === 'resources' && leagueResourceAffects(change, ['averages', 'projections', 'scoring'], { seasonId: season.current })) {
                fullRecovery = true
                refresh.trigger()
            }
        })
        registering = false
        const channel = subscribeToTableChanges(`players-screen:${leagueId}`, {
            mode: 'per-watch',
            watches: [
                { table: 'roster_players', filter: `league_id=eq.${leagueId}`, onChange: () => changed('ownership', 'transactions') },
                { table: 'league_members', filter: `league_id=eq.${leagueId}`, onChange: () => changed(...ALL_SUPPORT) },
            ],
            onReconnect: () => {
                invalidateSeasonCache(leagueId)
                fullRecovery = true
                refresh.trigger()
            },
        })
        return () => {
            stop()
            refresh.cancel()
            reportRealtimeCleanup('players', unsubscribeFromTableChanges(channel))
        }
    }, [active, leagueId, memberId, recover, refreshSupport])
}
