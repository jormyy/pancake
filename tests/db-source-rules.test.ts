import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dbSourceRuleFailures } from '../scripts/check-db-function-sources.mjs'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

const rules = async (files: Record<string, string>) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'db-source-rules-'))
    directories.push(directory)
    await Promise.all(Object.entries(files).map(([name, source]) => writeFile(path.join(directory, name), source)))
    return directory
}

describe('database source rules', () => {
    it('reports every failure each rule module returns, prefixed by its file', async () => {
        const directory = await rules({
            'definer-search-path.mjs': `export default ({ definitions }) => [...definitions].filter(([, sql]) => /SECURITY DEFINER/.test(sql) && !/SET search_path/.test(sql)).map(([key]) => key + ' must set search_path')`,
            'notes.md': 'not a rule',
        })
        const definitions = new Map([
            ['public.unsafe', 'CREATE FUNCTION public.unsafe() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ select $$'],
            ['public.safe', "CREATE FUNCTION public.safe() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ select $$"],
        ])

        expect(await dbSourceRuleFailures(definitions, directory)).toEqual(['definer-search-path.mjs: public.unsafe must set search_path'])
    })

    it('passes when the rule directory does not exist', async () => {
        expect(await dbSourceRuleFailures(new Map(), path.join(tmpdir(), 'pancake-no-db-source-rules'))).toEqual([])
    })
})
