import { readFile } from 'node:fs/promises'
import path from 'node:path'
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

const membershipStorage = ({ role = 'member', teamName = 'E2E Team 1', leagueName = 'Sunday Dynasty' } = {}) => ({
    'sb-abc-auth-token': session(),
    'pancake:league-memberships:v1:u1': JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        value: [{ id: 'm1', role, team_name: teamName, leagues: { id: 'l1', name: leagueName } }],
    }),
    'pancake:selected-league:v1:u1': JSON.stringify({ version: 1, savedAt: Date.now(), value: 'm1' }),
})

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
        const { texts, breadcrumb, commissionerHidden } = runBootScript('/roster', membershipStorage({ role: 'commissioner' }))
        // The live LeagueSwitcher crest is the team's first letter, not the league's.
        expect(texts).toEqual({ league: 'Sunday Dynasty', team: 'E2E Team 1', crest: 'E', initials: 'ET' })
        expect(commissionerHidden).toBe(false)
        expect(breadcrumb).toMatchObject({ league: 'Sunday Dynasty', team: 'E2E Team 1', active: '/roster' })
    })

    it('shows commissioner tools for co-commissioners too, matching isCommissioner', () => {
        expect(runBootScript('/', membershipStorage({ role: 'co_commissioner' })).commissionerHidden).toBe(false)
        expect(runBootScript('/', membershipStorage({ role: 'member' })).commissionerHidden).toBe(true)
    })

    it('picks the same membership league-context would', () => {
        const two = (selected: string) => ({
            'sb-abc-auth-token': session(),
            'pancake:league-memberships:v1:u1': JSON.stringify({
                version: 1,
                savedAt: Date.now(),
                value: [
                    { id: 'm1', role: 'member', team_name: 'First Team', leagues: { id: 'l1', name: 'First League' } },
                    { id: 'm2', role: 'member', team_name: 'Second Team', leagues: { id: 'l2', name: 'Second League' } },
                ],
            }),
            'pancake:selected-league:v1:u1': JSON.stringify({ version: 1, savedAt: Date.now(), value: selected }),
        })
        expect(runBootScript('/', two('m2')).texts.league).toBe('Second League')
        // Unknown selection falls back to the first membership, as useMemo does.
        expect(runBootScript('/', two('gone')).texts.league).toBe('First League')
    })

    it('derives initials exactly like lib/format getInitials', async () => {
        // Evaluate the real function's source rather than importing lib/format,
        // which drags in the whole React Native module graph.
        const source = await readFile(path.join(process.cwd(), 'lib/format.ts'), 'utf8')
        const body = source.slice(source.indexOf('export function getInitials'))
        const declaration = body.slice(0, body.indexOf('\n}\n') + 2).replace('export function', 'function')
        expect(declaration).toContain('letterWords')
        const getInitials = new Function(`${declaration.replace(/: string \| null \| undefined/g, '').replace(/: string/g, '')}; return getInitials`)() as (name: string) => string

        for (const name of ['E2E Team 1', 'Sunday Dynasty', 'Team #1', 'Solo', 'a', '123', 'The Big Bad Wolves']) {
            const { texts } = runBootScript('/', membershipStorage({ teamName: name }))
            expect(texts.initials, `initials for ${name}`).toBe(getInitials(name))
        }
    })

    it('paints the chrome but claims no league when the cache is long abandoned', () => {
        const ancient = Date.now() - 31 * 24 * 60 * 60 * 1000
        const { attributes, texts } = runBootScript('/', {
            'sb-abc-auth-token': session(),
            'pancake:league-memberships:v1:u1': JSON.stringify({
                version: 1,
                savedAt: ancient,
                value: [{ id: 'm1', role: 'member', team_name: 'Stale Team', leagues: { id: 'l1', name: 'Stale League' } }],
            }),
            'pancake:selected-league:v1:u1': JSON.stringify({ version: 1, savedAt: ancient, value: 'm1' }),
        })
        expect(attributes['data-visible']).toBe('1')
        expect(texts).toEqual({})
    })

    it('marks the moment it paints so the launch gate can measure the gap', () => {
        expect(runBootScript('/', { 'sb-abc-auth-token': session() }).marks).toEqual([BOOT_SHELL_MARK])
    })

    it('keeps the launch gate reading the marks this module actually emits', async () => {
        // The gate is an .mjs harness and cannot import this module, so it
        // repeats the mark names. Renaming one here must not silently blind it.
        const gate = await readFile(path.join(process.cwd(), 'tests/e2e/browser-pwa-launch.mjs'), 'utf8')
        expect(gate).toContain(`const BOOT_SHELL_MARK = '${BOOT_SHELL_MARK}'`)
        expect(gate).toContain(`const APP_MOUNTED_MARK = '${APP_MOUNTED_MARK}'`)
        expect(gate).toContain(`getElementById('${BOOT_SHELL_ID}')`)
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
