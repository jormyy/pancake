import path from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const eslint = new ESLint({ cwd: path.resolve(__dirname, '../..') })
const lint = (code: string) => eslint.lintText(code, { filePath: 'app/(modals)/claim-player.tsx' })
const restricted = (messages: { ruleId: string | null; message: string }[]) => messages.filter(message => message.ruleId === 'no-restricted-syntax')

describe('roster capacity lint rule', () => {
    it('rejects the historical inline active-roster filter and names the module', async () => {
        const [result] = await lint('const activeRoster = myRoster.filter((p) => !p.is_on_ir)\n')
        const messages = restricted(result.messages)

        expect(messages).toHaveLength(1)
        expect(messages[0].message).toContain('lib/roster-capacity')
    })

    it('rejects an inline taxi-slot fallback and names the module', async () => {
        const [result] = await lint('const taxi = currentLeague?.taxi_slots ?? 3\n')
        const messages = restricted(result.messages)

        expect(messages).toHaveLength(1)
        expect(messages[0].message).toContain('lib/roster-capacity')
    })

    it('rejects destructuring a roster flag and names the module', async () => {
        const [result] = await lint('const { is_on_ir } = row\n')
        const messages = restricted(result.messages)

        expect(messages).toHaveLength(1)
        expect(messages[0].message).toContain('lib/roster-capacity')
    })

    it('rejects destructuring a limit in a parameter and names the module', async () => {
        const [result] = await lint('const read = ({ taxi_slots }) => taxi_slots\n')
        const messages = restricted(result.messages)

        expect(messages).toHaveLength(1)
        expect(messages[0].message).toContain('lib/roster-capacity')
    })

    it('rejects computed string access and names the module', async () => {
        const [result] = await lint("const onIr = row['is_on_ir']\n")
        const messages = restricted(result.messages)

        expect(messages).toHaveLength(1)
        expect(messages[0].message).toContain('lib/roster-capacity')
    })

    it('allows object literal keys that construct rows', async () => {
        const [result] = await lint('const row = { is_on_ir: true, is_on_taxi: false }\n')

        expect(restricted(result.messages)).toEqual([])
    })

    it('allows assignment targets', async () => {
        const [result] = await lint("row.is_on_ir = true\nrow['is_on_taxi'] = false\n")

        expect(restricted(result.messages)).toEqual([])
    })

    it('allows Supabase select strings', async () => {
        const [result] = await lint("const query = supabase.from('roster_players').select('is_on_ir, is_on_taxi, roster_size')\n")

        expect(restricted(result.messages)).toEqual([])
    })

    it('allows the migrated equivalent', async () => {
        const [result] = await lint("import { partitionRoster } from '@/lib/roster-capacity'\nconst activeRoster = partitionRoster(myRoster).active\n")

        expect(restricted(result.messages)).toEqual([])
    })
})
