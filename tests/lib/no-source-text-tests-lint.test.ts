import path from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const eslint = new ESLint({ cwd: path.resolve(__dirname, '../..') })
const sourceText = async (code: string, filePath = 'tests/new-screen.test.ts') => {
    const [result] = await eslint.lintText(code, { filePath })
    return result.messages.filter(message => message.ruleId === 'pancake/no-source-text-tests')
}

describe('source-text test lint rule', () => {
    it('rejects the helper-read toContain shape that broke after the projections tab removal', async () => {
        const messages = await sourceText(`import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8')
const projectionsScreen = read('app/(tabs)/projections.tsx')
it('wires the screen', () => { expect(projectionsScreen).toContain('VIEW_OPTIONS') })
`)

        expect(messages).toHaveLength(1)
        expect(messages[0].message).toContain('app/(tabs)/projections.tsx')
        expect(messages[0].message).toContain('agent-browser e2e or a real-DB test')
        expect(messages[0].message).toContain('e3fc93e3/945f2849')
    })

    it('rejects index-ordering and sliced-block assertions on a screen source', async () => {
        const messages = await sourceText(`import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('guards stale loads', () => {
    const lineup = readFileSync('app/(modals)/lineup.tsx', 'utf8')
    const header = lineup.slice(lineup.indexOf('<Header'), lineup.indexOf('</Header>'))
    expect(header.indexOf('compact')).toBeGreaterThan(-1)
})
`)

        expect(messages.map(message => message.line)).toEqual([4])
    })

    it('rejects a read helper imported from another test module', async () => {
        const messages = await sourceText(`import { expect, it } from 'vitest'
import { read } from './static-helpers'
const tabs = read('lib/league/tabs.ts')
it('labels results', () => { expect(tabs).toContain("label: 'Results'") })
`)

        expect(messages).toHaveLength(1)
    })

    it('rejects SQL source pinned by text and the shared SQL text helper', async () => {
        const messages = await sourceText(`import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { readFunctionSource } from './source-guard'
const migration = readFileSync('supabase/migrations/20261201001200_guard_minute_workers.sql', 'utf8')
it('keeps the command', () => { expect(migration).toMatch(/work-dispatcher/) })
`)

        expect(messages.map(message => message.line)).toEqual([3, 4])
    })

    it('rejects source paths reached through a loop variable', async () => {
        const messages = await sourceText(`import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('has no underline', () => {
    for (const file of ['components/trades/MultiTeamTradeBuilder.tsx']) expect(readFileSync(file, 'utf8')).not.toContain('borderBottom')
})
`)

        expect(messages).toHaveLength(1)
    })

    it('allows executing product source in a sandbox', async () => {
        expect(await sourceText(`import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
const script = readFileSync('app/+html.tsx', 'utf8').split('SW_REGISTER')[1]
it('reloads', () => { expect(runInNewContext(script, {})).toBe(true) })
`)).toEqual([])
    })

    it('allows reading build output and files written under a temporary directory', async () => {
        expect(await sourceText(`import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
it('builds', async () => {
    const directory = '/tmp/work'
    expect(await readFile(path.join(directory, 'types/database.ts'), 'utf8')).toMatch(/p_pin/)
    expect(await readFile(path.join(process.cwd(), 'dist', 'sw.js'), 'utf8')).toContain('SHELL_ROUTES')
})
`)).toEqual([])
    })

    it('allows a source read whose text is never asserted', async () => {
        expect(await sourceText(`import { readFileSync } from 'node:fs'
import { it } from 'vitest'
it('applies the migration', () => { apply(readFileSync('supabase/migrations/001_init.sql', 'utf8')) })
`)).toEqual([])
    })

    it('keeps the named security and release contracts outside the rule', async () => {
        expect(await sourceText(`import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('hides tokens', () => { expect(readFileSync('lib/auth.ts', 'utf8')).not.toContain('is_username_available') })
`, 'tests/rls-grants.test.ts')).toEqual([])
    })
})
