import { useCallback } from 'react'
import { useFocusEffect, useRouter } from 'expo-router'
import DraftRoomScreen from '@/app/(modals)/draft-room'
import { EmptyState } from '@/components/EmptyState'
import { useLeagueContext } from '@/contexts/league-context'
import { useDraftRoomLauncher } from '@/hooks/use-draft-room-launcher'

export default function DraftRoomTab() {
    const router = useRouter()
    const { currentLeague, current } = useLeagueContext()
    const { openDraftRoom, draft, draftLoading, draftError, draftChecked } = useDraftRoomLauncher(currentLeague?.id, { renderAuctionInline: true, scopeKey: current?.id })

    useFocusEffect(
        useCallback(() => {
            void openDraftRoom({ fallbackOnMissing: false })
        }, [openDraftRoom]),
    )

    if ((currentLeague?.id && !draftChecked) || draftLoading || draft?.draftType === 'snake') {
        return (
            <EmptyState
                icon="flash-on"
                message="Checking draft room"
                description="The active auction or rookie draft opens automatically when one is ready."
            />
        )
    }

    if (draftError) {
        return (
            <EmptyState
                icon="error-outline"
                message="Could not check draft room"
                description={draftError}
                actionLabel="Try Again"
                onAction={() => { void openDraftRoom({ fallbackOnMissing: false }) }}
            />
        )
    }

    if (draft) {
        return <DraftRoomScreen key={draft.id} resolvedDraftId={draft.id} />
    }

    return (
        <EmptyState
            icon="flash-on"
            message="No active draft"
            description="Start an auction or rookie draft from the League screen to open the draft room."
            actionLabel="Go to League"
            onAction={() => router.push('/league?tab=auctions')}
        />
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'
