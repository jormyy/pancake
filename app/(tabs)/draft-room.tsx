import { useCallback, useState } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { EmptyState } from '@/components/EmptyState'
import { useLeagueContext } from '@/contexts/league-context'
import { getJoinableDraft } from '@/lib/draft'
import { colors } from '@/constants/tokens'

export default function DraftRoomTab() {
    const router = useRouter()
    const { currentLeague } = useLeagueContext()
    const [checking, setChecking] = useState(true)
    const [hasDraft, setHasDraft] = useState(false)

    useFocusEffect(
        useCallback(() => {
            if (!currentLeague?.id) {
                setChecking(false)
                setHasDraft(false)
                return
            }

            setChecking(true)
            getJoinableDraft(currentLeague.id, { includeCompletedRookie: true })
                .then((draft) => {
                    if (!draft) {
                        setHasDraft(false)
                        return
                    }
                    setHasDraft(true)
                    const pathname = draft.draftType === 'snake'
                        ? '/(modals)/rookie-draft-room'
                        : '/(modals)/draft-room'
                    router.push({ pathname, params: { draftId: draft.id } })
                })
                .catch(() => setHasDraft(false))
                .finally(() => setChecking(false))
        }, [currentLeague?.id, router]),
    )

    if (checking) {
        return (
            <View style={styles.center}>
                <ActivityIndicator color={colors.primary} size="large" />
            </View>
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

const styles = StyleSheet.create({
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
})
