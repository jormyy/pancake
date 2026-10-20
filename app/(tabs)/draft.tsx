import DraftRoomScreen from '@/app/(modals)/draft-room'
import { useCallback } from 'react'
import { useFocusEffect, useRouter } from 'expo-router'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner, LoadingState, Page, PageHeader } from '@/components/ui'
import { useGoBack } from '@/components/ui/useGoBack'
import { useLeagueContext } from '@/contexts/league-context'
import { useDraftRoomLauncher } from '@/hooks/use-draft-room-launcher'

export default function DraftRoomTab() {
    const router = useRouter()
    const goBack = useGoBack('/league')
    const { currentLeague, current } = useLeagueContext()
    const { openDraftRoom, draft, draftLoading, draftError, draftChecked } = useDraftRoomLauncher(currentLeague?.id, { renderAuctionInline: true, scopeKey: current?.id })

    useFocusEffect(
        useCallback(() => {
            void openDraftRoom({ fallbackOnMissing: false })
        }, [openDraftRoom]),
    )

    const checking = (currentLeague?.id && !draftChecked) || (draftLoading && !draftChecked) || draft?.draftType === 'snake'

    if (draft && !checking) return <>
        {draftError ? <ErrorBanner message={draftError} onRetry={() => { void openDraftRoom({ fallbackOnMissing: false }) }} /> : null}
        <DraftRoomScreen key={draft.id} resolvedDraftId={draft.id} />
    </>

    return (
        <Page title="Draft Room">
            <PageHeader title="Draft Room" onBack={goBack} />
            {checking ? (
                <LoadingState />
            ) : draftError ? (
                <EmptyState
                    icon="error-outline"
                    message="Could not check draft room"
                    description={draftError}
                    actionLabel="Try Again"
                    onAction={() => { void openDraftRoom({ fallbackOnMissing: false }) }}
                />
            ) : (
                <EmptyState
                    icon="flash-on"
                    message="No active draft"
                    description="Your league has no draft running. Practice in a mock draft room."
                    actionLabel="Open Mock Rooms"
                    onAction={() => router.push('/league?tab=mockRooms')}
                />
            )}
        </Page>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'
