import { useCallback, useState } from 'react'
import { useFocusEffect, useRouter } from 'expo-router'
import { EmptyState } from '@/components/EmptyState'
import { useLeagueContext } from '@/contexts/league-context'
import { getJoinableDraft } from '@/lib/draft'

export default function DraftRoomTab() {
    const router = useRouter()
    const { currentLeague } = useLeagueContext()
    const [checking, setChecking] = useState(true)

    useFocusEffect(
        useCallback(() => {
            if (!currentLeague?.id) {
                setChecking(false)
                return
            }

            setChecking(true)
            getJoinableDraft(currentLeague.id, { includeCompletedRookie: true })
                .then((draft) => {
                    if (!draft) return
                    const pathname = draft.draftType === 'snake'
                        ? '/(modals)/rookie-draft-room'
                        : '/(modals)/draft-room'
                    router.push({ pathname, params: { draftId: draft.id } })
                })
                .catch(() => {/* show empty state */})
                .finally(() => setChecking(false))
        }, [currentLeague?.id, router]),
    )

    if (checking) {
        return (
            <EmptyState
                icon="flash-on"
                message="Checking draft room"
                description="The active auction or rookie draft opens automatically when one is ready."
            />
        )
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

// Contain a render crash to this screen instead of blanking the whole app.
export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'
