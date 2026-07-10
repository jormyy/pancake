import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native'
import { MAX_TRADE_EXPIRATION_DAYS, MAX_TRADE_NOTES_BYTES, utf8ByteLength } from '@pancake/core'
import { MultiTeamTradeOverview, type TradeFlowItem } from '@/components/trades/MultiTeamTradeOverview'
import { ParticipantTradePanel } from '@/components/trades/ParticipantTradePanel'
import { breakpoints, colors, fontSize, fontWeight, radii, spacing, uiColors, type WebOnlyViewStyle } from '@/constants/tokens'
import type { TradeParticipantView } from '@/lib/trade-ui-model'
import type { MultiTeamTradeItemPayload } from '@/lib/trades'

type MultiTeamTradeBuilderProps = {
    participants: TradeParticipantView[]
    items: MultiTeamTradeItemPayload[]
    myMemberId: string
    faabEnabled: boolean
    notes: string
    notesError: string | null
    expirationDays: string
    expirationError: string | null
    rosterError: string | null
    rosterLoading: boolean
    avgMap: Map<string, number>
    avgStatsMap: Map<string, { avg_minutes_played: number | null }>
    participantName: (memberId: string) => string
    onRetry: () => void
    onTogglePlayer: (memberId: string, playerId: string) => void
    onTogglePick: (memberId: string, pickId: string) => void
    onDestinationChange: (memberId: string, toMemberId: string) => void
    onPlayerDestinationChange: (memberId: string, playerId: string, toMemberId: string) => void
    onPickDestinationChange: (memberId: string, pickId: string, toMemberId: string) => void
    onFaabChange: (memberId: string, toMemberId: string, value: string) => void
    onNotesChange: (value: string) => void
    onExpirationDaysChange: (value: string) => void
    reviewOnly?: boolean
}

export function MultiTeamTradeBuilder({
    participants,
    items,
    myMemberId,
    faabEnabled,
    notes,
    notesError,
    expirationDays,
    expirationError,
    rosterError,
    rosterLoading,
    avgMap,
    avgStatsMap,
    participantName,
    onRetry,
    onTogglePlayer,
    onTogglePick,
    onDestinationChange,
    onPlayerDestinationChange,
    onPickDestinationChange,
    onFaabChange,
    onNotesChange,
    onExpirationDaysChange,
    reviewOnly = false,
}: MultiTeamTradeBuilderProps) {
    const { width } = useWindowDimensions()
    const [contentWidth, setContentWidth] = useState(Math.min(width, 900))
    const shellContentWidth = width >= breakpoints.compact ? width - 264 : width
    const useColumns = Math.min(contentWidth, shellContentWidth) >= 880
    const [activeParticipantId, setActiveParticipantId] = useState(participants[0]?.memberId ?? '')
    const [overviewExpanded, setOverviewExpanded] = useState(false)
    const notesBytes = utf8ByteLength(notes)

    useEffect(() => {
        if (!participants.some((participant) => participant.memberId === activeParticipantId)) {
            setActiveParticipantId(participants[0]?.memberId ?? '')
        }
    }, [activeParticipantId, participants])

    const overviewItems = useMemo<TradeFlowItem[]>(() => items.map((item) => {
        const participant = participants.find((entry) => entry.memberId === item.fromMemberId)
        const player = item.kind === 'player'
            ? participant?.roster.find((entry) => entry.players.id === item.playerId)
            : null
        const pick = item.kind === 'pick'
            ? participant?.picks.find((entry) => entry.pickId === item.pickId)
            : null
        const label = player?.players.display_name ??
            (pick ? `${pick.seasonYear} Round ${pick.round}` : `$${item.kind === 'faab' ? item.faabAmount : 0} FAAB`)
        const assetKey = item.kind === 'player' ? `player:${item.playerId}`
            : item.kind === 'pick' ? `pick:${item.pickId}` : 'faab'
        return {
            key: `${assetKey}:${item.fromMemberId}:${item.toMemberId}`,
            fromMemberId: item.fromMemberId,
            toMemberId: item.toMemberId,
            label,
        }
    }), [items, participants])

    if (rosterError) {
        return (
            <Pressable
                style={styles.rosterErrorRow}
                onPress={onRetry}
                accessibilityRole="button"
                accessibilityLabel="Failed to load rosters. Tap to retry."
            >
                <Text style={styles.rosterErrorText}>Failed to load rosters. Tap to retry.</Text>
            </Pressable>
        )
    }

    if (rosterLoading) {
        return (
            <View style={styles.rosterLoadingRow} accessibilityRole="progressbar" accessibilityLabel="Loading trade assets">
                <ActivityIndicator color={colors.primary} />
                <Text style={styles.rosterLoadingText}>Loading rosters and picks...</Text>
            </View>
        )
    }

    const panels = participants.map((participant) => (
        <ParticipantTradePanel
            key={participant.memberId}
            participant={participant}
            myMemberId={myMemberId}
            faabEnabled={faabEnabled}
            useColumns={useColumns}
            avgMap={avgMap}
            avgStatsMap={avgStatsMap}
            participantName={participantName}
            onTogglePlayer={onTogglePlayer}
            onTogglePick={onTogglePick}
            onDestinationChange={onDestinationChange}
            onPlayerDestinationChange={onPlayerDestinationChange}
            onPickDestinationChange={onPickDestinationChange}
            onFaabChange={onFaabChange}
        />
    ))

    const overviewParticipants = participants.map((participant) => ({
        memberId: participant.memberId,
        label: participant.memberId === myMemberId ? 'You' : participantName(participant.memberId),
    }))

    if (reviewOnly) {
        return (
            <View
                style={styles.reviewRoot}
                onLayout={(event) => setContentWidth(event.nativeEvent.layout.width)}
            >
                <View style={styles.reviewHeading}>
                    <Text style={styles.reviewEyebrow}>FINAL REVIEW</Text>
                    <Text style={styles.reviewTitle}>
                        {participants.length}-team trade · {items.length} {items.length === 1 ? 'asset' : 'assets'}
                    </Text>
                </View>
                <MultiTeamTradeOverview
                    participants={overviewParticipants}
                    items={overviewItems}
                    columns={useColumns}
                />
                <View style={styles.reviewTerms}>
                    <Text style={styles.reviewTermsLabel}>TERMS</Text>
                    <Text style={styles.reviewTermsValue}>
                        Expires in {expirationDays} {expirationDays === '1' ? 'day' : 'days'}
                    </Text>
                    <Text style={styles.reviewTermsLabel}>NOTE</Text>
                    <Text style={styles.reviewTermsValue}>{notes.trim() || 'No note added'}</Text>
                </View>
            </View>
        )
    }

    return (
        <View
            style={styles.root}
            onLayout={(event) => setContentWidth(event.nativeEvent.layout.width)}
        >
            {useColumns ? (
                <MultiTeamTradeOverview participants={overviewParticipants} items={overviewItems} columns />
            ) : (
                <>
                    <Pressable
                        style={[styles.compactSummary, Platform.OS === 'web' && styles.compactSummarySticky]}
                        onPress={() => setOverviewExpanded((expanded) => !expanded)}
                        accessibilityRole="button"
                        accessibilityLabel={`${overviewExpanded ? 'Hide' : 'Show'} deal summary. ${participants.length} teams and ${items.length} routed assets.`}
                        accessibilityState={{ expanded: overviewExpanded }}
                        testID="trade-deal-summary"
                        id="trade-deal-summary"
                    >
                        <View style={styles.compactSummaryCopy}>
                            <Text style={styles.compactSummaryTitle}>DEAL SUMMARY</Text>
                            <Text style={styles.compactSummaryMeta}>
                                {participants.length} teams · {items.length} {items.length === 1 ? 'asset' : 'assets'} routed
                            </Text>
                        </View>
                        <MaterialIcons
                            name={overviewExpanded ? 'expand-less' : 'expand-more'}
                            size={24}
                            color={colors.textSecondary}
                        />
                    </Pressable>
                    {overviewExpanded ? (
                        <MultiTeamTradeOverview participants={overviewParticipants} items={overviewItems} compact />
                    ) : null}
                </>
            )}
            <Text style={styles.sectionLabel}>EDIT ASSETS SENT BY</Text>
            {!useColumns ? (
                <View
                    style={styles.senderTabs}
                    accessibilityRole="tablist"
                >
                    {participants.map((participant) => {
                        const active = participant.memberId === activeParticipantId
                        return (
                            <Pressable
                                key={participant.memberId}
                                style={[styles.senderTab, active && styles.senderTabActive]}
                                onPress={() => setActiveParticipantId(participant.memberId)}
                                accessibilityRole="tab"
                                accessibilityState={{ selected: active }}
                                accessibilityLabel={`Edit assets sent by ${participant.memberId === myMemberId ? 'you' : participantName(participant.memberId)}`}
                                testID={`trade-sender-${participant.memberId}`}
                                id={`trade-sender-${participant.memberId}`}
                            >
                                <Text style={[styles.senderTabText, active && styles.senderTabTextActive]} numberOfLines={1}>
                                    {participant.memberId === myMemberId ? 'You' : participantName(participant.memberId)}
                                </Text>
                            </Pressable>
                        )
                    })}
                </View>
            ) : null}
            {useColumns ? (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.scroller}
                    contentContainerStyle={styles.columns}
                >
                    {panels}
                </ScrollView>
            ) : (
                <View style={styles.stack}>
                    {panels.find((panel) => panel.key === activeParticipantId) ?? panels[0]}
                </View>
            )}
            <Text style={styles.sectionLabel}>NOTES (optional)</Text>
            <TextInput
                style={[styles.notesInput, notesError && styles.notesInputInvalid]}
                placeholder="Add a message to your trade offer..."
                placeholderTextColor={colors.textPlaceholder}
                value={notes}
                onChangeText={(value) => {
                    const nextBytes = utf8ByteLength(value)
                    if (nextBytes <= MAX_TRADE_NOTES_BYTES || nextBytes < notesBytes) onNotesChange(value)
                }}
                multiline
                numberOfLines={3}
                accessibilityLabel={notesError
                    ? `Trade notes. ${notesError}`
                    : `Trade notes. ${notesBytes} of ${MAX_TRADE_NOTES_BYTES} UTF-8 bytes.`
                }
                aria-invalid={Boolean(notesError)}
                testID="trade-notes-input"
            />
            <View style={styles.notesMeta}>
                {notesError ? (
                    <Text
                        style={styles.notesError}
                        accessibilityRole="alert"
                        accessibilityLiveRegion="polite"
                        testID="trade-notes-error"
                    >
                        {notesError}
                    </Text>
                ) : null}
                <Text
                    style={[styles.notesCount, notesError && styles.notesCountInvalid]}
                    accessibilityLabel={`Trade notes byte count: ${notesBytes} of ${MAX_TRADE_NOTES_BYTES}`}
                    testID="trade-notes-count"
                >
                    {notesBytes} / {MAX_TRADE_NOTES_BYTES} bytes
                </Text>
            </View>
            <Text style={styles.sectionLabel}>TERMS</Text>
            <View style={styles.termsRow}>
                <View style={styles.termField}>
                    <Text style={styles.termLabel}>Expires in days</Text>
                    <TextInput
                        style={[styles.termInput, expirationError && styles.termInputInvalid]}
                        value={expirationDays}
                        onChangeText={(value) => {
                            if (/^\d*$/.test(value) && value.length <= String(MAX_TRADE_EXPIRATION_DAYS).length) {
                                onExpirationDaysChange(value)
                            }
                        }}
                        maxLength={String(MAX_TRADE_EXPIRATION_DAYS).length}
                        keyboardType="numeric"
                        accessibilityLabel={expirationError
                            ? `Trade offer expiration in days. ${expirationError}`
                            : 'Trade offer expiration in days'
                        }
                        aria-invalid={Boolean(expirationError)}
                    />
                    {expirationError ? (
                        <Text
                            style={styles.termError}
                            accessibilityRole="alert"
                            accessibilityLiveRegion="polite"
                            testID="trade-expiration-error"
                        >
                            {expirationError}
                        </Text>
                    ) : null}
                </View>
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    root: { width: '100%', maxWidth: '100%', minWidth: 0 },
    reviewRoot: { width: '100%', maxWidth: '100%', minWidth: 0, paddingBottom: spacing['4xl'] },
    reviewHeading: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl },
    reviewEyebrow: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0,
    },
    reviewTitle: {
        marginTop: spacing.xs,
        fontSize: fontSize.xl,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    reviewTerms: {
        marginHorizontal: spacing.xl,
        marginTop: spacing.xl,
        paddingTop: spacing.lg,
        gap: spacing.xs,
        borderTopWidth: 1,
        borderTopColor: uiColors.borderNeutral,
    },
    reviewTermsLabel: {
        marginTop: spacing.sm,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
    },
    reviewTermsValue: {
        fontSize: fontSize.md,
        fontWeight: fontWeight.semibold,
        color: colors.textPrimary,
    },
    compactSummary: {
        minHeight: 56,
        marginTop: spacing.md,
        marginHorizontal: spacing.xl,
        paddingHorizontal: spacing.md,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: uiColors.borderNeutral,
        backgroundColor: uiColors.surfaceAlt,
    },
    compactSummarySticky: {
        position: 'sticky',
        top: 0,
        zIndex: 10,
    } as unknown as WebOnlyViewStyle,
    compactSummaryCopy: { minWidth: 0, flex: 1 },
    compactSummaryTitle: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0,
    },
    compactSummaryMeta: {
        marginTop: 2,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
        color: colors.textPrimary,
    },
    sectionLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0,
        paddingHorizontal: spacing.xl,
        paddingTop: spacing['2xl'],
        paddingBottom: spacing.md,
    },
    stack: { gap: spacing.lg, marginBottom: spacing.lg },
    scroller: { marginBottom: spacing.lg },
    columns: { flexDirection: 'row', gap: spacing.md, paddingHorizontal: spacing.xl, paddingBottom: spacing.sm },
    senderTabs: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
        paddingHorizontal: spacing.xl,
        paddingBottom: spacing.md,
    },
    senderTab: {
        flexGrow: 1,
        flexBasis: 96,
        minWidth: 96,
        maxWidth: 200,
        minHeight: 44,
        paddingHorizontal: spacing.md,
        borderBottomWidth: 2,
        borderBottomColor: colors.borderLight,
        alignItems: 'center',
        justifyContent: 'center',
    },
    senderTabActive: { borderBottomColor: colors.primary },
    senderTabText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textMuted },
    senderTabTextActive: { color: colors.textPrimary },
    notesInput: {
        marginHorizontal: spacing.xl,
        borderWidth: 1,
        borderColor: uiColors.borderNeutral,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 14,
        paddingVertical: 10,
        fontSize: fontSize.md,
        color: colors.textPrimary,
        minHeight: 80,
        textAlignVertical: 'top',
    },
    notesInputInvalid: { borderColor: colors.danger },
    notesMeta: {
        minHeight: 20,
        marginHorizontal: spacing.xl,
        marginTop: spacing.xs,
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: spacing.md,
    },
    notesError: { flex: 1, color: colors.dangerDark, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
    notesCount: { marginLeft: 'auto', color: colors.textMuted, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
    notesCountInvalid: { color: colors.dangerDark },
    termsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginHorizontal: spacing.xl },
    termField: { flexGrow: 1, flexBasis: 150, minWidth: 150, gap: spacing.xs },
    termLabel: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.textMuted, letterSpacing: 0 },
    termInput: {
        minHeight: 44,
        borderWidth: 1,
        borderColor: uiColors.borderNeutral,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.md,
        fontSize: fontSize.md,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },
    termInputInvalid: { borderColor: colors.danger },
    termError: { color: colors.dangerDark, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
    rosterErrorRow: { paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, minHeight: 44, alignItems: 'center' },
    rosterErrorText: { color: colors.dangerDark, fontSize: fontSize.md, fontWeight: fontWeight.semibold, textAlign: 'center' },
    rosterLoadingRow: { minHeight: 120, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
    rosterLoadingText: { color: colors.textMuted, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
})
