import type { ErrorBoundaryProps } from 'expo-router'
import { EmptyState } from '@/components/EmptyState'

export function ScreenErrorFallback({ error, retry }: ErrorBoundaryProps) {
    const detail = __DEV__ && error?.message ? ` ${error.message}` : ''
    return <EmptyState
        icon="error-outline"
        message="Something went wrong"
        description={`This screen hit an unexpected error. Your data is safe. Try again, or switch to another screen.${detail}`}
        actionLabel="Try again"
        onAction={() => { void retry() }}
    />
}
