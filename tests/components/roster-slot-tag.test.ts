import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { RosterSlotTag } from '@/components/roster/RosterItems'

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', TextInput: 'TextInput', Switch: 'Switch', Pressable: 'Pressable', Image: 'Image', Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer | undefined
afterEach(async () => { await act(async () => screen?.unmount()); screen = undefined })

it.each(['PG', 'UTIL', 'BE', 'IR', 'TX'])('labels the %s player slot with its short code', async slotType => {
    await act(async () => { screen = create(React.createElement(RosterSlotTag, { slotType })) })
    expect(screen!.root.findByType('Text' as React.ElementType).props.children).toBe(slotType)
})
