import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { ClaimsPill } from '@/components/roster/ClaimsPill'
import { Button } from '@/components/ui/Button'

const push = vi.hoisted(() => vi.fn())
vi.mock('expo-router', () => ({ useRouter: () => ({ push }) }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, StyleSheet: { create: (styles: unknown) => styles } }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer

afterEach(async () => { await act(async () => screen?.unmount()); push.mockClear() })
it.each([[0, '/players?section=players'], [1, '/players?section=waivers'], [2, '/players?section=waivers']] as const)('opens the correct section for %s claims', async (count, route) => {
    await act(async () => { screen = create(React.createElement(ClaimsPill, { count })) })
    const button = screen.root.findByType(Button)
    expect(button.props.title).toBe(`${count} ${count === 1 ? 'Waiver' : 'Waivers'}`)
    expect(button.props.style.minHeight).toBeGreaterThanOrEqual(44)
    expect(button.props.style.minWidth).toBeGreaterThanOrEqual(44)
    await act(async () => button.props.onPress())
    expect(push).toHaveBeenCalledExactlyOnceWith(route)
})
