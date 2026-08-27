import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    StyleSheet: { create: (styles: unknown) => styles, flatten: (style: unknown) => style },
}))

const {
    APP_MOUNTED_MARK,
    BOOT_SHELL_CSS,
    BOOT_SHELL_HTML,
    BOOT_SHELL_ID,
    BOOT_SHELL_MARK,
    BOOT_SHELL_READY_ATTR,
    BOOT_SHELL_SCRIPT,
} = await import('@/constants/boot-shell')

type Storage = Record<string, string>

/** Minimal DOM stand-in: the shell script only reads storage and one element. */
function runBootScript(pathname: string, storage: Storage) {
    const texts: Record<string, string> = {}
    const attributes: Record<string, string> = {}
    const hidden = new Set(['commissioner'])

    const textNode = (name: string) => ({
        set textContent(value: string) { texts[name] = value },
        get textContent() { return texts[name] ?? `stub-${name}` },
        getAttribute: () => (name === 'active' ? '/roster' : null),
        removeAttribute: () => {},
    })
    const element = {
        setAttribute(key: string, value: string) { attributes[key] = value },
        querySelectorAll: (selector: string) => {
            const match = /\[data-pbs="([^"]+)"\]/.exec(selector)
            return match ? [textNode(match[1])] : []
        },
        querySelector: (selector: string) => {
            if (selector === '[aria-current="page"]') return textNode('active')
            const match = /\[data-pbs="([^"]+)"\]/.exec(selector)
            if (!match) return null
            if (match[1] === 'commissioner') {
                return { removeAttribute: () => hidden.delete('commissioner') }
            }
            return textNode(match[1])
        },
    }
    const keys = Object.keys(storage)
    const marks: string[] = []
    const scope = { __PANCAKE_BOOT__: null as unknown }

    new Function('document', 'location', 'window', 'performance', BOOT_SHELL_SCRIPT)(
        {
            getElementById: (id: string) => (id === BOOT_SHELL_ID ? element : null),
            documentElement: { setAttribute: () => {} },
        },
        { pathname },
        Object.assign(scope, {
            localStorage: {
                length: keys.length,
                key: (index: number) => keys[index] ?? null,
                getItem: (key: string) => storage[key] ?? null,
            },
        }),
        { mark: (name: string) => marks.push(name) },
    )
    return { attributes, texts, marks, breadcrumb: scope.__PANCAKE_BOOT__, commissionerHidden: hidden.has('commissioner') }
}

const session = (userId = 'u1') => JSON.stringify({ access_token: 'fake-access-token', user: { id: userId } })

// The boot shell is emitted as a raw string into the document, so nothing type
// checks it. A single lost escape once left the whole script unparsable, which
// silently disabled the instant paint while every other gate stayed green.
describe('boot shell', () => {
    it('emits a script the browser can actually parse', () => {
        expect(() => new Function(BOOT_SHELL_SCRIPT)).not.toThrow()
    })

    it('reveals the shell only for a stored session on a non-auth route', () => {
        expect(runBootScript('/', { 'sb-abc-auth-token': session() }).attributes).toMatchObject({
            'data-visible': '1',
            [BOOT_SHELL_READY_ATTR]: '1',
        })
        // Signed out: the app boots to a marketing/auth screen, not the chrome.
        expect(runBootScript('/', {}).attributes).toEqual({})
        // Signed in but heading to auth: that screen owns the whole viewport.
        expect(runBootScript('/sign-in', { 'sb-abc-auth-token': session() }).attributes).toEqual({})
        expect(runBootScript('/sign-up', { 'sb-abc-auth-token': session() }).attributes).toEqual({})
        // Corrupt storage entry must not break the launch.
        expect(runBootScript('/', { 'sb-abc-auth-token': '{not json' }).attributes).toEqual({})
    })

    it('renders the cached league, team, and initials the app will render', () => {
        const { texts, breadcrumb, commissionerHidden } = runBootScript('/roster', {
            'sb-abc-auth-token': session(),
            'pancake:league-memberships:v1:u1': JSON.stringify({
                version: 1,
                savedAt: 0,
                value: [{ id: 'm1', role: 'commissioner', team_name: 'E2E Team 1', leagues: { id: 'l1', name: 'Sunday Dynasty' } }],
            }),
            'pancake:selected-league:v1:u1': JSON.stringify({ version: 1, savedAt: 0, value: 'm1' }),
        })
        expect(texts).toEqual({ league: 'Sunday Dynasty', team: 'E2E Team 1', crest: 'S', initials: 'ET' })
        expect(commissionerHidden).toBe(false)
        expect(breadcrumb).toMatchObject({ league: 'Sunday Dynasty', team: 'E2E Team 1', active: '/roster' })
    })

    it('marks the moment it paints so the launch gate can measure the gap', () => {
        expect(runBootScript('/', { 'sb-abc-auth-token': session() }).marks).toEqual([BOOT_SHELL_MARK])
        expect(APP_MOUNTED_MARK).toBe('pancake-app-mounted')
    })

    it('links every primary route so the shell navigates without the bundle', () => {
        for (const href of ['/', '/roster', '/players', '/trades', '/dynasty', '/league']) {
            expect(BOOT_SHELL_HTML).toContain(`data-href="${href}"`)
            expect(BOOT_SHELL_HTML).toContain(`href="${href}"`)
        }
    })

    it('keeps the shell hidden until the script opts it in', () => {
        expect(BOOT_SHELL_CSS).toContain(`#${BOOT_SHELL_ID}{`)
        expect(BOOT_SHELL_CSS).toContain('display:none')
        expect(BOOT_SHELL_CSS).toContain(`#${BOOT_SHELL_ID}[data-visible="1"]{display:block;}`)
    })
})
