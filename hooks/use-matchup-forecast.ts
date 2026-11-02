import { useEffect, useState } from 'react'
import { useIsFocused } from '@react-navigation/native'
import type { MatchupEstimate } from '@pancake/core'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { disposeTableChangeSubscription, reportRealtimeCleanup, subscribeToTableChanges } from '@/lib/realtime'
import { sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'
import type { Matchup } from '@/lib/scoring'
import { deferLeagueRefresh, leagueChangeAffects, listenForLeagueChanges } from '@/lib/league-changes'
import { supabase } from '@/lib/supabase'

export type MatchupForecast = MatchupEstimate & {
    matchupId: string
    calculatedAt: string
    validUntil?: string
    inputRevision: number
    stale: boolean
    lineupBasis: string
    games: {
        gameId: string
        playerId: string
        memberId: string
        date: string
        projection: number | null
        source: string | null
        sourceAt: string | null
        remainingFraction: number | null
    }[]
}

export type MatchupForecastDisplay = Pick<MatchupForecast, 'stale' | 'tieProbability' | 'missingInputs'> & {
    teams: Pick<MatchupForecast['teams'][number], 'memberId' | 'projectedFinal' | 'currentPoints' | 'winProbability'>[]
    games: Pick<MatchupForecast['games'][number], 'gameId' | 'playerId' | 'memberId'>[]
}

type ForecastState = { key: string; value: MatchupForecast | null; pending: boolean; error: boolean }

export function useMatchupForecast(userId?: string, leagueId?: string, matchup?: Matchup | null, enabled = true) {
    const matchupId = matchup?.id
    const seasonId = matchup?.seasonId
    const myMemberId = matchup?.myMemberId
    const opponentMemberId = matchup?.opponentMemberId
    const focused = useIsFocused()
    const activity = useBrowserReadActivity()
    const key = userId && leagueId && matchupId ? `pancake:matchup-forecast:v1:${userId}:${leagueId}:${matchupId}` : ''
    const [state, setState] = useState<ForecastState>(() => ({ key, value: key ? readPersistentCache<MatchupForecast>(key) ?? null : null, pending: true, error: false }))
    useEffect(() => {
        const cached = key ? readPersistentCache<MatchupForecast>(key) ?? null : null
        setState({ key, value: cached, pending: true, error: false })
        if (!key || !focused || !activity.active || !enabled) return
        let disposed = false
        let request = 0
        let expiry: ReturnType<typeof setTimeout> | undefined
        const generation = sessionGeneration()
        const current = () => !disposed && sessionGeneration() === generation && sessionOwner() === userId
        const refresh = async () => {
            const attempt = ++request
            if (!current()) return
            setState(previous => previous.key === key ? { ...previous, pending: true } : { key, value: cached, pending: true, error: false })
            try {
                const { data, error } = await supabase.rpc('get_matchup_forecast', { p_matchup_id: matchupId! })
                if (!current() || attempt !== request) return
                if (error) {
                    setState(previous => ({ ...previous, pending: false, error: true }))
                    return false
                }
                const value = data as unknown as MatchupForecast | null
                writePersistentCache(key, value)
                setState({ key, value, pending: false, error: false })
                if (expiry) clearTimeout(expiry)
                const validUntil = Date.parse(value?.validUntil ?? '')
                if (validUntil > Date.now()) expiry = setTimeout(invalidate, validUntil - Date.now())
                return true
            } catch {
                if (current() && attempt === request) setState(previous => ({ ...previous, pending: false, error: true }))
                return false
            }
        }
        const refreshLater = deferLeagueRefresh(refresh)
        const invalidate = () => {
            request++
            setState(previous => previous.key === key ? { ...previous, pending: true } : previous)
            refreshLater.trigger()
        }
        const stopChanges = listenForLeagueChanges(leagueId!, change => {
            if (!['lineup', 'roster', 'score', 'game', 'stat', 'player_stats', 'resources', 'catchup'].includes(change.topic)) return
            if (seasonId && !leagueChangeAffects(change, { seasonId, memberIds: [myMemberId!, opponentMemberId!] })) return
            invalidate()
        })
        refreshLater.trigger()
        const subscription = subscribeToTableChanges(`matchup-forecast:${matchupId}`, {
            mode: 'per-watch',
            watches: [{ table: 'matchup_forecasts', filter: `league_id=eq.${leagueId}`, onChange: payload => {
                const row = payload.new as { matchup_id?: string }
                const previous = payload.old as { matchup_id?: string }
                if (row.matchup_id === matchupId || previous.matchup_id === matchupId) invalidate()
            } }],
            onReconnect: refresh,
        })
        return () => {
            disposed = true
            if (expiry) clearTimeout(expiry)
            stopChanges()
            reportRealtimeCleanup('matchup forecast', disposeTableChangeSubscription(subscription, [refreshLater]))
        }
    }, [key, userId, leagueId, matchupId, focused, activity.active, activity.revision, enabled, seasonId, myMemberId, opponentMemberId])
    const visible = enabled && state.key === key ? state : { key, value: enabled && key ? readPersistentCache<MatchupForecast>(key) ?? null : null, pending: true, error: false }
    const unexpired = Date.parse(visible.value?.validUntil ?? '') > Date.now()
    return { forecast: visible.value, pending: visible.pending, error: visible.error, stale: !unexpired || visible.value?.stale === true || visible.pending || visible.error || !activity.active }
}
