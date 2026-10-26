import { useEffect, useRef } from 'react'
import type { PlayerSupportResource } from '@/lib/player-availability'
import { sessionGeneration } from '@/lib/session-cache-registry'
import { listenForMemberClaimsChanges } from '@/lib/claim-updates'
import { usePanelActivity } from '@/contexts/panel-activity'
import { deferLeagueRefresh, invalidateLeagueSnapshot, leagueResourceAffects, leagueChangeAffects, listenForLeagueChanges } from '@/lib/league-changes'
import { invalidateSeasonCache } from '@/lib/shared/season'
import { reportRealtimeCleanup, subscribeToTableChanges, unsubscribeFromTableChanges } from '@/lib/realtime'

type Read = () => void | boolean | Promise<void | boolean>
type SupportRead = (resources: readonly PlayerSupportResource[]) => ReturnType<Read>
const ALL_SUPPORT: PlayerSupportResource[] = ['ownership', 'waivers', 'claims', 'transactions']

export function usePlayerSupportRealtime(memberId: string | undefined, leagueId: string | null, refreshSupport: SupportRead, recover: Read, enabled = true, seasonId?: string | null, refreshDerived?: Read, invalidateSupport?: (resources: readonly PlayerSupportResource[] | null) => void) {
    const season = useRef(seasonId)
    season.current = seasonId
    const identity = JSON.stringify([leagueId, memberId, sessionGeneration()])
    const currentIdentity = useRef(identity)
    currentIdentity.current = identity
    const active = usePanelActivity() && enabled
    useEffect(() => {
        if (!active || !leagueId || !memberId) return
        let disposed = false
        const generation = sessionGeneration()
        const current = () => !disposed && generation === sessionGeneration() && currentIdentity.current === identity
        const pending = new Set<PlayerSupportResource>()
        let fullRecovery = false
        let dailyRecovery = false
        const refresh = deferLeagueRefresh(async () => {
            if (!current()) return true
            const resources = [...pending]
            const full = fullRecovery
            const daily = dailyRecovery
            pending.clear()
            fullRecovery = false
            dailyRecovery = false
            const work = full ? [{ read: recover, retry: () => { fullRecovery = true } }]
                : [
                    ...(resources.length ? [{ read: () => refreshSupport(resources), retry: () => { for (const resource of resources) pending.add(resource) } }] : []),
                    ...(daily ? [{ read: refreshDerived ?? recover, retry: () => { dailyRecovery = true } }] : []),
                ]
            const results = await Promise.allSettled(work.map(async item => item.read()))
            let succeeded = true
            for (let index = 0; index < results.length; index += 1) {
                const result = results[index]
                if (result.status === 'rejected' || result.value === false) {
                    work[index].retry()
                    succeeded = false
                }
            }
            const failed = results.find(result => result.status === 'rejected')
            if (failed?.status === 'rejected') throw failed.reason
            return succeeded
        })
        const changed = (...resources: PlayerSupportResource[]) => {
            if (!current()) return
            invalidateSupport?.(resources)
            for (const resource of resources) pending.add(resource)
            refresh.trigger()
        }
        const stopClaims = listenForMemberClaimsChanges(memberId, () => changed('claims', 'transactions'))
        let registering = true
        const stop = listenForLeagueChanges(leagueId, change => {
            if (!current()) return
            if (registering && change.topic === 'catchup') return
            if (change.topic === 'catchup' || leagueResourceAffects(change, ['season'])) {
                invalidateSeasonCache(leagueId)
                invalidateSupport?.(null)
                fullRecovery = true
                refresh.trigger()
            } else if (change.topic === 'roster') {
                if (!season.current || leagueChangeAffects(change, { seasonId: season.current })) changed(...ALL_SUPPORT)
            } else if (change.topic === 'inventory') {
                const selection = { seasonId: season.current, memberId }
                const resources: PlayerSupportResource[] = []
                if (leagueResourceAffects(change, ['waivers'], selection)) resources.push('waivers')
                if (leagueResourceAffects(change, ['claims'], selection)) resources.push('claims')
                if (leagueResourceAffects(change, ['faab'], selection)) resources.push('transactions')
                if (resources.length) changed(...resources)
            } else if (change.topic === 'resources' && leagueResourceAffects(change, ['averages', 'projections', 'scoring'])) {
                dailyRecovery = true
                refresh.trigger()
            }
        })
        registering = false
        const channel = subscribeToTableChanges(`players-screen:${leagueId}`, {
            mode: 'per-watch',
            watches: [
                { table: 'roster_players', filter: `league_id=eq.${leagueId}`, onChange: payload => {
                    if (!current()) return
                    invalidateLeagueSnapshot(leagueId, 'supportRaw')
                    const knownOtherPickup = payload?.eventType === 'INSERT' && typeof payload.new.member_id === 'string' && payload.new.member_id !== memberId
                    const ownRoster = payload && 'member_id' in payload.new && payload.new.member_id === memberId
                    changed('ownership', ...(ownRoster ? ['claims' as const] : []), ...(!knownOtherPickup ? ['transactions' as const] : []))
                } },
                { table: 'waiver_claims', filter: `member_id=eq.${memberId}`, onChange: () => changed('claims', 'transactions') },
                { table: 'league_members', filter: `league_id=eq.${leagueId}`, onChange: () => { if (!current()) return; invalidateLeagueSnapshot(leagueId, 'supportRaw'); changed(...ALL_SUPPORT) } },
            ],
            onReconnect: () => {
                if (!current()) return
                invalidateLeagueSnapshot(leagueId)
                invalidateSeasonCache(leagueId)
                invalidateSupport?.(null)
                fullRecovery = true
                refresh.trigger()
            },
        })
        return () => {
            disposed = true
            stop()
            stopClaims()
            refresh.cancel()
            reportRealtimeCleanup('players', unsubscribeFromTableChanges(channel))
        }
    }, [active, identity, leagueId, memberId, recover, refreshSupport, refreshDerived, invalidateSupport])
}
