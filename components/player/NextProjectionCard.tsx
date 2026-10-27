import { useEffect, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { colors, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import type { LeagueProjectionRow } from '@/lib/projections'
import { todayET } from '@/lib/shared/dates'
import type { PlayerGame } from './season-data'

type Props = {
    projection: LeagueProjectionRow | null
    loading?: boolean
    reserveSpace?: boolean
    liveGame?: PlayerGame | null
    liveFantasyPoints?: number | null
}

export function NextProjectionCard({ projection, loading = false, reserveSpace = false, liveGame, liveFantasyPoints }: Props) {
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
    if (!liveGame && !next) return reserveSpace ? <View style={styles.slot} testID="player-projection-slot" aria-hidden /> : null
    const date = next ? new Date(tipoff != null && Number.isFinite(tipoff) ? tipoff : `${next.next_game_date}T12:00:00`) : null
    const weekday = date?.toLocaleDateString('en-US', { weekday: 'short' })
    const time = next?.next_game_time && tipoff != null && Number.isFinite(tipoff)
        ? date?.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null
    const summary = liveGame
        ? `Live ${liveGame.opponent} · ${liveFantasyPoints != null ? `${liveFantasyPoints.toFixed(1)} FP` : `${liveGame.points} PTS`} so far`
        : [[next?.next_game_opponent, weekday, time].filter(Boolean).join(' '), next?.projection_fantasy_points == null ? '— proj' : `${next.projection_fantasy_points.toFixed(1)} proj`].join(' · ')
    const sourceTime = next?.projection_fetched_at ? new Date(next.projection_fetched_at) : null
    const source = !liveGame && next ? [next.projection_source_label, next.projection_is_fresh === false ? 'Out of date' : null, sourceTime && Number.isFinite(sourceTime.getTime()) ? `Updated ${sourceTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : null].filter(Boolean).join(' · ') : null
    const card = (
        <View style={styles.card} aria-busy={loading}>
            <Text style={[styles.summary, liveGame && styles.live]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>{summary}</Text>
            {source ? <Text style={styles.source}>{source}</Text> : null}
        </View>
    )
    return reserveSpace ? <View style={styles.slot} testID="player-projection-slot">{card}</View> : card
}

const styles = StyleSheet.create({
    slot: { minHeight: textStyles.meta.lineHeight + spacing.md * 2 + 2 },
    card: { padding: spacing.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.borderLight, borderRadius: radii.lg, borderCurve: 'continuous' },
    summary: { ...textStyles.meta, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
    source: { ...textStyles.meta, fontSize: textStyles.tableHeader.fontSize, lineHeight: textStyles.tableHeader.lineHeight, color: colors.textMuted, marginTop: spacing.xxs },
    live: { color: colors.success, fontWeight: fontWeight.semibold },
})
