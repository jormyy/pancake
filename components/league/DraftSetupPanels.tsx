import type { ReactNode } from 'react'
import { View, Text } from 'react-native'
import { ScreenStatusScrollView as ScrollView } from '@/components/ui/ScreenStatusOverlay'
import { Button, usePageMetrics } from '@/components/ui'
import {
    NOMINATION_ORDER_MODE_LABELS,
    ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS,
    type Draft,
} from '@/lib/draft'
import type { LeagueStatus } from '@/types/database'
import {
    DraftChips,
    DraftTimerControl,
    NOMINATION_ORDER_CHIPS,
    ROOKIE_ROUND_CHIPS,
    ROOKIE_TIMER_EXPIRY_CHIPS,
    rookieRoundChipLabel,
    type DraftControlProps,
} from '@/components/league/DraftChips'
import { ActiveDraftEntry, ActiveDraftErrorNotice } from '@/components/league/DraftActiveState'
import { panelStyles } from '@/components/league/draftPanelStyles'
import { textStyles } from '@/constants/tokens'

export function DraftPanel({
    activeDraft,
    activeDraftLoading,
    currentLeagueStatus,
    isCommissioner,
    draftLoading,
    activeDraftError,
    onRetryActiveDraft,
    nominationMode,
    onNominationModeChange,
    draftTimerSeconds,
    onDraftTimerSecondsChange,
    rookieRounds,
    onRookieRoundsChange,
    rookieTimerExpiryBehavior,
    onRookieTimerExpiryBehaviorChange,
    onStartDraft,
    onStartRookieDraft,
    onJoinDraft,
    onReseedRookiePicks,
    children,
}: DraftControlProps & {
    activeDraft: Draft | null
    activeDraftLoading: boolean
    currentLeagueStatus?: LeagueStatus
    isCommissioner: boolean
    draftLoading: boolean
    activeDraftError?: string | null
    onRetryActiveDraft: () => void
    onStartDraft: () => void
    onStartRookieDraft: () => void
    onJoinDraft: () => void
    onReseedRookiePicks: () => void
    children: ReactNode
}) {
    const { padX } = usePageMetrics()
    const ready = !activeDraftLoading && !activeDraftError
    const canStartAuction = ready && !activeDraft && currentLeagueStatus === 'setup' && isCommissioner
    const canStartRookie = ready && !activeDraft && currentLeagueStatus === 'offseason' && isCommissioner
    const canStart = canStartAuction || canStartRookie
    const startLabel = canStartAuction
        ? `Start auction draft, ${draftTimerSeconds} second timer, ${NOMINATION_ORDER_MODE_LABELS[nominationMode]} nomination order`
        : `Start rookie draft, ${rookieRounds} rounds, ${draftTimerSeconds} second timer, ${ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS[rookieTimerExpiryBehavior]} timeout behavior`

    return (
        <ScrollView contentContainerStyle={[panelStyles.panelScroll, { paddingHorizontal: padX }]}>
            <ActiveDraftErrorNotice activeDraftError={activeDraftError} onRetryActiveDraft={onRetryActiveDraft} />
            <ActiveDraftEntry
                activeDraft={activeDraft}
                activeDraftLoading={activeDraftLoading}
                isCommissioner={isCommissioner}
                draftLoading={draftLoading}
                onJoinDraft={onJoinDraft}
                onReseedRookiePicks={onReseedRookiePicks}
            />
            {canStart ? (
                <View style={panelStyles.panelCard}>
                    <Text style={panelStyles.panelTitle}>{canStartAuction ? 'Auction setup' : 'Rookie draft setup'}</Text>
                    <Text style={panelStyles.nominationModeLabel}>Timer</Text>
                    <DraftTimerControl
                        selectedValue={draftTimerSeconds}
                        onSelect={onDraftTimerSecondsChange}
                        groupLabel={canStartAuction ? 'Auction draft timer' : 'Rookie draft timer'}
                    />
                    {canStartAuction ? (
                        <>
                            <Text style={panelStyles.nominationModeLabel}>Nomination order</Text>
                            <DraftChips
                                options={NOMINATION_ORDER_CHIPS}
                                selectedValue={nominationMode}
                                onSelect={onNominationModeChange}
                                groupLabel="Nomination order"
                            />
                        </>
                    ) : (
                        <>
                            <Text style={panelStyles.nominationModeLabel}>Rookie rounds</Text>
                            <DraftChips
                                options={ROOKIE_ROUND_CHIPS}
                                selectedValue={rookieRounds}
                                onSelect={onRookieRoundsChange}
                                groupLabel="Rookie draft rounds"
                                accessibilityLabelForOption={rookieRoundChipLabel}
                            />
                            <Text style={panelStyles.nominationModeLabel}>Timeout behavior</Text>
                            <DraftChips
                                options={ROOKIE_TIMER_EXPIRY_CHIPS}
                                selectedValue={rookieTimerExpiryBehavior}
                                onSelect={onRookieTimerExpiryBehaviorChange}
                                groupLabel="Rookie timeout behavior"
                            />
                        </>
                    )}
                    <Button
                        title={canStartAuction ? 'Start Auction Draft' : 'Start Rookie Draft'}
                        onPress={canStartAuction ? onStartDraft : onStartRookieDraft}
                        disabled={draftLoading}
                        accessibilityLabel={startLabel}
                    />
                </View>
            ) : ready && !activeDraft ? <Text style={textStyles.meta}>No live draft.</Text> : null}
            {children}
        </ScrollView>
    )
}
