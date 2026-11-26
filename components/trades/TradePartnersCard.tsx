import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { Card } from '@/components/ui/Card'
import { SectionBand } from '@/components/ui/SectionBand'
import { Sheet } from '@/components/ui/Sheet'
import { colors, componentTokens, controlSize, fontWeight, radii, spacing, textStyles, typeScale, uiColors } from '@/constants/tokens'
import type { TradeComposerMember } from '@/lib/trade-ui-model'

export function TradePartnersCard({
    partnerIds,
    members,
    editable,
    canAdd,
    loading,
    teamName,
    onAdd,
    onRemove,
}: {
    partnerIds: string[]
    members: TradeComposerMember[]
    editable: boolean
    canAdd: boolean
    loading: boolean
    teamName: (memberId: string) => string
    onAdd: (memberId: string) => void
    onRemove: (memberId: string) => void
}) {
    const [choosing, setChoosing] = useState(false)
    const candidates = members.filter((member) => !partnerIds.includes(member.id))
    return (
        <Card padding="none" elevated="none" style={styles.card}>
            <SectionBand label="Trade with" />
            {partnerIds.length === 0 && !loading ? (
                <Text style={styles.empty} numberOfLines={1}>Add a team to start a trade.</Text>
            ) : null}
            {partnerIds.map((memberId) => (
                <View key={memberId} style={styles.row} accessibilityState={{ selected: true }}
                    testID={`trade-participant-${memberId}`} id={`trade-participant-${memberId}`}>
                    <MaterialIcons name="groups" size={controlSize.icon.md} color={colors.textMuted} />
                    <Text style={styles.teamName} numberOfLines={1}>{teamName(memberId)}</Text>
                    {editable ? (
                        <Pressable
                            style={styles.removeButton}
                            onPress={() => onRemove(memberId)}
                            accessibilityRole="button"
                            accessibilityLabel={`Remove ${teamName(memberId)} from trade`}
                            testID={`trade-remove-participant-${memberId}`}
                            id={`trade-remove-participant-${memberId}`}
                        >
                            <Text style={styles.removeText} numberOfLines={1}>Remove</Text>
                        </Pressable>
                    ) : null}
                </View>
            ))}
            {editable ? (
                <Pressable
                    style={[styles.addRow, (!canAdd || candidates.length === 0) && styles.disabled]}
                    onPress={() => setChoosing(true)}
                    disabled={!canAdd || candidates.length === 0}
                    accessibilityRole="button"
                    accessibilityLabel={partnerIds.length === 0 ? 'Choose a team to trade with' : 'Add another team to this trade'}
                    accessibilityState={{ disabled: !canAdd || candidates.length === 0 }}
                    aria-busy={loading}
                    testID="trade-add-team"
                    id="trade-add-team"
                >
                    <MaterialIcons name="add" size={controlSize.icon.md} color={colors.primaryDark} />
                    <Text style={styles.addText} numberOfLines={1}>{partnerIds.length === 0 ? 'Choose team' : 'Add team'}</Text>
                </Pressable>
            ) : null}
            {editable ? (
                <Sheet visible={choosing} title="Trade with" onClose={() => setChoosing(false)}>
                    {candidates.map((member) => {
                        const disabled = !canAdd
                        return (
                            <Pressable
                                key={member.id}
                                style={[styles.option, disabled && styles.disabled]}
                                onPress={() => { onAdd(member.id); setChoosing(false) }}
                                disabled={disabled}
                                accessibilityRole="button"
                                accessibilityLabel={`Trade with ${member.team_name ?? 'Unnamed team'}`}
                                accessibilityState={{ selected: false, disabled }}
                                testID={`trade-participant-${member.id}`}
                                id={`trade-participant-${member.id}`}
                            >
                                <Text style={styles.teamName} numberOfLines={1}>{member.team_name ?? 'Unnamed'}</Text>
                                <MaterialIcons name="add" size={controlSize.icon.md} color={colors.primaryDark} />
                            </Pressable>
                        )
                    })}
                </Sheet>
            ) : null}
        </Card>
    )
}

const rowPadX = componentTokens.sectionBand.paddingHorizontal

const styles = StyleSheet.create({
    card: { overflow: 'hidden' },
    empty: { ...textStyles.meta, paddingHorizontal: rowPadX, paddingTop: spacing.md, color: colors.textPlaceholder },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: componentTokens.playerRow.compact.minHeight,
        paddingHorizontal: rowPadX,
        paddingVertical: spacing.xs,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    teamName: { ...textStyles.rowTitle, flex: 1, minWidth: 0 },
    removeButton: {
        flexShrink: 0,
        width: controlSize.minTouch + spacing['3xl'],
        minHeight: controlSize.minTouch,
        paddingHorizontal: spacing.sm,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: uiColors.borderNeutral,
    },
    removeText: { ...typeScale.small, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    addRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        minHeight: controlSize.minTouch,
        paddingHorizontal: rowPadX,
        paddingVertical: spacing.xs,
    },
    addText: { ...typeScale.row, flexShrink: 1, minWidth: 0, fontWeight: fontWeight.semibold, color: colors.primaryDark },
    disabled: { opacity: 0.5 },
    option: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: controlSize.minTouch,
        paddingHorizontal: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
})
