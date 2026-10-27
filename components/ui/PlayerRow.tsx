import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors, componentTokens, textStyles } from '@/constants/tokens'
import { PlayerAvatar } from '@/components/player/PlayerAvatar'
import { PlayerEligibilityTags } from '@/components/player/PlayerEligibilityTags'
import { Avatar } from '@/components/Avatar'
import { PosTag } from '@/components/PosTag'

export type PlayerRowProps = {
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
    variant?: 'compact' | 'standard'
}

export function PlayerRow({ name, nbaId, headshotUrl, team, positions = [], yearsExp, careerGames, injuryStatus, onTaxi, stats, metadata, live = false, compact = false, variant }: PlayerRowProps) {
    compact = variant ? variant === 'compact' : compact
    const avatarSize = componentTokens.playerRow[compact ? 'compact' : 'standard'].avatarSize
    return <View style={[styles.row, compact && styles.compactRow]} testID="player-row-content">
        <View testID="player-row-avatar">{headshotUrl ? <Avatar name={name} uri={headshotUrl} size={avatarSize} /> : <PlayerAvatar name={name} nbaId={nbaId} size={avatarSize} />}</View>
        <View style={[styles.copy, compact && styles.compactCopy]}>
            <Text style={styles.name} testID="player-name-line">{name}</Text>
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
    row: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: componentTokens.playerRow.standard.gap },
    compactRow: { gap: componentTokens.playerRow.compact.gap },
    copy: { flex: 1, minWidth: 0, gap: componentTokens.playerRow.standard.copyGap },
    compactCopy: { gap: componentTokens.playerRow.compact.copyGap },
    compactMetadata: { flexWrap: 'wrap' },
    name: { ...componentTokens.playerRow.name, minWidth: 0 },
    metadata: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: componentTokens.playerRow.metadataGap, minHeight: componentTokens.badge.inline.minHeight, minWidth: 0 },
    team: { ...componentTokens.playerRow.metadata, flexShrink: 1 },
    stats: { minHeight: textStyles.meta.lineHeight, minWidth: 0 },
    statText: { ...componentTokens.playerRow.metadata, color: colors.primaryDark, fontVariant: ['tabular-nums'] },
    live: { color: colors.success },
})
