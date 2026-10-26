import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { RouteErrorBoundary } from '@/components/navigation/RouteErrorBoundary'
import { requestPwaReload } from '@/lib/pwa-update-guard'

vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/lib/pwa-update-guard', () => ({ requestPwaReload: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('uses guarded update recovery from the missing-screen Reload button', async () => {
    vi.stubGlobal('window', { location: { reload: vi.fn() } })
    let screen: ReturnType<typeof create>
    try {
        await act(async () => { screen = create(React.createElement(RouteErrorBoundary, { error: new Error('ChunkLoadError'), retry: vi.fn() })) })
        await act(async () => screen.root.findByType('EmptyState' as React.ElementType).props.onAction())
        expect(requestPwaReload).toHaveBeenCalledOnce()
    } finally {
        await act(async () => screen?.unmount())
        vi.unstubAllGlobals()
    }
})
