import type { ReactNode } from 'react'
import { PageHeader } from '@/components/ui'

export function DraftScreenHeader({
    title,
    onBack,
    children,
}: {
    title: string
    onBack: () => void
    children?: ReactNode
}) {
    return <PageHeader title={title} onBack={onBack} backLabel="Back to league drafts" actions={children} />
}
