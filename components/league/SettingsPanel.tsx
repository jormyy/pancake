import { ScreenStatusScrollView as ScrollView } from '@/components/ui/ScreenStatusOverlay'
import { useEffect, useRef, useState } from 'react'
import { Platform, View, Text, StyleSheet } from 'react-native'
import type { WaiverPriorityRow } from '@/lib/waivers'
import { colors, fontWeight, spacing, table, textStyles, typeScale } from '@/constants/tokens'
import { countLabel } from '@/lib/format'
import { panelStyles } from '@/components/league/draftPanelStyles'
import { tableStyles } from '@/components/league/leagueTableStyles'
import { SettingsRow } from '@/components/settings/SettingsGroup'
import { Button, usePageMetrics } from '@/components/ui'
import { Card } from '@/components/ui/Card'
import { SectionBand } from '@/components/ui/SectionBand'

function settingsWaiverPriorityRowLabel(row: WaiverPriorityRow, index: number, isMe: boolean) {
    return `Waiver priority ${index + 1}, ${row.teamName}${isMe ? ', your team' : ''}, manager ${row.displayName}`
}

function WaiverPriorityGroup({ waiverOrder, myMemberId }: { waiverOrder: WaiverPriorityRow[]; myMemberId?: string }) {
    const listLabel = `Waiver priority, ${countLabel(waiverOrder.length, 'team')}`
    return (
        <Card padding="none" elevated="none" style={styles.card}>
            <SectionBand label="Waiver priority" detail={<Text style={styles.bandDetail}>{countLabel(waiverOrder.length, 'team')}</Text>} />
            {waiverOrder.length ? (
                <View role="list" aria-label={listLabel} accessibilityRole="list" accessibilityLabel={listLabel}>
                    {waiverOrder.map((row, index) => {
                        const isMe = row.memberId === myMemberId
                        const label = settingsWaiverPriorityRowLabel(row, index, isMe)
                        return (
                            <View
                                key={row.memberId}
                                style={[styles.waiverRow, index > 0 && styles.rowDivider, isMe && tableStyles.rowMe]}
                                role="listitem"
                                aria-label={label}
                                accessibilityRole="text"
                                accessibilityLabel={label}
                            >
                                <Text style={[styles.waiverRank, isMe && tableStyles.textMe]}>{index + 1}</Text>
                                <Text style={[styles.waiverTeam, isMe && tableStyles.textMe]} numberOfLines={1}>{row.teamName}</Text>
                            </View>
                        )
                    })}
                </View>
            ) : (
                <SettingsRow label="No waiver priorities yet" detail="Priority order is listed here once the season starts." />
            )}
        </Card>
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
            return
        }
    }

    return (
        <ScrollView contentContainerStyle={[panelStyles.panelScroll, { paddingHorizontal: padX }]}>
            <Card padding="none" elevated="none" style={styles.card}>
                <SectionBand label="League" />
                <SettingsRow
                    label="Invite code"
                    detail={inviteCode ?? 'Not set'}
                    accessory={(
                        <View style={styles.inviteActions}>
                            {canCopy ? (
                                <Button
                                    title={copied ? 'Copied' : 'Copy'}
                                    size="sm"
                                    variant="outline"
                                    onPress={() => { void handleCopyInviteCode() }}
                                    accessibilityLabel="Copy invite code"
                                />
                            ) : null}
                            <Button
                                title="Share"
                                size="sm"
                                variant="outline"
                                onPress={onShareInviteCode}
                                accessibilityLabel={shareInviteAccessibilityLabel}
                            />
                        </View>
                    )}
                />
                <View style={styles.divider} />
                <SettingsRow label="Playoff bracket" onPress={onOpenBracket} accessibilityLabel="Open playoff bracket" />
                {isCommissioner ? (
                    <>
                        <View style={styles.divider} />
                        <SettingsRow label="Commissioner settings" onPress={onOpenCommissionerSettings} accessibilityLabel="Open commissioner settings" />
                    </>
                ) : null}
            </Card>
            <WaiverPriorityGroup waiverOrder={waiverOrder} myMemberId={myMemberId} />
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    card: { overflow: 'hidden' },
    bandDetail: { ...textStyles.meta, color: colors.info },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: spacing.lg },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
    inviteActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    waiverRow: {
        minHeight: table.rowHeightCompact,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
    },
    waiverRank: { ...typeScale.small, width: table.statColWidth, fontWeight: fontWeight.bold, color: colors.textMuted, fontVariant: ['tabular-nums'] as const },
    waiverTeam: { ...textStyles.rowTitle, flex: 1, minWidth: 0 },
})
