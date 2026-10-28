import { apiPost } from '@/lib/shared/api'
import { sessionOwner } from '@/lib/session-cache-registry'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DynastyTradeAnalysis } from '@pancake/core'
import { dynastyAnalyzerRouteSignature, dynastyScoringSignature } from '@/lib/dynasty-decisions'
import { type TradeEstimateQuote, type TradeRevaluation } from '@/lib/trade-estimates'
import type { TradeParticipantView } from '@/lib/trade-ui-model'
import type { Json } from '@/types/database'
import type { MultiTeamTradeItemPayload } from '@/lib/trades'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { usePanelActivity } from '@/contexts/panel-activity'
import { deferLeagueRefresh, listenForLeagueChanges } from '@/lib/league-changes'

type Input = {
    enabled: boolean
    debounceMs?: number
    leagueId: string
    memberId: string
    tradeId?: string
    scoringSettings: Json | null | undefined
    teams: number
    faabBudget: number
    participants: TradeParticipantView[]
    items: MultiTeamTradeItemPayload[]
}

export function useDynastyTradeAnalysis(input: Input): {
    analysis: DynastyTradeAnalysis | null
    quote: TradeEstimateQuote | null
    seasonYear: number | null
    calculatedAt: string | null
    loading: boolean
    error: string | null
    retry: () => void
} {
    const [result, setResult] = useState<{ scope: string; value: TradeEstimateQuote | TradeRevaluation | null; error: string | null } | null>(null)
    const [refresh, setRefresh] = useState(0)
    const sequence = useRef(0)
    const retry = useCallback(() => {
        sequence.current++
        setResult(null)
        setRefresh(value => value + 1)
    }, [])
    const online = useOnlineStatus()
    const visible = usePanelActivity()
    const active = input.enabled && online && visible && Boolean(input.leagueId && input.memberId && (input.tradeId || input.items.length))
    const scope = `${active}:${input.leagueId}:${input.memberId}:${input.tradeId ?? ''}:${dynastyAnalyzerRouteSignature(input.items)}:${dynastyScoringSignature(input.scoringSettings)}:${input.teams}:${input.faabBudget}`
    const currentScope = useRef(scope)
    currentScope.current = scope
    const itemsRef = useRef(input.items)
    itemsRef.current = input.items
    const debounceMs = input.debounceMs ?? 0

    useEffect(() => {
        if (!active) return
        const refresh = deferLeagueRefresh(() => setRefresh(value => value + 1))
        let registering = true
        const stop = listenForLeagueChanges(input.leagueId, change => {
            if (!registering && ['catchup', 'roster', 'inventory', 'resources'].includes(change.topic)) {
                sequence.current++
                setResult(null)
                refresh.trigger()
            }
        })
        registering = false
        return () => { stop(); refresh.cancel() }
    }, [active, input.leagueId])

    useEffect(() => {
        const request = ++sequence.current
        if (!active) return
        let cancelled = false
        const timer = setTimeout(() => {
            const body = { leagueId: input.leagueId, memberId: input.memberId }
            const requested = (input.tradeId
                ? apiPost<{ revaluation: TradeRevaluation }>(`/trades/${input.tradeId}/revalue`, body, { expectedUserId: sessionOwner() ?? undefined }).then(response => response.revaluation)
                : apiPost<{ quote: TradeEstimateQuote }>('/trades/estimate', { ...body, items: itemsRef.current }, { expectedUserId: sessionOwner() ?? undefined }).then(response => response.quote)
            ).then(value => {
                if (!value) throw new Error('Trade estimate unavailable. Try again after the next update.')
                if (Date.parse(value.expiresAt) <= Date.now()) throw new Error('Trade estimate expired. Try again.')
                return value
            })
            void requested.then(value => {
                if (cancelled || sequence.current !== request || currentScope.current !== scope) return
                setResult({ scope, value, error: null })

            }).catch(error => {
                if (cancelled || sequence.current !== request || currentScope.current !== scope) return
                setResult({ scope, value: null, error: error instanceof Error ? error.message : 'Trade estimate unavailable.' })
            })
        }, debounceMs)
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [active, debounceMs, input.memberId, input.tradeId, input.leagueId, scope, refresh])

    useEffect(() => {
        if (!active || result?.scope !== scope || !result.value) return
        const remaining = Date.parse(result.value.expiresAt) - Date.now()
        if (!Number.isFinite(remaining)) return
        const timer = setTimeout(retry, Math.max(1, remaining))
        return () => clearTimeout(timer)
    }, [active, result, scope, retry])

    const shown = active && result?.scope === scope ? result : null
    return {
        analysis: shown?.value?.analysis ?? null,
        quote: !input.tradeId && shown?.value && 'id' in shown.value ? shown.value : null,
        seasonYear: shown?.value?.seasonYear ?? null,
        calculatedAt: shown?.value?.createdAt ?? null,
        loading: active && !shown,
        error: shown?.error ?? null,
        retry,
    }
}
