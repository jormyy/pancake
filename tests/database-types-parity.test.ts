import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { latestFunctionDefinitions } from '../scripts/check-db-function-sources.mjs'

const root = path.resolve(__dirname, '..')

const countBy = (names: string[]) => names.reduce((counts, name) => counts.set(name, (counts.get(name) ?? 0) + 1), new Map<string, number>())

const migratedRpcSignatures = async () => {
    const definitions = await latestFunctionDefinitions()
    return countBy([...definitions]
        .filter(([key, definition]) => key.startsWith('public.') && !/\bRETURNS\s+trigger\b/i.test(definition))
        .map(([key]) => key.slice('public.'.length).split('(')[0]))
}

const property = (members: ts.NodeArray<ts.TypeElement> | undefined, name: string) => {
    const member = members?.find((candidate): candidate is ts.PropertySignature =>
        ts.isPropertySignature(candidate) && candidate.name.getText().replaceAll(/["']/g, '') === name)
    return member?.type && ts.isTypeLiteralNode(member.type) ? member.type.members : undefined
}

const typedRpcSignatures = async () => {
    const file = path.join(root, 'types/database.ts')
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const database = source.statements.find((statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === 'Database')
    const functions = database && ts.isTypeLiteralNode(database.type)
        ? property(property(database.type.members, 'public'), 'Functions')
        : undefined
    if (!functions) throw new Error('types/database.ts has no Database.public.Functions')
    return new Map(functions.filter(ts.isPropertySignature).map(member => [
        member.name.getText().replaceAll(/["']/g, ''),
        member.type && ts.isUnionTypeNode(member.type) ? member.type.types.length : 1,
    ]))
}

describe('generated database types', () => {
    it('declare every callable public function from the migrations, overloads included', async () => {
        const [migrated, typed] = await Promise.all([migratedRpcSignatures(), typedRpcSignatures()])
        const mismatches = [...new Set([...migrated.keys(), ...typed.keys()])].sort()
            .filter(name => migrated.get(name) !== typed.get(name))
            .map(name => `${name}: ${migrated.get(name) ?? 0} migrated, ${typed.get(name) ?? 0} typed`)

        expect(mismatches, 'Run npm run generate:database-types against a local database migrated to the repository head').toEqual([])
    })
})
