import { useCallback, useMemo, useRef, useState } from 'react'
import { useScreenView } from '@/hooks/use-screen-view'
import { screenScope } from '@/lib/cache/screen-scope'
import { rosterViewData, type TradeBlockView } from '@/lib/cache/view-types'
import { addTradeBlockItem, removeTradeBlockItem, withTradeBlockStats, type TradeBlockItem, type TradePickItem } from '@/lib/trades'
import type { RosterPlayer } from '@/lib/roster'
import { isTradeableRosterPlayer } from '@/lib/trade-assets'
import { sessionOwner } from '@/lib/session-cache-registry'
import { EMPTY_AVG_MAP, EMPTY_STATS_MAP } from '@/lib/roster-stats'

export function useTradeBlock(memberId: string, leagueId: string, canMutate = true, options: { visible?: boolean; allowInactive?: boolean } = {}) {
    const owner = sessionOwner()
    const view = useScreenView<TradeBlockView>(owner && memberId && leagueId ? screenScope('trade-block', leagueId, memberId, {}, owner) : null, options.visible !== false)
    const refreshView = view.refresh
    const data = useMemo(() => view.data ? rosterViewData(view.data) : undefined, [view.data])
    const avgMap = data?.avgMap ?? EMPTY_AVG_MAP
    const avgStatsMap = data?.avgStatsMap ?? EMPTY_STATS_MAP
    const items = useMemo(() => withTradeBlockStats(view.data?.items ?? [], avgMap, avgStatsMap), [view.data, avgMap, avgStatsMap])
    const [action, setAction] = useState<{ owner: string | null | undefined; busyId: string | null; error: string | null }>({ owner, busyId: null, error: null })
    const latest = useRef({ owner, memberId, leagueId, canMutate })
    latest.current = { owner, memberId, leagueId, canMutate }
    const queue = useRef(Promise.resolve())
    const refresh = useCallback(() => { setAction(previous => ({ ...previous, error: null })); return refreshView(true) }, [refreshView])
    const mutate = useCallback((id: string, operation: () => Promise<unknown>) => {
        const captured = latest.current
        const current = () => latest.current.owner === captured.owner && latest.current.memberId === captured.memberId && latest.current.leagueId === captured.leagueId
        const task = queue.current.then(async () => {
            if (!current() || !latest.current.canMutate) return false
            setAction({ owner: captured.owner, busyId: id, error: null })
            try { await operation(); if (!current()) return false; await refresh(); return true }
            catch (cause) { if (current()) setAction({ owner: captured.owner, busyId: null, error: cause instanceof Error ? cause.message : 'Could not update trade block.' }); return false }
            finally { if (current()) setAction(previous => ({ ...previous, busyId: null })) }
        })
        queue.current = task.then(() => {})
        return task
    }, [refresh])
    const addPlayer = useCallback((player: RosterPlayer) => mutate(player.players.id, () => addTradeBlockItem({ memberId, leagueId, playerId: player.players.id })).then(() => {}), [memberId, leagueId, mutate])
    const addPick = useCallback((pick: TradePickItem) => mutate(pick.pickId, () => addTradeBlockItem({ memberId, leagueId, pickId: pick.pickId })).then(() => {}), [memberId, leagueId, mutate])
    const removeItem = useCallback((item: TradeBlockItem) => mutate(item.id, () => removeTradeBlockItem(item.id, memberId)).then(() => {}), [memberId, mutate])
    const setNote = useCallback((item: TradeBlockItem, note: string) => item.memberId === memberId ? mutate(item.id, () => addTradeBlockItem({ memberId, leagueId, note, playerId: item.asset.kind === 'player' ? item.asset.playerId : null, pickId: item.asset.kind === 'pick' ? item.asset.pickId : null })) : Promise.resolve(false), [memberId, leagueId, mutate])
    return { items, picks: view.data?.picks ?? [], hasData: view.loaded, displayReady: view.loaded || Boolean(view.error), roster: (data?.roster ?? []).filter(player => isTradeableRosterPlayer(player, options.allowInactive ?? false)), avgMap, avgStatsMap, loading: view.loading || view.refreshing, error: view.error?.message ?? null, actionError: action.owner === owner ? action.error : null, busyId: action.owner === owner ? action.busyId : null, refresh, addPlayer, addPick, removeItem, setNote }
}
