import { useEffect, useMemo, useState } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { todayET } from '@/lib/shared/dates'
import { supabase } from '@/lib/supabase'

const emptyCopy = { message: 'No matchup this week yet', description: 'Matchups post before each week starts. Scout the player pool and get your roster ready.' }

type Reason = 'Skipped' | 'Bye' | null
type ReasonCache = { day: string; reason: Reason; savedAt: number }

export function WeekOffNotice({ leagueId, onBrowse }: { leagueId: string | undefined; onBrowse: () => void }) {
    const day = todayET()
    const cacheKey = `pancake:week-off:v1:${leagueId}:${day}`
    const cached = useMemo(() => readPersistentCache<ReasonCache>(cacheKey), [cacheKey])
    const saved = cached?.day === day ? cached : undefined
    const [resource, setResource] = useState({ leagueId, reason: saved?.reason ?? null })
    const reason = resource.leagueId === leagueId ? resource.reason : saved?.reason ?? null
    useEffect(() => {
        let cancelled = false
        if (!leagueId || saved && Date.now() - saved.savedAt < 30_000) return
        const finish = (reason: Reason) => {
            if (cancelled) return
            writePersistentCache<ReasonCache>(cacheKey, { day, reason, savedAt: Date.now() })
            setResource({ leagueId, reason })
        }
        const load = async () => {
            const { data: season, error } = await supabase.from('league_seasons').select('id, season_year, skipped_weeks')
                .eq('league_id', leagueId).eq('is_current', true).maybeSingle()
            if (error || !season) return
            const today = day
            const { data: week } = await supabase.from('season_weeks').select('week_number')
                .eq('season_year', season.season_year).lte('week_start', today).gte('week_end', today).maybeSingle()
            if (!week || cancelled) return
            if (season.skipped_weeks.includes(week.week_number)) {
                finish('Skipped')
                return
            }
            const { count } = await supabase.from('matchups').select('id', { count: 'exact', head: true })
                .eq('league_season_id', season.id).eq('week_number', week.week_number).eq('is_voided', false)
            finish(count ? 'Bye' : null)
        }
        load().catch(() => {})
        return () => { cancelled = true }
    }, [leagueId, cacheKey, day, saved])
    return <EmptyState fullScreen={false} framed reserveCopy={emptyCopy} icon="event"
        message={reason === 'Skipped' ? 'Skipped week' : reason === 'Bye' ? 'Bye week' : emptyCopy.message}
        description={reason ? 'This week adds no wins, losses, ties, or points to your record.' : emptyCopy.description}
        actionLabel="Browse Players" onAction={onBrowse} />
}
