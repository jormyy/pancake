// Shared mock preamble for rendering components with react-test-renderer.
// Import this module first in a test file; vi.mock registrations are hoisted
// inside it and apply to the component modules imported afterwards.
import React from 'react'
import { vi } from 'vitest'

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    NativeModules: { BlobModule: null },
    StyleSheet: { create: (styles: unknown) => styles },
    Image: 'Image',
    Pressable: 'Pressable',
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
}))
vi.mock('@/components/Motion', () => ({
    MotionPressable: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('Pressable', props, children),
    MotionView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('View', props, children),
}))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Badge', () => ({ Badge: 'Badge' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
