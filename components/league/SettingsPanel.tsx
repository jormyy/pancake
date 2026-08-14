import { useEffect, useRef, useState } from 'react'
import { Platform, View, Text, Pressable, StyleSheet, ScrollView, useWindowDimensions } from 'react-native'
import type { WaiverPriorityRow } from '@/lib/waivers'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { countLabel } from '@/lib/format'
import { panelStyles } from '@/components/league/draftPanelStyles'

function settingsWaiverPriorityRowLabel(row: WaiverPriorityRow, index: number, isMe: boolean) {
    return `Waiver priority ${index + 1}, ${row.teamName}${isMe ? ', your team' : ''}, manager ${row.displayName}`
}

function settingsCompactWaiverSummaryLabel(waiverOrder: WaiverPriorityRow[], myMemberId?: string) {
    if (!waiverOrder.length) return 'No waiver priorities yet. Priority order is listed here once the season starts.'
    const top = waiverOrder[0]
    const isMe = top.memberId === myMemberId
    return `Waiver priority, ${countLabel(waiverOrder.length, 'team')}. First priority ${top.teamName}${isMe ? ', your team' : ''}.`
}

function SettingsCompactWaiverSummary({
    waiverOrder,
    myMemberId,
}: {
    waiverOrder: WaiverPriorityRow[]
    myMemberId?: string
}) {
    const accessibilityLabel = settingsCompactWaiverSummaryLabel(waiverOrder, myMemberId)
    const value = waiverOrder.length ? `${waiverOrder.length} teams` : 'No priority'
    return (
        <View
            style={styles.settingsCompactWaiverSummary}
            role="status"
            aria-label={accessibilityLabel}
            aria-live="polite"
            accessibilityLabel={accessibilityLabel}
            accessibilityLiveRegion="polite"
        >
            <Text style={styles.settingsCompactWaiverLabel} numberOfLines={1}>Waivers</Text>
            <Text style={styles.settingsCompactWaiverValue} numberOfLines={1}>{value}</Text>
        </View>
    )
}

function SettingsWaiverPriorityCard({
    waiverOrder,
    myMemberId,
    compact,
}: {
    waiverOrder: WaiverPriorityRow[]
    myMemberId?: string
    compact: boolean
}) {
    const listLabel = `Waiver priority, ${countLabel(waiverOrder.length, 'team')}`
    const emptyLabel = 'No waiver priorities yet.'
    const emptyDescription = 'Priority order is listed here once the season starts.'
    const emptyAccessibilityLabel = `${emptyLabel} ${emptyDescription}`

    return (
        <View style={[panelStyles.panelCard, compact && panelStyles.panelCardCompact]}>
            <Text
                style={panelStyles.panelTitle}
                role="heading"
                aria-level={2}
                accessibilityRole="header"
            >
                Waiver Priority
            </Text>
            {waiverOrder.length ? (
                <View
                    role="list"
                    aria-label={listLabel}
                    accessibilityRole="list"
                    accessibilityLabel={listLabel}
                >
                    {waiverOrder.map((row, index) => {
                        const isMe = row.memberId === myMemberId
                        const label = settingsWaiverPriorityRowLabel(row, index, isMe)
                        return (
                            <View
                                key={row.memberId}
                                style={[styles.settingListRow, isMe && styles.settingListRowMe]}
                                role="listitem"
                                aria-label={label}
                                accessibilityRole="text"
                                accessibilityLabel={label}
                            >
                                <Text style={[styles.settingListRank, isMe && styles.settingListTextMe]}>{index + 1}</Text>
                                <Text style={[styles.settingListTeam, isMe && styles.settingListTextMe]} numberOfLines={1}>{row.teamName}</Text>
                                <Text style={[styles.settingListName, isMe && styles.settingListTextMe]} numberOfLines={1}>{row.displayName}</Text>
                            </View>
                        )
                    })}
                </View>
            ) : (
                <View
                    style={styles.settingsEmptyState}
                    role="status"
                    aria-label={emptyAccessibilityLabel}
                    aria-live="polite"
                    accessibilityLabel={emptyAccessibilityLabel}
                    accessibilityLiveRegion="polite"
                >
                    <Text style={styles.settingsEmptyTitle}>{emptyLabel}</Text>
                    <Text style={styles.settingsEmptyText}>{emptyDescription}</Text>
                </View>
            )}
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
}: {
    inviteCode?: string | null
    isCommissioner: boolean
    waiverOrder: WaiverPriorityRow[]
    myMemberId?: string
    onShareInviteCode: () => void
    onOpenBracket: () => void
    onOpenCommissionerSettings: () => void
}) {
    const { width, height } = useWindowDimensions()
    const compactLandscape = width >= 600 && height < 500
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

    if (compactLandscape) {
        return (
            <ScrollView contentContainerStyle={[panelStyles.panelScroll, styles.settingsScrollCompact, panelStyles.panelScrollCompactLandscape]}>
                <View style={styles.settingsCompactTopRow}>
                    <Pressable
                        style={[panelStyles.secondaryDraftButton, styles.settingsCompactShareButton]}
                        onPress={onShareInviteCode}
                        role="button"
                        aria-label={shareInviteAccessibilityLabel}
                        accessibilityRole="button"
                        accessibilityLabel={shareInviteAccessibilityLabel}
                    >
                        <Text style={panelStyles.secondaryDraftButtonText} numberOfLines={1}>
                            Invite {inviteCode}
                        </Text>
                    </Pressable>
                    {canCopy ? (
                        <Pressable
                            style={[panelStyles.secondaryDraftButton, styles.settingsCompactButton]}
                            onPress={handleCopyInviteCode}
                            role="button"
                            aria-label="Copy invite code"
                            accessibilityRole="button"
                            accessibilityLabel="Copy invite code"
                        >
                            <Text style={panelStyles.secondaryDraftButtonText} numberOfLines={1}>{copied ? 'Copied!' : 'Copy'}</Text>
                        </Pressable>
                    ) : null}
                    <Pressable
                        style={[panelStyles.secondaryDraftButton, styles.settingsCompactButton]}
                        onPress={onOpenBracket}
                        role="button"
                        aria-label="Open playoff bracket"
                        accessibilityRole="button"
                        accessibilityLabel="Open playoff bracket"
                    >
                        <Text style={panelStyles.secondaryDraftButtonText} numberOfLines={1}>Bracket</Text>
                    </Pressable>
                    {isCommissioner ? (
                        <Pressable
                            style={[panelStyles.secondaryDraftButton, styles.settingsCompactButton]}
                            onPress={onOpenCommissionerSettings}
                            role="button"
                            aria-label="Open commissioner settings"
                            accessibilityRole="button"
                            accessibilityLabel="Open commissioner settings"
                        >
                            <Text style={panelStyles.secondaryDraftButtonText} numberOfLines={1}>Commissioner</Text>
                        </Pressable>
                    ) : null}
                    <SettingsCompactWaiverSummary waiverOrder={waiverOrder} myMemberId={myMemberId} />
                </View>
            </ScrollView>
        )
    }

    return (
        <ScrollView contentContainerStyle={panelStyles.panelScroll}>
            <Pressable
                style={styles.inviteRow}
                onPress={onShareInviteCode}
                role="button"
                aria-label={shareInviteAccessibilityLabel}
                accessibilityRole="button"
                accessibilityLabel={shareInviteAccessibilityLabel}
            >
                <Text style={styles.inviteLabel}>Invite Code</Text>
                <Text style={styles.inviteCode}>{inviteCode}</Text>
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
                        <Text style={styles.inviteCopy}>{copied ? 'Copied!' : 'Copy'}</Text>
                    </Pressable>
                ) : null}
                <Text style={styles.inviteCopy}>Share</Text>
            </Pressable>
            <View style={styles.settingsActionRow}>
                <Pressable
                    style={panelStyles.secondaryDraftButton}
                    onPress={onOpenBracket}
                    role="button"
                    aria-label="Open playoff bracket"
                    accessibilityRole="button"
                    accessibilityLabel="Open playoff bracket"
                >
                    <Text style={panelStyles.secondaryDraftButtonText}>Bracket</Text>
                </Pressable>
                {isCommissioner ? (
                    <Pressable
                        style={panelStyles.secondaryDraftButton}
                        onPress={onOpenCommissionerSettings}
                        role="button"
                        aria-label="Open commissioner settings"
                        accessibilityRole="button"
                        accessibilityLabel="Open commissioner settings"
                    >
                        <Text style={panelStyles.secondaryDraftButtonText}>Commissioner Settings</Text>
                    </Pressable>
                ) : null}
            </View>
            <SettingsWaiverPriorityCard waiverOrder={waiverOrder} myMemberId={myMemberId} compact={false} />
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    settingsScrollCompact: {
        paddingTop: spacing.sm,
        paddingHorizontal: spacing.md,
        gap: spacing.sm,
    },
    settingsActionRow: { gap: spacing.md },
    settingsCompactTopRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: spacing.xs,
    },
    settingsCompactShareButton: {
        flex: 1.25,
        minWidth: 0,
        paddingHorizontal: spacing.sm,
    },
    settingsCompactButton: {
        flex: 1,
        minWidth: 0,
        paddingHorizontal: spacing.sm,
    },
    settingsCompactWaiverSummary: {
        flex: 0.95,
        minWidth: 0,
        minHeight: 44,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgSubtle,
        justifyContent: 'center',
        paddingHorizontal: spacing.sm,
    },
    settingsCompactWaiverLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0,
    },
    settingsCompactWaiverValue: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
    },
    settingListRow: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.sm,
        borderTopWidth: 1,
        borderTopColor: colors.separator,
    },
    settingListRowMe: { backgroundColor: colors.primaryLight, paddingHorizontal: spacing.sm, marginHorizontal: -spacing.sm },
    settingListTextMe: { color: colors.primaryDark, fontWeight: fontWeight.bold },
    settingListRank: { width: 28, fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textSecondary },
    settingListTeam: { flex: 1, minWidth: 0, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    settingListName: { width: 120, textAlign: 'right', fontSize: fontSize.sm, color: colors.textMuted },
    settingsEmptyState: {
        minHeight: 44,
        justifyContent: 'center',
        gap: spacing.xs,
        paddingTop: spacing.xs,
    },
    settingsEmptyTitle: {
        fontSize: fontSize.md,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },
    settingsEmptyText: {
        fontSize: fontSize.sm,
        lineHeight: 18,
        color: colors.textMuted,
    },

    inviteRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        minHeight: 44,
        gap: spacing.md,
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 14,
        paddingVertical: spacing.lg,
    },
    inviteLabel: { fontSize: fontSize.sm, color: colors.textMuted, flex: 1 },
    inviteCode: { flexShrink: 1, fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: colors.textPrimary, letterSpacing: 0 },
    inviteCopy: { fontSize: fontSize.sm, color: colors.primaryDark, fontWeight: fontWeight.semibold },
})
