import { useCallback, useEffect, useState } from 'react'
import { leagueVersionSnapshot, readLeagueVersion, subscribeLeagueVersion, type LeagueVersionSnapshot } from '@/lib/league-version'
import { sessionGeneration } from '@/lib/session-cache-registry'

export function useLeagueVersion(leagueId: string | undefined, userId: string | null, validated = true) {
    const generation = sessionGeneration()
    const [state, setState] = useState<{ leagueId?: string; userId: string | null; generation: number; snapshot: LeagueVersionSnapshot; error: Error | null }>(() => ({
        leagueId, userId, generation, snapshot: { version: '0', changes: [] }, error: null,
    }))
    const refresh = useCallback(async () => {
        if (!leagueId || !userId || !validated) return
        try {
            await readLeagueVersion(leagueId)
            const snapshot = leagueVersionSnapshot(leagueId)
            if (generation === sessionGeneration()) setState(current => current.leagueId === leagueId && current.userId === userId
                ? { leagueId, userId, generation, snapshot, error: null } : current)
        } catch (error) {
            if (generation === sessionGeneration()) setState(current => current.leagueId === leagueId && current.userId === userId
                ? { ...current, error: error instanceof Error ? error : new Error('Could not read the league version') } : current)
        }
    }, [leagueId, userId, validated, generation])
    useEffect(() => {
        if (!leagueId || !userId || !validated) return
        let active = true
        const current = () => active && generation === sessionGeneration()
        setState({ leagueId, userId, generation, snapshot: leagueVersionSnapshot(leagueId), error: null })
        const stop = subscribeLeagueVersion(leagueId, snapshot => {
            if (current()) setState({ leagueId, userId, generation, snapshot, error: null })
        })
        const resume = () => {
            if (current() && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) void refresh()
        }
        resume()
        if (typeof window !== 'undefined') window.addEventListener('online', resume)
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resume)
        return () => {
            active = false
            stop()
            if (typeof window !== 'undefined') window.removeEventListener('online', resume)
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resume)
        }
    }, [leagueId, userId, validated, refresh, generation])
    const selected = validated && state.leagueId === leagueId && state.userId === userId && state.generation === generation
    return { ...(selected ? state.snapshot : { version: '0', changes: [] }), error: selected ? state.error : null, refresh }
}
