import { StyleSheet, Text, View } from 'react-native'
import { Sheet } from '@/components/ui/Sheet'
import { Avatar } from '@/components/Avatar'
import { colors, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
import type { LiveStatLine } from '@/lib/games'
import type { LineupPlayer } from '@/lib/lineup'
import { formatPoints, playerHeadshotUrl, shortName } from '@/lib/format'
import { scoreBreakdown, type BreakdownRow } from '@/lib/score-breakdown'
import { computeLiveFantasyPoints } from '@/lib/scoring'

type Side = {
    player: LineupPlayer | null
    stats?: LiveStatLine
}

function signedPoints(value: number | null): string {
    if (value == null) return '–'
    if (value === 0) return '0'
    return `${value > 0 ? '+' : ''}${formatPoints(value)}`
}

function sideTotal(side: Side, settings: Record<string, number>): number | null {
    if (!side.player || !side.stats || side.stats.didNotPlay) return null
    return computeLiveFantasyPoints(side.stats, settings)
}

function sideStatus(side: Side): string {
    if (!side.player) return 'Empty slot'
    if (!side.stats) return 'No stats yet'
    if (side.stats.didNotPlay) return 'Did not play'
    return side.stats.minutesPlayed != null ? `${side.stats.minutesPlayed} min` : 'Played'
}

function PlayerHead({ side, total, align }: { side: Side; total: number | null; align: 'left' | 'right' }) {
    const right = align === 'right'
    return (
        <View style={[styles.head, right && styles.headRight]}>
            {side.player ? (
                <Avatar
                    name={side.player.displayName}
                    uri={playerHeadshotUrl(side.player.nbaId) ?? undefined}
                    color={colors.bgMuted}
                    textColor={colors.textSecondary}
                    size={40}
                />
            ) : null}
            <Text style={[textStyles.rowTitle, right && styles.textRight]} numberOfLines={1}>
                {side.player ? shortName(side.player.displayName) : '—'}
            </Text>
            <Text style={[textStyles.meta, right && styles.textRight]} numberOfLines={1}>{sideStatus(side)}</Text>
            <Text style={[styles.total, right && styles.textRight]}>{formatPoints(total)}</Text>
        </View>
    )
}

function rowFor(rows: BreakdownRow[], key: string) {
    return rows.find((row) => row.key === key)
}

/**
 * How each player in one lineup slot earned their points: every stat the
 * league scores, the count, and the points it added or took away.
 */
export function ScoreBreakdownSheet({
    visible,
    onClose,
    slotType,
    mine,
    theirs,
    settings,
}: {
    visible: boolean
    onClose: () => void
    slotType: string
    mine: Side
    theirs: Side
    settings: Record<string, number>
}) {
    const myRows = scoreBreakdown(mine.player ? mine.stats : undefined, settings)
    const theirRows = scoreBreakdown(theirs.player ? theirs.stats : undefined, settings)

    return (
        <Sheet visible={visible} onClose={onClose} title={`${slotType} slot · Score breakdown`}>
            <View style={styles.heads}>
                <PlayerHead side={mine} total={sideTotal(mine, settings)} align="left" />
                <PlayerHead side={theirs} total={sideTotal(theirs, settings)} align="right" />
            </View>
            <View style={styles.table} role="table" aria-label="Points by stat">
                <View style={[styles.tableRow, styles.tableHeader]} role="row">
                    <Text style={[styles.headCell, styles.numCell]} role="columnheader">Stat</Text>
                    <Text style={[styles.headCell, styles.numCell]} role="columnheader">FP</Text>
                    <Text style={[styles.headCell, styles.labelCell]} role="columnheader">Category</Text>
                    <Text style={[styles.headCell, styles.numCell]} role="columnheader">FP</Text>
                    <Text style={[styles.headCell, styles.numCell]} role="columnheader">Stat</Text>
                </View>
                {myRows.map((row) => {
                    const theirRow = rowFor(theirRows, row.key)
                    return (
                        <View key={row.key} style={styles.tableRow} role="row">
                            <Text style={[styles.cell, styles.numCell]}>{row.count ?? '–'}</Text>
                            <Text style={[styles.cell, styles.numCell, styles.pointsCell, (row.points ?? 0) < 0 && styles.negative]}>
                                {signedPoints(row.points)}
                            </Text>
                            <View style={styles.labelCell}>
                                <Text style={styles.label} numberOfLines={1}>{row.label}</Text>
                                <Text style={styles.weight}>{`${row.weight > 0 ? '+' : ''}${row.weight} each`}</Text>
                            </View>
                            <Text style={[styles.cell, styles.numCell, styles.pointsCell, (theirRow?.points ?? 0) < 0 && styles.negative]}>
                                {signedPoints(theirRow?.points ?? null)}
                            </Text>
                            <Text style={[styles.cell, styles.numCell]}>{theirRow?.count ?? '–'}</Text>
                        </View>
                    )
                })}
            </View>
        </Sheet>
    )
}

const styles = StyleSheet.create({
    heads: { flexDirection: 'row', gap: spacing.xl, marginBottom: spacing.lg },
    head: { flex: 1, minWidth: 0, gap: spacing.xxs },
    headRight: { alignItems: 'flex-end' },
    textRight: { textAlign: 'right' },
    total: { ...textStyles.hero, fontSize: fontSize['3xl'], lineHeight: 32, color: colors.textPrimary, marginTop: spacing.xs },
    table: {
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        overflow: 'hidden',
    },
    tableRow: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 40,
        paddingHorizontal: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    tableHeader: { minHeight: 32, backgroundColor: colors.bgSubtle },
    headCell: { ...textStyles.sectionLabel, fontSize: fontSize['2xs'], textAlign: 'center' },
    cell: { fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', fontVariant: ['tabular-nums'] as const },
    numCell: { width: 52 },
    pointsCell: { fontWeight: fontWeight.bold, color: colors.textPrimary },
    negative: { color: colors.dangerDark },
    labelCell: { flex: 1, minWidth: 0, alignItems: 'center' },
    label: { fontSize: fontSize['2sm'], fontWeight: fontWeight.semibold, color: colors.textPrimary },
    weight: { fontSize: fontSize['2xs'], color: colors.textMuted },
})
