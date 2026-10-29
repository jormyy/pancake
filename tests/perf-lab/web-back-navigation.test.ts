import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { PageHeader } from '@/components/ui/Page'

vi.mock('react-native', () => ({
  Platform: { OS: 'web' }, Pressable: 'Pressable', Text: 'Text', View: 'View',
  StyleSheet: { create: (value: unknown) => value },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'Icon' }))

let tree: ReturnType<typeof create> | undefined
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { if (tree) act(() => tree!.unmount()); tree = undefined })

it.each([true, false])('keeps a working named web back control with actions=%s', actions => {
  const back = vi.fn()
  act(() => { tree = create(React.createElement(PageHeader, {
    title: 'Trade analysis', onBack: back, backLabel: 'Back to trade editor',
    actions: actions ? React.createElement('button', null, 'Edit assets') : undefined,
  })) })
  const controls = tree!.root.findAllByProps({ accessibilityLabel: 'Back to trade editor' })
  expect(controls).toHaveLength(1)
  act(() => { controls[0].props.onPress() })
  expect(back).toHaveBeenCalledOnce()
})
