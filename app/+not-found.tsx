import { Stack, useRouter } from 'expo-router'
import { EmptyState } from '@/components/EmptyState'

/** Branded catch-all for unknown routes (replaces Expo Router's default Unmatched Route screen). */
export default function NotFoundScreen() {
    const router = useRouter()
    return (
        <>
            <Stack.Screen options={{ title: 'Not Found', headerShown: false }} />
            <EmptyState
                icon="explore-off"
                message="This page doesn't exist"
                description="The link may be outdated, or the page may have moved."
                actionLabel="Back to Home"
                onAction={() => router.replace('/')}
            />
        </>
    )
}
