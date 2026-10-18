import { useEffect, useState } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { supabase } from '@/lib/supabase'

export function WeekOffNotice({ leagueId, onBrowse }: { leagueId: string | undefined; onBrowse: () => void }) {
    const [reason, setReason] = useState<'Skipped' | 'Bye' | null>(null)
    useEffect(() => {
        let cancelled = false
        setReason(null)
        if (!leagueId) return
        const load = async () => {
            const { data: season, error } = await supabase.from('league_seasons').select('id, season_year, skipped_weeks')
                .eq('league_id', leagueId).eq('is_current', true).maybeSingle()
            if (error || !season) return
            const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
            const date = Object.fromEntries(parts.map((part) => [part.type, part.value]))
            const today = `${date.year}-${date.month}-${date.day}`
            const { data: week } = await supabase.from('season_weeks').select('week_number')
                .eq('season_year', season.season_year).lte('week_start', today).gte('week_end', today).maybeSingle()
            if (!week || cancelled) return
            if (season.skipped_weeks.includes(week.week_number)) {
                setReason('Skipped')
                return
            }
            const { count } = await supabase.from('matchups').select('id', { count: 'exact', head: true })
                .eq('league_season_id', season.id).eq('week_number', week.week_number).eq('is_voided', false)
            if (!cancelled && count) setReason('Bye')
        }
        load().catch(() => {})
        return () => { cancelled = true }
    }, [leagueId])
    return <EmptyState fullScreen={false} framed icon="event"
        message={reason === 'Skipped' ? 'Skipped week' : reason === 'Bye' ? 'Bye week' : 'No matchup this week yet'}
        description={reason ? 'This week adds no wins, losses, ties, or points to your record.' : 'Matchups post before each week starts. Scout the player pool and get your roster ready.'}
        actionLabel="Browse Players" onAction={onBrowse} />
}
