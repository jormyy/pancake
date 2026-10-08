import { View, Text, StyleSheet } from 'react-native'
import { useEffect, useState, type ReactNode } from 'react'
import type { RosterPlayer } from '@/lib/roster'
import { colors, fontWeight, spacing, textStyles } from '@/constants/tokens'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { playerHeadshotUrl } from '@/lib/format'

type Phase = 'ineligible' | 'drop-to-activate'

type Props = {
    visible: boolean
    ineligibleIR: RosterPlayer[]
    activeRoster: RosterPlayer[]
    rosterSize: number
    pendingPlayerName: string
    onActivate: (player: RosterPlayer) => Promise<void>
    onDropAndActivate: (dropPlayer: RosterPlayer, activatePlayer: RosterPlayer) => Promise<void>
    onCancel: () => void
}

function PlayerLine({ player, action }: { player: RosterPlayer; action: ReactNode }) {
    const p = player.players
    return (
        <View style={styles.row}>
            <Avatar
                name={p.display_name}
                uri={playerHeadshotUrl(p.nba_id) ?? undefined}
                color={colors.bgMuted}
                size={36}
            />
            <View style={styles.info}>
                <Text style={textStyles.rowTitle} numberOfLines={1}>{p.display_name}</Text>
                <Text style={textStyles.meta}>{[p.nba_team, p.position].filter(Boolean).join(' · ')}</Text>
            </View>
            {action}
        </View>
    )
}

export function IRResolutionModal({
    visible,
    ineligibleIR,
    activeRoster,
    rosterSize,
    pendingPlayerName,
    onActivate,
    onDropAndActivate,
    onCancel,
}: Props) {
    const [phase, setPhase] = useState<Phase>('ineligible')
    const [activatingPlayer, setActivatingPlayer] = useState<RosterPlayer | null>(null)
    const [loadingId, setLoadingId] = useState<string | null>(null)

    const activeCount = activeRoster.length
    const hasRoom = activeCount < rosterSize

    function reset() {
        setPhase('ineligible')
        setActivatingPlayer(null)
        setLoadingId(null)
    }

    // Start from the first step every time the sheet opens.
    useEffect(() => {
        if (visible) reset()
    }, [visible])

    async function handleActivate(player: RosterPlayer) {
        if (hasRoom) {
            setLoadingId(player.id)
            try {
                await onActivate(player)
            } finally {
                setLoadingId(null)
            }
        } else {
            // Need to drop someone first
            setActivatingPlayer(player)
            setPhase('drop-to-activate')
        }
    }

    async function handleDropAndActivate(dropPlayer: RosterPlayer) {
        if (!activatingPlayer) return
        setLoadingId(dropPlayer.id)
        try {
            await onDropAndActivate(dropPlayer, activatingPlayer)
        } finally {
            setLoadingId(null)
        }
    }

    const handleRequestClose = () => {
        if (loadingId !== null) return
        reset()
        onCancel()
    }

    return (
        <Sheet
            visible={visible}
            onClose={handleRequestClose}
            title={phase === 'ineligible' ? 'Resolve IR status' : 'Drop to activate'}
        >
            {phase === 'ineligible' ? (
                <>
                    <Text style={styles.sub}>
                        Activate these players before adding{' '}
                        <Text style={styles.playerName}>{pendingPlayerName}</Text>.
                    </Text>
                    <View style={styles.list}>
                        {ineligibleIR.map((rp) => (
                            <PlayerLine
                                key={rp.id}
                                player={rp}
                                action={(
                                    <Button
                                        title="Activate"
                                        size="sm"
                                        onPress={() => handleActivate(rp)}
                                        disabled={loadingId !== null}
                                        loading={loadingId === rp.id}
                                        accessibilityLabel={`Activate ${rp.players.display_name}`}
                                    />
                                )}
                            />
                        ))}
                    </View>
                </>
            ) : (
                <>
                    <Text style={styles.sub}>
                        Drop a player to activate{' '}
                        <Text style={styles.playerName}>{activatingPlayer?.players.display_name}</Text> from IR.
                    </Text>
                    <View style={styles.list}>
                        {activeRoster.map((rp) => (
                            <PlayerLine
                                key={rp.id}
                                player={rp}
                                action={(
                                    <Button
                                        title="Drop"
                                        size="sm"
                                        variant="danger"
                                        onPress={() => handleDropAndActivate(rp)}
                                        disabled={loadingId !== null}
                                        loading={loadingId === rp.id}
                                        accessibilityLabel={`Drop ${rp.players.display_name}`}
                                    />
                                )}
                            />
                        ))}
                    </View>
                </>
            )}

            <Button
                title="Cancel"
                variant="ghost"
                onPress={handleRequestClose}
                disabled={loadingId !== null}
                fullWidth
                style={styles.cancel}
            />
        </Sheet>
    )
}

const styles = StyleSheet.create({
    sub: { ...textStyles.body, marginBottom: spacing.md },
    playerName: { color: colors.primaryDark, fontWeight: fontWeight.semibold },
    list: { borderTopWidth: 1, borderTopColor: colors.separator },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 56,
        paddingVertical: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        gap: spacing.md,
    },
    info: { flex: 1, minWidth: 0, gap: spacing.xxs },
    cancel: { marginTop: spacing.md },
})
