import { useEffect, useRef, useState } from 'react'
import { Platform, View, Text, Pressable, StyleSheet, ScrollView } from 'react-native'
import type { WaiverPriorityRow } from '@/lib/waivers'
import { colors, fontSize, fontWeight, spacing, table, textStyles } from '@/constants/tokens'
import { countLabel } from '@/lib/format'
import { panelStyles } from '@/components/league/draftPanelStyles'
import { tableStyles } from '@/components/league/leagueTableStyles'
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsGroup'
import { usePageMetrics } from '@/components/ui'

function settingsWaiverPriorityRowLabel(row: WaiverPriorityRow, index: number, isMe: boolean) {
    return `Waiver priority ${index + 1}, ${row.teamName}${isMe ? ', your team' : ''}, manager ${row.displayName}`
}

function WaiverPriorityGroup({ waiverOrder, myMemberId }: { waiverOrder: WaiverPriorityRow[]; myMemberId?: string }) {
    const listLabel = `Waiver priority, ${countLabel(waiverOrder.length, 'team')}`
    if (!waiverOrder.length) {
        return (
            <SettingsGroup title="Waiver priority" footer="Priority order is listed here once the season starts.">
                <SettingsRow label="No waiver priorities yet" />
            </SettingsGroup>
        )
    }
    return (
        <View role="list" aria-label={listLabel} accessibilityRole="list" accessibilityLabel={listLabel}>
            <SettingsGroup title="Waiver priority">
                {waiverOrder.map((row, index) => {
                    const isMe = row.memberId === myMemberId
                    const label = settingsWaiverPriorityRowLabel(row, index, isMe)
                    return (
                        <View
                            key={row.memberId}
                            style={[styles.waiverRow, isMe && tableStyles.rowMe]}
                            role="listitem"
                            aria-label={label}
                            accessibilityRole="text"
                            accessibilityLabel={label}
                        >
                            <Text style={[styles.waiverRank, isMe && tableStyles.textMe]}>{index + 1}</Text>
                            <Text style={[styles.waiverTeam, isMe && tableStyles.textMe]} numberOfLines={1}>{row.teamName}</Text>
                            <Text style={[textStyles.meta, styles.waiverManager]} numberOfLines={1}>{row.displayName}</Text>
                        </View>
                    )
                })}
            </SettingsGroup>
        </View>
    )
}

export function SettingsPanel({
    inviteCode,
    isCommissioner,
    waiverOrder,
    myMemberId,
    onShareInviteCode,
    onOpenBracket,
    onOpenCommissionerSettings,
    onOpenProfile,
}: {
    inviteCode?: string | null
    isCommissioner: boolean
    waiverOrder: WaiverPriorityRow[]
    myMemberId?: string
    onShareInviteCode: () => void
    onOpenBracket: () => void
    onOpenCommissionerSettings: () => void
    onOpenProfile: () => void
}) {
    const { padX } = usePageMetrics()
    const shareInviteAccessibilityLabel = inviteCode ? `Share invite code ${inviteCode}` : 'Share invite code'
    const [copied, setCopied] = useState(false)
    const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const canCopy = Platform.OS === 'web'
        && typeof navigator !== 'undefined'
        && !!navigator.clipboard
        && !!inviteCode

    useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current) }, [])

    async function handleCopyInviteCode() {
        if (!inviteCode) return
        try {
            await navigator.clipboard.writeText(inviteCode)
            setCopied(true)
            if (copiedTimer.current) clearTimeout(copiedTimer.current)
            copiedTimer.current = setTimeout(() => setCopied(false), 2000)
        } catch {
            // Clipboard permission denied — the Share action still works.
        }
    }

    return (
        <ScrollView contentContainerStyle={[panelStyles.panelScroll, { paddingHorizontal: padX }]}>
            <SettingsGroup title="League">
                <SettingsRow
                    label="Invite code"
                    value={inviteCode ?? '—'}
                    onPress={onShareInviteCode}
                    accessibilityLabel={shareInviteAccessibilityLabel}
                    accessory={(
                        <View style={styles.inviteActions}>
                            {canCopy ? (
                                <Pressable
                                    // Nested inside the Share row — stop the press from
                                    // bubbling into the outer share handler on web.
                                    onPress={(e) => { e.stopPropagation(); void handleCopyInviteCode() }}
                                    role="button"
                                    aria-label="Copy invite code"
                                    accessibilityRole="button"
                                    accessibilityLabel="Copy invite code"
                                    hitSlop={8}
                                >
                                    <Text style={styles.inviteAction}>{copied ? 'Copied' : 'Copy'}</Text>
                                </Pressable>
                            ) : null}
                            <Text style={styles.inviteAction}>Share</Text>
                        </View>
                    )}
                />
                <SettingsRow label="Playoff bracket" onPress={onOpenBracket} accessibilityLabel="Open playoff bracket" />
                {isCommissioner ? (
                    <SettingsRow label="Commissioner settings" onPress={onOpenCommissionerSettings} accessibilityLabel="Open commissioner settings" />
                ) : null}
            </SettingsGroup>
            <SettingsGroup title="You">
                <SettingsRow label="Profile & settings" onPress={onOpenProfile} accessibilityLabel="Open profile and settings" />
            </SettingsGroup>
            <WaiverPriorityGroup waiverOrder={waiverOrder} myMemberId={myMemberId} />
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    inviteActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
    inviteAction: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.primaryDark },
    waiverRow: {
        minHeight: table.rowHeightCompact,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
    },
    waiverRank: { width: 24, fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textMuted, fontVariant: ['tabular-nums'] as const },
    waiverTeam: { ...textStyles.rowTitle, flex: 1, minWidth: 0 },
    waiverManager: { flexShrink: 1, textAlign: 'right' },
})
