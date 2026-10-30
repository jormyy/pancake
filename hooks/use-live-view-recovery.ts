import { useEffect, useRef, useState } from 'react'
import { browserReadsAllowed } from '@/hooks/use-browser-read-activity'
import { revalidateScreenVersion, screenCacheKey, type ScreenScope, type ViewContext } from '@/lib/cache/screen-cache'
import { listenForLeagueChanges } from '@/lib/league-changes'
import { sessionGeneration } from '@/lib/session-cache-registry'

type Game = { id: string; status: string; game_time?: string | null; game_date?: string; game_status_text?: string | null }
type Source = { context?: ViewContext; selectedDate?: string; todaysGames?: Game[]; weekDays?: { isToday: boolean; hasGames: boolean }[] }

function nextCheck(games: Game[]): number | null {
    const now = Date.now()
    const scheduled = games.filter(game => game.status === 'Scheduled' && !/postpon|cancel|suspend/i.test(game.game_status_text ?? ''))
    if (games.some(game => game.status === 'InProgress') || scheduled.some(game => {
        const time = Date.parse(game.game_time ?? '')
        return Number.isFinite(time) && time <= now && now - time < 6 * 60 * 60_000
    })) return 20_000
    const times = scheduled.map(game => Date.parse(game.game_time ?? '')).filter(time => Number.isFinite(time) && time > now)
    if (times.length) return Math.min(Math.min(...times) - now, 2_147_483_647)
    return scheduled.some(game => !Number.isFinite(Date.parse(game.game_time ?? ''))) ? 20_000 : null
}

export function useLiveViewRecovery(scope: ScreenScope | null, value: unknown, enabled: boolean, generation: number) {
    const source = value as Source | undefined
    const key = scope?.screen === 'home' && scope.leagueId ? screenCacheKey(scope) : null
    const external = Boolean(source?.context?.today && source.selectedDate !== source.context.today && source.weekDays?.some(day => day.isToday && day.hasGames))
    const dayKey = external && key ? JSON.stringify([scope!.accountId, scope!.leagueId, source?.context?.today]) : null
    const [slate, setSlate] = useState<{ key: string; games: Game[] } | null>(null)
    const slateReady = slate?.key === dayKey
    const games = external ? slateReady ? slate!.games : [] : source?.todaysGames ?? []
    const signature = JSON.stringify(games.map(game => [game.id, game.status, game.game_time, game.game_status_text]))
    const latest = useRef({ scope, games, source, dayKey, slateReady })
    latest.current = { scope, games, source, dayKey, slateReady }
    useEffect(() => {
        if (!key || !enabled) return
        let disposed = false
        let checking = false
        let loading = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const allowed = () => !disposed && generation === sessionGeneration() && browserReadsAllowed()
        const loadSlate = async () => {
            if (!allowed() || !latest.current.dayKey || loading) return
            loading = true
            try {
                const { supabase } = await import('@/lib/supabase')
                if (!allowed()) return
                const day = latest.current.source?.context?.today
                const selected = latest.current.dayKey
                const { data, error } = await supabase.from('nba_games').select('id,status,game_time,game_date,game_status_text').eq('game_date', day!)
                if (error) throw error
                if (allowed() && latest.current.dayKey === selected) setSlate({ key: selected, games: data ?? [] })
            } finally { loading = false }
        }
        const schedule = () => {
            clearTimeout(timer)
            if (!allowed()) return
            const delay = dayKey && !latest.current.slateReady ? 20_000 : nextCheck(latest.current.games)
            if (delay !== null) timer = setTimeout(() => { void check() }, delay)
        }
        const check = async () => {
            if (!allowed() || checking) return
            checking = true
            try {
                await revalidateScreenVersion(latest.current.scope!)
                if (allowed()) await loadSlate()
            } catch (error) {
                if (allowed()) console.error('Could not verify the live matchup.', error)
            } finally { checking = false; schedule() }
        }
        const resume = () => {
            if (allowed()) void check()
            else clearTimeout(timer)
        }
        const stop = dayKey ? listenForLeagueChanges(latest.current.scope!.leagueId!, change => {
            if (change.topic === 'game' && allowed()) void loadSlate().catch(error => { if (allowed()) console.error('Could not check current games.', error) })
        }) : () => {}
        if (typeof window !== 'undefined') {
            window.addEventListener('focus', resume)
            window.addEventListener('pageshow', resume)
            window.addEventListener('online', resume)
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resume)
        if (dayKey && !slateReady) void loadSlate().then(schedule).catch(error => { if (allowed()) console.error('Could not check current games.', error) })
        schedule()
        return () => {
            disposed = true
            clearTimeout(timer)
            stop()
            if (typeof window !== 'undefined') {
                window.removeEventListener('focus', resume)
                window.removeEventListener('pageshow', resume)
                window.removeEventListener('online', resume)
            }
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resume)
        }
    }, [key, enabled, generation, signature, dayKey, slateReady])
}
