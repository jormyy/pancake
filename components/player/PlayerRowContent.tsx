import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors, controlSize, spacing, textStyles } from '@/constants/tokens'
import { PlayerAvatar } from './PlayerAvatar'
import { PlayerEligibilityTags } from './PlayerEligibilityTags'
import { Avatar } from '@/components/Avatar'
import { PosTag } from '@/components/PosTag'

export type PlayerRowContentProps = {
    name: string
    nbaId?: string | null
    headshotUrl?: string | null
    team?: string | null
    positions?: readonly string[]
    yearsExp?: number | null
    careerGames?: number | null
    onTaxi?: boolean
    injuryStatus?: string | null
    stats?: ReactNode
    metadata?: ReactNode
    live?: boolean
    compact?: boolean
}

export function PlayerRowContent({ name, nbaId, headshotUrl, team, positions = [], yearsExp, careerGames, injuryStatus, onTaxi, stats, metadata, live = false, compact = false }: PlayerRowContentProps) {
    const avatarSize = compact ? controlSize.avatar.sm : controlSize.avatar.md
    return <View style={styles.row} testID="player-row-content">
        <View testID="player-row-avatar">{headshotUrl ? <Avatar name={name} uri={headshotUrl} size={avatarSize} /> : <PlayerAvatar name={name} nbaId={nbaId} size={avatarSize} />}</View>
        <View style={[styles.copy, compact && styles.compactCopy]}>
            <Text style={styles.name} numberOfLines={compact ? 2 : 1} testID="player-name-line">{name}</Text>
            <View style={[styles.metadata, compact && styles.compactMetadata]} testID="player-meta-line">
                {team ? <Text style={styles.team} numberOfLines={1}>{team}</Text> : null}
                {positions.map(position => <PosTag key={position} position={position} />)}
                <PlayerEligibilityTags yearsExp={yearsExp} careerGames={careerGames} injuryStatus={injuryStatus} onTaxi={onTaxi} />
                {metadata}
            </View>
            {stats != null ? <View style={styles.stats} testID="player-stats-line">
                {typeof stats === 'string' || typeof stats === 'number' ? <Text style={[styles.statText, live && styles.live]} numberOfLines={compact ? undefined : 1}>{stats}</Text> : stats}
            </View> : null}
        </View>
    </View>
}

const styles = StyleSheet.create({
    row: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    copy: { flex: 1, minWidth: 0, gap: spacing.xxs },
    compactCopy: { gap: 0 },
    compactMetadata: { flexWrap: 'wrap' },
    name: { ...textStyles.rowTitle, minWidth: 0 },
    metadata: { flexDirection: 'row', alignItems: 'center', gap: spacing.xxs, minHeight: controlSize.badge.height, minWidth: 0 },
    team: { ...textStyles.meta, flexShrink: 1 },
    stats: { minHeight: textStyles.meta.lineHeight, minWidth: 0 },
    statText: { ...textStyles.meta, color: colors.primaryDark, fontVariant: ['tabular-nums'] },
    live: { color: colors.success },
})
