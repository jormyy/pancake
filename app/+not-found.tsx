import { Stack, useRouter } from 'expo-router'
import { EmptyState } from '@/components/EmptyState'
import { Page, PageHeader } from '@/components/ui'
import { useGoBack } from '@/components/ui/useGoBack'

/** Branded catch-all for unknown routes (replaces Expo Router's default Unmatched Route screen). */
export default function NotFoundScreen() {
    const router = useRouter()
    const goBack = useGoBack('/')
    return (
        <Page title="Page not found">
            <Stack.Screen options={{ title: 'Not Found', headerShown: false }} />
            <PageHeader title="Page not found" onBack={goBack} />
            <EmptyState
                icon="explore-off"
                message="This page doesn't exist"
                description="The link may be outdated, or the page may have moved."
                actionLabel="Back to Home"
                onAction={() => router.replace('/')}
            />
        </Page>
    )
}
