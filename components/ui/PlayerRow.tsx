import { LineupPinTag } from '@/components/LineupPinTag'
import type { LineupPin } from '@/lib/lineup/pins'
import { LockedAssetNotice } from '@/components/roster/LockedAssetNotice'
import type { AssetLock } from '@/lib/locked-assets'
import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors, componentTokens, spacing, textStyles } from '@/constants/tokens'
import { PlayerAvatar } from '@/components/player/PlayerAvatar'
import { useJerseyNumber } from '@/hooks/use-jersey-number'
import { Avatar } from '@/components/Avatar'
import { PlayerDetailsLine } from '@/components/player/PlayerDetailsLine'
import { InjuryTag } from '@/components/InjuryTag'
import { PlayerEligibilityTags } from '@/components/player/PlayerEligibilityTags'
import { Badge } from '@/components/ui/Badge'
import { usePlayerAge } from '@/hooks/use-player-age'

export type PlayerRowProps = {
    lineupPin?: LineupPin
    locks?: readonly AssetLock[]
    playerId?: string | null
    name: string
    /** Shown as #N on the second line; looked up by player when omitted. */
    jerseyNumber?: string | null
    nbaId?: string | null
    headshotUrl?: string | null
    team?: string | null
    positions?: readonly string[]
    age?: number | null
    birthdate?: string | null
    yearsExp?: number | null
    careerGames?: number | null
    onTaxi?: boolean
    injuryStatus?: string | null
    stats?: ReactNode
    metadata?: ReactNode
    live?: boolean
    compact?: boolean
    variant?: 'compact' | 'standard'
    showTags?: boolean
}

export function PlayerRow({ lineupPin, locks = [], playerId, name, jerseyNumber, nbaId, headshotUrl, team, positions = [], age, birthdate, yearsExp, careerGames, onTaxi, injuryStatus, stats, metadata, live = false, compact = false, variant, showTags = false }: PlayerRowProps) {
    compact = variant ? variant === 'compact' : compact
    const jersey = useJerseyNumber(playerId, nbaId, jerseyNumber)
    const avatarSize = componentTokens.playerRow[compact ? 'compact' : 'standard'].avatarSize
    return <View style={[styles.row, compact && styles.compactRow]} testID="player-row-content">
        <View testID="player-row-avatar">{headshotUrl ? <Avatar name={name} uri={headshotUrl} size={avatarSize} /> : <PlayerAvatar name={name} nbaId={nbaId} size={avatarSize} />}<InjuryTag status={injuryStatus} avatarSize={avatarSize} /></View>
        <View style={[styles.copy, compact && styles.compactCopy]}>
            <Text style={styles.name} testID="player-name-line">{name}</Text>
            <View style={[styles.metadata, compact && styles.compactMetadata]} testID="player-meta-line">
                <PlayerDetailsLine team={team} positions={positions} jersey={jersey} />
                {showTags ? <PlayerTags playerId={playerId} nbaId={nbaId} age={age} birthdate={birthdate} yearsExp={yearsExp} careerGames={careerGames} onTaxi={onTaxi} /> : null}
                {locks.length > 0 ? <LockedAssetNotice locks={locks} /> : null}
                <LineupPinTag pin={lineupPin} />
                {metadata}
            </View>
            {stats != null ? <View style={styles.stats} testID="player-stats-line">
                {typeof stats === 'string' || typeof stats === 'number' ? <Text style={[styles.statText, live && styles.live]} numberOfLines={compact ? undefined : 1}>{stats}</Text> : stats}
            </View> : null}
        </View>
    </View>
}

function PlayerTags({ playerId, nbaId, age, birthdate, yearsExp, careerGames, onTaxi }: Pick<PlayerRowProps, 'playerId' | 'nbaId' | 'age' | 'birthdate' | 'yearsExp' | 'careerGames' | 'onTaxi'>) {
    const displayAge = usePlayerAge(playerId, birthdate, age, nbaId)
    return <>
        <PlayerEligibilityTags yearsExp={yearsExp} careerGames={careerGames} onTaxi={onTaxi} />
        {displayAge != null ? <Badge inline label={`${displayAge}`} accessibilityLabel={`Age ${displayAge}`} color={colors.textMuted} /> : null}
        {yearsExp != null ? <Badge inline label={`Yr ${yearsExp + 1}`} color={colors.textMuted} /> : null}
    </>
}

const styles = StyleSheet.create({
    row: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: componentTokens.playerRow.standard.gap },
    compactRow: { gap: componentTokens.playerRow.compact.gap },
    copy: { flex: 1, minWidth: 0, gap: componentTokens.playerRow.standard.copyGap },
    compactCopy: { gap: componentTokens.playerRow.compact.copyGap },
    compactMetadata: { flexWrap: 'wrap' },
    name: { ...componentTokens.playerRow.name, minWidth: 0 },
    // The team logo inks its full line height, so it needs a little extra room below the name to
    // look as far from it as the third line looks from this one.
    metadata: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: componentTokens.playerRow.metadataGap, minHeight: componentTokens.badge.inline.minHeight, minWidth: 0, marginTop: spacing.xxs },
    stats: { minHeight: textStyles.meta.lineHeight, minWidth: 0 },
    statText: { ...componentTokens.playerRow.metadata, color: colors.primaryDark, fontVariant: ['tabular-nums'] },
    live: { color: colors.success },
})
