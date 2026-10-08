import { afterEach, describe, expect, it, vi } from 'vitest'
import { webChrome } from '@/constants/tokens'
import { THEME_BOOT_SCRIPT, THEME_STORAGE_KEY, readThemePreference, setThemePreference } from '@/lib/theme-preference'

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}))

function fakePage({ saved, deviceDark = false, storageThrows = false }: { saved?: string; deviceDark?: boolean; storageThrows?: boolean }) {
    const attributes = new Map<string, string>()
    const meta = { content: '', setAttribute: (_name: string, value: string) => { meta.content = value } }
    const listeners: (() => void)[] = []
    const media = {
        matches: deviceDark,
        addEventListener: (_event: string, listener: () => void) => { listeners.push(listener) },
    }
    const stored = new Map<string, string>(saved ? [[THEME_STORAGE_KEY, saved]] : [])
    const localStorage = {
        getItem: (key: string) => {
            if (storageThrows) throw new Error('blocked')
            return stored.get(key) ?? null
        },
        setItem: (key: string, value: string) => { stored.set(key, value) },
    }
    const document = {
        documentElement: {
            getAttribute: (name: string) => attributes.get(name) ?? null,
            setAttribute: (name: string, value: string) => { attributes.set(name, value) },
        },
        querySelector: () => meta,
    }
    const window = { matchMedia: () => media }
    const boot = () => new Function('document', 'localStorage', 'window', THEME_BOOT_SCRIPT)(document, localStorage, window)
    const switchDevice = (dark: boolean) => {
        media.matches = dark
        listeners.forEach((listener) => listener())
    }
    return { boot, switchDevice, document, localStorage, window, meta, stored, theme: () => attributes.get('data-theme') }
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('theme boot script', () => {
    it('starts light on a dark device when nothing is saved', () => {
        const page = fakePage({ deviceDark: true })
        page.boot()

        expect(page.theme()).toBe('light')
        expect(page.meta.content).toBe(webChrome.themeColor)
    })

    it('applies a saved dark choice before first paint', () => {
        const page = fakePage({ saved: 'dark' })
        page.boot()

        expect(page.theme()).toBe('dark')
        expect(page.meta.content).toBe(webChrome.themeColorDark)
    })

    it('follows the device under Auto, including later switches', () => {
        const page = fakePage({ saved: 'system', deviceDark: true })
        page.boot()

        expect(page.theme()).toBe('system')
        expect(page.meta.content).toBe(webChrome.themeColorDark)
        page.switchDevice(false)
        expect(page.meta.content).toBe(webChrome.themeColor)
    })

    it('falls back to light for an unknown saved value or blocked storage', () => {
        const unknown = fakePage({ saved: 'sepia', deviceDark: true })
        unknown.boot()
        const blocked = fakePage({ storageThrows: true, deviceDark: true })
        blocked.boot()

        expect(unknown.theme()).toBe('light')
        expect(blocked.theme()).toBe('light')
    })
})

describe('setThemePreference', () => {
    it('saves the choice and repaints the page and browser bar at once', () => {
        const page = fakePage({})
        vi.stubGlobal('document', page.document)
        vi.stubGlobal('localStorage', page.localStorage)
        vi.stubGlobal('window', page.window)
        page.boot()

        setThemePreference('dark')

        expect(page.stored.get(THEME_STORAGE_KEY)).toBe('dark')
        expect(readThemePreference()).toBe('dark')
        expect(page.meta.content).toBe(webChrome.themeColorDark)

        setThemePreference('light')
        expect(readThemePreference()).toBe('light')
        expect(page.meta.content).toBe(webChrome.themeColor)
    })
})
