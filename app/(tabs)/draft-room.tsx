import { useCallback } from 'react'
import { useFocusEffect, useRouter } from 'expo-router'
import { EmptyState } from '@/components/EmptyState'
import { useLeagueContext } from '@/contexts/league-context'
import { useDraftRoomLauncher } from '@/hooks/use-draft-room-launcher'

export default function DraftRoomTab() {
    const router = useRouter()
    const { currentLeague } = useLeagueContext()
    const { openDraftRoom, draftLoading, draftError, draftChecked } = useDraftRoomLauncher(currentLeague?.id)

    useFocusEffect(
        useCallback(() => {
            void openDraftRoom({ fallbackOnMissing: false })
        }, [openDraftRoom]),
    )

    if ((currentLeague?.id && !draftChecked) || draftLoading) {
        return (
            <EmptyState
                icon="flash-on"
                message="Checking for a live draft"
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

    return (
        <EmptyState
            icon="flash-on"
            message="No active draft"
            description="Drafts start from League."
            actionLabel="Go to League"
            onAction={() => router.push('/league?tab=auctions')}
        />
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'
