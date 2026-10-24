import { useEffect, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing, table, textStyles } from '@/constants/tokens'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { formatProjectionGame, projectionFreshnessLabel, type LeagueProjectionRow } from '@/lib/projections'
import { todayET } from '@/lib/shared/dates'
import type { PlayerGame } from './season-data'

type Props = {
    projection: LeagueProjectionRow | null
    loading?: boolean
    liveGame?: PlayerGame | null
    liveFantasyPoints?: number | null
}

export function NextProjectionCard({ projection, loading = false, liveGame, liveFantasyPoints }: Props) {
    const activity = useBrowserReadActivity()
    const [, updateTime] = useState(0)
    const tipoff = projection?.next_game_time ? new Date(projection.next_game_time).getTime() : null
    useEffect(() => {
        if (!activity.active || tipoff == null || !Number.isFinite(tipoff)) return
        const delay = tipoff - Date.now()
        if (delay <= 0 || delay > 2_147_483_647) return
        const timer = setTimeout(() => updateTime(value => value + 1), delay)
        return () => clearTimeout(timer)
    }, [tipoff, activity.active, activity.revision])
    const unstarted = projection && projection.next_game_date && (tipoff != null && Number.isFinite(tipoff)
        ? tipoff > Date.now() : projection.next_game_date > todayET())
    const next = unstarted ? projection : null
    const time = next?.next_game_time ? new Date(next.next_game_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null
    const meta = next ? [
        formatProjectionGame({ ...next, projection_date: next.next_game_date }),
        next.projection_status, next.projection_source_label,
        next.projection_is_fresh === false ? 'Outdated' : null,
        projectionFreshnessLabel(next.projection_fetched_at),
    ].filter(Boolean).join(' · ') : loading ? '' : 'No upcoming game available.'
    return (
        <View style={styles.card} aria-busy={loading}>
            <View style={styles.row}>
                <View style={styles.copy}>
                    <Text style={textStyles.sectionLabel}>Next game projection</Text>
                    <Text style={styles.meta} numberOfLines={2}>{meta}</Text>
                </View>
                <View style={styles.scoreBox}>
                    <Text style={styles.score}>{next?.projection_fantasy_points != null ? next.projection_fantasy_points.toFixed(1) : '—'}</Text>
                    <Text style={textStyles.meta}>FP</Text>
                </View>
            </View>
            <Text style={[styles.note, liveGame && styles.live]} numberOfLines={1}>{liveGame
                ? `Live ${liveGame.opponent} · ${liveFantasyPoints != null ? `${liveFantasyPoints.toFixed(1)} FP` : `${liveGame.points} PTS`} so far` : time ? `Tipoff ${time}` : ' '}</Text>
        </View>
    )
}

const styles = StyleSheet.create({
    card: { height: table.rowHeight * 2, padding: spacing.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.borderLight, borderRadius: radii.lg, borderCurve: 'continuous', justifyContent: 'space-between' },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    copy: { flex: 1, minWidth: 0 },
    meta: { ...textStyles.meta, marginTop: spacing.xs, minHeight: textStyles.meta.lineHeight * 2 },
    scoreBox: { alignItems: 'flex-end', width: spacing['4xl'] * 2 },
    score: { width: '100%', textAlign: 'right', fontSize: fontSize['2xl'], fontWeight: fontWeight.extrabold, color: colors.primaryDark, fontVariant: ['tabular-nums'] },
    note: { ...textStyles.meta, height: textStyles.meta.lineHeight },
    live: { ...textStyles.meta, color: colors.success, fontWeight: fontWeight.semibold, height: textStyles.meta.lineHeight },
})
