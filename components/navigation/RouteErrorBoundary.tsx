import type { ErrorBoundaryProps } from 'expo-router'
import { requestPwaReload } from '@/lib/pwa-update-guard'
import { EmptyState } from '@/components/EmptyState'

export function RouteErrorBoundary({ retry }: ErrorBoundaryProps) {
    return <EmptyState
        message="Couldn't load this screen"
        description="Reload to get the latest version and try again."
        actionLabel="Reload"
        onAction={() => {
            if (typeof window !== 'undefined') requestPwaReload()
            else void retry()
        }}
    />
}
