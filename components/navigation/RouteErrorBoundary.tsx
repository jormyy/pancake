import type { ErrorBoundaryProps } from 'expo-router'
import { EmptyState } from '@/components/EmptyState'

export function RouteErrorBoundary({ retry }: ErrorBoundaryProps) {
    return <EmptyState
        message="Couldn't load this screen"
        description="Reload to get the latest version and try again."
        actionLabel="Reload"
        onAction={() => {
            if (typeof window !== 'undefined' && window.location?.reload) window.location.reload()
            else void retry()
        }}
    />
}
