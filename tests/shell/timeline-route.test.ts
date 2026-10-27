import React, { lazy } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import TimelineRoute from '@/app/(modals)/timeline'

const state = vi.hoisted(() => ({ failed: false, loads: 0 }))
vi.mock('react-native', () => ({ Text: 'Text', View: 'View', Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('@/components/navigation/TimelineScreenLoader', () => ({ loadTimeline: () => lazy(async () => {
    state.loads += 1
    if (state.failed) throw new Error('Missing screen')
    return { default: () => React.createElement('TimelineScreen', {}, 'Season events') }
}) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
afterEach(async () => { await act(async () => screen?.unmount()); vi.restoreAllMocks() })

it('renders the loaded timeline screen', async () => {
    state.failed = false
    await act(async () => { screen = create(React.createElement(TimelineRoute)) })
    expect(screen.root.findByType('TimelineScreen' as React.ElementType).props.children).toBe('Season events')
})

it('shows a retry after a failed import and loads the screen on retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    state.failed = true
    state.loads = 0
    await act(async () => { screen = create(React.createElement(TimelineRoute)) })
    expect(screen.root.findByProps({ accessibilityRole: 'alert' }).props.children).toContain('could not load')
    state.failed = false
    await act(async () => screen.root.findByProps({ title: 'Retry timeline' }).props.onPress())
    expect(screen.root.findByType('TimelineScreen' as React.ElementType).props.children).toBe('Season events')
    expect(state.loads).toBe(2)
})
