import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import Root from '@/app/+html'

const fonts = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('expo-router', () => ({ usePathname: () => '/' }))
vi.mock('@/components/auth/AuthDocumentForm', () => ({ AuthDocumentForm: () => null }))
vi.mock('expo-router/html', () => ({ ScrollViewStyleReset: () => null }))
vi.mock('expo-asset', () => ({ Asset: { fromModule: (uri: string) => ({ uri }) } }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: { font: { material: '/icons.woff2' } } }))
vi.mock('@expo-google-fonts/outfit', () => ({ Outfit_500Medium: '/medium.woff2', Outfit_600SemiBold: '/semibold.woff2', Outfit_700Bold: '/bold.woff2' }))
vi.mock('expo-font', () => ({ useFonts: fonts.load, FontDisplay: { OPTIONAL: 'optional', SWAP: 'swap', BLOCK: 'block' } }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))
vi.mock('@/constants/boot-shell', () => ({ BOOT_SHELL_CSS: '', BOOT_SHELL_HTML: '', BOOT_SHELL_SCRIPT: '' }))
vi.mock('@/lib/theme-preference', () => ({ THEME_BOOT_SCRIPT: '' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('registers and preloads all critical fonts in the exported document', async () => {
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(Root)) })
    const preloads = screen.root.findAllByType('link').filter(node => node.props.as === 'font')
    expect(preloads.map(node => node.props.href).sort()).toEqual(['/bold.woff2', '/icons.woff2', '/medium.woff2', '/semibold.woff2'])
    expect(preloads.every(node => node.props.crossOrigin === 'anonymous')).toBe(true)
    expect(fonts.load).toHaveBeenCalledWith(expect.objectContaining({ material: { uri: '/icons.woff2', display: 'block' } }))
    await act(async () => screen.unmount())
})
