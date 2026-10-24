import { useEffect, useMemo, useState } from 'react'
import { DeferredContent } from '@/components/ui/DeferredContent'
import { StyleSheet, Text, View } from 'react-native'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { spacing, textStyles } from '@/constants/tokens'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { todayET } from '@/lib/shared/dates'
import { getCurrentWeekNumber } from '@/lib/shared/week'
import { supabase } from '@/lib/supabase'

const emptyCopy = { message: 'No matchup this week' }

type Reason = 'Skipped' | 'Bye' | null
type ReasonCache = { day: string; reason: Reason; savedAt: number }

export function WeekOffNotice({ leagueId, onBrowse }: { leagueId: string | undefined; onBrowse: () => void }) {
    const day = todayET()
    const cacheKey = `pancake:week-off:v1:${leagueId}:${day}`
    const cached = useMemo(() => readPersistentCache<ReasonCache>(cacheKey), [cacheKey])
    const saved = cached?.day === day ? cached : undefined
    const [resource, setResource] = useState({ leagueId, day, reason: saved?.reason ?? null, loaded: Boolean(saved) })
    const reason = resource.leagueId === leagueId && resource.day === day ? resource.reason : saved?.reason ?? null
    useEffect(() => {
        let cancelled = false
        if (!leagueId || saved && Date.now() - saved.savedAt < 30_000) return
        const finish = (reason: Reason) => {
            if (cancelled) return
            writePersistentCache<ReasonCache>(cacheKey, { day, reason, savedAt: Date.now() })
            setResource({ leagueId, day, reason, loaded: true })
        }
        const load = async () => {
            const { data: season, error } = await supabase.from('league_seasons').select('id, season_year, skipped_weeks')
                .eq('league_id', leagueId).eq('is_current', true).maybeSingle()
            if (error || !season) { finish(null); return }
            const weekNumber = await getCurrentWeekNumber(season.season_year)
            if (cancelled) return
            if (!weekNumber) { finish(null); return }
            if (season.skipped_weeks.includes(weekNumber)) {
                finish('Skipped')
                return
            }
            const { count } = await supabase.from('matchups').select('id', { count: 'exact', head: true })
                .eq('league_season_id', season.id).eq('week_number', weekNumber).eq('is_voided', false)
            finish(count ? 'Bye' : null)
        }
        load().catch(() => finish(null))
        return () => { cancelled = true }
    }, [leagueId, cacheKey, day, saved])
    return <DeferredContent key={cacheKey} ready={!leagueId || Boolean(saved) || resource.leagueId === leagueId && resource.day === day && resource.loaded}>
        <View style={styles.notice}>
            <Card style={styles.card}>
                <Text style={textStyles.pageTitle} role="heading" aria-level={2} accessibilityRole="header">
                    {reason === 'Skipped' ? 'Skipped week' : reason === 'Bye' ? 'Bye week' : emptyCopy.message}
                </Text>
                {reason ? <Text style={textStyles.body}>This week does not change your record.</Text> : null}
                <Button title="Browse Players" onPress={onBrowse} />
            </Card>
        </View>
    </DeferredContent>
}


const styles = StyleSheet.create({
    notice: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
    card: { gap: spacing.md },
})
